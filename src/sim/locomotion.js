// Human locomotion, body-to-body contact and contested possession.
//
//   stepBodies(players, dt)                 -> one full body pass for a frame
//   resolveBallContest(body, players, dt)   -> shield / challenge resolution
//   requestVelocity(a, vx, vz)              -> AI-facing "this is where I want to go"
//   driveTo(a, tx, tz, dt, speed, slack)    -> seek helper that obeys the model
//   attributes(a)                           -> { mass, strength, balance, ... }
//   shieldOwner(players)                    -> who is currently protecting the ball
//   contestOf(challenger)                   -> 0..1 progress of that player's challenge
//   canDispossess(challenger)               -> has the challenge been won yet?
//
// WHY THIS FILE EXISTS
// --------------------
// The sim used to move players by writing straight into `agent.vel` and then
// integrating: `pos += vel * dt`. A steering routine could therefore reverse a
// sprinting player inside one frame, and a defender who happened to brush the
// ball owned it instantly. Both read as robots, not footballers.
//
// This module makes `agent.vel` a REQUEST rather than a fact. Once per frame
// stepBodies() reads the request, runs it through a locomotion model that a
// human body could actually execute, and writes back the velocity and position
// that resulted. Nothing else in the codebase has to change: the AI keeps
// steering exactly as it did, it just no longer gets to cheat physics.
//
// THE MODEL
// ---------
//  * bounded acceleration and deceleration (you cannot stop dead)
//  * a maximum turn rate that FALLS with speed — a walk can pivot at ~380 deg/s,
//    a full sprint at ~115 deg/s, so a reversal at pace costs a slow-plant-turn
//  * a requested turn also scrubs speed, which is what makes the plant happen:
//    ask for 180 deg and the target speed collapses, the player decelerates,
//    the falling speed raises his turn budget, and he comes back out the far side
//  * body orientation lags the direction of travel and the body leans into
//    lateral acceleration
//  * stamina drains while sprinting and caps top speed as it empties
//
// BODIES AND SHIELDING
// --------------------
// Players are bodies with mass and strength, not ghosts that pass through each
// other. Overlap is resolved by a soft push whose split is decided by how well
// each man is braced, so a striker leaning back into a defender gives ground
// slowly and a light winger bounces off. When one player is in control of the
// ball, an opponent has to get PAST that body to reach it: the hold-off keeps
// the challenger on the far side of the carrier, and taking the ball is a
// CONTEST that fills over time from strength, momentum and which side of the
// carrier the challenger is on. Until that contest is won, a poke or a lunge at
// the ball is rejected — a mistimed lunge leaves the challenger on the floor.
// Dispossession is therefore never an instant snatch on contact.

import {
  HALF_W, HALF_D, PLAYER_R, BALL_R, RUN_SPEED, SPRINT_SPEED,
} from '../core/constants.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

