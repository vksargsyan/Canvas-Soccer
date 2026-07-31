// Ball integration + collision resolution.
//
//   createBallBody(cfg) -> { pos, vel, spin, grounded, step(dt, world),
//                            kick(dir, power, lift, curl), stop(), place(x,y,z) }
//
// `world` is supplied every step and may contain:
//   { bounds:{halfW,halfD}, goals:[goal], players:[{pos,vel,radius,id}],
//     events:{ onBounce(speed,pos), onPost(pos), onGoal(side), onOut(kind,pos),
//              onTouch(player, speed) } }
//
// Also exports player separation and a ball/player interaction helper so sim/ai.js
// and sim/match.js do not each reimplement them.

import * as THREE from 'three';
import {
  BALL_R, GRAVITY, AIR_DRAG, MAGNUS, RESTITUTION, ROLL_FRICTION, SPIN_DECAY,
  MAX_BALL_SPEED, PLAYER_R,
} from '../core/constants.js';

const _v = new THREE.Vector3();
const _m = new THREE.Vector3();

export function createBallBody(cfg = {}) {
  const pos = new THREE.Vector3(cfg.x || 0, cfg.y ?? BALL_R, cfg.z || 0);
  const vel = new THREE.Vector3();
  const spin = new THREE.Vector3();

  const body = {
    pos, vel, spin,
    grounded: true,
    lastTouch: null,
    lastTouchTeam: -1,

    place(x, y, z) {
      pos.set(x, y ?? BALL_R, z);
      vel.set(0, 0, 0);
      spin.set(0, 0, 0);
      body.grounded = (pos.y <= BALL_R + 1e-3);
      return body;
    },

    stop() { vel.set(0, 0, 0); spin.set(0, 0, 0); return body; },

    /**
     * dir  : THREE.Vector3-ish direction on the ground plane (need not be normalised)
     * power: metres/second along dir
     * lift : upward metres/second
     * curl : sideways spin (rad/s about Y), positive bends right
     */
    kick(dir, power, lift = 0, curl = 0) {
      const len = Math.hypot(dir.x, dir.z) || 1;
      vel.x = (dir.x / len) * power;
      vel.z = (dir.z / len) * power;
      vel.y = lift;
      spin.y = curl;
      spin.x = (dir.z / len) * -power * 0.55;
      spin.z = (dir.x / len) * power * 0.55;
      body.grounded = false;
      clampSpeed();
      return body;
    },

    step(dt, world) { integrate(dt, world || {}); },
  };

  function clampSpeed() {
    const s = vel.length();
    if (s > MAX_BALL_SPEED) vel.multiplyScalar(MAX_BALL_SPEED / s);
  }

  function integrate(dt, world) {
    const ev = world.events || {};
    const speed = vel.length();

    // --- aerodynamics ------------------------------------------------------
    if (speed > 0.01) {
      // quadratic drag
      const d = AIR_DRAG * speed;
      _v.copy(vel).multiplyScalar(-d * dt);
      vel.add(_v);

      // Magnus: F = k (w x v)
      _m.crossVectors(spin, vel).multiplyScalar(MAGNUS * dt * 0.02);
      vel.add(_m);
    }

    vel.y += GRAVITY * dt;

    // --- integrate ---------------------------------------------------------
    pos.addScaledVector(vel, dt);

    // spin decay
    const decay = Math.pow(SPIN_DECAY, dt * 60 * 0.05);
    spin.multiplyScalar(decay);

    // --- ground ------------------------------------------------------------
    if (pos.y <= BALL_R) {
      const impact = -vel.y;
      pos.y = BALL_R;
      if (impact > 0.9) {
        vel.y = impact * RESTITUTION;
        // friction + spin transfer on bounce
        vel.x *= 0.86; vel.z *= 0.86;
        vel.x += spin.z * 0.012;
        vel.z -= spin.x * 0.012;
        spin.multiplyScalar(0.72);
        body.grounded = false;
        if (ev.onBounce) ev.onBounce(impact, pos);
      } else {
        vel.y = 0;
        body.grounded = true;
        // rolling resistance
        const damp = Math.max(0, 1 - ROLL_FRICTION * dt);
        vel.x *= damp; vel.z *= damp;
        // rolling spin follows velocity
        spin.x = -vel.z / BALL_R;
        spin.z = vel.x / BALL_R;
        spin.y *= Math.max(0, 1 - 2.2 * dt);
        if (vel.lengthSq() < 0.0025) vel.set(0, 0, 0);
      }
    } else {
      body.grounded = false;
    }

    // --- goals: posts, crossbar, net ---------------------------------------
    if (world.goals) {
      for (const g of world.goals) {
        // posts
        for (const p of g.posts) {
          const dx = pos.x - p.x, dz = pos.z - p.z;
          const rr = p.r + BALL_R;
          const d2 = dx * dx + dz * dz;
          if (d2 < rr * rr && pos.y < g.crossbarY + BALL_R) {
            const d = Math.sqrt(d2) || 1e-4;
            const nx = dx / d, nz = dz / d;
            pos.x = p.x + nx * rr;
            pos.z = p.z + nz * rr;
            const vn = vel.x * nx + vel.z * nz;
            if (vn < 0) {
              vel.x -= 2 * vn * nx * 0.82;
              vel.z -= 2 * vn * nz * 0.82;
              if (ev.onPost) ev.onPost(pos, Math.abs(vn));
            }
          }
        }
        // crossbar
        const nearBarX = Math.abs(pos.x - g.posts[0].x) < BALL_R + 0.2;
        if (nearBarX && Math.abs(pos.z) < 4.2 && Math.abs(pos.y - g.crossbarY) < BALL_R + 0.12 && vel.y > 0) {
          pos.y = g.crossbarY - BALL_R - 0.12;
          vel.y = -Math.abs(vel.y) * 0.7;
          if (ev.onPost) ev.onPost(pos, Math.abs(vel.y));
        }
        // back + side of net catches the ball
        if (g.contains(pos.x, pos.y, pos.z)) {
          const beyond = g.side > 0 ? pos.x - g.backX : g.backX - pos.x;
          if (beyond > -BALL_R) {
            pos.x = g.backX - g.side * BALL_R;
            vel.x *= -0.18; vel.y *= 0.35; vel.z *= 0.45;
          }
          if (Math.abs(pos.z) > 4 - BALL_R) {
            pos.z = Math.sign(pos.z) * (4 - BALL_R);
            vel.z *= -0.25;
          }
          if (ev.onGoal) ev.onGoal(g.side, pos);
        }
      }
    }

    // --- pitch bounds ------------------------------------------------------
    const b = world.bounds;
    if (b) {
      if (Math.abs(pos.z) > b.halfD + BALL_R * 0.5 && ev.onOut) {
        ev.onOut('throw', pos);
      } else if (Math.abs(pos.x) > b.halfW + BALL_R * 0.5 && ev.onOut) {
        const inMouth = Math.abs(pos.z) < 4 && pos.y < 3;
        if (!inMouth) ev.onOut(pos.x > 0 ? 'goalkickR' : 'goalkickL', pos);
      }
      // hard cage so the ball can never escape the stadium
      const cageX = b.halfW + 8, cageZ = b.halfD + 6;
      if (Math.abs(pos.x) > cageX) { pos.x = Math.sign(pos.x) * cageX; vel.x *= -0.35; }
      if (Math.abs(pos.z) > cageZ) { pos.z = Math.sign(pos.z) * cageZ; vel.z *= -0.35; }
    }

    clampSpeed();
  }

  return body;
}

