// Ball control: possession, close-control dribbling, and the first touch.
//
//   import { createBallControl } from './control.js';
//   const control = createBallControl({ agents, body, rng, events });
//
//   control.update(dt)                    // possession bookkeeping + receiving
//   control.carry(a, dt, aimX, aimZ, opt) // one dribble step for the man on the ball
//   control.reset()
//
// WHY THIS FILE EXISTS
// --------------------
// Before this module the ball was a loose object that players booted: the carry
// was "if the ball is closer than CARRY_R, kick it at RUN_SPEED in the running
// direction, every 0.3 s". That produces exactly the complaint it earned — the
// ball leaves at 8 m/s while the man accelerates at 34 m/s^2 behind it, so the
// gap opens to nine metres and the whole match reads as kicking it through the
// pitch. A ball a player CARRIES is a different model, and it is a well known
// one. Two mechanisms, both implemented here:
//
// 1. THE DRIBBLE POCKET (an impulse, and nothing but an impulse)
//    A touch is a foot on a ball: one pace, applied once, along a direction he
//    chooses. It is deliberately BLIND to where the ball will be next frame and
//    to how far away it is now, and that is the whole design.
//
//        u = s + push(s)            push = PUSH_BASE + PUSH_PER_MS * s
//
//    Nothing else runs. Between touches the ball's position comes entirely from
//    sim/physics.js — velocity, skid, roll, drag — and the player's transform
//    has no say in it whatsoever.
//
//    THIS FILE USED TO DO THE OPPOSITE and it is worth spelling out, because the
//    result passed every metric and was obviously fake. The old touch SOLVED for
//    the pace that would put the ball in a speed-scaled pocket at the instant of
//    the next touch: u = D/T + 0.5*a*T for D = |pocket - ball|. That is a servo.
//    In steady state it forces D = s*T, so u - s = 0.5*a*T, so the gap peaks at
//    only a*T^2/8 above the pocket — 4 cm at a sprint. Measured on the old code
//    the gap sat between 0.588 m and 0.73 m for an entire five second run and
//    the ball was ahead on 100% of frames. Not a dribble. A ball on a stick.
//    Any "put the ball where it ought to be" term reintroduces that, however it
//    is dressed up, so there is none here.
//
//    RHYTHM comes from the ball, not from a timer. A touch needs two things: a
//    FOOTFALL (a stride phase tied to running speed, so contact lands on a step)
//    and the ball actually within playing distance of his boot. Push it out and
//    he cannot touch it again until he has run it down — which is exactly the
//    ball-out / chase / ball-out cycle a carry is made of. Measured at a sprint
//    the gap now swings 0.6 m -> 1.1 m and back roughly three times a second at
//    a walk, 1.4 times a second flat out.
//
//    A dribble touch is STABBED, not rolled. body.kick() leaves a ball with the
//    exact topspin for a true roll, which is right for a pass and wrong for a
//    knock-on: it means the only thing slowing the ball is rolling resistance,
//    so a touch big enough to see takes two seconds to come back. So the touch
//    keeps only a fraction of that spin (TOUCH_SKID) and the ball skids before
//    it bites — sim/physics.js already models the contact patch properly, and
//    MU_SLIDE puts ~9.4 m/s^2 on a sliding ball against 2.35 for a rolling one.
//    The ball surges out and checks up. That is what makes a big touch and a
//    fast touch rate compatible instead of a straight trade.
//
//    Speed loosens control three ways: a longer push, a bigger touch error, and
//    turn swing. A carried ball keeps its old line for a beat when the man
//    changes direction, so the touch lands on the OUTSIDE of the turn, scaled by
//    turn rate * speed — and the harder he is turning the less the touch is
//    allowed to correct the ball back onto his new line, so it genuinely runs
//    wide of him rather than snapping in front of his chest. And a touch taken
//    with the ball already wide of his line, at pace, is the one allowed to
//    break the ceiling and run loose — so turning hard at a sprint can cost
//    possession, while the same turn at a walk cannot.
//
// 2. THE FIRST TOUCH (kill it, do not bounce it)
//    sim/physics.js resolves a ball against a player as a restitution collision
//    with momentum transfer, which is right for a shin deflection and wrong for
//    a pass played to feet — the ball pings off at 60% of its arrival pace and
//    the receiver chases it. So a controlled reception is intercepted BEFORE the
//    collider ever sees it (this module runs inside the AI step, physics runs
//    after): the incoming pace is killed outright and replaced with the same
//    kind of impulse a dribble touch uses, knocked into his stride ready to run
//    with. Same rule as above — the trap sets a velocity, never a position.
//
//    A perfect trap every time is robotic, so difficulty is scored — arrival
//    speed, angle (a ball over the shoulder is far harder than one into the
//    path), bounce height, and how many opponents are breathing on him — and
//    rolled against. A failed roll gives a genuine bad touch: a chunk of the
//    pace survives, the ball squirts off line and sometimes bobbles up, and the
//    contest for it is live. That variability is the point.
//
// EVERYTHING HERE IS DETERMINISTIC. Every stochastic choice draws from the
// seeded stream handed in as `ctx.rng`; nothing calls Math.random(). Same seed,
// same frame, same touch.
//
// OWNERSHIP / INTERFACE
// ---------------------
// This module owns the ball<->carrier relationship and nothing else. It never
// steers a player (sim/ai.js decides WHERE to go, this decides what the ball
// does about it), never reads the pitch phase, and never touches rendering.
// Callers hand in the aim point they are already steering toward.

import * as THREE from 'three';
import {
  BALL_R, PLAYER_R, HALF_W, HALF_D, RUN_SPEED, SPRINT_SPEED,
} from '../core/constants.js';

