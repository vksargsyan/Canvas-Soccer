// Objective gameplay metrics harness.
//
//   import { createGameplayProbe, gameplayTargets } from './sim/probe.js';
//   const report = createGameplayProbe().run();      // -> the JSON shape below
//
// Exposed to tools as `window.__debug.gameplayProbe()` and
// `window.__debug.gameplayTargets()`.
//
// WHY THIS FILE EXISTS
// --------------------
// "Feels human" is not measurable, so it cannot be tuned and cannot be graded.
// This module runs scripted, seeded, headless scenarios against the REAL sim
// (sim/ai.js + sim/match.js + sim/physics.js, unmodified) on a fixed 1/60 clock
// and reports numbers. Nothing here contains gameplay: every decision, kick and
// collision comes out of the shipping modules. If a number here is bad, the
// gameplay is bad — there is nowhere else for it to have come from.
//
// CONTRACT
// --------
// run() returns exactly:
//   { dribble:   { maxBallDist, meanBallDist, touchesPerSec, aheadFraction },
//     passing:   { attempts, completion, medianArrivalSpeed, medianLeadError },
//     shielding: { medianHoldSeconds, instantLosses },
//     locomotion:{ maxTurnRateAtSprint, maxAccel, maxDecel, instantReversals },
//     match:     { possessionChangesPerMin, outOfPlayPerMin, passesPerMin, shotsPerMin } }
// run({ verbose: true }) adds a `meta` block with sample counts and diagnostics.
//
// RULES THIS FILE OBEYS
// ---------------------
//  * Seeded and deterministic. Every stochastic choice comes from makeRng() with
//    a literal seed; the shared gameplay `rng` stream is never touched, so running
//    the probe cannot perturb a live match. Nothing calls Math.random().
//  * Fixed 1/60 steps driven programmatically. No wall clock, no rAF, no render,
//    no DOM, no WebGL, no audio. It runs identically in a browser tab and in node.
//  * Headless. Views, animator rigs and goal meshes are replaced by behaviourally
//    faithful stubs (see makeAnimStub / makeGoalStub) that reproduce the exact
//    timings the sim reads — clip durations, the kick/pass contact delays and the
//    distance-driven gait phase. Nothing that affects a decision is faked.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import {
  HALF_W, HALF_D, GOAL_HALF_W, GOAL_H, GOAL_DEPTH, POST_R, BALL_R,
  TEAMS, MATCH_SECONDS, RUN_SPEED,
} from '../core/constants.js';
import { createBallBody, separatePlayers, ballPlayerContact } from './physics.js';
import { createAI, FORMATION } from './ai.js';
import { createMatch } from './match.js';

const FIXED = 1 / 60;
const TAU = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// thresholds
// ---------------------------------------------------------------------------
// The pass/fail bar a tuner has to clear. Ranges are inclusive.

const TARGETS = {
  dribble: {
    maxBallDist: { max: 1.6 },
    touchesPerSec: { min: 1.2, max: 3.2 },
    aheadFraction: { min: 0.85 },
  },
  passing: {
    completion: { min: 0.72 },
    medianArrivalSpeed: { min: 3.5, max: 9.5 },
    medianLeadError: { max: 1.6 },
  },
  shielding: {
    // Upper bound matters as much as the lower one. A carrier who can hold the
    // ball for nine seconds against a defender is not shielding, he is
    // untacklable — the opposite failure to being snatched instantly, and just
    // as unlike football. Real shielding under active pressure buys a couple of
    // seconds to find a pass, not a stalemate.
    medianHoldSeconds: { min: 1.5, max: 4.5 },
    instantLosses: { equals: 0 },
  },
  locomotion: {
    maxTurnRateAtSprint: { max: 230 },
    maxAccel: { max: 13 },
    instantReversals: { equals: 0 },
  },
  match: {
    possessionChangesPerMin: { min: 6, max: 28 },
    outOfPlayPerMin: { max: 7 },
  },
};

/**
 * `window.__debug.gameplayTargets` — callable AND readable.
 *   __debug.gameplayTargets()                       -> the whole threshold table
 *   __debug.gameplayTargets.dribble.maxBallDist.max -> 1.6
 *   __debug.gameplayTargets(report)                 -> per-metric pass/fail verdict
 */
export function gameplayTargets(report) {
  if (!report) return TARGETS;
  return gradeReport(report);
}
Object.assign(gameplayTargets, TARGETS);

/** Grade a report against TARGETS. Returns { pass, failures[], checks{} }. */
export function gradeReport(report) {
  const checks = {};
  const failures = [];
  for (const group of Object.keys(TARGETS)) {
    for (const key of Object.keys(TARGETS[group])) {
      const t = TARGETS[group][key];
      const v = report && report[group] ? report[group][key] : undefined;
      let ok = typeof v === 'number' && Number.isFinite(v);
      if (ok && t.min !== undefined && v < t.min) ok = false;
      if (ok && t.max !== undefined && v > t.max) ok = false;
      if (ok && t.equals !== undefined && v !== t.equals) ok = false;
      const name = `${group}.${key}`;
      checks[name] = { value: v, target: t, pass: ok };
      if (!ok) failures.push(name);
    }
  }
  return { pass: failures.length === 0, failures, checks };
}

