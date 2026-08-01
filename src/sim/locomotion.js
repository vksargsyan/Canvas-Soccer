// Human locomotion, body-to-body contact and contested possession.
//
//   stepBodies(players, dt)                 -> one body pass for the frame
//   resolveBallContest(body, players, dt)   -> shield / challenge resolution
//   driveTo(a, tx, tz, dt, speed, slack)    -> seek helper, obeys the model
//   requestVelocity(a, vx, vz)              -> "this is where I want to go"
//   attributes(a)                           -> { mass, strength, balance, ... }
//   shieldOwner(body)                       -> who is protecting the ball
//   contestOf(q) / canDispossess(q)         -> how far his challenge has got
//   maxTurnRateDeg(speed) / speedCap(a)     -> the envelope, for tools and UI
//
// WHY THIS FILE EXISTS
// --------------------
// The sim used to move players by writing straight into `agent.vel` and then
// integrating `pos += vel * dt`. A steering routine could therefore reverse a
// sprinting player, stop him dead or double his speed inside a single frame,
// and a defender who happened to brush the ball owned it instantly. Both read
// as robots rather than footballers.
//
// THE CONTRACT
// ------------
// `agent.vel` is a REQUEST, not a fact. The first time this module sees an
// agent it takes ownership of that vector: x and z become accessors, so a write
// records what the controller ASKED FOR and a read returns what a human body
// could actually be doing about it. Everything downstream — the integrator, the
// AI's own feedback terms, the animator, the camera — sees the honest number
// without changing a line, and no external writer, not even a whistle that
// zeroes every velocity on the pitch, can produce a discontinuity.
//
// The envelope, evaluated against the velocity carried INTO the frame:
//   * bounded acceleration and deceleration — you cannot stop dead
//   * a maximum turn rate that falls with speed, from ~380 deg/s at a walk to
//     the limit of the boot's sideways grip at a sprint (v * omega <= latGrip),
//     so a sprinting player runs an arc and cannot hairpin
//   * a sharp request also scrubs speed, which is what makes a reversal read as
//     slow-plant-turn: ask for 180 deg and the target speed collapses, he
//     decelerates, the falling speed buys him turn rate, and he comes out the
//     far side about a second later
//   * body orientation lags the direction of travel, and the body leans into
//     lateral acceleration
//   * stamina drains while sprinting and caps top speed as it empties
//
// BODIES AND SHIELDING
// --------------------
// Players are bodies with mass and strength, not ghosts. Overlap is resolved by
// a soft push whose split is decided by how well each man is braced, so a
// striker leaning back into a defender gives ground slowly and a light winger
// bounces off. When a player is in control, an opponent has to get PAST that
// body to reach the ball: the hold-off walks the challenger around the wedge
// the carrier's body defends, and taking the ball is a CONTEST that fills over
// time from strength, momentum and which side of the carrier the challenger is
// on. Until it is won, a poke or a lunge at the ball is rewound and an early
// lunge leaves the challenger on the floor. Dispossession is never instant.

import {
  HALF_W, HALF_D, PLAYER_R, BALL_R, RUN_SPEED, SPRINT_SPEED,
} from '../core/constants.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