// --- reach ------------------------------------------------------------------
// sim/physics.js resolves a boot-height contact at PLAYER_R*0.72 + BALL_R*0.95,
// so this is the closest the ball is ever allowed to sit: the collider pushes it
// back out to exactly here, which makes it the floor of every gap this module
// can produce.
export const CONTACT_R = PLAYER_R * 0.72 + BALL_R * 0.95;   // 0.588 m

// How far from his boot the ball may be and still be PLAYABLE. This is the gate
// that gives the pocket its rhythm: push the ball out and there is simply no
// touch available until he has run it back down. It is the difference between
// "touch every 0.4 s because a timer said so" and "touch it when you get to it".
// A man at full pelt can stretch a little further for it than a man jogging.
const REACH_WALK = 0.72;
const REACH_SPRINT = 0.88;
// If a touch leaves the ball hanging just out of reach — he matched its pace
// instead of running it down — he lunges for it rather than letting it drift.
const REACH_STRETCH = 1.14;
const TOUCH_STALE = 0.85;         // s without a touch before he stretches
const STRETCH_OFF = 1.20;         // rad across his body before he throws a leg at it
const LASTCHANCE_R = 1.04;        // m at which a ball off his line gets one anyway
const LASTCHANCE_OFF = 0.70;      // rad off his line for that to count as leaving
const FOOT_BAND = 0.09;           // m past the collider radius that counts as "on his boot"

// The hard ceiling on how far a controlled touch may ever put the ball. Kept
// under sim/ai.js's CARRY_R (PLAYER_R + BALL_R + 0.42 = 1.16 m) on purpose: past
// that radius the AI stops recognising him as the carrier, the carry logic drops
// out and the ball is loose again. A carry model that quietly loses its own
// possession flag every few strides is worse than no carry model. This bounds
// the IMPULSE — it caps how hard he may hit it — it does not place the ball.
const GAP_CEILING = 1.35;

// --- the touch --------------------------------------------------------------
// Pace over his own, so the ball runs away from him and he has to catch it. It
// scales with speed, which is what makes the pocket run longer at a sprint: at a
// walk the ball barely leaves his feet, flat out it is knocked a full stride in
// front and he sprints onto it.
const PUSH_BASE = 0.55;           // m/s of pace over his own, standing still
const PUSH_PER_MS = 0.34;        // ...and per m/s he is running
const PUSH_PRESSED = 0.74;        // shorter, safer touches with a man on him

// Share of true rolling spin a stabbed touch leaves on the ball. body.kick()
// hands out the exact topspin for a true roll (right for a pass, wrong for a
// knock-on); keeping only a fraction of it means the ball skids before it bites,
// and sim/physics.js puts MU_SLIDE * g ~ 9.4 m/s^2 on a sliding ball against
// ROLL_RES 2.35 on a rolling one. The touch surges out and checks up, which is
// what lets it be big enough to see and still come back inside a stride.
const TOUCH_SKID = 0.6;

// Share of the ball's existing SIDEWAYS momentum a touch leaves on it. A boot
// cannot teleport a rolling ball onto a new line, and pretending it can is the
// second half of welding the ball to the player: it lets him turn through ninety
// degrees and find the ball already back in front of him. See strikeBall().
const TOUCH_KEEP = 0.6;

// Effective deceleration of a touched ball over the stride that follows, used
// ONLY to bound the impulse against GAP_CEILING — never to place the ball or to
// time anything. Not a free parameter: it is ROLL_RES (2.35) plus the quadratic
// drag term at dribbling pace plus the skid check-up, measured against
// sim/physics.js at 12-14 m/s.
const TOUCH_DECEL = 6.4;

// --- stride ----------------------------------------------------------------
// Footfall frequency — how often a boot is on the ground and therefore able to
// play the ball. NOT the touch rate: most footfalls come round with the ball
// still out in front and nothing happens. The touch rate falls out of the ball's
// own run-out, quantised to these.
const STRIDE_HZ_BASE = 1.90;
const STRIDE_HZ_PER_MS = 0.115;
const STRIDE_HZ_MIN = 1.90;
const STRIDE_HZ_MAX = 3.20;
const STRIDE_STANCE = 0.42;       // share of the stride cycle with a boot on the deck
const TOUCH_REFRACTORY = 0.22;    // s; two touches can never land closer than this
const STRETCH_REFRACTORY = 0.10;  // ...but a leg thrown at a leaving ball may be quicker

const SWING_K = 0.019;            // rad of turn swing, per (rad/s * m/s)
const SWING_MAX = 0.42;           // rad of swing on the hardest turn
const SWING_OFF_FADE = 0.80;      // rad off his line at which swing is done

// How hard a touch drags a ball that has drifted off his line back onto it. This
// is a DIRECTION choice and only a direction choice — he aims the touch across
// himself, he does not decide where the ball ends up. Turning hard costs him the
// correction: mid-turn the ball keeps running wide instead of snapping in front.
const LINE_PULL = 0.85;
const LINE_PULL_TURN = 0.55;      // share of it lost per rad/s of turn
const LINE_PULL_MIN = 0.35;       // ...but he never stops trying to keep it
// The run-out a touch is aimed over, which is what turns a lateral offset into a
// sane angle. See the aim block in carry() for why this is not just "a stride".
const AIM_BASE = 1.20;
const AIM_PER_MS = 0.28;
// The most a touch may be aimed off the line he is actually running. A body
// turns at roughly 2 rad/s at a sprint (sim/locomotion.js), so half a radian is
// about what he can come round onto before the ball has stopped; at a walk he
// can turn on it far more freely.
const AIM_OFF_SPRINT = 0.50;
const AIM_OFF_WALK = 1.30;
// How a touch turns from a knock-on into a recovery as the ball goes wide.
const RECOVER_ON = 0.45;          // rad off his line where it starts
const RECOVER_SPAN = 0.85;        // rad over which it is fully a recovery
const RECOVER_AIM = 0.74;         // share of the aim run-out it takes off
const RECOVER_KEEP = 0.85;        // share of the kept sideways momentum it kills
const CORRECT_MAX = 1.05;         // rad — a touch is never swung backwards
const RECOVER_PUSH = 0.80;        // share of the power a stretched leg has not got