// ---------------------------------------------------------------------------
// stats helpers
// ---------------------------------------------------------------------------

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) * 0.5;
}
function mean(xs) {
  if (!xs.length) return 0;
  let t = 0;
  for (const x of xs) t += x;
  return t / xs.length;
}
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// headless stubs
// ---------------------------------------------------------------------------

/**
 * Goal stub. sim/physics.js reads posts / crossbarY / backX / contains() /
 * sheetDepthAt(); sim/match.js calls reset(). The geometry below is copied from
 * world/goal.js so the woodwork, the net volume and the goal test are bit-for-bit
 * the ones the game uses — the real object only adds meshes and cloth.
 */
const NET_D_TOP = 0.85;
const NET_D_BOT = GOAL_DEPTH - 0.06;
const NET_BACK_P = 2.6;

function makeGoalStub(side) {
  const gx = side * HALF_W;
  const HW = GOAL_HALF_W;
  return {
    side,
    posts: [{ x: gx, z: -HW, r: POST_R }, { x: gx, z: HW, r: POST_R }],
    crossbarY: GOAL_H,
    backX: gx + side * NET_D_BOT,
    sheetDepthAt(y) {
      const v = 1 - clamp(y / GOAL_H, 0, 1);
      return NET_D_TOP + (NET_D_BOT - NET_D_TOP) * Math.pow(v, NET_BACK_P);
    },
    contains(x, y, z) {
      if (Math.abs(z) > HW - BALL_R * 0.4) return false;
      if (y > GOAL_H - BALL_R * 0.4) return false;
      return side > 0 ? x > HALF_W + BALL_R * 0.35 : x < -HALF_W - BALL_R * 0.35;
    },
    update() {},
    reset() {},
  };
}

// --- animator stub ---------------------------------------------------------
// entities/animation.js needs a THREE rig (which needs canvas textures), so it
// cannot run headless. What sim/ai.js actually READS off an animator is only:
//   play(state, opts), busy, current, phase, contactDelay, passContactDelay
// plus the implicit state machine (a one-shot clip expires after `dur` and falls
// back). Those are reproduced exactly here, including the distance-driven gait
// phase — that phase is the stride clock a stride-synced dribble touch must ride,
// so it has to be the real solve and not a fixed timer.

const A_STATES = {
  idle: 0, run: 0, sprint: 0, celebrate: 0, keeperIdle: 0,
  kick: 0.42, pass: 0.32, dribble: 0.26, header: 0.70, throwIn: 1.00,
  tackle: 1.05, knocked: 1.15, getup: 0.80, keeperDive: 1.20, keeperCatch: 0.85,
};
const A_KICK_CONTACT = 0.17;
const A_PASS_CONTACT = 0.20;
const A_RUN_AMP = 0.95, A_SPR_AMP = 1.16;
const A_RUN_DUTY = 0.40, A_SPR_DUTY = 0.33;
const A_THIGH_L = 0.30, A_SHIN_L = 0.28;

function stanceKnee(q) { return 0.10 + 0.44 * Math.sin(Math.PI * Math.pow(q, 0.85)); }
function chainReach(kn) {
  const a = A_THIGH_L + A_SHIN_L * Math.cos(kn);
  const b = A_SHIN_L * Math.sin(kn);
  return Math.sqrt(a * a + b * b);
}
function halfStride(amp) { return chainReach(stanceKnee(0.5)) * Math.sin(amp); }