export const LOCO = {
  // --- translation ---
  maxAccel: 9.0,            // m/s^2 from a standing start
  accelFade: 0.30,          // fraction of that lost by the time you are flat out
  maxDecel: 12.0,           // m/s^2 — heels in, studs down
  // --- rotation ---
  turnWalkDeg: 380,         // deg/s of heading change at a standstill
  turnSprintDeg: 115,       // deg/s at SPRINT_SPEED, before grip is considered
  latGrip: 18,              // m/s^2 of sideways grip (~1.8 g). At pace THIS, not
                            // agility, sets the arc: v * omega <= latGrip.
  turnFloorSpeed: 0.8,      // below this you are turning on the spot
  turnSpeedFloor: 0.22,     // speed you are cut to when asked for a full reversal
  // --- orientation / lean ---
  yawLag: 12.0,             // 1/s exponential lag of the shoulders behind the feet
  yawRateDeg: 620,          // hard cap on that
  leanGain: 0.030,          // rad of lean per m/s^2 of lateral acceleration
  leanDecay: 7.0,
  // --- stamina ---
  sprintFloor: RUN_SPEED * 0.98,
  staminaDrain: 1 / 21,     // per second at a sprint
  staminaRecover: 1 / 15,   // per second when not
  staminaSpeedFloor: 0.82,  // top-speed multiplier on an empty tank
  // --- bodies ---
  bodyRadius: PLAYER_R * 0.88,   // shoulder to shoulder
  contactDamp: 0.55,        // share of the closing speed a collision kills
  braceGain: 0.55,          // extra stability from leaning into the contact
  // --- possession ---
  controlRadius: 1.60,      // ball inside this of a player becomes his...
  controlSettle: 0.16,      // ...once he has held it this long
  controlRelSpeed: 16,      // ...and it is not flying past his shins
  controlKeep: 4.20,        // and he KEEPS it out to here: a dribble touch puts
                            // the ball a stride clear by design, and a man who
                            // has to win it back on every stride is not carrying
  // --- the challenge ---
  contestRadius: 1.49,      // he has to be this tight to be working
  contestBase: 4.00,        // per second, even matchup, challenger in front
  contestShieldMin: 0.50,   // multiplier when fully shielded (challenger behind)
  contestDecay: 0.22,       // per second once he backs off
  pokeCredit: 0.14,         // progress earned by a rejected poke, and only if
  lungeCredit: 0.30,        // ...he was tight enough for it to have been a
                            // challenge at all — a lunge from two metres is a
                            // miss, not a contribution
  creditCeiling: 0.62,      // and diving in can never win it on its own: past
                            // this you have to get your body in and hold it there
  minChallenge: 0.55,       // seconds of contact a challenge takes at minimum,
                            // however strong you are. Never a snatch on contact.
  lungeFallBelow: 0.25,     // lunge this early and you end up on the floor
  lungeFallTime: 0.70,
  winKnock: 4.5,            // m/s the ball comes off him when it is finally won
  // The hold-off sits INSIDE the contest range on purpose: a man being held off
  // must be close enough to be working, or the carrier would simply orbit him at
  // arm's length and could never be tackled at all.
  holdOffRadius: 1.30,
  holdOffSectorDeg: 62,     // half-width of the wedge the carrier's body defends
  holdOffTurn: 2.5,         // rad/s the challenger is walked around him
};

// Bodies differ. Roles stand in for physique: a full back is heavy and hard to
// move, a winger is light and nimble, a striker holds the ball up.
const ROLE = {
  GK: { mass: 1.10, strength: 1.06, balance: 1.00, speed: 1.00, accel: 1.00 },
  LB: { mass: 1.10, strength: 1.10, balance: 1.06, speed: 0.97, accel: 0.97 },
  RB: { mass: 1.10, strength: 1.10, balance: 1.06, speed: 0.97, accel: 0.97 },
  LM: { mass: 0.92, strength: 0.90, balance: 0.96, speed: 1.03, accel: 1.06 },
  RM: { mass: 0.92, strength: 0.90, balance: 0.96, speed: 1.03, accel: 1.06 },
  ST: { mass: 1.06, strength: 1.08, balance: 1.08, speed: 1.00, accel: 1.00 },
};
const ROLE_DEFAULT = { mass: 1, strength: 1, balance: 1, speed: 1, accel: 1 };

/** Physique for an agent. Pure function of its role — cheap to call per frame. */
export function attributes(a) {
  return (a && ROLE[a.role]) || ROLE_DEFAULT;
}

// ---------------------------------------------------------------------------
// the envelope
// ---------------------------------------------------------------------------

