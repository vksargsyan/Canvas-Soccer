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
// 1. THE DRIBBLE POCKET (a servo, not an impulse)
//    The carrier keeps the ball in a pocket AHEAD of him whose distance scales
//    with speed. A touch does not apply a fixed impulse; it SOLVES for the pace
//    that puts the ball in the pocket at the moment of the NEXT touch, given
//    where the player will be by then and how much a rolling ball loses to the
//    grass on the way:
//
//        D = |target - ball|,  T = 1 / touchRate
//        u = D/T + 0.5 * a_roll * T          (constant-deceleration solve)
//
//    That is self-correcting. If the last touch ran away, D shrinks on the next
//    one and the ball is under-hit until the man is back on it. In steady state
//    D = s*T (the player's own stride) so u = s + 0.5*a_roll*T — barely faster
//    than the man, which is what a carried ball looks like. The gap peaks at
//    (u - s)^2 / (2 a_roll) above the pocket, so `GAP_CEILING` below is enforced
//    by capping u at exactly the value that solves that expression. The ball is
//    therefore mathematically unable to get further away than the ceiling on a
//    controlled touch, which is what makes the metric hold rather than hoping.
//
//    Touches land on FOOTFALLS, not every frame and not on a fixed timer: the
//    stride phase advances at a rate tied to running speed (~1.25 Hz at a walk,
//    ~2.3 Hz at a sprint) and a touch fires when the phase wraps. That rhythm —
//    ball, stride, stride, ball — is what reads as a human carrying it. Between
//    touches nothing here runs; the ball just rolls under sim/physics.js.
//
//    Speed loosens control three ways: a longer pocket, a bigger touch error,
//    and turn swing. A carried ball keeps its old line for a beat when the man
//    changes direction, so the touch lands on the OUTSIDE of the turn, scaled by
//    turn rate * speed. And a touch taken with the ball already wide of his new
//    line, at pace, is the one allowed to break the ceiling and run genuinely
//    loose — so turning hard at a sprint can cost possession, while the same
//    turn at a walk cannot. Measured: a 150 deg turn at a sprint swings the
//    pocket from 0.98 m to 1.29 m and occasionally puts it out of reach.
//
// 2. THE FIRST TOUCH (kill it, do not bounce it)
//    sim/physics.js resolves a ball against a player as a restitution collision
//    with momentum transfer, which is right for a shin deflection and wrong for
//    a pass played to feet — the ball pings off at 60% of its arrival pace and
//    the receiver chases it. So a controlled reception is intercepted BEFORE the
//    collider ever sees it (this module runs inside the AI step, physics runs
//    after) and re-solved with the same servo as a dribble touch: the incoming
//    pace is killed and the ball is dropped into the pocket, ready to run with.
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

// --- pocket geometry --------------------------------------------------------
// How far ahead of the man the ball sits, walking -> sprinting. The floor is not
// arbitrary: sim/physics.js resolves a boot-height contact at
// PLAYER_R * 0.72 + BALL_R * 0.95 = 0.588 m, so a pocket tighter than that hands
// the ball back to the collider every frame — which both spams contacts and
// re-applies the collider's momentum transfer that this module exists to avoid.
// The pocket therefore starts just outside the boot band and opens with pace.
export const CONTACT_R = PLAYER_R * 0.72 + BALL_R * 0.95;
const POCKET_WALK = 0.78;
const POCKET_SPRINT = 0.96;
const POCKET_LOOSE = 0.04;        // extra slack while genuinely sprinting

// The hard ceiling on how far a controlled touch may ever put the ball. Kept
// under sim/ai.js's CARRY_R (PLAYER_R + BALL_R + 0.42 = 1.16 m) on purpose: past
// that radius the AI stops recognising him as the carrier, the carry logic drops
// out and the ball is loose again. A carry model that quietly loses its own
// possession flag every few strides is worse than no carry model.
const GAP_CEILING = 1.12;