export const LOCO = {
  // --- translation ---
  maxAccel: 9.0,            // m/s^2 from a standing start
  accelFade: 0.30,          // fraction of that lost by the time you are at top speed
  maxDecel: 12.0,           // m/s^2 — heels-in braking
  // --- rotation ---
  turnWalkDeg: 380,         // deg/s of heading change at a standstill
  turnSprintDeg: 115,       // deg/s at SPRINT_SPEED
  turnFloorSpeed: 0.8,      // below this you are turning on the spot, not running
  turnSpeedFloor: 0.22,     // speed you are cut to when asked for a full reversal
  // --- orientation / lean ---
  yawRateDeg: 620,          // how fast the shoulders can come round
  yawLag: 12.0,             // 1/s exponential lag of the body behind the heading
  leanGain: 0.030,          // rad of lean per m/s^2 of lateral acceleration
  leanDecay: 7.0,
  // --- stamina ---
  sprintFloor: RUN_SPEED * 0.98,
  staminaDrain: 1 / 21,     // per second at a sprint
  staminaRecover: 1 / 15,   // per second when not sprinting
  staminaSpeedFloor: 0.82,  // top speed multiplier on an empty tank
  // --- bodies ---
  bodyRadius: PLAYER_R * 0.88,   // shoulder-to-shoulder half width for contact
  contactDamp: 0.55,        // how much of the closing speed a collision kills
  braceGain: 0.55,          // extra stability from leaning into the contact
  // --- shielding / contest ---
  controlRadius: 1.45,      // ball inside this of a player = that player's ball
  controlSettle: 0.18,      // ...once he has held it this long
  controlRelSpeed: 16,      // ...and the ball is not flying past him
  controlGrace: 0.35,       // a touch that puts the ball out of reach for a
                            // moment does not end his possession
  contestRadius: 1.42,      // challenger must be at least this close to work
  contestBase: 1.20,        // per second, even matchup, challenger in front
  contestShieldMin: 0.38,   // multiplier when fully shielded (challenger behind)
  contestDecay: 0.55,       // per second when the challenger backs off
  pokeCredit: 0.09,         // progress earned by a rejected poke
  lungeCredit: 0.18,        // progress earned by a rejected lunge
  lungeFallBelow: 0.55,     // lunge this early and you end up on the floor
  lungeFallTime: 0.95,
  holdOffRadius: 1.75,      // arm's-length hold-off around the carrier
  holdOffSectorDeg: 62,     // half-width of the wedge the carrier's body defends
  holdOffTurn: 2.5,         // rad/s the challenger is walked around the carrier
};

// Bodies differ. Roles are a stand-in for physique: a centre back is heavy and
// hard to move, a winger is light and nimble, a striker holds the ball up.
const ROLE = {
  GK: { mass: 1.10, strength: 1.06, balance: 1.00, speed: 1.00, accel: 1.00 },
  LB: { mass: 1.10, strength: 1.10, balance: 1.06, speed: 0.97, accel: 0.97 },
  RB: { mass: 1.10, strength: 1.10, balance: 1.06, speed: 0.97, accel: 0.97 },
  LM: { mass: 0.92, strength: 0.90, balance: 0.96, speed: 1.03, accel: 1.06 },
  RM: { mass: 0.92, strength: 0.90, balance: 0.96, speed: 1.03, accel: 1.06 },
  ST: { mass: 1.06, strength: 1.08, balance: 1.08, speed: 1.00, accel: 1.00 },
};
const ROLE_DEFAULT = { mass: 1, strength: 1, balance: 1, speed: 1, accel: 1 };

/** Physique for an agent. Pure function of its role — safe to call every frame. */
export function attributes(a) {
  return (a && ROLE[a.role]) || ROLE_DEFAULT;
}

// ---------------------------------------------------------------------------
// per-agent state
// ---------------------------------------------------------------------------

/**
 * Locomotion state hangs off the agent as `agent.loco` so it survives whatever
 * the integrator does and needs no registration step.
 */
export function locoState(a) {
  let L = a.loco;
  if (!L) {
    L = a.loco = {
      vx: a.vel ? a.vel.x : 0,
      vz: a.vel ? a.vel.z : 0,
      px: a.pos.x, pz: a.pos.z,
      primed: false,
      yaw: a.yaw || 0,
      lean: 0, leanX: 0, leanZ: 0,
      stamina: 1,
      sprintT: 0,
      pressure: 0,
      shielding: 0,
    };
  }
  return L;
}

/** Heading change budget in rad/s at a given ground speed. */
export function maxTurnRate(speed) {
  const k = clamp(speed / SPRINT_SPEED, 0, 1);
  return (LOCO.turnWalkDeg + (LOCO.turnSprintDeg - LOCO.turnWalkDeg) * k) * DEG;
}

/** Same thing in degrees, for tools and tests. */
export function maxTurnRateDeg(speed) { return maxTurnRate(speed) / DEG; }

/** Top speed this player can currently reach, given his tank. */
export function speedCap(a) {
  const L = locoState(a);
  const at = attributes(a);
  return SPRINT_SPEED * at.speed
    * (LOCO.staminaSpeedFloor + (1 - LOCO.staminaSpeedFloor) * L.stamina);
}