/**
 * Heading change budget in rad/s at a given ground speed. Two limits, whichever
 * bites first: how fast the hips can come round (agility — dominant at walking
 * pace) and how much sideways grip the boot has (dominant at pace, because the
 * ground simply cannot give a sprinting man any more than this).
 */
export function maxTurnRate(speed) {
  const k = clamp(speed / SPRINT_SPEED, 0, 1);
  const agility = (LOCO.turnWalkDeg + (LOCO.turnSprintDeg - LOCO.turnWalkDeg) * k) * DEG;
  return Math.min(agility, LOCO.latGrip / Math.max(speed, 0.35));
}

/** Same thing in degrees, for tools and tests. */
export function maxTurnRateDeg(speed) { return maxTurnRate(speed) / DEG; }

/** Top speed this player can reach right now, given his tank. */
export function speedCap(a) {
  const L = locoState(a);
  const at = attributes(a);
  return SPRINT_SPEED * at.speed
    * (LOCO.staminaSpeedFloor + (1 - LOCO.staminaSpeedFloor) * L.stamina);
}

export function stamina(a) { return locoState(a).stamina; }

/**
 * Project a requested velocity onto what the body can deliver this frame,
 * starting from (sp0, d0) — the velocity carried into the frame. This is the
 * whole locomotion model; everything else in the file is bookkeeping.
 */
function project(a, L, out) {
  const dt = L.dt;
  const at = attributes(a);

  let rx = L.rx, rz = L.rz;
  let want = Math.hypot(rx, rz);
  const cap = speedCap(a);
  if (want > cap) { const k = cap / want; rx *= k; rz *= k; want = cap; }

  const sp0 = L.sp0;
  let dirX = L.d0x, dirZ = L.d0z;
  if (sp0 <= 1e-5) {
    if (want > 1e-5) { dirX = rx / want; dirZ = rz / want; }
    else { out.x = 0; out.z = 0; return out; }
  }

  let target = want;
  if (want > 1e-5 && sp0 > 1e-5) {
    const wx = rx / want, wz = rz / want;
    const cos = clamp(dirX * wx + dirZ * wz, -1, 1);
    if (sp0 > LOCO.turnFloorSpeed) {
      const ang = Math.acos(cos);
      const budget = maxTurnRate(sp0) * dt;
      const cross = dirX * wz - dirZ * wx;
      const t = Math.min(ang, budget) * (cross >= 0 ? 1 : -1);
      const c = Math.cos(t), s = Math.sin(t);
      const nx = dirX * c - dirZ * s;
      const nz = dirX * s + dirZ * c;
      dirX = nx; dirZ = nz;
      // asking for a turn costs pace — and losing pace is what buys the turn
      const align = 0.5 + 0.5 * cos;
      target = want * (LOCO.turnSpeedFloor + (1 - LOCO.turnSpeedFloor) * align);
    } else {
      dirX = wx; dirZ = wz;                       // pivoting on the spot is free
    }
  }

  const accel = LOCO.maxAccel * at.accel
    * (1 - LOCO.accelFade * clamp(sp0 / SPRINT_SPEED, 0, 1))
    * (0.78 + 0.22 * L.stamina);
  let sp;
  if (target > sp0) sp = Math.min(target, sp0 + accel * dt);
  else sp = Math.max(target, sp0 - LOCO.maxDecel * dt);
  sp = clamp(sp, 0, cap);

  out.x = dirX * sp;
  out.z = dirZ * sp;
  return out;
}

// ---------------------------------------------------------------------------
// per-agent state, and taking ownership of agent.vel
// ---------------------------------------------------------------------------

const _out = { x: 0, z: 0 };

/**
 * Locomotion state hangs off the agent as `agent.loco`. Creating it also
 * installs the accessors that make `agent.vel` a request — see THE CONTRACT at
 * the top of the file. Idempotent: an agent is only ever adopted once.
 */