function makeAnimStub() {
  let current = 'idle';
  let dur = 0;
  let stateTime = 0;
  let oneShot = 0;
  let phase = 0;
  let gaitAmp = A_RUN_AMP;
  let footSide = 1;

  function fallback(ctx) {
    if (current === 'knocked') return 'getup';
    if (current === 'keeperDive' || current === 'keeperCatch') return 'keeperIdle';
    if (ctx && ctx.isKeeper) return 'keeperIdle';
    if (ctx && ctx.hasBall && ctx.moving && !ctx.sprinting) return 'dribble';
    if (ctx && ctx.moving) return ctx.sprinting ? 'sprint' : 'run';
    return 'idle';
  }

  return {
    play(state, o) {
      if (A_STATES[state] === undefined) return;
      const force = !!(o && o.force);
      if (state === current && !force) {
        if (o && o.foot) footSide = o.foot >= 0 ? 1 : -1;
        return;
      }
      if (!force && oneShot > 0.05 && dur > 0) return;
      current = state;
      dur = A_STATES[state];
      stateTime = 0;
      oneShot = dur;
      if (o && o.foot) footSide = o.foot >= 0 ? 1 : -1;
    },
    update(dt, ctx) {
      const step = dt > 0 ? dt : 0;
      stateTime += step;
      if (dur > 0) {
        oneShot = Math.max(0, dur - stateTime);
        if (oneShot <= 0) {
          const nxt = fallback(ctx);
          current = nxt;
          dur = A_STATES[nxt];
          stateTime = 0;
          oneShot = dur;
        }
      } else {
        oneShot = 0;
      }

      const rawSpeed = (ctx && ctx.speed) || 0;
      const locomotion = current === 'run' || current === 'sprint' || current === 'dribble';
      if (locomotion) {
        const fast = current === 'sprint';
        const duty = fast ? A_SPR_DUTY : A_RUN_DUTY;
        const baseAmp = fast ? A_SPR_AMP : A_RUN_AMP;
        const eff = rawSpeed > 0.8 ? rawSpeed : (fast ? 10.4 : 7.0);
        const k = clamp(eff / (fast ? 11.6 : 8.2), 0.22, 1.30);
        const wantAmp = clamp(baseAmp * Math.sqrt(k), 0.40, baseAmp * 1.06);
        gaitAmp += (wantAmp - gaitAmp) * (step > 0 ? 1 - Math.exp(-step * 8) : 1);
        const stride = 2 * halfStride(gaitAmp);
        const cyc = clamp((eff * duty) / stride, 0.8, 4.2);
        phase += step * cyc * TAU;
        if (phase > TAU * 1024) phase -= TAU * 1024;
      } else if (current === 'idle' || current === 'keeperIdle') {
        const p = ((phase % TAU) + TAU) % TAU;
        const d = 0 - (p > Math.PI ? p - TAU : p);
        phase += d * Math.min(1, step * 3);
      }
    },
    reset(state = 'idle') {
      current = state;
      dur = A_STATES[state] || 0;
      stateTime = 0;
      oneShot = dur;
      phase = 0;
      gaitAmp = A_RUN_AMP;
    },
    get current() { return current; },
    get busy() { return oneShot > 0; },
    get stateTime() { return stateTime; },
    get phase() { return phase; },
    get foot() { return footSide; },
    get contactDelay() { return A_STATES.kick * A_KICK_CONTACT; },
    get passContactDelay() { return A_STATES.pass * A_PASS_CONTACT; },
  };
}

// ---------------------------------------------------------------------------
// headless world
// ---------------------------------------------------------------------------

/**
 * The same wiring main.js does, minus everything that draws or makes noise.
 * Step order is copied from main.js step() so timing is identical:
 *   ai.update -> integrate agents -> separate -> ball.step -> ball/player contact
 *   -> match.update -> animator update
 */
