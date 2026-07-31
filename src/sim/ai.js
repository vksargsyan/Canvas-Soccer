// Team AI: formations, roles, ball pursuit, passing, shooting and the goalkeeper.
//
//   createAI(ctx) -> { update(dt), homeFor(agent), chaserOf(team), reset() }
//
// ctx: { agents, body, goals, match, rng, events }
// An "agent" is the sim-side record for a player:
//   { id, team, role, isKeeper, pos, vel, yaw, down, control, anim, view, ... }
//
// Everything here is a pure function of the fixed-step simulation state, so a
// scenario replayed from the same seed produces the same frame.

import * as THREE from 'three';
import {
  HALF_W, HALF_D, GOAL_HALF_W, RUN_SPEED, SPRINT_SPEED, KEEPER_SPEED,
  ACCEL, PLAYER_R, BALL_R, TEAMS,
} from '../core/constants.js';

// 2-2-1, expressed in "attacking" space: +X is the direction the team attacks.
export const FORMATION = [
  { role: 'GK', x: -27.0, z: 0.0 },
  { role: 'LB', x: -16.0, z: -7.5 },
  { role: 'RB', x: -16.0, z: 7.5 },
  { role: 'LM', x: -3.0, z: -9.5 },
  { role: 'RM', x: -3.0, z: 9.5 },
  { role: 'ST', x: 8.0, z: 0.0 },
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const _d = new THREE.Vector3();

export function createAI(ctx) {
  const { agents, body, goals } = ctx;
  const rng = ctx.rng;
  const events = ctx.events || {};

  const home = new THREE.Vector3();

  function goalCenter(team) {
    // the goal this team attacks
    return TEAMS[team].dir > 0 ? HALF_W : -HALF_W;
  }
  function ownGoal(team) { return -goalCenter(team); }

  /** formation slot in world space, shifted by where the ball is */
  function homeFor(a) {
    const dir = TEAMS[a.team].dir;
    const f = FORMATION[a.slot] || FORMATION[0];
    let x = f.x * dir;
    let z = f.z;
    if (!a.isKeeper) {
      // shuffle the block toward the ball
      x += clamp(body.pos.x * 0.42, -12, 12);
      z += clamp(body.pos.z * 0.30, -7, 7);
      x = clamp(x, -HALF_W + 3, HALF_W - 3);
      z = clamp(z, -HALF_D + 2.5, HALF_D - 2.5);
    }
    home.set(x, 0, z);
    return home;
  }

  function distToBall(a) {
    const dx = body.pos.x - a.pos.x, dz = body.pos.z - a.pos.z;
    return Math.hypot(dx, dz);
  }

  const chasers = [null, null];
  function chaserOf(team) { return chasers[team]; }

  function pickChasers() {
    for (const t of [0, 1]) {
      let best = null, bd = 1e9;
      for (const a of agents) {
        if (a.team !== t || a.isKeeper || a.down) continue;
        const d = distToBall(a) - (a === chasers[t] ? 2.0 : 0);
        if (d < bd) { bd = d; best = a; }
      }
      chasers[t] = best;
    }
  }

  /** steer an agent toward a world point */
  function seek(a, tx, tz, dt, speed) {
    const dx = tx - a.pos.x, dz = tz - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.06) { a.vel.multiplyScalar(Math.max(0, 1 - 9 * dt)); return 0; }
    const nx = dx / d, nz = dz / d;
    const want = Math.min(speed, d * 3.4 + 1.2);
    a.vel.x += (nx * want - a.vel.x) * Math.min(1, ACCEL * dt / Math.max(1, want));
    a.vel.z += (nz * want - a.vel.z) * Math.min(1, ACCEL * dt / Math.max(1, want));
    return d;
  }

  function bestPass(a) {
    const dir = TEAMS[a.team].dir;
    let best = null, bs = -1e9;
    for (const m of agents) {
      if (m === a || m.team !== a.team || m.isKeeper || m.down) continue;
      const dx = m.pos.x - a.pos.x, dz = m.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 4 || d > 26) continue;
      let s = (m.pos.x - a.pos.x) * dir * 1.4 - d * 0.35;
      // penalise passing into a crowd
      for (const o of agents) {
        if (o.team === a.team || o.down) continue;
        const t = ((o.pos.x - a.pos.x) * dx + (o.pos.z - a.pos.z) * dz) / (d * d);
        if (t < 0 || t > 1) continue;
        const px = a.pos.x + dx * t, pz = a.pos.z + dz * t;
        const off = Math.hypot(o.pos.x - px, o.pos.z - pz);
        if (off < 2.2) s -= 9;
      }
      if (s > bs) { bs = s; best = m; }
    }
    return best;
  }

  function pressure(a) {
    let n = 0;
    for (const o of agents) {
      if (o.team === a.team || o.down) continue;
      if (Math.hypot(o.pos.x - a.pos.x, o.pos.z - a.pos.z) < 3.0) n++;
    }
    return n;
  }

  // ---- goalkeeper ---------------------------------------------------------
  function updateKeeper(a, dt) {
    const line = ownGoal(a.team);
    const s = Math.sign(line) || 1;
    const towardOwn = body.pos.x * s;   // >0 means the ball is in this keeper's half

    // Track the ball across the mouth, hugging the line.
    const t = clamp(body.pos.z * 0.55, -GOAL_HALF_W + 0.6, GOAL_HALF_W - 0.6);
    let px = line - s * 0.9;
    if (towardOwn > HALF_W - 16) px = line - s * (1.6 + clamp((HALF_W - Math.abs(body.pos.x)) * 0.08, 0, 1.6));

    a.keeperTimer = (a.keeperTimer || 0) - dt;

    // dive when a fast ball is heading at goal
    const approaching = (body.vel.x * s) > 8 && Math.abs(body.pos.x - line) < 20;
    if (approaching && a.keeperTimer <= 0 && !a.diving) {
      const tHit = Math.abs(body.pos.x - line) / Math.max(1, Math.abs(body.vel.x));
      const zHit = body.pos.z + body.vel.z * tHit;
      if (Math.abs(zHit) < GOAL_HALF_W + 1.6 && tHit < 0.72) {
        a.diving = true;
        a.diveDir = zHit > a.pos.z ? 1 : -1;
        a.diveTarget = clamp(zHit, -GOAL_HALF_W - 0.5, GOAL_HALF_W + 0.5);
        a.keeperTimer = 1.5;
        if (a.anim) a.anim.play('keeperDive', { dir: a.diveDir, force: true });
        if (events.onKeeperDive) events.onKeeperDive(a);
      }
    }

    if (a.diving) {
      seek(a, px, a.diveTarget, dt, KEEPER_SPEED * 1.7);
      if (a.anim && !a.anim.busy) a.diving = false;
    } else {
      const d = seek(a, px, t, dt, KEEPER_SPEED);
      if (a.anim) {
        if (a.anim.current !== 'keeperDive' && a.anim.current !== 'keeperCatch') {
          a.anim.play(d > 0.5 ? 'run' : 'keeperIdle');
        }
      }
    }
    a.faceX = line > 0 ? -1 : 1;
    a.faceZ = 0;
  }

  // ---- outfield -----------------------------------------------------------
  function updateOutfield(a, dt) {
    const dir = TEAMS[a.team].dir;
    const gx = goalCenter(a.team);
    const d = distToBall(a);
    const hasBall = d < PLAYER_R + BALL_R + 0.35 && body.pos.y < 1.4;
    const isChaser = chasers[a.team] === a;

    a.cool = Math.max(0, (a.cool || 0) - dt);

    if (hasBall && a.cool <= 0) {
      const toGoal = Math.abs(gx - a.pos.x);
      const press = pressure(a);
      const shootRange = 22 + rng.float() * 4;

      if (toGoal < shootRange && Math.abs(a.pos.z) < 17) {
        // shoot
        const aimZ = clamp(rng.range(-GOAL_HALF_W + 0.8, GOAL_HALF_W - 0.8), -3.2, 3.2);
        _d.set(gx - a.pos.x, 0, aimZ - a.pos.z);
        const power = clamp(16 + toGoal * 0.62, 18, 32);
        body.kick(_d, power, 2.6 + rng.range(0, 2.2), rng.range(-6, 6));
        a.cool = 0.7;
        if (a.anim) a.anim.play('kick', { foot: rng.sign(), force: true });
        if (events.onShot) events.onShot(a, power);
        return;
      }

      if (press >= 1 && rng.chance(0.5 + press * 0.2)) {
        const mate = bestPass(a);
        if (mate) {
          const lead = 0.28;
          _d.set(mate.pos.x + mate.vel.x * lead - a.pos.x, 0, mate.pos.z + mate.vel.z * lead - a.pos.z);
          const dist = _d.length();
          body.kick(_d, clamp(dist * 1.35, 9, 24), dist > 14 ? 2.4 : 0.7, 0);
          a.cool = 0.5;
          if (a.anim) a.anim.play('pass', { foot: rng.sign(), force: true });
          if (events.onPass) events.onPass(a, mate);
          return;
        }
      }

      // dribble
      const tz = clamp(a.pos.z * 0.85, -HALF_D + 4, HALF_D - 4);
      seek(a, a.pos.x + dir * 6, tz, dt, RUN_SPEED * 1.02);
      if (rng.chance(dt * 6)) {
        _d.set(dir, 0, (tz - a.pos.z) * 0.15);
        body.kick(_d, RUN_SPEED * 1.15, 0, 0);
      }
      if (a.anim && !a.anim.busy) a.anim.play('run');
      a.faceX = dir; a.faceZ = 0;
      return;
    }

    if (isChaser) {
      // intercept: aim slightly ahead of the ball
      const lead = clamp(d / 16, 0, 0.5);
      const tx = body.pos.x + body.vel.x * lead;
      const tz = body.pos.z + body.vel.z * lead;
      const sp = d > 6 ? SPRINT_SPEED : RUN_SPEED;
      seek(a, clamp(tx, -HALF_W - 1, HALF_W + 1), clamp(tz, -HALF_D - 1, HALF_D - 1), dt, sp);
      if (a.anim && !a.anim.busy) a.anim.play(d > 6 ? 'sprint' : 'run');

      // slide tackle when very close to an opposing carrier
      if (d < 2.4 && body.lastTouchTeam >= 0 && body.lastTouchTeam !== a.team && a.cool <= 0 && rng.chance(dt * 1.6)) {
        a.cool = 1.3;
        if (a.anim) a.anim.play('tackle', { force: true });
        if (events.onTackle) events.onTackle(a);
      }
      return;
    }

    // hold formation
    const h = homeFor(a);
    const dd = seek(a, h.x, h.z, dt, RUN_SPEED * 0.86);
    if (a.anim && !a.anim.busy) a.anim.play(dd > 1.2 ? 'run' : 'idle');
  }

  function update(dt) {
    pickChasers();
    for (const a of agents) {
      if (a.down) {
        a.vel.multiplyScalar(Math.max(0, 1 - 6 * dt));
        continue;
      }
      if (a.control === 'user') continue;   // driven by the player
      if (a.isKeeper) updateKeeper(a, dt);
      else updateOutfield(a, dt);
    }
  }

  function reset() {
    chasers[0] = chasers[1] = null;
    for (const a of agents) { a.cool = 0; a.diving = false; a.keeperTimer = 0; }
  }

  return { update, homeFor, chaserOf, reset, FORMATION };
}