export function stamina(a) { return locoState(a).stamina; }

// ---------------------------------------------------------------------------
// AI-facing API
// ---------------------------------------------------------------------------

/**
 * Ask for a ground velocity. This is the ONLY thing a controller needs to do;
 * stepBodies() decides what the body can actually deliver.
 */
export function requestVelocity(a, vx, vz) {
  a.vel.x = vx;
  a.vel.z = vz;
  return a;
}

/**
 * Seek helper: aim at (tx,tz) at up to `speed`, easing off as you arrive.
 * Returns the distance remaining. Equivalent to the old steering call, except
 * the request is a clean desired velocity instead of a hand-rolled blend.
 */
export function driveTo(a, tx, tz, dt, speed, slack = 0.08) {
  const dx = tx - a.pos.x, dz = tz - a.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < slack) { requestVelocity(a, 0, 0); return d; }
  const want = Math.min(speed, d * 3.4 + 1.2);
  requestVelocity(a, (dx / d) * want, (dz / d) * want);
  return d;
}

/** Ask for a stop. The model still has to brake for it. */
export function requestStop(a) { requestVelocity(a, 0, 0); }

// ---------------------------------------------------------------------------
// the locomotion integrator
// ---------------------------------------------------------------------------

const TELEPORT_M = 1.2;      // unexplained displacement that means "not locomotion"
const BOUND_X = HALF_W + 2.5;
const BOUND_Z = HALF_D + 2.0;

// A whistle (kickoff, set piece, half time) stops everybody where they stand.
// It arrives as an outright overwrite of the velocity rather than as steering,
// and the difference is visible: steering only ever scales a velocity by a
// bounded factor per frame, so a request that collapses to nothing in one frame
// did not come from a controller and must be obeyed rather than smoothed.
const STOP_ABS = 0.9;        // m/s — a request this small is not steering...
const STOP_RATIO = 0.45;     // ...if it also lost this much of last frame's ask
const STOP_CARRY = 1.5;      // ...while we still had this much pace

function parkAt(a, L) {
  L.vx = 0; L.vz = 0;
  L.px = a.pos.x;
  L.pz = a.pos.z;
  L.primed = true;
  L.lean = 0;
}