function makeWorld(seed) {
  const prng = makeRng(seed);
  const body = createBallBody({ x: 0, y: BALL_R, z: 0 });
  const goals = [makeGoalStub(1), makeGoalStub(-1)];
  const agents = [];

  for (let team = 0; team < 2; team++) {
    for (let slot = 0; slot < 6; slot++) {
      const f = FORMATION[slot];
      const dir = TEAMS[team].dir;
      agents.push({
        id: agents.length,
        team, slot,
        role: f.role,
        isKeeper: slot === 0,
        pos: new THREE.Vector3(f.x * dir, 0, f.z),
        vel: new THREE.Vector3(),
        yaw: dir > 0 ? Math.PI / 2 : -Math.PI / 2,
        faceX: dir, faceZ: 0,
        down: false,
        control: 'ai',
        cool: 0,
        view: null,
        anim: makeAnimStub(),
      });
    }
  }

  // --- observable event log ------------------------------------------------
  // Every hook the game fires is recorded here; scenarios read the log instead
  // of poking at internals, so what the probe sees is exactly what the game
  // announced.
  const log = {
    t: 0,
    passes: [],        // { t, passer, receiver }
    shots: 0,
    outs: 0,
    goals: 0,
    tackles: 0,
    touchT: new Map(), // agent id -> sim time of its most recent ball contact
    lastTouchAgent: null,
  };

  const events = {
    onBounce() {},
    onPost() {},
    onNet() {},
    onKeeperSave() {},
    onKeeperDive() {},
    onPhase() {},
    onShot() { log.shots++; },
    onPass(a, mate) { log.passes.push({ t: log.t, passer: a, receiver: mate || a }); },
    onTouch(p) { log.touchT.set(p.id, log.t); log.lastTouchAgent = p; },
    onTackle(a) {
      log.tackles++;
      // main.js owns this rule, so the probe has to reproduce it or a tackle in
      // the harness would not knock anybody over and shielding would read long.
      for (const o of agents) {
        if (o.team === a.team || o.down) continue;
        if (Math.hypot(o.pos.x - a.pos.x, o.pos.z - a.pos.z) < 1.5) {
          o.down = true;
          o.downTimer = 1.5;
          if (o.anim) o.anim.play('knocked', { force: true });
        }
      }
    },
    onGoal(side) { log.goals++; match.scoreGoal(side); },
    onOut(kind, p) { log.outs++; match.restart(kind, p); },
  };

  const ai = createAI({ agents, body, goals, rng: prng, events });
  const match = createMatch({ agents, body, goals, ai, events });
  ai.match = match;

  const world = { bounds: { halfW: HALF_W, halfD: HALF_D }, goals, events };

  function step(dt) {
    log.t += dt;

    ai.update(dt);

    for (const a of agents) {
      if (a.down) {
        a.downTimer = (a.downTimer ?? 1.2) - dt;
        a.vel.multiplyScalar(Math.max(0, 1 - 5 * dt));
        if (a.downTimer <= 0) a.down = false;
      }
      a.pos.x += a.vel.x * dt;
      a.pos.z += a.vel.z * dt;
      a.pos.x = clamp(a.pos.x, -HALF_W - 2.5, HALF_W + 2.5);
      a.pos.z = clamp(a.pos.z, -HALF_D - 2.0, HALF_D + 2.0);
    }
    separatePlayers(agents, dt);

    body.step(dt, world);
    ballPlayerContact(body, agents, dt, events);

    match.update(dt);

    // yaw + animator, exactly as main.js syncViews does it
    for (const a of agents) {
      const sp = Math.hypot(a.vel.x, a.vel.z);
      let fx = a.faceX, fz = a.faceZ;
      if (sp > 0.5) { fx = a.vel.x / sp; fz = a.vel.z / sp; }
      if (fx !== 0 || fz !== 0) {
        const want = Math.atan2(fx, fz);
        a.yaw = dt > 0 ? angleLerp(a.yaw, want, 1 - Math.exp(-dt * 11)) : want;
      }
      a.anim.update(dt, {
        speed: sp, moving: sp > 0.5, sprinting: sp > 9.4,
        isKeeper: a.isKeeper, hasBall: !!a.hasBall,
      });
    }
  }

  /** Park an agent out of the way and freeze it (AI skips control === 'user'). */
  function park(a, x, z) {
    a.control = 'user';
    a.pos.set(x, 0, z);
    a.vel.set(0, 0, 0);
    a.down = false;
    a.hasBall = false;
    a.anim.reset(a.isKeeper ? 'keeperIdle' : 'idle');
  }

  /** Clean slate between trials: clear deferred kicks, timers, phase and log. */
  function stage() {
    for (const a of agents) {
      a.control = 'ai';
      a.vel.set(0, 0, 0);
      a.down = false;
      a.downTimer = 0;
      a.hasBall = false;
      a.carry = 0;
      a.anim.reset(a.isKeeper ? 'keeperIdle' : 'idle');
    }
    match.state.clock = MATCH_SECONDS;
    match.setPhase('play');
    ai.reset();
    log.passes.length = 0;
    log.shots = 0;
    log.outs = 0;
    log.goals = 0;
    log.tackles = 0;
    log.touchT.clear();
    log.lastTouchAgent = null;
  }

  return { prng, body, goals, agents, ai, match, world, events, log, step, park, stage };
}

// ---------------------------------------------------------------------------
// scenario 1 — close control / dribbling
// ---------------------------------------------------------------------------
//
// One carrier, ball at his feet, nobody else on the pitch (everyone parked and
// frozen). He runs at full speed for 5 s. When he gets close enough to the goal
// that the AI would start looking at a shot, both he and the ball are shifted
// back down the pitch by the same vector — the run continues uninterrupted and
// the carry geometry is untouched, so we measure carrying and nothing else.
//
//   maxBallDist   how far the ball EVER gets from him (the headline number:
//                 this is what "kicking it through the pitch" looks like)
//   meanBallDist  the average pocket distance
//   touchesPerSec distinct contacts per second (rising-edge contact + kicks)
//   aheadFraction fraction of frames the ball sits in his forward hemisphere,
//                 measured against the rendered body yaw, not the input vector

const DRIBBLE_RUNS = 8;
const DRIBBLE_SECONDS = 5;
const WRAP_X = 4;             // shift back before the shot logic can fire
const WRAP_BY = 30;