// ---------------------------------------------------------------------------
// player <-> player separation
// ---------------------------------------------------------------------------

export function separatePlayers(players, dt) {
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (a.down || b.down) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const min = PLAYER_R * 2 * 0.82;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) * 0.5;
      const nx = dx / d, nz = dz / d;
      a.pos.x -= nx * push; a.pos.z -= nz * push;
      b.pos.x += nx * push; b.pos.z += nz * push;
    }
  }
}

// ---------------------------------------------------------------------------
// player <-> ball
// ---------------------------------------------------------------------------

/**
 * Nudge / dribble contact. Returns the player who touched the ball this step, or null.
 * Deliberate kicks come from sim/match.js and sim/ai.js via body.kick().
 */
export function ballPlayerContact(body, players, dt, events = {}) {
  let touched = null;
  const reach = PLAYER_R + BALL_R * 0.9;
  for (const p of players) {
    if (p.down) continue;
    const dx = body.pos.x - p.pos.x;
    const dz = body.pos.z - p.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > reach * reach) continue;
    if (body.pos.y > 1.5) continue;
    const d = Math.sqrt(d2) || 1e-4;
    const nx = dx / d, nz = dz / d;

    // push the ball out of the body
    body.pos.x = p.pos.x + nx * reach;
    body.pos.z = p.pos.z + nz * reach;

    const relx = body.vel.x - p.vel.x;
    const relz = body.vel.z - p.vel.z;
    const vn = relx * nx + relz * nz;
    if (vn < 0) {
      body.vel.x -= 2 * vn * nx * 0.55;
      body.vel.z -= 2 * vn * nz * 0.55;
    }
    // carry: bleed some of the player's momentum into the ball
    body.vel.x += p.vel.x * 0.55 * dt * 12;
    body.vel.z += p.vel.z * 0.55 * dt * 12;

    body.lastTouch = p;
    body.lastTouchTeam = p.team;
    touched = p;
    if (events.onTouch) events.onTouch(p, Math.abs(vn));
  }
  return touched;
}