export function locoState(a) {
  let L = a.loco;
  if (L) return L;
  L = a.loco = {
    rx: 0, rz: 0,             // what the controller asked for
    vx: 0, vz: 0,             // what the body is doing (committed)
    sp0: 0, d0x: 0, d0z: 1,   // the velocity carried into this frame
    dirty: true,
    // Is this frame's envelope still to be spent? See evaluate(): a frame's
    // worth of acceleration may be spent exactly once, between one stepBodies
    // and the next. Once commit() has settled the frame, further requests are
    // recorded but do not move the body until the next frame opens.
    open: false,
    cx: 0, cz: 0,             // cached projection of (rx, rz)
    dt: 1 / 60,
    yaw: a.yaw || 0,
    lean: 0, leanX: 0, leanZ: 0,
    stamina: 1,
    pressure: 0,
    shielding: 0,
  };
  adopt(a, L);
  return L;
}

/**
 * Bring the cached velocity up to date with the current request — but only if
 * this frame's envelope has not already been spent.
 *
 * A frame may accelerate a body ONCE. stepBodies() opens the envelope, commit()
 * closes it. Anything that writes a velocity after that — a whistle zeroing the
 * pitch in match.update(), a contact resolved after the bodies pass — is stored
 * as a request and takes effect on the next frame, instead of quietly spending
 * a second frame's worth of braking on top of the one already committed. That
 * second spend is invisible in the position (the integrator ran before it) but
 * it is entirely visible in the velocity, and it is what let a bounded 12 m/s^2
 * model report 20 m/s^2 of deceleration to anything sampling `agent.vel`.
 */
function evaluate(a, L) {
  if (L.dirty && L.open) {
    project(a, L, _out);
    L.cx = _out.x; L.cz = _out.z;
    L.dirty = false;
  }
}

/**
 * Replace `vel.x` / `vel.z` with accessors on the SAME vector object, so every
 * existing reference and every THREE.Vector3 method keeps working unchanged.
 * A write is a request; a read is what the body could do about it. `y` is left
 * alone — agents do not use it, and the ball is never adopted.
 */
function adopt(a, L) {
  const v = a.vel;
  if (!v || v.__loco) return;
  L.rx = v.x || 0; L.rz = v.z || 0;
  L.vx = L.rx; L.vz = L.rz;
  L.sp0 = Math.hypot(L.vx, L.vz);
  if (L.sp0 > 1e-5) { L.d0x = L.vx / L.sp0; L.d0z = L.vz / L.sp0; }
  L.cx = L.vx; L.cz = L.vz;
  L.dirty = false;
  Object.defineProperty(v, '__loco', { value: true, enumerable: false });
  Object.defineProperty(v, 'x', {
    configurable: true,
    enumerable: true,
    get() { evaluate(a, L); return L.cx; },
    set(val) { L.rx = val; L.dirty = true; },
  });
  Object.defineProperty(v, 'z', {
    configurable: true,
    enumerable: true,
    get() { evaluate(a, L); return L.cz; },
    set(val) { L.rz = val; L.dirty = true; },
  });
}

// ---------------------------------------------------------------------------
// controller-facing API
// ---------------------------------------------------------------------------

/** Ask for a ground velocity. The model decides what actually happens. */
export function requestVelocity(a, vx, vz) {
  const L = locoState(a);
  L.rx = vx; L.rz = vz; L.dirty = true;
  return a;
}

/** Ask for a stop. He still has to brake for it. */
export function requestStop(a) { return requestVelocity(a, 0, 0); }

/**
 * Seek: aim at (tx,tz) at up to `speed`, easing off on arrival. Returns the
 * distance remaining. A drop-in replacement for a hand-rolled steering blend —
 * the smoothing is the locomotion model's job now, not the caller's.
 */
export function driveTo(a, tx, tz, dt, speed, slack = 0.08) {
  const dx = tx - a.pos.x, dz = tz - a.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < slack) { requestVelocity(a, 0, 0); return d; }
  const want = Math.min(speed, d * 3.4 + 1.2);
  requestVelocity(a, (dx / d) * want, (dz / d) * want);
  return d;
}