function runDribble(seed) {
  const dists = [];
  let maxDist = 0;
  let ahead = 0;
  let frames = 0;
  let touches = 0;
  let seconds = 0;
  let lostRuns = 0;

  for (let run = 0; run < DRIBBLE_RUNS; run++) {
    const W = makeWorld(seed + run * 17);
    const R = makeRng(seed + run * 101 + 5);
    W.stage();

    const subj = W.agents[5];                    // team 0, striker (slot 5)
    subj.pos.set(-26, 0, R.range(-9, 9));
    subj.vel.set(0, 0, 0);
    subj.faceX = 1; subj.faceZ = 0;
    subj.yaw = Math.PI / 2;
    subj.control = 'ai';

    // everyone else off the park, spaced so separatePlayers has nothing to do
    let k = 0;
    for (const a of W.agents) {
      if (a === subj) continue;
      W.park(a, (k % 2 ? 1 : -1) * (HALF_W + 2), -HALF_D - 1.4 + (k >> 1) * 3.4);
      k++;
    }

    W.body.place(subj.pos.x + 0.5, BALL_R, subj.pos.z);

    let prevKickId = W.body.kickId;
    let wasContact = false;
    let lastTouchAt = -1;
    let lost = false;
    const steps = Math.round(DRIBBLE_SECONDS / FIXED);

    for (let i = 0; i < steps; i++) {
      W.step(FIXED);
      seconds += FIXED;

      const dx = W.body.pos.x - subj.pos.x;
      const dz = W.body.pos.z - subj.pos.z;
      const d = Math.hypot(dx, dz);
      dists.push(d);
      if (d > maxDist) maxDist = d;

      // forward hemisphere against the body orientation the player sees
      const fx = Math.sin(subj.yaw), fz = Math.cos(subj.yaw);
      if (d > 1e-4 && (dx * fx + dz * fz) > 0) ahead++;
      frames++;

      // a touch = a rising-edge physics contact, or a deliberate kick by him.
      // 0.05 s refractory so one event is not double counted when a kick and a
      // contact land on the same frame.
      const contact = W.log.touchT.get(subj.id) === W.log.t;
      const kicked = W.body.kickId !== prevKickId && W.body.lastTouch === subj;
      prevKickId = W.body.kickId;
      if ((kicked || (contact && !wasContact)) && (W.log.t - lastTouchAt) > 0.05) {
        touches++;
        lastTouchAt = W.log.t;
      }
      wasContact = contact;

      if (d > 8 && !lost) { lost = true; lostRuns++; }

      const wx = Math.max(subj.pos.x, W.body.pos.x);
      if (wx > WRAP_X) {
        subj.pos.x -= WRAP_BY;
        W.body.pos.x -= WRAP_BY;
      }
    }
  }

  return {
    maxBallDist: r3(maxDist),
    meanBallDist: r3(mean(dists)),
    touchesPerSec: r3(touches / Math.max(1e-6, seconds)),
    aheadFraction: r3(frames ? ahead / frames : 0),
    _meta: { runs: DRIBBLE_RUNS, seconds: r3(seconds), touches, frames, runsWhereBallEscaped: lostRuns },
  };
}

// ---------------------------------------------------------------------------
// scenario 2 — passing
// ---------------------------------------------------------------------------
//
// The probe never fabricates a pass: it stages a picture in which the AI wants
// to release (carrier in his own half so shooting is out of range, two opponents
// inside 3.6 m so the release threshold drops to zero) and then listens for the
// engine's own onPass(passer, receiver) event. Everything after that is
// observation of the real ball flight.
//
// Per attempt:
//   tMin           when the ball is closest to the INTENDED receiver
//   leadError      that closest distance — how far the pass missed him by
//   arrivalSpeed   ball ground speed at tMin
//   complete       leadError <= RECEIVE_R and no other player touched the ball
//                  before tMin (i.e. it reached him uncontested)
//
// Tracking stops when the ball dies, leaves play or is contested, NOT when the
// receiver eventually walks over to it: a pass that expires four metres short is
// a four-metre lead error even if he jogs onto it afterwards.

const PASS_TRIALS = 150;
const PASS_MIN_ATTEMPTS = 100;
const PASS_SETUP_SECONDS = 2.5;
const PASS_TRACK_SECONDS = 4.0;
const RECEIVE_R = 1.8;          // a player can take a ball inside this radius