function integrateAgent(a, dt) {
  if (!a || !a.pos || !a.vel) return;
  const L = locoState(a);
  L.free = false;

  // A player on the floor is not walking: the integrator owns him, we just
  // keep our baseline in step so he resumes cleanly when he gets up.
  if (a.down) {
    L.vx = a.vel.x; L.vz = a.vel.z;
    L.px = a.pos.x; L.pz = a.pos.z;
    L.primed = true; L.free = true; L.reqPrev = 0;
    L.sprintT = 0;
    tickStamina(a, L, 0, dt);
    return;
  }

  const at = attributes(a);

  // --- what was asked for -------------------------------------------------
  let dvx = a.vel.x, dvz = a.vel.z;
  let want = Math.hypot(dvx, dvz);
  const reqPrev = L.reqPrev || 0;
  L.reqPrev = want;

  // The caller has already run `pos += vel * dt` with the REQUESTED velocity.
  // Anything else that moved him (a kickoff reset, a set-piece placement) shows
  // up as displacement we cannot explain: he was PUT there, so he is standing
  // still and starts running again from rest.
  const drift = Math.hypot(
    a.pos.x - L.px - dvx * dt,
    a.pos.z - L.pz - dvz * dt,
  );
  if (!L.primed || drift > TELEPORT_M) parkAt(a, L);
  else if (want < STOP_ABS && want < STOP_RATIO * reqPrev
           && Math.hypot(L.vx, L.vz) > STOP_CARRY) {
    // the whistle, not the legs
    L.vx = 0; L.vz = 0;
  }

  const cap = speedCap(a);
  if (want > cap) { const k = cap / want; dvx *= k; dvz *= k; want = cap; }

  // --- where we are already going -----------------------------------------
  let sp = Math.hypot(L.vx, L.vz);
  // the state this frame's envelope is measured against, captured after any
  // external authority (whistle, respawn) has had its say
  L.sp0 = sp;
  L.d0x = sp > 1e-5 ? L.vx / sp : 0;
  L.d0z = sp > 1e-5 ? L.vz / sp : 0;
  let dirX, dirZ;
  if (sp > 1e-5) { dirX = L.vx / sp; dirZ = L.vz / sp; }
  else if (want > 1e-5) { dirX = dvx / want; dirZ = dvz / want; }
  else { dirX = a.faceX || 0; dirZ = a.faceZ || 1; }

  let target = want;

  if (want > 1e-5) {
    const wx = dvx / want, wz = dvz / want;
    const cos = clamp(dirX * wx + dirZ * wz, -1, 1);

    if (sp > LOCO.turnFloorSpeed) {
      // Rotate the heading by at most this frame's budget. The budget is set by
      // the speed we are ALREADY at, which is what makes pace expensive to turn.
      const ang = Math.acos(cos);
      const cross = dirX * wz - dirZ * wx;
      const budget = maxTurnRate(sp) * dt;
      const t = Math.min(ang, budget) * (cross >= 0 ? 1 : -1);
      const c = Math.cos(t), s = Math.sin(t);
      const nx = dirX * c - dirZ * s;
      const nz = dirX * s + dirZ * c;
      dirX = nx; dirZ = nz;

      // A sharp request also costs speed — you have to slow down to change
      // direction, and slowing down is what buys you the turn.
      const align = 0.5 + 0.5 * cos;                       // 1 ahead .. 0 behind
      target = want * (LOCO.turnSpeedFloor + (1 - LOCO.turnSpeedFloor) * align);
    } else {
      dirX = wx; dirZ = wz;                                // pivoting on the spot
    }
  }

  // --- bounded speed change ------------------------------------------------
  const accel = LOCO.maxAccel * at.accel
    * (1 - LOCO.accelFade * clamp(sp / SPRINT_SPEED, 0, 1))
    * (0.78 + 0.22 * L.stamina);
  let nsp;
  if (target > sp) nsp = Math.min(target, sp + accel * dt);
  else nsp = Math.max(target, sp - LOCO.maxDecel * dt);
  nsp = clamp(nsp, 0, cap);

  const nvx = dirX * nsp, nvz = dirZ * nsp;

  // --- lean from lateral acceleration --------------------------------------
  const ax = (nvx - L.vx) / dt, az = (nvz - L.vz) / dt;
  const latX = -dirZ, latZ = dirX;
  const lat = ax * latX + az * latZ;
  const k = 1 - Math.exp(-LOCO.leanDecay * dt);
  L.lean += (clamp(lat * LOCO.leanGain, -0.55, 0.55) - L.lean) * k;
  L.leanX = latX * L.lean;
  L.leanZ = latZ * L.lean;
  a.lean = L.lean;

  // --- commit ---------------------------------------------------------------
  L.vx = nvx; L.vz = nvz;
  a.vel.x = nvx; a.vel.z = nvz;
  a.pos.x = clamp(L.px + nvx * dt, -BOUND_X, BOUND_X);
  a.pos.z = clamp(L.pz + nvz * dt, -BOUND_Z, BOUND_Z);

  // --- orientation: the shoulders trail the feet ---------------------------
  if (nsp > 0.35) {
    const wantYaw = Math.atan2(dirX, dirZ);
    let d = wantYaw - L.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const lag = 1 - Math.exp(-LOCO.yawLag * dt);
    const step = clamp(d * lag, -LOCO.yawRateDeg * DEG * dt, LOCO.yawRateDeg * DEG * dt);
    L.yaw += step;
  }
  a.bodyYaw = L.yaw;

  tickStamina(a, L, nsp, dt);
}