// ---------------------------------------------------------------------------
// bodies: soft separation, bracing, hold-off
// ---------------------------------------------------------------------------

/** How hard this player is to shift along (nx,nz) right now. */
function stability(a, nx, nz) {
  const L = locoState(a);
  const at = attributes(a);
  let s = at.mass * (0.55 + 0.45 * at.strength);
  // leaning into the contact braces you; being shoved from behind does not
  const into = -(L.vx * nx + L.vz * nz);
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
    const La = locoState(a);
    for (let j = i + 1; j < n; j++) {
      const b = players[j];
      if (b.down) continue;
      const Lb = locoState(b);
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      const pen = min - d;

      const sa = stability(a, nx, nz);
      const sb = stability(b, -nx, -nz);
      const wa = sb / (sa + sb);
      const wb = 1 - wa;

      a.pos.x -= nx * pen * wa; a.pos.z -= nz * pen * wa;
      b.pos.x += nx * pen * wb; b.pos.z += nz * pen * wb;

      // Shoulder charge: kill part of the closing speed. It goes in as a
      // REQUEST, so contact spends the same envelope the legs do and can never
      // fling anybody across the pitch.
      const rvn = (Lb.vx - La.vx) * nx + (Lb.vz - La.vz) * nz;
      if (rvn < 0) {
        const j2 = -rvn * LOCO.contactDamp;
        requestVelocity(a, La.rx - nx * j2 * wa, La.rz - nz * j2 * wa);
        requestVelocity(b, Lb.rx + nx * j2 * wb, Lb.rz + nz * j2 * wb);
        const shove = clamp(-rvn / SPRINT_SPEED, 0, 1);
        if (shove > La.pressure) La.pressure = shove;
        if (shove > Lb.pressure) Lb.pressure = shove;
      }

      La.lean = clamp(La.lean - pen * 0.35, -0.6, 0.6);
      Lb.lean = clamp(Lb.lean + pen * 0.35, -0.6, 0.6);
    }
  }
}

/**
 * Hold-off. The carrier's body occupies the wedge between the challenger and
 * the ball, so a man who wants it has to go AROUND. The correction is purely
 * tangential — the challenger keeps his distance and stays in the contest, he
 * is simply walked sideways out of the ball-side wedge at a bounded rate, and
 * the grip fades as his challenge starts to tell. A hold-off, not a force field.
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
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
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
// the frame
// ---------------------------------------------------------------------------

/**
 * One body pass. Call it once per frame, after the integrator has advanced
 * positions. It resolves contact, then commits each body's velocity for the
 * frame and opens the next frame's envelope.
 */
export function stepBodies(players, dt) {
  if (!players || !players.length) return;
  const h = dt > 0 ? dt : 0;

  for (const a of players) {
    const L = locoState(a);
    if (h > 0) L.dt = h;
    L.open = true;                  // this frame's envelope is now available
    L.pressure = Math.max(0, L.pressure - 3.0 * h);
    L.shielding = Math.max(0, L.shielding - 2.2 * h);
  }

  const ball = players.__ball || null;
  if (ball && h > 0) holdOff(players, ball, h);
  if (h > 0) jostle(players, h);

  for (const a of players) commit(a, h);
}