function runPassing(seed) {
  const leadErrors = [];
  const arrivalSpeeds = [];
  let attempts = 0;
  let completions = 0;
  let intercepted = 0;
  let strayed = 0;

  const W = makeWorld(seed);
  const R = makeRng(seed + 991);

  for (let trial = 0; trial < PASS_TRIALS && attempts < PASS_MIN_ATTEMPTS * 1.35; trial++) {
    W.stage();

    const passer = W.agents[5];                       // team 0 striker
    const px = R.range(-10, -2);                      // own half: goal is 32-40 m off
    const pz = R.range(-12, 12);
    passer.pos.set(px, 0, pz);
    passer.faceX = 1; passer.faceZ = 0;
    passer.yaw = Math.PI / 2;

    // team-mates spread into plausible receiving positions; left on AI so they
    // keep moving and a lead has something to lead
    for (let slot = 1; slot <= 4; slot++) {
      const m = W.agents[slot];
      const ang = R.range(-1.25, 1.25);
      const rad = R.range(6, 22);
      m.pos.set(
        clamp(px + Math.cos(ang) * rad, -HALF_W + 2, HALF_W - 2),
        0,
        clamp(pz + Math.sin(ang) * rad, -HALF_D + 2, HALF_D - 2),
      );
      m.vel.set(0, 0, 0);
    }
    W.agents[0].pos.set(-HALF_W + 3, 0, 0);           // own keeper stays home

    // two opponents right on him (that is what makes him release), the rest
    // scattered where they can realistically cut a lane
    for (let slot = 1; slot <= 5; slot++) {
      const o = W.agents[6 + slot];
      let ang, rad;
      if (slot <= 2) { ang = R.range(0, TAU); rad = R.range(2.8, 3.5); }
      else { ang = R.range(-1.6, 1.6); rad = R.range(6, 24); }
      o.pos.set(
        clamp(px + Math.cos(ang) * rad, -HALF_W + 2, HALF_W - 2),
        0,
        clamp(pz + Math.sin(ang) * rad, -HALF_D + 2, HALF_D - 2),
      );
      o.vel.set(0, 0, 0);
    }
    W.agents[6].pos.set(HALF_W - 3, 0, 0);            // their keeper stays home

    W.body.place(px + 0.5, BALL_R, pz);

    // ---- wait for the engine to release a pass ----
    let ev = null;
    const setupSteps = Math.round(PASS_SETUP_SECONDS / FIXED);
    for (let i = 0; i < setupSteps && !ev; i++) {
      W.step(FIXED);
      if (W.log.passes.length) ev = W.log.passes[0];
      if (W.match.state.phase !== 'play') break;
    }
    if (!ev) continue;
    if (ev.passer !== passer || ev.receiver === passer) continue;

    attempts++;
    const receiver = ev.receiver;
    const originX = W.body.pos.x, originZ = W.body.pos.z;

    // ---- follow the ball ----
    let minD = Infinity;
    let minSpeed = 0;
    let tMin = 0;
    let tContest = Infinity;
    const t0 = W.log.t;
    const trackSteps = Math.round(PASS_TRACK_SECONDS / FIXED);

    for (let i = 0; i < trackSteps; i++) {
      W.step(FIXED);
      const dt = W.log.t - t0;

      const d = Math.hypot(W.body.pos.x - receiver.pos.x, W.body.pos.z - receiver.pos.z);
      const travelled = Math.hypot(W.body.pos.x - originX, W.body.pos.z - originZ);
      if (travelled > 1.0 && d < minD) {
        minD = d;
        minSpeed = Math.hypot(W.body.vel.x, W.body.vel.z);
        tMin = dt;
      }

      // anyone other than the passer and the intended receiver getting a touch
      // is a contest — record when it first happened
      if (tContest === Infinity && travelled > 1.0) {
        for (const a of W.agents) {
          if (a === receiver) continue;
          if (a === passer && dt < 0.25) continue;
          if (W.log.touchT.get(a.id) === W.log.t) { tContest = dt; break; }
        }
      }

      if (W.match.state.phase !== 'play') break;
      const stopped = Math.hypot(W.body.vel.x, W.body.vel.z) < 0.3 && W.body.grounded;
      if (stopped && dt > 0.4) break;
      if (tContest < Infinity && dt > tContest + 0.3) break;
    }

    if (!Number.isFinite(minD)) { strayed++; continue; }
    leadErrors.push(minD);
    arrivalSpeeds.push(minSpeed);
    if (minD <= RECEIVE_R && tContest >= tMin) completions++;
    else if (tContest < tMin) intercepted++;
    else strayed++;
  }

  return {
    attempts,
    completion: r3(attempts ? completions / attempts : 0),
    medianArrivalSpeed: r3(median(arrivalSpeeds)),
    medianLeadError: r3(median(leadErrors)),
    _meta: {
      completions, intercepted, strayed,
      receiveRadius: RECEIVE_R,
      meanLeadError: r3(mean(leadErrors)),
      meanArrivalSpeed: r3(mean(arrivalSpeeds)),
    },
  };
}

// ---------------------------------------------------------------------------
// scenario 3 — shielding / hold-off
// ---------------------------------------------------------------------------
//
// Carrier with the ball, ONE defender closing from a seeded angle, nobody else
// on the pitch. The carrier is staged in midfield so the AI has no shot and no
// pass available: all he can do is keep the ball.
//
//   first contact  the first frame the defender is inside challenge range
//                  (1.5 m — the distance at which sim/ai.js may poke)
//   dispossessed   the first frame the ball's last touch belongs to the defender,
//                  or the defender becomes the carrier
//   hold           dispossessed - first contact
//   instant loss   hold <= 0.2 s (a snatch on contact, which must never happen)
//
// A contest where the carrier is still holding at the cap counts as a censored
// hold of CONTEST_CAP seconds, which is the conservative reading.

const CONTESTS = 28;
const CONTEST_CAP = 10.0;
const CHALLENGE_R = 1.5;