function tickStamina(a, L, sp, dt) {
  if (sp > LOCO.sprintFloor) {
    L.sprintT += dt;
    L.stamina = clamp(L.stamina - LOCO.staminaDrain * dt, 0, 1);
  } else {
    L.sprintT = 0;
    L.stamina = clamp(L.stamina + LOCO.staminaRecover * dt * (sp < 2 ? 1.4 : 1), 0, 1);
  }
  a.stamina = L.stamina;
}

// ---------------------------------------------------------------------------
// bodies: soft separation, bracing, hold-off
// ---------------------------------------------------------------------------

/** How hard this player is to shift along `(nx,nz)` right now. */
function stability(a, nx, nz) {
  const L = locoState(a);
  const at = attributes(a);
  let s = at.mass * (0.55 + 0.45 * at.strength);
  // leaning into the contact braces you; being pushed from behind while running
  // away does not
  const into = -(a.vel.x * nx + a.vel.z * nz);
  if (into > 0) s *= 1 + LOCO.braceGain * clamp(into / RUN_SPEED, 0, 1);
  else s *= 1 - 0.25 * clamp(-into / SPRINT_SPEED, 0, 1);
  // the man protecting the ball is set, side-on and expecting it
  s *= 1 + 0.55 * L.shielding * at.balance;
  return s;
}

function jostle(players, dt) {
  const n = players.length;
  const min = LOCO.bodyRadius * 2;
  for (let i = 0; i < n; i++) {
    const a = players[i];
    if (a.down) continue;
    for (let j = i + 1; j < n; j++) {
      const b = players[j];
      if (b.down) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      const pen = min - d;

      // push share: the better braced man holds his ground
      const sa = stability(a, nx, nz);
      const sb = stability(b, -nx, -nz);
      const wa = sb / (sa + sb);
      const wb = 1 - wa;

      a.pos.x -= nx * pen * wa; a.pos.z -= nz * pen * wa;
      b.pos.x += nx * pen * wb; b.pos.z += nz * pen * wb;

      // shoulder charge: kill part of the closing speed and register the contact
      const rvn = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
      if (rvn < 0) {
        const j2 = -rvn * LOCO.contactDamp;
        const La = locoState(a), Lb = locoState(b);
        La.vx -= nx * j2 * wa; La.vz -= nz * j2 * wa;
        Lb.vx += nx * j2 * wb; Lb.vz += nz * j2 * wb;
        a.vel.x = La.vx; a.vel.z = La.vz;
        b.vel.x = Lb.vx; b.vel.z = Lb.vz;
        const shove = clamp(-rvn / SPRINT_SPEED, 0, 1);
        locoState(a).pressure = Math.max(locoState(a).pressure, shove);
        locoState(b).pressure = Math.max(locoState(b).pressure, shove);
      }

      // lean away from whoever is leaning on you
      locoState(a).lean = clamp(locoState(a).lean - pen * 0.35, -0.6, 0.6);
      locoState(b).lean = clamp(locoState(b).lean + pen * 0.35, -0.6, 0.6);
    }
  }
}

/**
 * Hold-off. The carrier's body occupies the wedge between the challenger and
 * the ball, so a man who wants the ball has to go AROUND him. The correction is
 * purely tangential — the challenger keeps his distance and stays in contact,
 * he is simply walked sideways out of the ball-side wedge at a bounded rate,
 * and the grip fades as his challenge starts to tell. This is a hold-off, not a
 * force field: it never pushes anyone away.
 */