// --- stride ----------------------------------------------------------------
// Footfall frequency. A walking player touches it about every three quarters of
// a second; a sprinter is on it every stride cycle.
const TOUCH_HZ_BASE = 1.25;
const TOUCH_HZ_PER_MS = 0.100;
const TOUCH_HZ_MIN = 1.25;
const TOUCH_HZ_MAX = 2.35;
const TOUCH_REFRACTORY = 0.30;    // s; two touches can never land closer than this

// Deceleration of a rolling ball on grass: sim/physics.js ROLL_RES (2.35 m/s^2)
// plus a small allowance for the quadratic drag term, which matters at pace.
const ROLL_DECEL = 2.62;

const LEAD = 1.00;                // how much of the player's own travel to lead by
const SWING_K = 0.030;            // turn swing, per (rad/s * m/s)
const SWING_MAX = 0.55;           // m of lateral swing on the hardest turn

// Turning hard at pace must be able to cost you the ball, or a carry is a
// guarantee and there is no reason to ever slow down. Only a touch taken with
// the ball already wide of his line, at pace, may break GAP_CEILING — out to
// LOOSE_CEILING, which is loose enough that sim/ai.js drops him as the carrier
// and the ball is genuinely there to be won.
// A MISCUE. Not every touch comes off the laces: at pace, one in a dozen or so
// is taken with the wrong part of the boot, and it goes ACROSS him rather than
// in front of him — far enough off his line to be outside his own shoulder, and
// soft, because a stubbed contact does not fly. He runs past it and has to check
// back for it. This is the only thing in the model that can put the ball behind
// the man carrying it, and without it the ball sat inside 23 degrees of his
// facing on every frame of every run: a pocket that never breathes sideways,
// which is what `aheadFraction` reading exactly 1.000 was reporting.
const SCUFF_P = 0.26;             // scaled by pace and by how raw he is
const SCUFF_MIN = 0.30;           // rad across himself, at the least
const SCUFF_SPAN = 0.35;          // ...and up to this much more
const SCUFF_PACE = 0.35;          // share of the pace he meant to put on it

const LOOSE_OFF_ON = 0.42;        // rad off his line before a touch can be heavy
const LOOSE_OFF_SPAN = 0.85;      // rad over that at which it is as loose as it gets
const LOOSE_CEILING = 2.30;       // m a heavy touch may put it — loose enough to lose