function runShielding(seed) {
  const holds = [];
  let instant = 0;
  let held = 0;
  let noContact = 0;

  for (let c = 0; c < CONTESTS; c++) {
    const W = makeWorld(seed + c * 13);
    const R = makeRng(seed + c * 271 + 3);
    W.stage();

    const carrier = W.agents[5];                 // team 0 striker
    const defender = W.agents[6 + 3];            // team 1 midfielder
    const cx = R.range(-8, 4);
    const cz = R.range(-11, 11);
    carrier.pos.set(cx, 0, cz);
    carrier.faceX = 1; carrier.faceZ = 0;
    carrier.yaw = Math.PI / 2;
    carrier.control = 'ai';

    const ang = R.range(0, TAU);
    const rad = R.range(2.6, 4.6);
    defender.pos.set(
      clamp(cx + Math.cos(ang) * rad, -HALF_W + 2, HALF_W - 2),
      0,
      clamp(cz + Math.sin(ang) * rad, -HALF_D + 2, HALF_D - 2),
    );
    defender.vel.set(0, 0, 0);
    defender.control = 'ai';

    let k = 0;
    for (const a of W.agents) {
      if (a === carrier || a === defender) continue;
      W.park(a, (k % 2 ? 1 : -1) * (HALF_W + 2), -HALF_D - 1.4 + (k >> 1) * 3.4);
      k++;
    }

    W.body.place(cx + 0.5, BALL_R, cz);

    let tContact = -1;
    let tLoss = -1;
    const steps = Math.round(CONTEST_CAP / FIXED);
    for (let i = 0; i < steps; i++) {
      W.step(FIXED);
      const t = i * FIXED;

      if (tContact < 0) {
        const d = Math.hypot(defender.pos.x - carrier.pos.x, defender.pos.z - carrier.pos.z);
        if (d <= CHALLENGE_R) tContact = t;
      }

      const lostToDefender = W.body.lastTouchTeam === defender.team
        || (W.ai.carrier && W.ai.carrier.team === defender.team);
      if (lostToDefender) { tLoss = t; break; }
      if (W.match.state.phase !== 'play') break;
    }

    if (tContact < 0) {
      // the defender never got near enough to challenge; not a contest
      noContact++;
      holds.push(CONTEST_CAP);
      held++;
      continue;
    }
    if (tLoss < 0) { holds.push(CONTEST_CAP - tContact); held++; continue; }

    const hold = Math.max(0, tLoss - tContact);
    holds.push(hold);
    if (hold <= 0.2) instant++;
  }

  return {
    medianHoldSeconds: r3(median(holds)),
    instantLosses: instant,
    _meta: {
      contests: CONTESTS, heldToCap: held, defenderNeverArrived: noContact,
      meanHoldSeconds: r3(mean(holds)),
      minHoldSeconds: r3(holds.length ? Math.min(...holds) : 0),
      challengeRadius: CHALLENGE_R, capSeconds: CONTEST_CAP,
    },
  };
}

// ---------------------------------------------------------------------------
// scenario 4/5 — full matches (locomotion + match rhythm)
// ---------------------------------------------------------------------------
//
// Two whole matches, played out on the fixed clock. Locomotion is sampled every
// step for every agent; match rhythm is counted off the engine's own events.
//
// Locomotion definitions
//   maxTurnRateAtSprint  |d(heading)/dt| in deg/s, sampled only where the agent
//                        is above RUN_SPEED. Heading is the VELOCITY direction:
//                        it is what actually moves the body, and a smoothed yaw
//                        would hide an instant change underneath it.
//   maxAccel / maxDecel  the tangential rate of change of ground speed. Frames
//                        where the agent was teleported (kickoff resets, set
//                        pieces) are discarded, otherwise a formation reset
//                        would register as infinite acceleration.
//   instantReversals     steps where the velocity direction flipped more than
//                        120 deg while moving above 1.5 m/s on both sides.
//
// Match definitions
//   possessionChangesPerMin  changes of the team owning the ball's last touch,
//                            debounced by 0.4 s so a ricochet off a shin is not
//                            counted as two turnovers
//   outOfPlayPerMin          onOut events (throw-ins + goal kicks + corners)
//   passesPerMin             onPass events, including set-piece deliveries
//   shotsPerMin              ai.stats.shots, which counts deliberate efforts on
//                            goal only (a hoofed clearance is not a shot)

const MATCH_SEEDS = [4101, 4207];
const MATCH_CAP_SECONDS = 240;
const POSSESSION_DEBOUNCE = 0.4;
const REVERSAL_DEG = 120;
const REVERSAL_MIN_SPEED = 1.5;
const SPRINT_FLOOR = RUN_SPEED;      // 8.2 m/s — above a jog