const EDGE_TURN = 2.4;            // m from a line at which touches turn infield
const EDGE_TURN_K = 1.5;          // how hard the aim swings away from it

// Turning hard at pace must be able to cost you the ball, or a carry is a
// guarantee and there is no reason to ever slow down. Only a touch taken with
// the ball already wide of his line, at pace, may break GAP_CEILING — out to
// LOOSE_CEILING, which is loose enough that sim/ai.js drops him as the carrier
// and the ball is genuinely there to be won.
const LOOSE_OFF_ON = 0.42;        // rad off his line before a touch can be heavy
const LOOSE_OFF_SPAN = 0.85;      // rad over that at which it is as loose as it gets
const LOOSE_CEILING = 2.30;       // m a heavy touch may put it — loose enough to lose

// The ordinary scuffed touch: across the ball rather than through it. See the
// block in carry() — this is what stops a straight-line carry being a ball on
// a stick, and it is the same event that gives a defender something to press.
const SCUFF_K = 0.44;             // rate, per (pace * lack of competence)
const SCUFF_TIGHT = 0.12;         // share of that rate that survives on a ball at his feet
const SCUFF_MAX = 0.20;           // never more than one touch in five
const SCUFF_ANG = 0.34;           // rad it goes across him, minimum
const SCUFF_ANG_SPAN = 0.16;      // ...and the spread above that
const SCUFF_PACE = 0.88;          // share of his own pace the ball is left with
const SCUFF_REFRACTORY = 0.44;    // s before he has his feet back under him