/** Settle this frame's velocity and roll the envelope forward. */
function commit(a, dt) {
  const L = locoState(a);

  // A man on the floor obeys the envelope too: whoever is damping him is making
  // a request like everybody else, so he slides to a stop instead of stopping in
  // one frame — and a knockdown that gets cancelled (see resolveBallContest)
  // leaves no discontinuity behind it.
  evaluate(a, L);
  const nvx = L.cx, nvz = L.cz;
  const sp = Math.hypot(nvx, nvz);
  const dirX = sp > 1e-5 ? nvx / sp : L.d0x;
  const dirZ = sp > 1e-5 ? nvz / sp : L.d0z;

  if (dt > 0 && !a.down) {
    // lean into whatever lateral acceleration this frame produced
    const lat = ((nvx - L.vx) / dt) * -dirZ + ((nvz - L.vz) / dt) * dirX;
    const k = 1 - Math.exp(-LOCO.leanDecay * dt);
    L.lean += (clamp(lat * LOCO.leanGain, -0.55, 0.55) - L.lean) * k;
    L.leanX = -dirZ * L.lean;
    L.leanZ = dirX * L.lean;
    a.lean = L.lean;

    // the shoulders trail the feet
    if (sp > 0.35) {
      const wantYaw = Math.atan2(dirX, dirZ);
      let d = wantYaw - L.yaw;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const rate = LOCO.yawRateDeg * DEG * dt;
      L.yaw += clamp(d * (1 - Math.exp(-LOCO.yawLag * dt)), -rate, rate);
    }
    a.bodyYaw = L.yaw;
  }

  L.vx = nvx; L.vz = nvz;
  L.sp0 = sp;
  if (sp > 1e-5) { L.d0x = dirX; L.d0z = dirZ; }
  // the request settles onto what actually happened, so a controller that says
  // nothing next frame is asking to carry on doing what it is doing
  L.rx = nvx; L.rz = nvz;
  L.cx = nvx; L.cz = nvz;
  L.dirty = false;
  L.open = false;                   // spent: later writes wait for the next frame

  // keep everybody on the planet
  a.pos.x = clamp(a.pos.x, -HALF_W - 2.5, HALF_W + 2.5);
  a.pos.z = clamp(a.pos.z, -HALF_D - 2.0, HALF_D + 2.0);

  tickStamina(a, L, a.down ? 0 : sp, dt);
}

function tickStamina(a, L, sp, dt) {
  if (sp > LOCO.sprintFloor) {
    L.stamina = clamp(L.stamina - LOCO.staminaDrain * dt, 0, 1);
  } else {
    L.stamina = clamp(L.stamina + LOCO.staminaRecover * dt * (sp < 2 ? 1.4 : 1), 0, 1);
  }
  a.stamina = L.stamina;
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
    };
    BALL_STATE.set(body, S);
  }
  return S;
}

/** The player currently in control of the ball, or null. */
export function shieldOwner(body) {
  if (!body) return null;
  const b = body.pos ? body : body.__ball;
  if (!b) return null;
  const S = BALL_STATE.get(b);
  return S && S.owner && !S.owner.down && S.ownTime >= LOCO.controlSettle
    ? S.owner : null;
}

/** Possession snapshot for the HUD and for tools: { owner, ownTime }. */
export function possession(body) {
  const b = body && (body.pos ? body : body.__ball);
  const S = b && BALL_STATE.get(b);
  return S ? { owner: S.owner, ownTime: S.ownTime } : { owner: null, ownTime: 0 };
}

/** 0..1 progress of this player's challenge for the ball. */
export function contestOf(q) { return (q && q.__contest) || 0; }

/** Has he earned the right to take it off the man in front of him? */
export function canDispossess(q) { return contestOf(q) >= 1; }

function addContest(q, v, ceiling = 1.2) {
  const at = q.__contest || 0;
  if (at >= ceiling) return;
  q.__contest = clamp(at + v, 0, ceiling);
}

function clearContests(list) {
  if (!list) return;
  for (const p of list) { if (p.__contest) p.__contest = 0; p.__contestT = 0; }
}

/** Register the ball with a player list so stepBodies can run the hold-off. */
export function attachBall(players, body) {
  if (players) players.__ball = body;
}

/**
 * Wipe possession. The ball has been PLACED — kickoff, a throw staged on the
 * touchline, a keeper putting it down — so nobody is shielding it and the veto
 * must not fire at the man about to take the set piece.
 */