function runMatches() {
  let maxTurn = 0;
  let maxAccel = 0;
  let maxDecel = 0;
  let reversals = 0;
  let turnSamples = 0;

  let possChanges = 0;
  let outs = 0;
  let passes = 0;
  let shots = 0;
  let goals = 0;
  let simSeconds = 0;

  for (const seed of MATCH_SEEDS) {
    const W = makeWorld(seed);
    W.match.reset();

    const prev = W.agents.map((a) => ({ vx: 0, vz: 0, sp: 0, x: a.pos.x, z: a.pos.z, valid: false }));

    let possTeam = -1;
    let pendTeam = -1;
    let pendT = 0;
    let t = 0;
    const steps = Math.round(MATCH_CAP_SECONDS / FIXED);

    for (let i = 0; i < steps; i++) {
      W.step(FIXED);
      t += FIXED;

      // ---- locomotion ----
      for (let k = 0; k < W.agents.length; k++) {
        const a = W.agents[k];
        const p = prev[k];
        const moved = Math.hypot(a.pos.x - p.x, a.pos.z - p.z);
        const sp = Math.hypot(a.vel.x, a.vel.z);
        // a teleport (formation reset, keeper placement) invalidates the sample
        const teleported = moved > sp * FIXED * 2 + 0.5;
        const usable = p.valid && !teleported && !a.down;

        if (usable) {
          const dsp = (sp - p.sp) / FIXED;
          if (dsp > maxAccel) maxAccel = dsp;
          if (-dsp > maxDecel) maxDecel = -dsp;

          const ps = p.sp;
          if (sp > 0.2 && ps > 0.2) {
            const dot = clamp((a.vel.x * p.vx + a.vel.z * p.vz) / (sp * ps), -1, 1);
            const degs = Math.acos(dot) * 180 / Math.PI;
            if (sp >= SPRINT_FLOOR && ps >= SPRINT_FLOOR) {
              const rate = degs / FIXED;
              if (rate > maxTurn) maxTurn = rate;
              turnSamples++;
            }
            if (degs > REVERSAL_DEG && sp >= REVERSAL_MIN_SPEED && ps >= REVERSAL_MIN_SPEED) {
              reversals++;
            }
          }
        }
        p.vx = a.vel.x; p.vz = a.vel.z; p.sp = sp;
        p.x = a.pos.x; p.z = a.pos.z;
        p.valid = !a.down;
      }

      // ---- possession, debounced ----
      const lt = W.body.lastTouchTeam;
      if (lt >= 0) {
        if (lt !== possTeam) {
          if (lt !== pendTeam) { pendTeam = lt; pendT = 0; }
          else {
            pendT += FIXED;
            if (pendT >= POSSESSION_DEBOUNCE) {
              if (possTeam >= 0) possChanges++;
              possTeam = lt;
              pendTeam = -1;
              pendT = 0;
            }
          }
        } else { pendTeam = -1; pendT = 0; }
      }

      if (W.match.state.phase === 'fulltime') break;
    }

    simSeconds += t;
    outs += W.log.outs;
    passes += W.log.passes.length;
    goals += W.log.goals;
    shots += W.ai.stats.shots;
  }

  const mins = simSeconds / 60;
  return {
    locomotion: {
      maxTurnRateAtSprint: r3(maxTurn),
      maxAccel: r3(maxAccel),
      maxDecel: r3(maxDecel),
      instantReversals: reversals,
      _meta: { sprintSamples: turnSamples, sprintFloor: SPRINT_FLOOR, simSeconds: r3(simSeconds) },
    },
    match: {
      possessionChangesPerMin: r3(possChanges / mins),
      outOfPlayPerMin: r3(outs / mins),
      passesPerMin: r3(passes / mins),
      shotsPerMin: r3(shots / mins),
      _meta: {
        matches: MATCH_SEEDS.length, simSeconds: r3(simSeconds),
        possessionChanges: possChanges, outs, passes, shots, goals,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * createGameplayProbe() -> { run(opts), targets, grade(report) }
 *
 * run({ verbose }) executes every scenario and returns the report. It is pure:
 * it builds its own worlds and never touches a live match, the shared RNG stream,
 * the renderer or the clock.
 */
export function createGameplayProbe() {
  function run(opts = {}) {
    const dribble = runDribble(opts.seed ?? 2001);
    const passing = runPassing(opts.seed ?? 3001);
    const shielding = runShielding(opts.seed ?? 5001);
    const rest = runMatches();

    const report = {
      dribble: {
        maxBallDist: dribble.maxBallDist,
        meanBallDist: dribble.meanBallDist,
        touchesPerSec: dribble.touchesPerSec,
        aheadFraction: dribble.aheadFraction,
      },
      passing: {
        attempts: passing.attempts,
        completion: passing.completion,
        medianArrivalSpeed: passing.medianArrivalSpeed,
        medianLeadError: passing.medianLeadError,
      },
      shielding: {
        medianHoldSeconds: shielding.medianHoldSeconds,
        instantLosses: shielding.instantLosses,
      },
      locomotion: {
        maxTurnRateAtSprint: rest.locomotion.maxTurnRateAtSprint,
        maxAccel: rest.locomotion.maxAccel,
        maxDecel: rest.locomotion.maxDecel,
        instantReversals: rest.locomotion.instantReversals,
      },
      match: {
        possessionChangesPerMin: rest.match.possessionChangesPerMin,
        outOfPlayPerMin: rest.match.outOfPlayPerMin,
        passesPerMin: rest.match.passesPerMin,
        shotsPerMin: rest.match.shotsPerMin,
      },
    };

    if (opts.verbose) {
      report.meta = {
        dribble: dribble._meta,
        passing: passing._meta,
        shielding: shielding._meta,
        locomotion: rest.locomotion._meta,
        match: rest.match._meta,
        grade: gradeReport(report),
      };
    }
    return report;
  }

  return { run, targets: TARGETS, grade: gradeReport };
}

export { TARGETS as GAMEPLAY_TARGETS };