// --- receiving --------------------------------------------------------------
const TRAP_R = 1.15;              // reach at which a player can take a ball down
const TRAP_MIN_SPEED = 2.4;       // below this the ball is a loose roll, not a pass
const TRAP_MIN_CLOSING = 1.5;     // m/s of closing speed before it is a reception
const TRAP_MAX_HEIGHT = 1.45;     // above this it is a header, not a trap
const TRAP_PUSH = 0.62;           // share of a dribble knock a settling touch is
const TRAP_PULL = 0.90;           // how squarely he takes it back onto his line
const TRAP_KEEP = 0.16;           // share of arrival pace a scruffy touch leaves on
const TRAP_COOLDOWN = 0.35;       // s before the same man may re-take the ball
const GATHER_MIN_SPEED = 2.5;     // m/s he must be running to gather a dead ball
const SELF_RECOVER = 0.55;        // s before the last toucher may reclaim his own ball
const SELF_KEEP_R = 3.20;         // m out to which his own dribble touch is still his

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export function createBallControl(ctx) {
  const agents = ctx.agents;
  const body = ctx.body;
  const rng = ctx.rng;
  const events = ctx.events || {};

  const state = new Map();          // agent -> per-player control state
  let t = 0;                        // module clock, advanced by update()
  let seenKickId = body ? body.kickId : 0;

  function stateOf(a) {
    let st = state.get(a);
    if (!st) {
      st = {
        phase: rng ? rng.float() : 0,   // stride phase, so a team is not in lockstep
        headYaw: 0,
        hasHeading: false,
        turn: 0,                        // smoothed turn rate of the carry line, rad/s
        lastTouchT: -99,
        kickedAt: -99,                  // last deliberate kick (pass/shot) by this man
        touches: 0,
        trapQ: 1,
        badTouch: false,
        // Is the ball he last touched one he is CARRYING? A ball he knocked in
        // front of himself on purpose is not a ball arriving at him, and the
        // reception path below must leave it alone: run a first touch on your own
        // dribble and every few strides you roll for a bad one and knock your own
        // ball into the corner — which is precisely how this module used to lose
        // possession for reasons that looked like nothing at all. Cleared by a
        // heavy touch, so that one is genuinely there to be won.
        carrying: false,
        scuffed: false,             // the last touch came off the wrong part of the boot
      };
      state.set(a, st);
    }
    return st;
  }

  // --- helpers --------------------------------------------------------------

  function speedOf(a) { return Math.hypot(a.vel.x, a.vel.z); }

  function ballSpeed() { return Math.hypot(body.vel.x, body.vel.z); }

  function gapTo(a) { return Math.hypot(body.pos.x - a.pos.x, body.pos.z - a.pos.z); }

  /** how many opponents are inside `r` of `a` */
  function pressureOn(a, r) {
    let n = 0;
    for (const o of agents) {
      if (o === a || o.team === a.team || o.down) continue;
      const dx = o.pos.x - a.pos.x, dz = o.pos.z - a.pos.z;
      if (dx * dx + dz * dz < r * r) n++;
    }
    return n;
  }

  /**
   * How strongly a touch taken this close to a line has to be turned back
   * infield. Zero over most of the pitch, 1 on the paint.
   */
  function edgeBias(v, half) {
    const in_ = half - EDGE_TURN - Math.abs(v);
    if (in_ >= 0) return 0;
    return Math.sign(v) * clamp(-in_ / EDGE_TURN, 0, 1);
  }

  /** how far in front of his boot a ball is still playable at speed `s` */
  function reachFor(s) {
    const f = clamp(s / SPRINT_SPEED, 0, 1);
    return REACH_WALK + (REACH_SPRINT - REACH_WALK) * f;
  }

  /**
   * How hard he knocks it, as pace OVER his own. This is the entire strength
   * model: a function of how fast he is running and nothing else. It never sees
   * the ball's position, so it cannot become a spring.
   */
  function pushFor(s, pressed) {
    const p = PUSH_BASE + PUSH_PER_MS * Math.max(0, s);
    return pressed ? p * PUSH_PRESSED : p;
  }

  /**
   * The most pace a touch may carry without putting the ball further than
   * `ceil` from him before he is back level with it. The ball leaves at
   * dir * u + w, where w is whatever the touch did not take off it, so what has
   * to be bounded is the speed RELATIVE to him:
   *
   *   gap_peak = gap_now + |v_rel|^2 / (2 a)   =>   |v_rel| <= sqrt(2 a headroom)
   *
   * A bound on the impulse, evaluated once, at the instant of contact. It is the
   * only thing in the touch that reads the current gap at all, and all it can do
   * is hit it softer — it can never pull the ball in, and it never touches the
   * direction.
   */
  function paceCap(dirX, dirZ, wx, wz, gapNow, ceil) {
    const rvMax = Math.sqrt(2 * TOUCH_DECEL * Math.max(0.02, ceil - gapNow));
    // |dir*u + w| = rvMax  ->  u^2 + 2u(dir.w) + |w|^2 - rvMax^2 = 0
    const b = dirX * wx + dirZ * wz;
    const c = wx * wx + wz * wz - rvMax * rvMax;
    const disc = b * b - c;
    // No pace at all satisfies the bound — the ball is already going to end up
    // further away than the ceiling whatever he does, usually because it is
    // behind him and he is sprinting. The cap has nothing to say, so it says
    // nothing. (Returning the softest touch here instead was a real bug: it
    // stopped the ball stone dead behind a man at ten metres a second, and he
    // then had to turn round and run four metres back to it.)
    if (disc <= 0) return Infinity;
    return Math.max(0.2, -b + Math.sqrt(disc));
  }

  /**
   * The part of the ball's current velocity that a touch along (dx, dz) does NOT
   * take off it — see strikeBall()'s `keep`.
   */
  function keptMomentum(dx, dz, keep, out) {
    const along = body.vel.x * dx + body.vel.z * dz;
    out.x = (body.vel.x - along * dx) * keep;
    out.z = (body.vel.z - along * dz) * keep;
    return out;
  }

  /**
   * Put the ball on its way, and record the contact against `a`.
   *
   * `skid` is how much of a true roll the ball leaves with: 1 is body.kick()'s
   * own exact-roll topspin (a passed ball, which keeps running), lower means the
   * ball slides on the grass first and checks up hard. A dribble touch is a stab
   * and skids; a trap sets it rolling.
   *
   * `keep` is the share of the ball's EXISTING sideways momentum that survives
   * the contact. body.kick() overwrites the velocity outright, which is right
   * for a struck pass and wrong for a boot brushing a ball that is already
   * rolling: it lets a touch swing the ball through ninety degrees in one frame,
   * so a man can turn on a sixpence and the ball is simply always in front of
   * him. Leaving some of the old line on is what makes turning at pace a real
   * decision — the ball runs wide of his new heading and he has to come back
   * across for it, or lose it.
   */
  function strikeBall(a, st, dx, dz, u, lift = 0, skid = 1, keep = 0) {
    _v.set(dx, 0, dz);
    if (_v.lengthSq() < 1e-8) _v.set(a.faceX || 0, 0, a.faceZ || 1);
    _v.y = 0;
    _v.normalize();
    if (keep > 0) keptMomentum(_v.x, _v.z, keep, _w);
    body.kick(_v, u, lift, 0);
    if (keep > 0) { body.vel.x += _w.x; body.vel.z += _w.z; }
    if (skid < 1 && lift <= 0.01) {
      // bleed the rolling spin only; sidespin is nobody's business here
      body.spin.x *= skid;
      body.spin.z *= skid;
    }
    body.lastTouch = a;
    body.lastTouchTeam = a.team;
    body.lastTouchPart = 'foot';
    st.lastTouchT = t;
    st.touches++;
    seenKickId = body.kickId;         // a control touch is not a "deliberate kick"
  }

  // =========================================================================
  // close control
  // =========================================================================

  /**
   * One frame of carrying the ball.
   *
   *   a            the man on the ball
   *   aimX, aimZ   the point he is steering toward (the caller already has it)
   *   opts.sprint  is he flat out
   *   opts.skill   0..1 competence, drives touch error
   *   opts.pressed is a defender on him (shortens the touch)
   *
   * On most frames this does nothing at all: it advances his stride phase and
   * returns. The ball is out in front rolling on its own and there is no touch
   * to take. That is the point.
   *
   * Returns true on a frame where the ball was actually touched.
   */
  function carry(a, dt, aimX, aimZ, opts = {}) {
    if (!body || dt <= 0) return false;
    const st = stateOf(a);
    const s = speedOf(a);

    // ---- the line he is carrying along ----
    // Prefer the steering target; fall back to his own travel, then his facing,
    // so a man standing still with the ball still has a front.
    let hx = aimX - a.pos.x, hz = aimZ - a.pos.z;
    let hl = Math.hypot(hx, hz);
    if (hl < 0.45) { hx = a.vel.x; hz = a.vel.z; hl = s; }
    if (hl < 0.05) { hx = a.faceX || 0; hz = a.faceZ || 1; hl = Math.hypot(hx, hz) || 1; }
    hx /= hl; hz /= hl;

    // He cannot play it somewhere he cannot follow. Callers hand in a steering
    // target that can jump a long way in a single frame — sim/ai.js re-picks
    // from a fan of directions every step — while a body at ten metres a second
    // turns at about two radians a second and no faster. Knocking the ball down
    // a line he is not on and cannot get onto inside a stride is not a dribble,
    // it is a kick into the corner, and the gap it opens is unbounded because
    // the two of them are simply running apart. So the aim is limited to the
    // angle he could actually turn through while the ball is out.
    if (s > 1.5) {
      const vx = a.vel.x / s, vz = a.vel.z / s;
      const cos = clamp(vx * hx + vz * hz, -1, 1);
      const lim = AIM_OFF_SPRINT
        + (AIM_OFF_WALK - AIM_OFF_SPRINT) * (1 - clamp(s / SPRINT_SPEED, 0, 1));
      const off0 = Math.acos(cos);
      if (off0 > lim) {
        // rotate the travel direction `lim` toward the steering line
        const sgn = (vx * hz - vz * hx) < 0 ? 1 : -1;   // toward r = (hz,-hx)
        const c = Math.cos(lim * sgn), sn = Math.sin(lim * sgn);
        const nx = vx * c + vz * sn;
        const nz = -vx * sn + vz * c;
        hx = nx; hz = nz;
      }
    }

    // ---- turn rate of that line ----
    const yaw = Math.atan2(hx, hz);
    if (st.hasHeading) {
      let d = yaw - st.headYaw;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const rate = d / dt;
      st.turn += (rate - st.turn) * Math.min(1, dt * 9);
    }
    st.headYaw = yaw;
    st.hasHeading = true;

    const sprint = opts.sprint !== undefined ? !!opts.sprint : s > RUN_SPEED * 1.02;

    // ---- stride phase ----
    // A boot can only play the ball while it is ON THE GROUND. The stride runs
    // at a speed-scaled rate and a foot is planted for the first STRIDE_STANCE
    // of each cycle; the rest of the time he is between steps and there is
    // nothing to touch it with. That window is what lets the ball arrive at the
    // wrong moment: if it comes back to him mid-flight he runs on and takes it a
    // beat later, level with his hip instead of out in front — the overrun that
    // every real dribble is full of and no timer ever produces.
    const hz_ = clamp(STRIDE_HZ_BASE + STRIDE_HZ_PER_MS * s, STRIDE_HZ_MIN, STRIDE_HZ_MAX);
    st.phase += hz_ * dt;
    if (st.phase >= 1) st.phase -= 1;
    st.phase = clamp(st.phase, 0, 1);
    const planted = st.phase < STRIDE_STANCE;

    const gapx = body.pos.x - a.pos.x, gapz = body.pos.z - a.pos.z;
    const gap = Math.hypot(gapx, gapz);
    const since = t - st.lastTouchT;
    // How far off the line he is running the ball has ended up. Dead ahead is a
    // ball he is carrying; across his body is a ball he is losing.
    const off = Math.acos(clamp((gapx * hx + gapz * hz) / Math.max(0.05, gap), -1, 1));

    // ---- is there a touch to take? ----
    // He can only play a ball that is at his feet. Between touches the ball is
    // out in front and there is nothing to do but run — which is the whole
    // reason the gap breathes instead of sitting still.
    const reach = reachFor(s);
    let want = planted && gap <= reach;
    // it is on his boot — play it, whatever the stride is doing, because the
    // alternative is the collider playing it for him
    if (!want && gap < CONTACT_R + FOOT_BAND && s > 1.0) want = true;
    // It has gone across his body and is running away from his line. He throws a
    // leg at it — off balance, out of stride, but it is that or lose it, and
    // sim/ai.js stops calling this function altogether at CARRY_R (1.16 m), so
    // there are only a few frames in which anything can be done at all. This is
    // the whole answer to a scuffed touch: it genuinely gets away from his front
    // for a beat, and then he reaches out and drags it back.
    let stretch = false;
    if (!want && gap <= REACH_STRETCH && off > STRETCH_OFF) { want = true; stretch = true; }
    // Last chance. The ball is off his line and about to cross the radius past
    // which sim/ai.js stops calling him the carrier — after that this function is
    // not running and there is nothing left to do but chase. He does not stand
    // and watch it go, so anything off his line that is nearly out of the carry
    // radius gets a leg thrown at it whether it has reached his hip or not. This
    // is what bounds how far a scuffed touch can put the ball: without it the
    // excursion is decided by how long the steering happens to keep him running
    // in the wrong direction, which is not this module's business and is not
    // bounded by anything.
    if (!want && gap >= LASTCHANCE_R && gap <= REACH_STRETCH && off > LASTCHANCE_OFF) {
      want = true; stretch = true;
    }
    // he has matched its pace instead of running it down and it is hanging just
    // out of range: stretch for that too rather than letting it drift away
    if (!want && since > TOUCH_STALE && gap <= REACH_STRETCH) { want = true; stretch = true; }

    // A stretch is not part of the rhythm — it is a leg thrown at a ball that is
    // leaving — so it does not have to wait for the stride to come round again.
    // A scuff costs him a beat: he is off balance and the ball is on the wrong
    // side of him, and until he has got his feet back under himself there is
    // nothing he can do but watch it run across him. That pause is the whole
    // reason a scuff shows up in the picture at all — take it away and he simply
    // re-takes the ball on the next step and nothing ever happened.
    const refr = st.scuffed ? SCUFF_REFRACTORY : TOUCH_REFRACTORY;
    if (since < (stretch ? STRETCH_REFRACTORY : refr)) want = false;
    if (body.pos.y > BALL_R + 0.45) want = false;   // bouncing: not his to place
    if ((a.kickLock || 0) > 0) want = false;   // mid-strike, the boot is committed
    // A pass or a shot he has just struck is GONE. Without this the carry reels
    // his own release back in a frame later and no ball ever leaves a player's
    // feet.
    if (t - st.kickedAt < 0.4) want = false;

    if (!want) return false;

    // ---- which way he knocks it ----
    // ONE angle off his own line, and that is the whole of the aim. Nothing here
    // decides how far the ball goes or when it arrives.
    //
    // In this yaw convention (+yaw rotates the heading toward (hz, -hx)) the
    // right-hand vector is r = (hz, -hx), so a positive angle knocks it right.
    const rx = hz, rz = -hx;
    const lat = gapx * rx + gapz * rz;          // signed offset from his line

    // Back onto his line. The angle is small because the ball runs a long way on
    // one touch: a ball 0.4 m off his line with four metres of run-out in front
    // of it needs about six degrees, not the twenty a straight "aim at a point a
    // stride ahead" gives — that one over-corrects, sends the ball across his
    // body and out the other side, and loses possession for reasons that read as
    // random. AIM_LEN is that run-out, and it grows with pace.
    // The wider the ball has ended up, the more of the touch is about getting it
    // BACK rather than getting it forward. A ball dead ahead is knocked on down
    // the same long line; a ball out at eighty degrees is played square into his
    // stride, which means aiming at a point a stride ahead of him instead of
    // four metres ahead — a much bigger angle — and killing the sideways run it
    // already has rather than leaving it on.
    const recover = clamp((off - RECOVER_ON) / RECOVER_SPAN, 0, 1);
    const aimLen = (AIM_BASE + AIM_PER_MS * s) * (1 - RECOVER_AIM * recover);
    // Turning hard costs him the correction — mid-turn the ball keeps running
    // wide instead of being snapped back in front of him.
    const pull = LINE_PULL
      * clamp(1 - Math.abs(st.turn) * LINE_PULL_TURN, LINE_PULL_MIN, 1)
      * (1 + recover);
    // Bounded: a touch is a foot going forward through the ball. However far off
    // his line it has ended up he never swings at it backwards.
    const correct = clamp(Math.atan2(-lat * pull, aimLen), -CORRECT_MAX, CORRECT_MAX);
    // How far off his line the ball already is. It gates both terms below.
    // A carried ball keeps its old line for a beat when the man changes
    // direction, so the touch lands on the OUTSIDE of the turn. But only while
    // the ball is still in front of him: a ball already out at forty degrees
    // across his body is one he plays back into his stride, not one he knocks
    // further into the corner. Without that fade the swing compounds — each
    // touch puts it wider than the last — and he loses it to arithmetic rather
    // than to a decision.
    const swing = clamp(-st.turn * s * SWING_K, -SWING_MAX, SWING_MAX)
      * (sprint ? 1.35 : 1.0)
      * clamp(1 - off / SWING_OFF_FADE, 0, 1);

    // ---- how hard ----
    // Speed in, pace out. It never sees the gap. The one thing that takes power
    // off it is a ball that has got away across his body: a leg thrown out at
    // something beside his hip has no swing behind it, and a full-blooded knock
    // struck off balance at sixty degrees to his own line does not rescue the
    // situation, it fires the ball into the next postcode.
    const push = pushFor(s, opts.pressed) * (1 - RECOVER_PUSH * recover);

    // ---- touch error ----
    // Scruffiness rises with pace and falls with competence. A sprinter turning
    // hard is the worst case, which is where a carry should be losable.
    const skill = clamp(opts.skill ?? 0.8, 0.35, 1);
    const err = (1.2 - skill) * (0.6 + 0.9 * clamp(s / SPRINT_SPEED, 0, 1))
      * (sprint ? 1.7 : 1.0)
      * (1 + Math.min(1.4, Math.abs(st.turn) * 0.55));
    // ---- can this touch get away from him? ----
    // The load is not the turn itself but its consequence: how far OFF his new
    // line the ball has ended up. A carried ball keeps running the old way while
    // he comes round, so after a real turn it is out at an angle and the touch
    // is a reach across the body. Dead ahead is free; wide of the line at pace is
    // where a touch is allowed to break the pocket ceiling and run loose. A man
    // at a walk can spin on the ball all day — there is no momentum in it — so
    // pace gates the whole term. `off` is measured above, at the gate.
    const fast = clamp((s - RUN_SPEED * 0.7) / (SPRINT_SPEED - RUN_SPEED * 0.7), 0, 1);
    const loose = clamp((off - LOOSE_OFF_ON) / LOOSE_OFF_SPAN, 0, 1)
      * fast * clamp(1.25 - skill, 0, 1) * 1.9;
    const heavy = loose > 0 && rng.float() < loose;

    // ---- and the ordinary one that simply is not clean ----
    // Not every touch comes off the middle of the boot. At pace the foot catches
    // the ball across its face instead of through it: it goes across him at an
    // angle AND under-hit, so it dies under his own stride, ends up level with
    // his hip rather than out in front, and he has to check back onto it. This
    // is the ordinary scruffiness a running dribble is full of. It is also the
    // only thing in a straight-line carry that puts the ball behind the line of
    // his shoulders — a man running straight with a clean touch every time has
    // the ball in front of him on literally every frame, which is what a welded
    // ball looks like whatever the pocket is doing. Rate rises with pace and
    // with how hard he is turning, and falls with competence.
    // The touch that gets away from a man is the one taken at FULL STRETCH — toe
    // end of the boot, ball at the edge of what he can reach, no weight behind
    // it. A ball sitting under his feet he can always place. So the rate rises
    // with how far out the ball is when he reaches it, and with how hard he is
    // turning at the time.
    const strain = clamp((gap - CONTACT_R) / Math.max(0.05, reach - CONTACT_R), 0, 1);
    const scuffP = clamp(SCUFF_K * (SCUFF_TIGHT + (1 - SCUFF_TIGHT) * strain)
      * (1.25 - skill) * (1 + Math.min(1.2, Math.abs(st.turn) * 0.4)), 0, SCUFF_MAX);
    const scuff = !heavy && rng.float() < scuffP;
    const scuffAng = scuff
      ? (rng.float() < 0.5 ? -1 : 1) * (SCUFF_ANG + rng.float() * SCUFF_ANG_SPAN)
      : 0;

    const ang = correct + swing + scuffAng
      + rng.gauss() * 0.06 * err + (heavy ? rng.gauss() * 0.16 : 0);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let dx = hx * ca + rx * sa;
    let dz = hz * ca + rz * sa;
    // He does not knock it into the stand. Near a line the touch is turned back
    // infield — a change of direction and nothing else; the pace it is struck
    // with is untouched. (The servo this replaced got the same effect for free
    // by clamping its target point inside the pitch.)
    const ebx = edgeBias(body.pos.x, HALF_W), ebz = edgeBias(body.pos.z, HALF_D);
    if (ebx || ebz) {
      dx -= ebx * EDGE_TURN_K; dz -= ebz * EDGE_TURN_K;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
    }
    let u = s + push * (1 + rng.gauss() * 0.10 * err);
    if (heavy) u += (0.5 + rng.float()) * (1 + loose);
    // A scuffed touch leaves the ball SLOWER than the man, not faster. That is
    // the whole character of it: the ball dies under his stride, he runs past it
    // and it ends up level with his hip. An under-hit that is still quicker than
    // he is just a shorter pocket, and the ball stays obediently in front.
    if (scuff) u = Math.max(0.8, s * SCUFF_PACE);
    // The only reading of the gap in the whole touch, and it can only hit it
    // SOFTER. Never a pull, never a placement.
    const ceil = heavy ? LOOSE_CEILING : GAP_CEILING;
    const keep = TOUCH_KEEP * (1 - RECOVER_KEEP * recover);
    keptMomentum(dx, dz, keep, _w);
    u = Math.min(u, paceCap(dx, dz, _w.x - a.vel.x, _w.z - a.vel.z, gap, ceil));

    strikeBall(a, st, dx, dz, u, 0, TOUCH_SKID, keep);
    st.carrying = !heavy;
    st.scuffed = scuff;
    if (a.anim && a.anim.play) a.anim.play('dribble', { force: true });
    if (events.onCarryTouch) events.onCarryTouch(a, u);
    return true;
  }

  // =========================================================================
  // receiving / first touch
  // =========================================================================

  /**
   * Score how hard this ball is to take down. 1 = a rolled pass into the path
   * of an unmarked player; 0 = a driven ball dropping over his shoulder with two
   * defenders on him.
   */
  function trapQuality(a, hx, hz, bs, skill) {
    if (bs < 1e-3) return 0.9;
    const inx = body.vel.x / bs, inz = body.vel.z / bs;
    // +1 when the ball is travelling the same way he is (over the shoulder),
    // -1 when it is coming straight at him.
    const shoulder = clamp((inx * hx + inz * hz + 1) * 0.5, 0, 1);
    let q = 1
      - clamp((bs - 8) / 26, 0, 0.45)                    // pace on the pass
      - shoulder * 0.28                                  // angle of arrival
      - clamp((body.pos.y - BALL_R) / 1.1, 0, 1) * 0.22  // dropping / bouncing
      - Math.min(0.30, pressureOn(a, 2.6) * 0.16)        // someone on his back
      + (clamp(skill, 0.35, 1) - 0.8) * 0.55;
    return clamp(q, 0.06, 0.97);
  }

  /**
   * Take an arriving ball down. On a good touch the arrival pace is killed
   * outright and replaced with a short knock into his stride — the same impulse
   * a dribble touch uses, softer, so he is running with it rather than watching
   * it bounce off. On a bad one a chunk of the pace survives and it squirts off
   * line.
   */
  function firstTouch(a, opts = {}) {
    const st = stateOf(a);
    const bs = ballSpeed();
    const s = speedOf(a);
    let hx = a.vel.x, hz = a.vel.z;
    let hl = Math.hypot(hx, hz);
    if (hl < 1.2) { hx = a.faceX || 0; hz = a.faceZ || 1; hl = Math.hypot(hx, hz) || 1; }
    hx /= hl; hz /= hl;

    const skill = opts.skill ?? a.skill ?? 0.8;
    const q = opts.quality ?? trapQuality(a, hx, hz, bs, skill);
    const good = rng.float() < q;

    st.trapQ = q;
    st.badTouch = !good;

    if (good) {
      // Knock it into his stride: forward along his line, dragged back onto it
      // by however far off to one side the ball has arrived.
      const gap = gapTo(a);
      const rx = hz, rz = -hx;
      const lat = (body.pos.x - a.pos.x) * rx + (body.pos.z - a.pos.z) * rz;
      let dx = hx + rx * (-lat * TRAP_PULL);
      let dz = hz + rz * (-lat * TRAP_PULL);
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      // A trap is a softer touch than a dribble knock — he is killing it, not
      // driving it on — and a heavier pass is never quite fully deadened, so it
      // runs on a little in proportion to how marginal the take was.
      let u = s + pushFor(s, false) * TRAP_PUSH + bs * TRAP_KEEP * (1 - q);
      u = Math.min(u, paceCap(dx, dz, -a.vel.x, -a.vel.z,
        Math.min(gap, GAP_CEILING - 0.05), GAP_CEILING));
      u = Math.max(u, 0.2);
      strikeBall(a, st, dx, dz, u, 0, TOUCH_SKID);
      st.carrying = true;
      if (a.anim && a.anim.play) a.anim.play('dribble', { force: true });
    } else {
      // Bad touch: it runs loose. A mishit pass carries on roughly the way it
      // arrived; a mistimed gather is overrun, so it squirts off HIS line rather
      // than the ball's — a dead ball has no line of its own to keep.
      const live = bs > TRAP_MIN_SPEED * 0.6;
      const bx = live ? body.vel.x / bs : hx;
      const bz = live ? body.vel.z / bs : hz;
      const splay = rng.gauss() * 0.5 + (rng.float() < 0.5 ? -0.28 : 0.28);
      const ca = Math.cos(splay), sa = Math.sin(splay);
      const dx = bx * ca - bz * sa;
      const dz = bx * sa + bz * ca;
      const keep = 0.30 + 0.26 * rng.float();
      const u = live ? Math.max(2.0, bs * keep) : Math.max(2.2, s * 0.5);
      const lift = rng.float() < 0.32 ? 0.7 + 1.3 * rng.float() : 0;
      strikeBall(a, st, dx, dz, u, lift);
      st.carrying = false;               // this one is there to be won
    }

    if (events.onFirstTouch) events.onFirstTouch(a, { quality: q, good, speed: bs });
    return true;
  }

  /**
   * Gather a loose ball he is running onto. Same servo, different problem: the
   * ball has no pace worth killing, the danger is his own. sim/physics.js hands
   * a running player's momentum to the ball on contact (vel -> 1.28 * his), so a
   * man sprinting onto a stationary ball punts it fifteen metres up the pitch
   * without ever deciding to — the loose-ball half of "kicks it through the
   * pitch". Taking the touch first turns that into a player knocking it into his
   * stride, which is the whole point of the module.
   */
  function gather(a) {
    const s = speedOf(a);
    const skill = a.skill ?? 0.8;
    // easy at a jog, harder the faster he arrives and the tighter he is marked
    const q = clamp(
      1 - clamp((s - 7.5) / 12, 0, 0.34)
        - Math.min(0.24, pressureOn(a, 2.4) * 0.12)
        - clamp((body.pos.y - BALL_R) / 1.1, 0, 1) * 0.18
        + (clamp(skill, 0.35, 1) - 0.8) * 0.5,
      0.25, 0.98,
    );
    return firstTouch(a, { quality: q, skill });
  }

  /** should `a` be allowed to take this ball down on this frame? */
  function canReceive(a, bs) {
    if (a.down || a.isKeeper) return false;
    if ((a.kickLock || 0) > 0) return false;
    if ((a.hold || 0) > 0) return false;
    const st = stateOf(a);
    if (t - st.lastTouchT < TRAP_COOLDOWN) return false;
    // A ball he has just played is not his to receive. But the man who last
    // touched it must still be able to RECOVER it: if a heavy touch or a shove
    // has put it beyond sim/ai.js's carrier radius, the carry servo has stopped
    // being called for him, and without this he can only chase it. One stride
    // (longer than the touch interval at any running speed) separates "I am
    // dribbling" from "that got away from me".
    if (t - st.kickedAt < 0.5) return false;
    if (body.lastTouch === a && t - st.lastTouchT < SELF_RECOVER) return false;
    // A ball he knocked in front of himself on purpose is not arriving at him,
    // it is his — for as long as it is still inside the envelope a carry runs
    // in. Without this the trap fires on his own dribble touch every stride and
    // rolls for a bad one each time, and a good one re-solves the ball back to
    // his feet, which is the weld this module exists to avoid. Past SELF_KEEP_R
    // it has genuinely got away from him and taking it down again is a first
    // touch like any other.
    const dx = body.pos.x - a.pos.x, dz = body.pos.z - a.pos.z;
    const gap = Math.hypot(dx, dz);
    if (body.lastTouch === a && st.carrying && gap < SELF_KEEP_R) return false;

    if (gap > TRAP_R || gap < 1e-4) return false;
    if (body.pos.y > TRAP_MAX_HEIGHT) return false;

    // must actually be arriving at him, not leaving
    const rvx = body.vel.x - (a.vel.x || 0);
    const rvz = body.vel.z - (a.vel.z || 0);
    const closing = -(dx * rvx + dz * rvz) / gap;
    if (closing < TRAP_MIN_CLOSING) return false;

    // A pass has pace to kill; a loose ball has none, and he must be the one
    // doing the closing (otherwise a stationary player "gathers" a ball that is
    // merely trickling past him).
    if (bs < TRAP_MIN_SPEED && speedOf(a) < GATHER_MIN_SPEED) return false;
    return true;
  }

  // =========================================================================

  /**
   * Per-frame possession bookkeeping and reception. Call this once per step,
   * BEFORE the per-agent AI pass and before sim/physics.js resolves contacts —
   * a trap that runs after the collider is not a trap, it is a rebound.
   */
  function update(dt) {
    t += dt;
    if (!body) return;

    // Note any deliberate kick (pass, shot, clearance) so its own author is not
    // allowed to instantly "receive" the ball he has just struck.
    if (body.kickId !== seenKickId) {
      seenKickId = body.kickId;
      if (body.lastTouch) stateOf(body.lastTouch).kickedAt = t;
    }

    const bs = ballSpeed();

    // Nearest eligible man wins the ball — one reception per frame, so two
    // players cannot both trap the same pass.
    let best = null, bd = 1e9;
    for (const a of agents) {
      if (!canReceive(a, bs)) continue;
      const d = gapTo(a);
      if (d < bd) { bd = d; best = a; }
    }
    if (!best) return;
    if (bs >= TRAP_MIN_SPEED) firstTouch(best, { skill: best.skill });
    else gather(best);
  }

  function reset() {
    state.clear();
    t = 0;
    seenKickId = body ? body.kickId : 0;
  }

  return {
    update,
    carry,
    firstTouch,
    canReceive,
    reset,
    /**
     * The point in front of his boot a touch is aimed THROUGH. Explicitly not
     * "where the ball should be": the ball is wherever its own physics has put
     * it, which on most frames is somewhere well past here.
     */
    pocketPoint(a, out = new THREE.Vector3()) {
      const p = reachFor(speedOf(a));
      let hx = a.vel.x, hz = a.vel.z;
      let hl = Math.hypot(hx, hz);
      if (hl < 0.05) { hx = a.faceX || 0; hz = a.faceZ || 1; hl = Math.hypot(hx, hz) || 1; }
      return out.set(a.pos.x + (hx / hl) * p, BALL_R, a.pos.z + (hz / hl) * p);
    },
    reachFor,
    /** read-only view of a player's control state (HUD / debug) */
    stateOf(a) {
      const st = stateOf(a);
      return {
        touches: st.touches, phase: st.phase, turn: st.turn,
        trapQuality: st.trapQ, badTouch: st.badTouch,
        sinceTouch: t - st.lastTouchT,
      };
    },
    get clock() { return t; },
    GAP_CEILING,
    CONTACT_R,
  };
}
