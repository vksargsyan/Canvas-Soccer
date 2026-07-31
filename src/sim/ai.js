// Team AI: formations, roles, marking, pressing, passing, shooting, goalkeeper.
//
//   createAI(ctx) -> {
//     update(dt), reset(), homeFor(agent), chaserOf(team), carrierOf(team),
//     bestSwitch(team, current), bestPass(agent), after(t, fn), FORMATION
//   }
//
// ctx: { agents, body, goals, rng, events }
// An "agent" is the sim-side record for a player:
//   { id, team, slot, role, isKeeper, pos, vel, yaw, down, control, anim, view, ... }
//
// `ai.match` is assigned by the integrator after construction; the AI reads the
// phase from it so it can stand still for dead balls instead of chasing a ball
// the rules have frozen.
//
// Design notes
// ------------
// * Nobody swarms. Exactly one presser (`chaser`) and one cover player per team
//   go near the ball; everyone else holds a role-specific slot derived from a
//   team shape that slides and compresses with the ball.
// * Everything is expressed in ATTACKING SPACE (u = x * teamDir), so the same
//   numbers describe both teams. u = -30 is your own goal line, u = +30 theirs.
// * Kicks are deferred by `animator.contactDelay` so the boot visibly meets the
//   ball instead of the ball leaving four frames before the strike.
// * Every decision is a pure function of the fixed-step state + the seeded RNG,
//   so a replay from the same seed produces the same frame.

import * as THREE from 'three';
import {
  HALF_W, HALF_D, GOAL_HALF_W, GOAL_H, RUN_SPEED, SPRINT_SPEED, KEEPER_SPEED,
  ACCEL, PLAYER_R, BALL_R, TEAMS, BOX_W, BOX_D, SIX_W,
} from '../core/constants.js';

// 2-2-1 in attacking space: +X is the direction this team attacks.
// slot 0 is always the keeper — the integrator indexes agents as team*6 + slot.
export const FORMATION = [
  { role: 'GK', line: 0, x: -27.0, z: 0.0 },
  { role: 'LB', line: 1, x: -16.0, z: -8.0 },
  { role: 'RB', line: 1, x: -16.0, z: 8.0 },
  { role: 'LM', line: 2, x: -3.0, z: -11.0 },
  { role: 'RM', line: 2, x: -3.0, z: 11.0 },
  { role: 'ST', line: 3, x: 9.0, z: 0.0 },
];

// Kickoff pictures, also in attacking space. The side taking the kick puts a
// striker on the ball with a midfielder square to him; the side receiving sits
// behind the halfway line. Clamping the ordinary formation into a half instead
// piles three defenders onto the centre spot, which hands them the kickoff.
export const KICKOFF_ATTACK = [
  { x: -27.0, z: 0.0 }, { x: -17.0, z: -8.0 }, { x: -17.0, z: 8.0 },
  { x: -8.0, z: -8.5 }, { x: -8.0, z: 8.5 }, { x: -1.3, z: 0.5 },
];
export const KICKOFF_DEFEND = [
  { x: -27.0, z: 0.0 }, { x: -19.0, z: -8.0 }, { x: -19.0, z: 8.0 },
  { x: -10.0, z: -9.5 }, { x: -10.0, z: 9.5 }, { x: -4.5, z: 0.0 },
];

// Per-slot competence. Deterministic (no RNG) so shape never depends on stream
// position. Drives reaction lag, pass weighting error and shot accuracy.
const SKILL = [0.86, 0.74, 0.74, 0.80, 0.80, 0.88];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

const BOX_X = BOX_W;            // penalty area depth from the goal line
const BOX_HZ = BOX_D / 2;       // penalty area half-width
const CARRY_R = PLAYER_R + BALL_R + 0.42;

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();