function holdOff(players, ball, dt) {
  const S = ballStateFor(ball);
  const owner = S.owner;
  if (!owner || owner.down || S.ownTime < LOCO.controlSettle) return;

  const obx = ball.pos.x - owner.pos.x, obz = ball.pos.z - owner.pos.z;
  if (Math.hypot(obx, obz) < 1e-3) return;
  const ballAng = Math.atan2(obz, obx);
  const sector = LOCO.holdOffSectorDeg * DEG;

  for (const q of players) {
    if (q === owner || q.down || q.team === owner.team) continue;
    const dx = q.pos.x - owner.pos.x, dz = q.pos.z - owner.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > LOCO.holdOffRadius || d < 0.05) continue;

    let diff = Math.atan2(dz, dx) - ballAng;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) >= sector) continue;          // already round the side

    const grip = 1 - clamp(contestOf(q), 0, 1);
    if (grip <= 0.02) continue;

    const wantSide = diff >= 0 ? sector : -sector;
    const turn = clamp(wantSide - diff,
      -LOCO.holdOffTurn * grip * dt, LOCO.holdOffTurn * grip * dt);
    const c = Math.cos(turn), s = Math.sin(turn);
    q.pos.x = owner.pos.x + dx * c - dz * s;
    q.pos.z = owner.pos.z + dx * s + dz * c;

    locoState(owner).shielding = Math.min(1, locoState(owner).shielding + dt * 6);
  }
}

// ---------------------------------------------------------------------------
// public frame entry point
// ---------------------------------------------------------------------------

/**
 * One body pass for the frame. Call it after the integrator has advanced
 * positions with the requested velocities; it rewrites both velocity and
 * position with what the bodies could actually do, then resolves contact.
 */
export function stepBodies(players, dt) {
  if (!players || !players.length) return;
  const h = dt > 0 ? dt : 0;

  for (const a of players) {
    const L = locoState(a);
    L.pressure = Math.max(0, L.pressure - 3.0 * h);
    L.shielding = Math.max(0, L.shielding - 2.2 * h);
  }

  if (h > 0) for (const a of players) integrateAgent(a, h);

  const ball = players.__ball || null;
  if (ball && h > 0) holdOff(players, ball, h);

  jostle(players, h);

  // Contact happens inside the same body, so it spends the same budget: a shove
  // can redirect a man but it cannot accelerate, brake or spin him harder than
  // his legs could. This is what makes the envelope a guarantee rather than a
  // hope, and it is why a collision never reads as a teleport.
  if (h > 0) for (const a of players) enforceEnvelope(a, h);

  // baseline for next frame's drift test — AFTER every positional correction,
  // so our own pushes are never mistaken for a teleport
  for (const a of players) {
    const L = locoState(a);
    L.px = a.pos.x; L.pz = a.pos.z;
  }
}

/** Clamp this frame's total velocity change back inside the human envelope. */
function enforceEnvelope(a, dt) {
  const L = locoState(a);
  if (L.free || a.down || !a.vel) return;
  const at = attributes(a);

  let vx = a.vel.x, vz = a.vel.z;
  let sp = Math.hypot(vx, vz);
  const sp0 = L.sp0;

  let dx, dz;
  if (sp > 1e-5) { dx = vx / sp; dz = vz / sp; }
  else if (sp0 > 1e-5) { dx = L.d0x; dz = L.d0z; }
  else { a.vel.x = 0; a.vel.z = 0; L.vx = 0; L.vz = 0; return; }

  // heading budget, measured from the speed he was carrying into the frame
  if (sp0 > LOCO.turnFloorSpeed) {
    const cos = clamp(L.d0x * dx + L.d0z * dz, -1, 1);
    const ang = Math.acos(cos);
    const budget = maxTurnRate(sp0) * dt;
    if (ang > budget) {
      const cross = L.d0x * dz - L.d0z * dx;
      const t = budget * (cross >= 0 ? 1 : -1);
      const c = Math.cos(t), s = Math.sin(t);
      const nx = L.d0x * c - L.d0z * s;
      const nz = L.d0x * s + L.d0z * c;
      dx = nx; dz = nz;
    }
  }

  // speed budget
  const accelCap = LOCO.maxAccel * at.accel
    * (1 - LOCO.accelFade * clamp(sp0 / SPRINT_SPEED, 0, 1))
    * (0.78 + 0.22 * L.stamina);
  const hi = sp0 + accelCap * dt;
  const lo = Math.max(0, sp0 - LOCO.maxDecel * dt);
  if (sp > hi) sp = hi;
  else if (sp < lo) sp = lo;
  sp = Math.min(sp, speedCap(a));

  L.vx = dx * sp; L.vz = dz * sp;
  a.vel.x = L.vx; a.vel.z = L.vz;
}