export function resetBallPossession(body) {
  const S = ballStateFor(body);
  clearContests(body.players);
  S.owner = null;
  S.ownTime = 0;
  S.kickId = body.kickId;
}

/**
 * Called at the top of the ball's own step — the first moment in the frame
 * where every controller has had its say and `body.lastTouch` is correct.
 *
 *  1. veto a kick the challenger has not earned. A poke or a lunge at a
 *     shielded ball does nothing until the contest is won, and an early lunge
 *     puts the challenger on the floor rather than the carrier.
 *  2. work out who is in control, with hysteresis so a dribble touch is not
 *     mistaken for losing the ball.
 *  3. advance every live challenge, and settle it when one is won.
 */
export function resolveBallContest(body, players, dt) {
  if (!body) return;
  const S = ballStateFor(body);
  const list = players && players.length ? players : null;

  // --- 1. a kick since we last looked --------------------------------------
  if (body.kickId !== S.kickId) {
    const kicker = body.lastTouch;
    const owner = S.owner;
    // A knockdown that landed on the carrier THIS frame is part of the
    // challenge we are judging, so it must not disqualify him from shielding.
    const freshDown = !!owner && owner.down && !S.ownerDown;
    const settled = owner && S.ownTime >= LOCO.controlSettle
      && (!owner.down || freshDown);
    if (settled && kicker && kicker !== owner && kicker.team !== owner.team
        && contestOf(kicker) < 1) {
      const lunge = body.vel.y > 1.0 || body.kickPower > 8.5;

      body.vel.set(S.vx, S.vy, S.vz);
      body.spin.set(S.sx, S.sy, S.sz);
      body.lastTouch = owner;
      body.lastTouchTeam = owner.team;

      const reach = Math.hypot(kicker.pos.x - owner.pos.x, kicker.pos.z - owner.pos.z);
      if (reach <= LOCO.contestRadius) {
        addContest(kicker, lunge ? LOCO.lungeCredit : LOCO.pokeCredit,
          LOCO.creditCeiling);
      }
      locoState(owner).shielding = 1;

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

  // --- 2. who is in control ------------------------------------------------
  // Possession is anchored on the LAST TOUCH, not on who happens to be nearest.
  // A carrier pushes the ball a stride ahead of himself on every touch, so a
  // defender coming the other way is repeatedly the nearest man to it without
  // ever having got near TAKING it. Nearest-wins made possession strobe, and
  // every strobe wiped the challenges in progress. The man who last played it
  // keeps it until somebody else plays it or wins the contest below.
  let best = null;
  if (list && body.pos.y <= 1.1) {
    const lt = body.lastTouch;
    if (lt && !lt.down && lt.pos) {
      const d = Math.hypot(body.pos.x - lt.pos.x, body.pos.z - lt.pos.z);
      const rel = Math.hypot(body.vel.x - lt.vel.x, body.vel.z - lt.vel.z);
      // He has to have had it under control once to keep it out to controlKeep,
      // and he has to still be the nearest man to it — that is the difference
      // between a heavy touch he will run onto and a pass that has left him.
      let nearest = true;
      if (lt === S.owner) {
        for (const p of list) {
          if (p === lt || p.down) continue;
          if (Math.hypot(body.pos.x - p.pos.x, body.pos.z - p.pos.z) < d) {
            nearest = false; break;
          }
        }
      }
      const keep = (lt === S.owner && nearest) ? LOCO.controlKeep : LOCO.controlRadius;
      if (d <= keep && rel <= LOCO.controlRelSpeed * 1.5) best = lt;
    }
    if (!best) {
      let bd = LOCO.controlRadius;
      for (const p of list) {
        if (p.down) continue;
        const d = Math.hypot(body.pos.x - p.pos.x, body.pos.z - p.pos.z);
        if (d >= bd) continue;
        const rel = Math.hypot(body.vel.x - p.vel.x, body.vel.z - p.vel.z);
        if (rel > LOCO.controlRelSpeed) continue;
        bd = d; best = p;
      }
    }
  }

  if (best && best === S.owner) S.ownTime += dt;
  else if (best !== S.owner) {
    clearContests(list);
    S.owner = best;
    S.ownTime = 0;
  }

  // --- 3. the live challenges ----------------------------------------------
  if (list) {
    const owner = S.owner;
    const settled = owner && S.ownTime >= LOCO.controlSettle && !owner.down;
    const obx = settled ? body.pos.x - owner.pos.x : 0;
    const obz = settled ? body.pos.z - owner.pos.z : 0;
    const ob = Math.hypot(obx, obz) || 1;

    for (const q of list) {
      if (!settled || q === owner || q.team === owner.team) {
        if (q.__contest && !q.down) {
          q.__contest = Math.max(0, q.__contest - LOCO.contestDecay * dt);
        }
        continue;
      }
      if (q.down) continue;                     // progress freezes on the floor
      const dx = q.pos.x - owner.pos.x, dz = q.pos.z - owner.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > LOCO.contestRadius || d < 1e-4) {
        q.__contest = Math.max(0, (q.__contest || 0) - LOCO.contestDecay * dt);
        q.__contestT = Math.max(0, (q.__contestT || 0) - dt * 0.12);
        continue;
      }

      const A = attributes(owner), B = attributes(q);
      const str = (2 * B.strength) / (A.strength + B.strength);
      const closing = ((owner.pos.x - q.pos.x) * q.vel.x
                     + (owner.pos.z - q.pos.z) * q.vel.z) / d;
      const mom = clamp(0.72 + closing * 0.12, 0.60, 1.45);
      // geometry: getting between the man and the ball is a real advantage,
      // arriving from behind his shoulder is not
      const side = (dx * obx + dz * obz) / (d * ob);
      const shield = LOCO.contestShieldMin
        + (1 - LOCO.contestShieldMin) * clamp(side * 0.5 + 0.5, 0, 1);
      const set = 1 / (0.72 + 0.28 * A.balance
        * (1 + 0.5 * locoState(owner).shielding));

      addContest(q, LOCO.contestBase * str * mom * shield * set * dt);
      q.__contestT = (q.__contestT || 0) + dt;
      locoState(owner).shielding = Math.min(1, locoState(owner).shielding + dt * 4);

      // Won. He got his body in and the ball comes off the carrier, out toward
      // the side he came from and live for both of them. This is the only way a
      // shielded ball changes hands, and it took as long as the contest took.
      if (contestOf(q) >= 1 && (q.__contestT || 0) >= LOCO.minChallenge) {
        const nx = dx / d, nz = dz / d;
        const pace = LOCO.winKnock + clamp(closing, 0, 7) * 0.35;
        body.vel.x = nx * pace + q.vel.x * 0.35;
        body.vel.z = nz * pace + q.vel.z * 0.35;
        body.vel.y = 0;
        body.spin.set(body.vel.z / BALL_R, body.spin.y * 0.4, -body.vel.x / BALL_R);
        body.lastTouch = q;
        body.lastTouchTeam = q.team;
        body.kickId++;
        owner.cool = Math.max(owner.cool || 0, 0.4);
        owner.hasBall = false;
        locoState(owner).shielding = 0;
        clearContests(list);
        // He owns it from this instant. Without that the man he just beat is
        // still standing over the ball and his own collider would reclaim the
        // last touch on the very next line, so the challenge he lost would look
        // like it never happened.
        S.owner = q;
        S.ownTime = LOCO.controlSettle;
        break;
      }
    }
  }

  // --- 4. snapshot, so the next kick can be rewound ------------------------
  S.ownerDown = !!(S.owner && S.owner.down);
  S.kickId = body.kickId;
  S.vx = body.vel.x; S.vy = body.vel.y; S.vz = body.vel.z;
  S.sx = body.spin.x; S.sy = body.spin.y; S.sz = body.spin.z;
}