export function createAI(ctx) {
  const { agents, body, goals } = ctx;
  const rng = ctx.rng;
  const events = ctx.events || {};

  const home = new THREE.Vector3();
  const api = {};                 // returned; `api.match` is set by the integrator

  // Behaviour counters — not gameplay, but the only way to tell whether the AI
  // is actually doing football things without watching it for ten minutes.
  const stats = {
    shots: 0, passes: 0, clears: 0, headers: 0, tackles: 0,
    dives: 0, saves: 0, catches: 0, parries: 0, smothers: 0, distributions: 0,
  };

  // ---- deferred actions ----------------------------------------------------
  // A kick scheduled here lands on the animation's contact frame.
  const pending = [];
  function after(t, fn) { pending.push({ t, fn }); }
  function tickPending(dt) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      p.t -= dt;
      if (p.t <= 0) { pending.splice(i, 1); p.fn(); }
    }
  }
  function clearPending() { pending.length = 0; }

  // ---- per-team scratch ----------------------------------------------------
  const side = [makeSide(0), makeSide(1)];
  function makeSide(t) {
    return {
      team: t,
      chaser: null,
      cover: null,
      hasBall: false,        // this team is in possession
      think: 0,              // marking-assignment cooldown
      marks: new Map(),      // defender agent -> opponent agent
      runner: 0,             // round-robin index for off-ball run evaluation
    };
  }

  let carrier = null;        // the single agent currently in control of the ball
  let holder = null;         // keeper holding the ball in his hands

  // ---- geometry helpers ----------------------------------------------------
  function attackX(team) { return TEAMS[team].dir * HALF_W; }   // goal they attack
  function ownX(team) { return -TEAMS[team].dir * HALF_W; }     // goal they defend
  function toU(team, x) { return x * TEAMS[team].dir; }         // world X -> attacking space
  function toX(team, u) { return u * TEAMS[team].dir; }

  function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
  function distTo(a, x, z) { return Math.hypot(a.pos.x - x, a.pos.z - z); }
  function distToBall(a) { return Math.hypot(body.pos.x - a.pos.x, body.pos.z - a.pos.z); }

  /** shortest distance from point p to segment a->b, or Infinity if p is not beside it */
  function laneOffset(ax, az, bx, bz, px, pz) {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) return Infinity;
    const t = ((px - ax) * dx + (pz - az) * dz) / len2;
    if (t < 0.04 || t > 1.02) return Infinity;
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  }

  /** how many opponents are inside `r` of an agent */
  function pressure(a, r = 3.0) {
    let n = 0;
    for (const o of agents) {
      if (o.team === a.team || o.down) continue;
      if (dist2(o.pos.x, o.pos.z, a.pos.x, a.pos.z) < r * r) n++;
    }
    return n;
  }

  /** free space around a point: distance to the nearest opponent of `team` */
  function openness(team, x, z) {
    let best = 40;
    for (const o of agents) {
      if (o.team === team || o.down) continue;
      const d = Math.hypot(o.pos.x - x, o.pos.z - z);
      if (d < best) best = d;
    }
    return best;
  }

  /** where the ball will be in `t` seconds (roll/flight approximation) */
  function predictBall(t, out) {
    const decay = body.grounded ? 1.35 : 0.28;    // 1/s velocity bleed
    const k = t < 1e-4 ? t : (1 - Math.exp(-decay * t)) / decay;
    out.set(body.pos.x + body.vel.x * k, 0, body.pos.z + body.vel.z * k);
    return out;
  }

  /** iterate to the point where `a` running at `speed` can meet the ball */
  function interceptPoint(a, speed, out) {
    let t = 0;
    for (let i = 0; i < 4; i++) {
      predictBall(t, out);
      t = clamp(Math.hypot(out.x - a.pos.x, out.z - a.pos.z) / Math.max(1, speed), 0, 1.8);
    }
    return predictBall(t, out);
  }

  // ---- steering ------------------------------------------------------------
  function seek(a, tx, tz, dt, speed, slack = 0.08) {
    const dx = tx - a.pos.x, dz = tz - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < slack) { a.vel.multiplyScalar(Math.max(0, 1 - 9 * dt)); return 0; }
    const nx = dx / d, nz = dz / d;
    const want = Math.min(speed, d * 3.4 + 1.2);
    a.vel.x += (nx * want - a.vel.x) * Math.min(1, ACCEL * dt / Math.max(1, want));
    a.vel.z += (nz * want - a.vel.z) * Math.min(1, ACCEL * dt / Math.max(1, want));
    return d;
  }

  function brake(a, dt, k = 8) { a.vel.multiplyScalar(Math.max(0, 1 - k * dt)); }

  function face(a, x, z) {
    const dx = x - a.pos.x, dz = z - a.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    a.faceX = dx / d; a.faceZ = dz / d;
  }

  /** locomotion animation for an agent that is not doing anything special */
  function locomote(a, moving, sprinting) {
    if (!a.anim || a.anim.busy) return;
    if (a.hasBall) { if (a.anim.current !== 'dribble') a.anim.play('dribble'); return; }
    a.anim.play(moving ? (sprinting ? 'sprint' : 'run') : 'idle');
  }

  // ---- striking the ball ---------------------------------------------------
  // Start the animation now; apply the impulse on the contact frame. `aim` is
  // re-evaluated at contact time so the strike uses live geometry.
  function strike(a, state, foot, aim) {
    const anim = a.anim;
    let delay = 0.07;
    if (anim) {
      anim.play(state, { foot, force: true });
      delay = state === 'kick' ? anim.contactDelay
        : state === 'pass' ? anim.passContactDelay
          : state === 'header' ? 0.26
            : state === 'throwIn' ? 0.52 : 0.07;
    }
    a.kickLock = delay + 0.05;
    a.cool = Math.max(a.cool || 0, delay + 0.22);
    after(delay, () => { a.kickLock = 0; aim(); });
  }

  /** apply skill-scaled aim error, in metres at the target */
  function wobble(a, spread) {
    const s = SKILL[a.slot] ?? 0.8;
    return rng.gauss() * spread * (1.25 - s);
  }

  // -------------------------------------------------------------------------
  // team-level bookkeeping
  // -------------------------------------------------------------------------
  function pickCarrier() {
    carrier = null;
    if (holder) return;
    let bd = CARRY_R;
    if (body.pos.y > 1.35) return;
    for (const a of agents) {
      if (a.down) continue;
      const d = distToBall(a);
      if (d < bd) { bd = d; carrier = a; }
    }
  }

  function pickChasers() {
    for (let t = 0; t < 2; t++) {
      const s = side[t];
      let best = null, bd = 1e9, second = null, sd = 1e9;
      for (const a of agents) {
        if (a.team !== t || a.isKeeper || a.down) continue;
        // The human's player is driven by the stick, so he is never counted as
        // the AI presser — otherwise a stationary human leaves his side with
        // nobody closing the ball down.
        if (a.control === 'user') continue;
        // cost = time to reach the intercept point, with hysteresis for the
        // incumbent so the roles do not flicker between two equidistant players
        interceptPoint(a, SPRINT_SPEED, _v);
        let c = Math.hypot(_v.x - a.pos.x, _v.z - a.pos.z);
        if (a === s.chaser) c -= 2.6;
        if (a === carrier) c -= 6.0;
        if (c < bd) { sd = bd; second = best; bd = c; best = a; } else if (c < sd) { sd = c; second = a; }
      }
      s.chaser = best;
      s.cover = second;
    }
  }

  function updatePossession() {
    const t = body.lastTouchTeam;
    for (let i = 0; i < 2; i++) side[i].hasBall = false;
    if (carrier) { side[carrier.team].hasBall = true; return; }
    if (holder) { side[holder.team].hasBall = true; return; }
    if (t >= 0) side[t].hasBall = true;
  }

  /** greedy man-marking for the team without the ball */
  function assignMarks(t) {
    const s = side[t];
    s.marks.clear();
    const opp = agents.filter((o) => o.team !== t && !o.isKeeper && !o.down);
    const def = agents.filter((a) => a.team === t && !a.isKeeper && !a.down && a !== s.chaser);
    if (!opp.length || !def.length) return;
    const dir = TEAMS[t].dir;
    // Sort threats by how advanced they are toward our goal, then hand each to
    // the nearest unused defender.
    opp.sort((p, q) => toU(t, p.pos.x) - toU(t, q.pos.x));
    const used = new Set();
    for (const o of opp) {
      let best = null, bd = 1e9;
      for (const d of def) {
        if (used.has(d)) continue;
        // prefer the defender already on that side of the pitch
        const c = Math.hypot(d.pos.x - o.pos.x, d.pos.z - o.pos.z) + Math.abs(d.pos.z - o.pos.z) * 0.5;
        if (c < bd) { bd = c; best = d; }
      }
      if (!best) break;
      used.add(best);
      s.marks.set(best, o);
    }
  }

  // -------------------------------------------------------------------------
  // formation / off-ball positioning
  // -------------------------------------------------------------------------
  /**
   * Role slot in world space. Everything is computed in attacking space and
   * mapped back, so the two teams share one set of numbers.
   */
  function homeFor(a) {
    const t = a.team;
    const dir = TEAMS[t].dir;
    const f = FORMATION[a.slot] || FORMATION[0];
    if (a.isKeeper) { home.set(toX(t, f.x), 0, 0); return home; }

    const s = side[t];
    const bu = toU(t, body.pos.x);        // ball position in attacking space
    const bz = body.pos.z;
    const att = s.hasBall;

    // Lateral compression: the block slides toward the ball but keeps its width.
    // Sliding too hard is what turns a 2-2-1 into a five-man huddle.
    const zSlide = clamp(bz * (att ? 0.30 : 0.42), -6, 6);
    const zSquash = att ? 0.95 : 0.82;

    let u, z = f.z * zSquash + zSlide;

    if (f.line === 1) {
      // Back pair: one line, goal-side of the ball, never dragged past it.
      u = clamp(bu + (att ? -15 : -12), -25, att ? 3 : -2);
      // when the ball is wide, the far full-back tucks in to cover the middle
      const wideSide = Math.sign(bz) || 1;
      if (Math.sign(f.z) !== wideSide) z = lerp(z, bz * 0.20, 0.45);
    } else if (f.line === 2) {
      // Midfield: supports the ball, one on each flank, ahead of the back line.
      u = clamp(bu + (att ? -2 : -3), -20, att ? 17 : 9);
      // the ball-side midfielder pushes wide to give an outlet, the far one tucks
      const wideSide = Math.sign(bz) || 1;
      if (Math.sign(f.z) === wideSide) z = clamp(bz + wideSide * 6.5, -HALF_D + 3, HALF_D - 3);
      else z = lerp(z, -wideSide * 6.0, 0.5);
    } else {
      // Striker: stays high as the outlet, and when we have the ball he runs
      // into the emptiest channel ahead of it.
      u = clamp(bu + (att ? 10 : 8), -6, 26);
      if (att) z = runChannel(a, toX(t, u));
      else z = clamp(bz * 0.35, -10, 10);
    }

    // Never let the whole block leave the pitch, and keep a keeper-safe gap.
    const x = clamp(toX(t, u), -HALF_W + 2.5, HALF_W - 2.5);
    home.set(x, 0, clamp(z, -HALF_D + 2.2, HALF_D - 2.2));
    return home;
  }

  /**
   * Off-ball run: pick the emptiest of a handful of channels ahead of the ball.
   * Evaluated for one player per team per frame (round robin) — 12 agents at
   * 60 Hz means every runner is re-evaluated ~10x/second, which is plenty.
   */
  const CHANNELS = [-11, -6.5, -2, 2, 6.5, 11];
  function runChannel(a, x) {
    const s = side[a.team];
    if (s.runner !== a.slot) return a.runZ ?? 0;
    let best = a.runZ ?? 0, bs = -1e9;
    for (const cz of CHANNELS) {
      const z = clamp(cz + body.pos.z * 0.25, -HALF_D + 3, HALF_D - 3);
      const open = Math.min(openness(a.team, x, z), 12);
      // reward space and a shootable angle, penalise a long lateral scramble
      const angle = 1 - Math.abs(z) / 22;
      const move = Math.abs(z - a.pos.z);
      const sc = open * 1.0 + angle * 6 - move * 0.28;
      if (sc > bs) { bs = sc; best = z; }
    }
    a.runZ = best;
    return best;
  }

  function markTarget(a, out) {
    const s = side[a.team];
    const o = s.marks.get(a);
    if (!o) return null;
    const gx = ownX(a.team), gz = 0;
    const dx = gx - o.pos.x, dz = gz - o.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    // stand 1.7 m goal-side of the man, and half a stride ahead of his run
    out.set(
      o.pos.x + (dx / d) * 1.7 + o.vel.x * 0.18,
      0,
      o.pos.z + (dz / d) * 1.7 + o.vel.z * 0.18,
    );
    return out;
  }

  // -------------------------------------------------------------------------
  // on-ball decisions
  // -------------------------------------------------------------------------
  /** best aim point in the goal mouth + a 0..1 quality, accounting for blockers */
  const AIMS = [-3.2, -1.9, -0.6, 0.6, 1.9, 3.2];
  function shotLook(a) {
    const gx = attackX(a.team);
    const d = Math.hypot(gx - a.pos.x, -a.pos.z);
    let bestZ = 0, bs = -1e9;
    for (const az of AIMS) {
      let clear = 4.0;
      for (const o of agents) {
        if (o.team === a.team || o.down) continue;
        const off = laneOffset(a.pos.x, a.pos.z, gx, az, o.pos.x, o.pos.z);
        // a keeper covers more ground than his collision radius
        const w = o.isKeeper ? 1.5 : 0.95;
        if (off < clear + w) clear = Math.min(clear, Math.max(0, off - w));
      }
      // central aims are easier but more coverable; corners are worth more
      const sc = clear * 2.2 + Math.abs(az) * 0.35;
      if (sc > bs) { bs = sc; bestZ = az; }
    }
    let clear = 4.0;
    for (const o of agents) {
      if (o.team === a.team || o.down) continue;
      const off = laneOffset(a.pos.x, a.pos.z, gx, bestZ, o.pos.x, o.pos.z);
      const w = o.isKeeper ? 1.5 : 0.95;
      if (off < clear) clear = Math.max(0, off - w);
    }
    // quality: near + open + not from an impossible angle. Range dominates, so
    // the AI does not fire hopefully from 26 m every time the lane is clean.
    const range = clamp(1 - (d - 6) / 20, 0, 1);
    const lane = clamp(clear / 2.2, 0, 1);
    const angle = clamp(1 - (Math.abs(a.pos.z) - 4) / 15, 0, 1);
    return { z: bestZ, dist: d, q: range * 0.55 + lane * 0.30 + angle * 0.15 };
  }

  /** best pass: openness of the lane, of the receiver, and progression */
  function bestPass(a, opts = {}) {
    const t = a.team;
    const dir = TEAMS[t].dir;
    const minD = opts.minDist ?? 3.5;
    const maxD = opts.maxDist ?? 30;
    let best = null, bs = opts.floor ?? -2;
    for (const m of agents) {
      if (m === a || m.team !== t || m.down) continue;
      if (m.isKeeper && !opts.allowKeeper) continue;
      const lead = clamp(Math.hypot(m.pos.x - a.pos.x, m.pos.z - a.pos.z) / 16, 0.12, 0.5);
      const tx = m.pos.x + m.vel.x * lead;
      const tz = m.pos.z + m.vel.z * lead;
      const d = Math.hypot(tx - a.pos.x, tz - a.pos.z);
      if (d < minD || d > maxD) continue;

      // lane must be clean
      let block = 0;
      for (const o of agents) {
        if (o.team === t || o.down) continue;
        const off = laneOffset(a.pos.x, a.pos.z, tx, tz, o.pos.x, o.pos.z);
        if (off < 2.4) block += (2.4 - off) * (o.isKeeper ? 1.4 : 1.0);
      }
      const space = Math.min(openness(t, tx, tz), 10);
      const gain = (toU(t, tx) - toU(t, a.pos.x));      // metres of progress
      let sc = gain * 0.42 + space * 0.85 - d * 0.13 - block * 5.0;
      // do not pass into our own box
      if (toU(t, tx) < -20 && Math.abs(tz) < BOX_HZ) sc -= 8;
      sc += wobble(a, 2.2);
      if (sc > bs) { bs = sc; best = m; _aim.set(tx, 0, tz); }
    }
    return best ? { mate: best, x: _aim.x, z: _aim.z, score: bs } : null;
  }

  function doShoot(a, look) {
    const gx = attackX(a.team);
    const foot = a.pos.z > look.z ? -1 : 1;
    stats.shots++;
    strike(a, 'kick', foot, () => {
      // aim error grows with range, so long-range efforts miss the way they should
      const az = look.z + wobble(a, 1.4 + look.dist * 0.075);
      _v.set(gx - a.pos.x, 0, az - a.pos.z);
      const d = _v.length();
      const power = clamp(19 + d * 0.60, 20, 33);
      // a shot from range is lifted so it arrives in the air; close range is driven
      const lift = clamp(2.2 + d * 0.09, 1.6, 4.4) * (look.q > 0.6 ? 0.7 : 1.0);
      const curl = clamp(-az * 0.9, -7, 7) + wobble(a, 3);
      body.kick(_v, power, lift, curl);
      body.lastTouch = a; body.lastTouchTeam = a.team;
      if (events.onShot) events.onShot(a, power);
    });
    face(a, gx, look.z);
  }

  function doPass(a, p, opts = {}) {
    stats.passes++;
    const foot = p.z > a.pos.z ? 1 : -1;
    strike(a, 'pass', foot, () => {
      const ex = p.x + wobble(a, 1.6), ez = p.z + wobble(a, 1.6);
      _v.set(ex - a.pos.x, 0, ez - a.pos.z);
      const d = _v.length();
      // chip over a crowded lane, drill it along the deck otherwise
      const lofted = !!opts.loft || d > 16;
      const power = lofted ? clamp(d * 1.02, 11, 26) : clamp(d * 1.30 + 2.5, 9, 25);
      body.kick(_v, power, lofted ? clamp(d * 0.22, 2.6, 5.4) : 0.35, 0);
      body.lastTouch = a; body.lastTouchTeam = a.team;
      if (events.onPass) events.onPass(a, p.mate);
    });
    face(a, p.x, p.z);
  }

  function doClear(a) {
    stats.clears++;
    const dir = TEAMS[a.team].dir;
    // hoof it upfield and toward the nearer touchline, away from our own goal
    const wide = (Math.sign(a.pos.z) || rng.sign()) * 9;
    strike(a, 'kick', rng.sign(), () => {
      _v.set(dir * 22, 0, wide - a.pos.z);
      body.kick(_v, 28, 6.2, 0);
      body.lastTouch = a; body.lastTouchTeam = a.team;
      if (events.onShot) events.onShot(a, 22);
    });
    face(a, a.pos.x + dir * 6, wide);
  }

  /**
   * Carry the ball: steer into space toward goal, nudging it ahead with small
   * touches. The steering samples fan directions and avoids the nearest cover.
   */
  const FAN = [-0.85, -0.5, -0.22, 0, 0.22, 0.5, 0.85];
  function doDribble(a, dt) {
    const dir = TEAMS[a.team].dir;
    const gx = attackX(a.team);
    let bx = 0, bz = 0, bs = -1e9;
    const base = Math.atan2(0 - a.pos.z, gx - a.pos.x);
    for (const off of FAN) {
      const ang = base + off;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const px = a.pos.x + dx * 4.5, pz = a.pos.z + dz * 4.5;
      if (Math.abs(px) > HALF_W - 1.5 || Math.abs(pz) > HALF_D - 1.5) continue;
      const open = Math.min(openness(a.team, px, pz), 9);
      const gain = (toU(a.team, px) - toU(a.team, a.pos.x));
      const sc = open * 1.1 + gain * 0.9 - Math.abs(off) * 1.6;
      if (sc > bs) { bs = sc; bx = px; bz = pz; }
    }
    if (bs <= -1e9) { bx = a.pos.x + dir * 4; bz = a.pos.z; }

    const press = pressure(a, 3.2);
    const sp = press ? RUN_SPEED * 1.02 : SPRINT_SPEED * 0.90;
    seek(a, bx, bz, dt, sp);
    face(a, bx, bz);

    // push the ball into the running lane so it stays a stride ahead
    const ahead = Math.hypot(body.pos.x - a.pos.x, body.pos.z - a.pos.z);
    if (ahead < CARRY_R * 0.95 && (a.touchCool || 0) <= 0) {
      a.touchCool = 0.30;
      _v.set(bx - a.pos.x, 0, bz - a.pos.z);
      body.kick(_v, RUN_SPEED * (press ? 0.86 : 1.06), 0, 0);
      body.lastTouch = a; body.lastTouchTeam = a.team;
      if (a.anim) a.anim.play('dribble', { force: true });
    }
    a.touchCool = Math.max(0, (a.touchCool || 0) - dt);
  }

  /** ball above knee height and close: head it */
  function tryHeader(a) {
    if (body.pos.y < 1.25 || body.pos.y > 2.6) return false;
    if (distToBall(a) > 1.5) return false;
    if ((a.cool || 0) > 0) return false;
    const dir = TEAMS[a.team].dir;
    const look = shotLook(a);
    const attacking = toU(a.team, a.pos.x) > 12;
    stats.headers++;
    strike(a, 'header', 1, () => {
      if (attacking && look.q > 0.34) {
        _v.set(attackX(a.team) - a.pos.x, 0, look.z - a.pos.z);
        body.kick(_v, 20, 1.4, 0);
        if (events.onShot) events.onShot(a, 20);
      } else {
        _v.set(dir * 14, 0, (Math.sign(a.pos.z) || 1) * 6);
        body.kick(_v, 17, 4.0, 0);
        if (events.onPass) events.onPass(a, a);
      }
      body.lastTouch = a; body.lastTouchTeam = a.team;
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // outfield update
  // -------------------------------------------------------------------------
  function updateOutfield(a, dt) {
    const t = a.team;
    const s = side[t];
    const dir = TEAMS[t].dir;
    const u = toU(t, a.pos.x);
    const d = distToBall(a);

    a.cool = Math.max(0, (a.cool || 0) - dt);
    a.touchCool = Math.max(0, (a.touchCool || 0) - dt);

    // mid-strike: plant and hold the aim, do not run out from under the ball
    if ((a.kickLock || 0) > 0) {
      a.kickLock -= dt;
      brake(a, dt, 11);
      return;
    }

    // ---------------- on the ball ----------------
    if (a === carrier) {
      a.hasBall = true;
      if (a.cool <= 0) {
        const look = shotLook(a);
        const press = pressure(a, 3.0);
        const deep = u < -12;

        // clear the danger first
        if (deep && press >= 1) {
          const out = bestPass(a, { minDist: 5, maxDist: 24, floor: 2.5 });
          if (out) { doPass(a, out, { loft: true }); return; }
          doClear(a);
          return;
        }
        // shoot when the picture is good
        if (look.q > 0.60 && look.dist < 24) { doShoot(a, look); return; }
        // a snap effort when pressed inside range
        if (look.q > 0.44 && look.dist < 15 && press >= 1) { doShoot(a, look); return; }

        // pass under pressure, or when a clearly better option exists
        const p = bestPass(a);
        if (p) {
          const solo = pressure(a, 3.6);
          const need = solo >= 2 ? 0 : solo >= 1 ? 3.5 : 9.0;
          if (p.score > need) { doPass(a, p); return; }
        }
      }
      doDribble(a, dt);
      return;
    }
    a.hasBall = false;

    // ---------------- loose ball in the air ----------------
    if (d < 1.6 && tryHeader(a)) return;

    // ---------------- pressing / intercepting ----------------
    if (a === s.chaser) {
      interceptPoint(a, SPRINT_SPEED, _v);
      const far = Math.hypot(_v.x - a.pos.x, _v.z - a.pos.z);
      const sp = far > 4.5 ? SPRINT_SPEED : RUN_SPEED * 1.05;
      // when an opponent is carrying, approach on the goal side rather than
      // running through his back
      let tx = clamp(_v.x, -HALF_W - 1, HALF_W + 1);
      let tz = clamp(_v.z, -HALF_D - 1, HALF_D - 1);
      if (carrier && carrier.team !== t && d > 1.6) {
        const gx = ownX(t);
        const ax = gx - carrier.pos.x, az = -carrier.pos.z;
        const al = Math.hypot(ax, az) || 1;
        tx = carrier.pos.x + (ax / al) * 0.9;
        tz = carrier.pos.z + (az / al) * 0.9;
      }
      seek(a, tx, tz, dt, sp);
      locomote(a, true, far > 4.5);

      // slide tackle: only from behind/beside a real carrier, never a wild lunge
      if (carrier && carrier.team !== t && d < 2.3 && a.cool <= 0) {
        const closing = (a.vel.x * (carrier.pos.x - a.pos.x) + a.vel.z * (carrier.pos.z - a.pos.z)) > 0;
        const chance = dt * (2.4 * (SKILL[a.slot] ?? 0.8)) * (closing ? 1 : 0.3);
        if (rng.chance(chance)) {
          a.cool = 1.35;
          stats.tackles++;
          if (a.anim) a.anim.play('tackle', { force: true });
          if (events.onTackle) events.onTackle(a);
        }
      }
      return;
    }

    // ---------------- cover: second man, goal side of the presser ----------------
    if (a === s.cover && !s.hasBall) {
      const gx = ownX(t);
      const bx = body.pos.x, bz = body.pos.z;
      const ax = gx - bx, az = -bz;
      const al = Math.hypot(ax, az) || 1;
      const cx = bx + (ax / al) * 4.6;
      const cz = bz + (az / al) * 4.6;
      const dd = seek(a, clamp(cx, -HALF_W + 2, HALF_W - 2), clamp(cz, -HALF_D + 2, HALF_D - 2), dt, RUN_SPEED);
      face(a, bx, bz);
      locomote(a, dd > 1.0, dd > 7);
      return;
    }

    // ---------------- marking (defending) ----------------
    if (!s.hasBall) {
      const m = markTarget(a, _v);
      if (m) {
        const h = homeFor(a);
        // deep in our own half marking dominates; up the pitch shape dominates
        const bu = toU(t, body.pos.x);
        const w = clamp((-bu + 4) / 24, 0.15, 0.85);
        const tx = lerp(h.x, m.x, w);
        const tz = lerp(h.z, m.z, w);
        const dd = seek(a, tx, tz, dt, RUN_SPEED * 0.95);
        const opp = s.marks.get(a);
        if (opp) face(a, opp.pos.x, opp.pos.z); else face(a, body.pos.x, body.pos.z);
        locomote(a, dd > 0.9, dd > 8);
        return;
      }
    }

    // ---------------- shape / off-ball run ----------------
    const h = homeFor(a);
    const dd = seek(a, h.x, h.z, dt, s.hasBall ? RUN_SPEED * 0.95 : RUN_SPEED * 0.82, 0.5);
    if (s.hasBall) face(a, body.pos.x, body.pos.z);
    else face(a, body.pos.x, body.pos.z);
    locomote(a, dd > 0.9, dd > 9);
  }

  // -------------------------------------------------------------------------
  // goalkeeper
  // -------------------------------------------------------------------------
  //  * stands on the bisector of the ball and the goal centre, depth scaled by
  //    how far out the ball is
  //  * reacts to a shot after a delay set by shot speed and range, then dives
  //  * catches a soft/central ball, parries a hard or wide one
  //  * comes off the line to smother a through ball
  //  * holds, then distributes to the best outlet
  function updateKeeper(a, dt) {
    const t = a.team;
    const gx = ownX(t);
    const s = Math.sign(gx) || 1;         // +1 when this keeper defends the +X goal

    a.cool = Math.max(0, (a.cool || 0) - dt);
    a.reactT = Math.max(0, (a.reactT || 0) - dt);
    a.diveT = Math.max(0, (a.diveT || 0) - dt);

    // ---- holding the ball ------------------------------------------------
    if (a.hold > 0) {
      a.hold -= dt;
      holder = a;
      const hx = a.pos.x - s * 0.55;
      body.place(hx, 1.05, a.pos.z);
      body.lastTouch = a; body.lastTouchTeam = t;
      a.diving = false;
      // walk back toward the middle of the goal while holding
      seek(a, gx - s * 1.8, clamp(a.pos.z * 0.6, -2.5, 2.5), dt, KEEPER_SPEED * 0.55);
      if (a.anim && !a.anim.busy && a.anim.current !== 'keeperCatch') a.anim.play('keeperIdle');
      a.faceX = -s; a.faceZ = 0;
      if (a.hold <= 0) distribute(a);
      return;
    }

    if ((a.kickLock || 0) > 0) { a.kickLock -= dt; brake(a, dt, 12); return; }

    const bx = body.pos.x, bz = body.pos.z, by = body.pos.y;
    const toGoal = Math.abs(bx - gx);
    const closing = body.vel.x * s;        // >0 means the ball is coming at us

    // ---- shot detection + reaction lag -----------------------------------
    if (body.kickId !== a.sawKick) {
      a.sawKick = body.kickId;
      if (closing > 6 && toGoal < 30) {
        const speed = Math.hypot(body.vel.x, body.vel.z);
        // a rocket from close range leaves less time; the keeper's own reaction
        // shortens with danger but never gets to zero
        const react = clamp(0.30 - speed * 0.0055 - (24 - toGoal) * 0.004, 0.055, 0.26)
          * (1.35 - (SKILL[a.slot] ?? 0.85));
        a.reactT = react;
        a.shotLive = true;
      }
    }
    if (closing < 2) a.shotLive = false;

    // ---- where the shot crosses the line ---------------------------------
    let onTarget = false, zHit = 0, yHit = 0, tHit = 9;
    if (closing > 4) {
      tHit = (gx - bx) / body.vel.x;
      if (tHit > 0 && tHit < 1.6) {
        zHit = bz + body.vel.z * tHit;
        yHit = by + body.vel.y * tHit - 10.25 * tHit * tHit;
        onTarget = Math.abs(zHit) < GOAL_HALF_W + 1.0 && yHit < GOAL_H + 0.4 && yHit > -0.4;
      }
    }

    // ---- save resolution --------------------------------------------------
    // hands reach out along the dive as it develops
    const ext = a.diving ? clamp(a.diveAge / 0.30, 0, 1) * 2.0 : 0;
    const handZ = a.pos.z + (a.diveDir || 0) * ext;
    const handY = a.diving ? clamp(a.diveHigh ? 1.9 : 0.75, 0, 2.4) : 1.05;
    const reach = a.diving ? 0.95 : 0.85;
    const nearHands = Math.hypot(bx - a.pos.x, bz - handZ) < reach + BALL_R + 0.45
      && Math.abs(by - handY) < 1.15;
    if (a.diving) a.diveAge = (a.diveAge || 0) + dt;

    if (nearHands && a.cool <= 0 && Math.abs(bx - gx) < 5.5) {
      const speed = Math.hypot(body.vel.x, body.vel.y, body.vel.z);
      const central = Math.abs(bz - a.pos.z) < 1.1;
      if (speed < 21 && central && by < 2.1) {
        // clean catch
        a.hold = 1.15;
        a.cool = 1.4;
        a.diving = false;
        holder = a;
        body.place(a.pos.x - s * 0.55, 1.05, a.pos.z);
        body.lastTouch = a; body.lastTouchTeam = t;
        stats.saves++; stats.catches++;
        if (a.anim) a.anim.play('keeperCatch', { force: true });
        if (events.onKeeperSave) events.onKeeperSave(a, 'catch');
        return;
      }
      // parry: push it wide and up, away from the goal mouth
      const away = (Math.sign(bz - 0) || rng.sign());
      _v.set(-s * 1.0, 0, away * 1.25);
      body.kick(_v, clamp(speed * 0.45, 7, 15), 3.4, 0);
      body.lastTouch = a; body.lastTouchTeam = t;
      a.cool = 0.7;
      stats.saves++; stats.parries++;
      if (a.anim && a.anim.current !== 'keeperDive') a.anim.play('keeperDive', { dir: away, force: true });
      if (events.onKeeperSave) events.onKeeperSave(a, 'parry');
      return;
    }

    // ---- dive decision ----------------------------------------------------
    if (onTarget && a.reactT <= 0 && !a.diving && a.cool <= 0 && tHit < 0.85) {
      const lateral = zHit - a.pos.z;
      if (Math.abs(lateral) > 0.55 || yHit > 1.5) {
        a.diving = true;
        a.diveAge = 0;
        a.diveDir = Math.sign(lateral) || 1;
        a.diveHigh = yHit > 1.5;
        a.diveTarget = clamp(zHit, -GOAL_HALF_W - 0.9, GOAL_HALF_W + 0.9);
        a.cool = 0.9;
        stats.dives++;
        if (a.anim) a.anim.play('keeperDive', { dir: a.diveDir, force: true });
        if (events.onKeeperDive) events.onKeeperDive(a);
      }
    }
    if (a.diving) {
      // travel along the dive; the animation owns the pose, the sim owns the slide
      seek(a, gx - s * 1.1, a.diveTarget, dt, KEEPER_SPEED * 2.2, 0.05);
      if (a.anim && !a.anim.busy) { a.diving = false; a.diveAge = 0; }
      a.faceX = -s; a.faceZ = 0;
      return;
    }

    // ---- sweeping: come out to smother -----------------------------------
    let rush = false;
    if (toGoal < 13 && Math.abs(bz) < BOX_HZ - 1 && by < 1.4) {
      // only if no defender of ours will get there first
      let mineNear = 1e9, theirsNear = 1e9;
      for (const o of agents) {
        if (o.down || o.isKeeper) continue;
        const dd = Math.hypot(o.pos.x - bx, o.pos.z - bz);
        if (o.team === t) mineNear = Math.min(mineNear, dd);
        else theirsNear = Math.min(theirsNear, dd);
      }
      const mine = Math.hypot(a.pos.x - bx, a.pos.z - bz);
      rush = theirsNear < mineNear - 0.5 && mine < theirsNear + 3.5 && mine < 9.5;
    }
    if (rush) {
      const dd = seek(a, bx, bz, dt, KEEPER_SPEED * 1.35);
      if (a.anim && !a.anim.busy) a.anim.play(dd > 1 ? 'run' : 'keeperIdle');
      a.faceX = -s; a.faceZ = 0;
      // smother a ball at his feet
      if (Math.hypot(a.pos.x - bx, a.pos.z - bz) < 1.0 && by < 0.9 && a.cool <= 0) {
        a.hold = 1.0; a.cool = 1.3; holder = a;
        stats.saves++; stats.smothers++;
        if (a.anim) a.anim.play('keeperCatch', { force: true });
        if (events.onKeeperSave) events.onKeeperSave(a, 'smother');
      }
      return;
    }

    // ---- angle-bisector line position ------------------------------------
    // stand on the segment from the goal centre to the ball, at a depth that
    // grows with range so a long shot meets a keeper who has cut the angle
    const vx = bx - gx, vz = bz - 0;
    const vl = Math.hypot(vx, vz) || 1;
    const depth = clamp(0.85 + (vl - 7) * 0.085, 0.7, 4.2);
    let px = gx + (vx / vl) * depth;
    let pz = (vz / vl) * depth * 1.55;
    // never wander outside the posts by more than a step
    pz = clamp(pz, -GOAL_HALF_W + 0.35, GOAL_HALF_W - 0.35);
    px = s > 0 ? Math.min(px, gx - 0.55) : Math.max(px, gx - 0.55 * s);
    if (s > 0) px = clamp(px, gx - BOX_X + 1.5, gx - 0.55);
    else px = clamp(px, gx + 0.55, gx + BOX_X - 1.5);

    const dd = seek(a, px, pz, dt, KEEPER_SPEED * (toGoal < 20 ? 1.0 : 0.65), 0.12);
    if (a.anim && !a.anim.busy) {
      if (a.anim.current !== 'keeperDive' && a.anim.current !== 'keeperCatch') {
        a.anim.play(dd > 0.55 ? 'run' : 'keeperIdle');
      }
    }
    a.faceX = -s; a.faceZ = 0;
  }

  /** keeper releases the ball: roll it to a full-back, or punt it long */
  function distribute(a) {
    stats.distributions++;
    const t = a.team;
    const dir = TEAMS[t].dir;
    holder = null;
    const p = bestPass(a, { minDist: 6, maxDist: 34, floor: -1e9 });
    const short = p && Math.hypot(p.x - a.pos.x, p.z - a.pos.z) < 17;
    if (short) {
      strike(a, 'throwIn', 1, () => {
        _v.set(p.x - a.pos.x, 0, p.z - a.pos.z);
        const d = _v.length();
        body.place(a.pos.x + dir * 0.5, 1.2, a.pos.z);
        body.kick(_v, clamp(d * 1.15, 9, 20), 1.6, 0);
        body.lastTouch = a; body.lastTouchTeam = t;
        if (events.onPass) events.onPass(a, p.mate);
      });
      face(a, p.x, p.z);
    } else {
      const tz = p ? p.z : (Math.sign(a.pos.z) || 1) * 8;
      const tx = p ? p.x : a.pos.x + dir * 26;
      strike(a, 'kick', 1, () => {
        body.place(a.pos.x + dir * 0.6, BALL_R, a.pos.z);
        _v.set(tx - a.pos.x, 0, tz - a.pos.z);
        body.kick(_v, 30, 7.0, 0);
        body.lastTouch = a; body.lastTouchTeam = t;
        if (events.onShot) events.onShot(a, 24);
      });
      face(a, tx, tz);
    }
  }

  // -------------------------------------------------------------------------
  // dead-ball behaviour (kickoff, throw-in, corner, goal kick, goal, halftime)
  // -------------------------------------------------------------------------
  /** where this agent should stand while the ball is out of play */
  function deadBallSpot(a, sp, out) {
    const t = a.team;
    const dir = TEAMS[t].dir;
    const f = FORMATION[a.slot] || FORMATION[0];

    if (a.isKeeper) {
      const gx = ownX(t);
      const s = Math.sign(gx) || 1;
      out.set(gx - s * (sp && sp.kind === 'goalkick' && sp.team === t ? 3.0 : 1.2), 0,
        clamp(body.pos.z * 0.25, -2.4, 2.4));
      return out;
    }

    if (!sp || sp.kind === 'kickoff') {
      const mine = sp ? sp.team === t : false;
      const k = (mine ? KICKOFF_ATTACK : KICKOFF_DEFEND)[a.slot] || KICKOFF_DEFEND[0];
      out.set(clamp(toX(t, k.x), -HALF_W + 2, HALF_W - 2), 0,
        clamp(k.z, -HALF_D + 2, HALF_D - 2));
      return out;
    }

    const bx = sp.x, bz = sp.z;
    const mine = sp.team === t;

    if (sp.kind === 'corner') {
      if (mine) {
        // three into the box, one at the edge for the cut-back
        if (f.line === 3) out.set(bx - dir * 4.5, 0, bz * 0.28);
        else if (f.line === 2) out.set(bx - dir * 7.0, 0, -Math.sign(bz) * 3.2 + f.z * 0.25);
        else out.set(bx - dir * 15.0, 0, f.z * 0.9);
      } else {
        // defend the six-yard box and the near post
        if (f.line === 1) out.set(bx + dir * 3.0, 0, Math.sign(f.z) * 2.6);
        else if (f.line === 2) out.set(bx + dir * 5.5, 0, Math.sign(bz) * 4.5 + f.z * 0.2);
        else out.set(bx + dir * 14.0, 0, 0);
      }
    } else if (sp.kind === 'throw') {
      const inward = -Math.sign(bz) || 1;
      if (mine) {
        if (f.line === 3) out.set(bx + dir * 7.5, 0, bz + inward * 3.0);
        else if (f.line === 2) out.set(bx + dir * 1.5, 0, bz + inward * 5.5);
        else out.set(bx - dir * 9.0, 0, f.z * 0.8);
      } else {
        if (f.line >= 2) out.set(bx - dir * 3.0, 0, bz + inward * 4.0);
        else out.set(bx - dir * 9.5, 0, f.z * 0.9);
      }
    } else { // goal kick
      if (mine) {
        if (f.line === 1) out.set(toX(t, -14), 0, f.z * 1.5);
        else if (f.line === 2) out.set(toX(t, 1), 0, f.z * 1.15);
        else out.set(toX(t, 14), 0, 0);
      } else {
        if (f.line === 1) out.set(toX(t, -6), 0, f.z * 1.2);
        else if (f.line === 2) out.set(toX(t, -14), 0, f.z * 1.0);
        else out.set(toX(t, -20), 0, 2.5);
      }
    }
    out.x = clamp(out.x, -HALF_W + 1.6, HALF_W - 1.6);
    out.z = clamp(out.z, -HALF_D + 1.6, HALF_D - 1.6);
    return out;
  }

  function updateDeadBall(dt, phase) {
    const m = api.match;
    const sp = m && m.state.setPiece && m.state.setPiece.kind ? m.state.setPiece : null;
    for (const a of agents) {
      if (a.control === 'user') continue;
      if (a.down) { brake(a, dt, 6); continue; }
      a.cool = Math.max(0, (a.cool || 0) - dt);
      a.hasBall = false;
      if ((a.kickLock || 0) > 0) { a.kickLock -= dt; brake(a, dt, 12); continue; }

      // whoever is taking it walks onto the ball
      if (sp && sp.taker === a) {
        const s = Math.sign(sp.z) || 1;
        const off = sp.kind === 'throw' ? s * 1.15 : 0;
        const dd = seek(a, sp.x - (sp.kind === 'goalkick' ? TEAMS[a.team].dir * 1.0 : 0), sp.z + off,
          dt, RUN_SPEED * 1.1, 0.18);
        face(a, sp.aimX ?? body.pos.x, sp.aimZ ?? body.pos.z);
        locomote(a, dd > 0.6, false);
        continue;
      }

      // celebrating after a goal: keep dancing, do not run drills
      if (phase === 'goal' && a.anim && a.anim.current === 'celebrate') { brake(a, dt, 5); continue; }

      const spot = deadBallSpot(a, sp, _v);
      const dd = seek(a, spot.x, spot.z, dt, RUN_SPEED * 0.7, 0.55);
      face(a, body.pos.x, body.pos.z);
      locomote(a, dd > 0.9, false);
    }
  }

  // -------------------------------------------------------------------------
  function update(dt) {
    tickPending(dt);

    const m = api.match;
    const phase = m ? m.state.phase : 'play';
    if (phase !== 'play') {
      // a keeper holding the ball into a dead phase must let go of it
      if (holder) { holder.hold = 0; holder = null; }
      updateDeadBall(dt, phase);
      return;
    }

    if (holder && !(holder.hold > 0)) holder = null;
    pickCarrier();
    updatePossession();
    pickChasers();

    for (let t = 0; t < 2; t++) {
      const s = side[t];
      s.think -= dt;
      if (s.think <= 0) {
        s.think = 0.22;
        s.runner = 1 + ((s.runner) % 5);      // slots 1..5, round robin
        if (!s.hasBall) assignMarks(t);
        else s.marks.clear();
      }
    }

    for (const a of agents) {
      if (a.down) { brake(a, dt, 6); a.hasBall = false; continue; }
      if (a.control === 'user') { a.hasBall = a === carrier; continue; }
      if (a.isKeeper) updateKeeper(a, dt);
      else updateOutfield(a, dt);
    }
  }

  // -------------------------------------------------------------------------
  function reset() {
    clearPending();
    carrier = null;
    holder = null;
    for (let t = 0; t < 2; t++) {
      const s = side[t];
      s.chaser = s.cover = null;
      s.marks.clear();
      s.think = 0;
      s.hasBall = false;
      s.runner = 1;
    }
    for (const a of agents) {
      a.cool = 0;
      a.touchCool = 0;
      a.kickLock = 0;
      a.diving = false;
      a.diveAge = 0;
      a.hold = 0;
      a.reactT = 0;
      a.shotLive = false;
      a.sawKick = body.kickId;
      a.hasBall = false;
      a.runZ = 0;
    }
  }

  /** the teammate a SWITCH press should hand control to */
  function bestSwitch(team, current) {
    let best = null, bs = -1e9;
    for (const a of agents) {
      if (a.team !== team || a.isKeeper || a.down || a === current) continue;
      const d = distToBall(a);
      // nearest to the ball, but prefer someone goal-side / already engaged
      const s = -d + (side[team].chaser === a ? 4 : 0)
        + (toU(team, a.pos.x) - toU(team, body.pos.x) > 0 ? 1.5 : 0);
      if (s > bs) { bs = s; best = a; }
    }
    return best;
  }

  Object.assign(api, {
    update, reset, homeFor, bestPass, bestSwitch, after, deadBallSpot, strike, seek, stats,
    chaserOf(t) { return side[t].chaser; },
    coverOf(t) { return side[t].cover; },
    carrierOf(t) { return carrier && carrier.team === t ? carrier : null; },
    get carrier() { return carrier; },
    get holder() { return holder; },
    FORMATION,
  });
  reset();
  return api;
}