// ---------------------------------------------------------------------------
// possession: who is shielding the ball, and who is winning the challenge
// ---------------------------------------------------------------------------

const BALL_STATE = new WeakMap();

function ballStateFor(body) {
  let S = BALL_STATE.get(body);
  if (!S) {
    S = {
      owner: null, ownTime: 0, ownerDown: false,
      kickId: body.kickId | 0,
      vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0,
      contest: new WeakMap(),
      challengers: [],
    };
    BALL_STATE.set(body, S);
  }
  return S;
}

/** The player currently in control of the ball, or null. */
export function shieldOwner(bodyOrPlayers) {
  if (!bodyOrPlayers) return null;
  const body = bodyOrPlayers.pos ? bodyOrPlayers : bodyOrPlayers.__ball;
  if (!body) return null;
  const S = BALL_STATE.get(body);
  return S && S.ownTime >= LOCO.controlSettle ? S.owner : null;
}

/** 0..1 progress of this player's challenge for the ball. */
export function contestOf(q) {
  return (q && q.__contest) || 0;
}

/** Has this player earned the right to take the ball off the man in front? */
export function canDispossess(q) { return contestOf(q) >= 1; }

function addContest(q, v) {
  q.__contest = clamp((q.__contest || 0) + v, 0, 1.35);
}

/**
 * Called at the top of the ball's own step, which is the first moment in the
 * frame where every controller has had its say and `body.lastTouch` is correct.
 *
 * Two jobs:
 *   1. veto a kick that a challenger has not earned — a poke or a lunge at a
 *      shielded ball does nothing until the contest is won, and an early lunge
 *      puts the challenger on the floor
 *   2. advance every live challenge from strength, momentum and which side of
 *      the carrier the challenger is on
 */