// --- receiving --------------------------------------------------------------
const TRAP_R = 1.15;              // reach at which a player can take a ball down
const TRAP_MIN_SPEED = 2.4;       // below this the ball is a loose roll, not a pass
const TRAP_MIN_CLOSING = 1.5;     // m/s of closing speed before it is a reception
const TRAP_MAX_HEIGHT = 1.45;     // above this it is a header, not a trap
const TRAP_SETTLE = 0.34;         // s the good touch has to put it in the pocket
const TRAP_KEEP = 0.16;           // share of arrival pace a scruffy touch leaves on
const TRAP_COOLDOWN = 0.35;       // s before the same man may re-take the ball
const GATHER_MIN_SPEED = 2.5;     // m/s he must be running to gather a dead ball
const SELF_RECOVER = 0.55;        // s before the last toucher may reclaim his own ball

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const _v = new THREE.Vector3();

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

  /** pocket distance for a player travelling at `s` */
  function pocketFor(s, sprint) {
    const f = clamp(s / SPRINT_SPEED, 0, 1);
    let p = POCKET_WALK + (POCKET_SPRINT - POCKET_WALK) * f;
    if (sprint) p += POCKET_LOOSE * f;
    return p;
  }

  /**
   * The pace that carries the ball from where it is to (tx, tz) in T seconds,
   * given it is decelerating on the grass the whole way — and never more pace
   * than would push it past GAP_CEILING from the man before it slows down.
   *
   *   gap_peak = gap_now + (u - s)^2 / (2 a)   =>   u_max = s + sqrt(2 a headroom)
   *
   * This one line is what stops a touch turning back into a boot up the pitch.
   */
  function solvePace(a, tx, tz, T, s, gapNow) {
    const dx = tx - body.pos.x, dz = tz - body.pos.z;
    const d = Math.hypot(dx, dz);
    let u = d / T + 0.5 * ROLL_DECEL * T;
    const headroom = Math.max(0.02, GAP_CEILING - gapNow);
    const uMax = s + Math.sqrt(2 * ROLL_DECEL * headroom);
    u = clamp(u, 0.25, uMax);
    return { u, dx: d < 1e-4 ? 0 : dx / d, dz: d < 1e-4 ? 0 : dz / d, d };
  }

  /** put the ball on its way, and record the contact against `a` */
  function strikeBall(a, st, dx, dz, u, lift = 0) {
    _v.set(dx, 0, dz);
    if (_v.lengthSq() < 1e-8) _v.set(a.faceX || 0, 0, a.faceZ || 1);
    body.kick(_v, u, lift, 0);
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
   *   opts.pressed is a defender on him (tightens the pocket)
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
    let pocket = pocketFor(s, sprint);
    if (opts.pressed) pocket *= 0.88;          // shorten the stride under contact

    // ---- stride phase ----
    const hz_ = clamp(TOUCH_HZ_BASE + TOUCH_HZ_PER_MS * s, TOUCH_HZ_MIN, TOUCH_HZ_MAX);
    st.phase += hz_ * dt;

    const gapx = body.pos.x - a.pos.x, gapz = body.pos.z - a.pos.z;
    const gap = Math.hypot(gapx, gapz);
    const since = t - st.lastTouchT;

    let want = false;
    if (st.phase >= 1) { st.phase -= 1; want = true; }
    // recovery touch: it is running away from him between strides. The trigger
    // sits inside GAP_CEILING rather than at some multiple of the pocket,
    // because past the ceiling sim/ai.js has already stopped calling him the
    // carrier and this function is no longer running at all.
    if (!want && gap > Math.min(pocket * 1.2, GAP_CEILING - 0.10)) want = true;
    // it has come back under his feet — poke it out in front again
    if (!want && gap < CONTACT_R * 1.02 && s > 1.0) want = true;

    if (since < TOUCH_REFRACTORY) want = false;
    if (gap > 2.6) want = false;               // this is a chase, not a carry
    if (body.pos.y > BALL_R + 0.45) want = false;   // bouncing: not his to place
    if ((a.kickLock || 0) > 0) want = false;   // mid-strike, the boot is committed
    // A pass or a shot he has just struck is GONE. Without this the carry servo
    // reels his own release back into the pocket a frame later, and no ball ever
    // leaves a player's feet.
    if (t - st.kickedAt < 0.4) want = false;

    st.phase = clamp(st.phase, 0, 1);
    if (!want) return false;

    // ---- where the touch must put it ----
    // Ahead of where he WILL be, not where he is: by the time the next stride
    // comes round he has covered s*T, and a touch aimed at his current feet is
    // a touch he runs past.
    const T = 1 / hz_;
    const px = a.pos.x + a.vel.x * T * LEAD;
    const pz = a.pos.z + a.vel.z * T * LEAD;

    // A carried ball keeps its old line for a beat: the harder and faster he
    // turns, the wider the touch lands on the outside of the turn. In this yaw
    // convention (+yaw rotates the heading toward (hz, -hx)) the outside of the
    // turn is -sign(turn) along that vector.
    const swing = clamp(-st.turn * s * SWING_K, -SWING_MAX, SWING_MAX)
      * (sprint ? 1.35 : 1.0);

    let tx = px + hx * pocket + hz * swing;
    let tz = pz + hz * pocket - hx * swing;
    tx = clamp(tx, -HALF_W + 0.5, HALF_W - 0.5);
    tz = clamp(tz, -HALF_D + 0.5, HALF_D - 0.5);

    const sol = solvePace(a, tx, tz, T, s, gap);

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
    // pace gates the whole term.
    const off = Math.acos(clamp((gapx * hx + gapz * hz) / Math.max(0.05, gap), -1, 1));
    const fast = clamp((s - RUN_SPEED * 0.7) / (SPRINT_SPEED - RUN_SPEED * 0.7), 0, 1);
    const loose = clamp((off - LOOSE_OFF_ON) / LOOSE_OFF_SPAN, 0, 1)
      * fast * clamp(1.25 - skill, 0, 1) * 1.9;
    const heavy = loose > 0 && rng.float() < loose;

    // ...and the miscue, which is a different failure from a heavy touch: heavy
    // is the right idea hit too hard, this is the wrong part of the boot. It is
    // gated on pace and competence, so a good player at a jog never produces one.
    const scuffed = rng.float() < SCUFF_P * fast * clamp(1.35 - skill, 0, 1);
    const scuff = scuffed
      ? (rng.float() < 0.5 ? -1 : 1) * (SCUFF_MIN + rng.float() * SCUFF_SPAN)
      : 0;

    const ang = rng.gauss() * 0.06 * err + (heavy ? rng.gauss() * 0.16 : 0) + scuff;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const dx = sol.dx * ca - sol.dz * sa;
    const dz = sol.dx * sa + sol.dz * ca;
    let u = sol.u * (1 + rng.gauss() * 0.055 * err);
    if (scuffed) u *= SCUFF_PACE;        // stubbed, not struck: it does not fly
    if (heavy) u += (0.5 + rng.float()) * (1 + loose);
    const ceil = heavy ? LOOSE_CEILING : GAP_CEILING;
    u = clamp(u, 0.2, s + Math.sqrt(2 * ROLL_DECEL * Math.max(0.02, ceil - gap)));

    strikeBall(a, st, dx, dz, u, 0);
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
   * Take an arriving ball down. On a good touch the pace is killed and the ball
   * is dropped straight into the dribble pocket; on a bad one a chunk of the
   * pace survives and it squirts off line.
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
      // settle it into the pocket, exactly as a dribble touch would
      const pocket = pocketFor(s, false);
      const T = TRAP_SETTLE;
      const tx = clamp(a.pos.x + a.vel.x * T * LEAD + hx * pocket, -HALF_W + 0.5, HALF_W - 0.5);
      const tz = clamp(a.pos.z + a.vel.z * T * LEAD + hz * pocket, -HALF_D + 0.5, HALF_D - 0.5);
      const gap = gapTo(a);
      const sol = solvePace(a, tx, tz, T, s, Math.min(gap, GAP_CEILING - 0.05));
      // a heavier pass is never quite fully deadened — the touch runs on a
      // little, in proportion to how marginal it was
      const u = clamp(sol.u + bs * TRAP_KEEP * (1 - q), 0.2, s + 2.0);
      strikeBall(a, st, sol.dx || hx, sol.dz || hz, u, 0);
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

    const dx = body.pos.x - a.pos.x, dz = body.pos.z - a.pos.z;
    const gap = Math.hypot(dx, dz);
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
    /** where the ball should be sitting for this player right now */
    pocketPoint(a, out = new THREE.Vector3()) {
      const s = speedOf(a);
      const p = pocketFor(s, s > RUN_SPEED * 1.02);
      let hx = a.vel.x, hz = a.vel.z;
      let hl = Math.hypot(hx, hz);
      if (hl < 0.05) { hx = a.faceX || 0; hz = a.faceZ || 1; hl = Math.hypot(hx, hz) || 1; }
      return out.set(a.pos.x + (hx / hl) * p, BALL_R, a.pos.z + (hz / hl) * p);
    },
    pocketFor,
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