export function resolveBallContest(body, players, dt) {
  if (!body) return;
  const S = ballStateFor(body);
  const list = players && players.length ? players : null;

  // --- 1. did someone kick it since we last looked? ------------------------
  if (body.kickId !== S.kickId) {
    const kicker = body.lastTouch;
    const owner = S.owner;
    // A knockdown that landed on the carrier THIS frame is part of the challenge
    // we are about to judge, so it must not disqualify him from being shielded.
    const freshDown = !!owner && owner.down && !S.ownerDown;
    const settled = owner && S.ownTime >= LOCO.controlSettle
      && (!owner.down || freshDown);
    if (settled && kicker && kicker !== owner && kicker.team !== owner.team
        && contestOf(kicker) < 1) {
      const lunge = body.vel.y > 1.0 || body.kickPower > 8.5;

      // rewind the ball: the challenge did not connect cleanly
      body.vel.set(S.vx, S.vy, S.vz);
      body.spin.set(S.sx, S.sy, S.sz);
      body.lastTouch = owner;
      body.lastTouchTeam = owner.team;

      addContest(kicker, lunge ? LOCO.lungeCredit : LOCO.pokeCredit);
      locoState(owner).shielding = 1;

      // a knockdown that came with the failed challenge does not stand: the man
      // in possession rode it. The man who dived in is the one on the floor.
      if (owner.down) {
        owner.down = false;
        owner.downTimer = 0;
        if (owner.anim) owner.anim.play('run', { force: true });
      }
      if (lunge && contestOf(kicker) < LOCO.lungeFallBelow && !kicker.down) {
        kicker.down = true;
        kicker.downTimer = LOCO.lungeFallTime;
        if (kicker.anim) kicker.anim.play('knocked', { force: true });
      }
    }
  }

  // --- 2. who is in control now? ------------------------------------------
  let best = null, bd = LOCO.controlRadius;
  if (list && body.pos.y <= 1.1) {
    for (const p of list) {
      if (p.down) continue;
      const d = Math.hypot(body.pos.x - p.pos.x, body.pos.z - p.pos.z);
      if (d >= bd) continue;
      // a ball flying past your shins is not your ball
      const rel = Math.hypot(body.vel.x - p.vel.x, body.vel.z - p.vel.z);
      if (rel > LOCO.controlRelSpeed) continue;
      bd = d; best = p;
    }
  }
  if (best && best === S.owner) {
    S.ownTime += dt;
    S.grace = 0;
  } else if (!best && S.owner && !S.owner.down && S.grace < LOCO.controlGrace
      && Math.hypot(body.pos.x - S.owner.pos.x, body.pos.z - S.owner.pos.z)
         < LOCO.controlRadius * 1.7) {
    // he has knocked it a stride further than the control radius. That is a
    // touch, not a loss of possession — the ball is still his to run onto.
    S.grace += dt;
    S.ownTime += dt;
  } else if (best !== S.owner) {
    clearContests(S, list);
    S.owner = best;
    S.ownTime = 0;
    S.grace = 0;
  }

  // --- 3. advance the live challenges --------------------------------------
  if (list) {
    const owner = S.owner;
    const settled = owner && S.ownTime >= LOCO.controlSettle && !owner.down;
    const obx = settled ? body.pos.x - owner.pos.x : 0;
    const obz = settled ? body.pos.z - owner.pos.z : 0;
    const ob = Math.hypot(obx, obz) || 1;

    for (const q of list) {
      if (!settled || q === owner || q.team === owner.team) {
        if (q.__contest && !q.down) q.__contest = Math.max(0, q.__contest - LOCO.contestDecay * dt);
        continue;
      }
      if (q.down) continue;                       // progress freezes on the floor
      const dx = q.pos.x - owner.pos.x, dz = q.pos.z - owner.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > LOCO.contestRadius || d < 1e-4) {
        q.__contest = Math.max(0, (q.__contest || 0) - LOCO.contestDecay * dt);
        continue;
      }

      const A = attributes(owner), B = attributes(q);
      // strength: 1.0 for an even matchup
      const str = (2 * B.strength) / (A.strength + B.strength);
      // momentum: closing speed into the man
      const closing = ((owner.pos.x - q.pos.x) * q.vel.x
                     + (owner.pos.z - q.pos.z) * q.vel.z) / d;
      const mom = clamp(0.72 + closing * 0.12, 0.60, 1.45);
      // geometry: standing between the carrier and the ball is a real advantage;
      // arriving from behind his shoulder is not
      const side = ((dx * obx + dz * obz) / (d * ob));
      const shield = LOCO.contestShieldMin
        + (1 - LOCO.contestShieldMin) * clamp(side * 0.5 + 0.5, 0, 1);
      // and a set, balanced carrier is harder to shift
      const set = 1 / (0.72 + 0.28 * A.balance * (1 + 0.5 * locoState(owner).shielding));

      addContest(q, LOCO.contestBase * str * mom * shield * set * dt);
      locoState(owner).shielding = Math.min(1, locoState(owner).shielding + dt * 4);
    }
  }

  // --- 4. snapshot, so the next kick can be rewound -------------------------
  S.ownerDown = !!(S.owner && S.owner.down);
  S.kickId = body.kickId;
  S.vx = body.vel.x; S.vy = body.vel.y; S.vz = body.vel.z;
  S.sx = body.spin.x; S.sy = body.spin.y; S.sz = body.spin.z;
}

function clearContests(S, list) {
  if (!list) return;
  for (const p of list) if (p.__contest) p.__contest = 0;
}

/** Register the ball with a player list so stepBodies can run the hold-off. */
export function attachBall(players, body) {
  if (players) players.__ball = body;
}

/**
 * Wipe possession. The ball has been PLACED — a kickoff, a throw-in staged on
 * the touchline, a keeper putting it down — so nobody is shielding it and the
 * challenge veto must not fire at the man who is about to take the set piece.
 */
export function resetBallPossession(body) {
  const S = ballStateFor(body);
  clearContests(S, body.players);
  S.owner = null;
  S.ownTime = 0;
  S.grace = 0;
  S.kickId = body.kickId;
}
