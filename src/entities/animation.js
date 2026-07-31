// Procedural animation state machine for the chibi rig.
//
//   createAnimator(rig) -> { play(state, opts), update(dt, ctx), current }
//
// States: idle | run | sprint | kick | pass | tackle | knocked | getup |
//         celebrate | keeperIdle | keeperDive | keeperCatch
//   plus: dribble | header | throwIn   (extra one-shots, same play() call)
//
// ---------------------------------------------------------------------------
// HOW IT WORKS
//
//  * Each state has a *generator* that writes an analytic pose into `gen`.
//  * On a state change the live pose is snapshotted into `from`, and the applied
//    pose is `lerp(from, gen, smoothstep(fadeT / fadeDur))`. That is a real
//    cross-fade with per-state fade lengths — no hard switches, no popping, and
//    snappy one-shots still hit their key poses on time.
//  * After the blend, additive layers run: acceleration/turn lean, and a spring
//    driven head so the big chibi head bobbles and lags (secondary motion).
//  * The gait phase is driven by *distance travelled*, not by wall time, so a
//    planted foot moves backwards at exactly ground speed and does not slide.
//
// ROTATION CONVENTIONS (verified against the rig built in player.js — local +Z
// is the facing direction, bones hang down -Y, arms sit at x = -0.345 for 'L'):
//   thigh.x   +back   -forward
//   shin.x    +knee flexion (heel toward the seat).  NEGATIVE HYPEREXTENDS.
//   foot.x    +toe down (plantarflex)   -toe up
//   torso.x   +lean forward             head.x  +look down
//   arm.x     +arm back  -arm forward   forearm.x  -elbow flexion
//   arm.z     outward is NEGATIVE for side 'L' (x<0), POSITIVE for side 'R'
//   rootPitch +lean forward (pivot at the feet)
//   rootRoll  +tips the top toward -X (the character's right)
// Everything pivots at the feet, and a grounding pass at the end of update()
// raises the root until the lowest boot point sits on the turf. That is why no
// state can bury the character in the pitch (the old tackle/knocked bug) and
// why push-off actually lifts the body during a run.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const HIP_Y = 0.64;           // must match player.js
// gait shape. amp is the hip swing at contact; duty is the stance fraction.
const RUN_AMP = 0.95, SPR_AMP = 1.16;
const RUN_DUTY = 0.40, SPR_DUTY = 0.33;

const BONES = [
  'hips', 'torso', 'head',
  'armL', 'armR', 'forearmL', 'forearmR',
  'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR',
];
const NB = BONES.length;

// side sign: which way is "outward" for the shoulder Z rotation
const SIDE = { L: -1, R: 1 };

// Pre-built bone-name lookup so the per-frame pose code never builds a string.
const KEY = {
  L: { thigh: 'thighL', shin: 'shinL', foot: 'footL', arm: 'armL', fore: 'forearmL' },
  R: { thigh: 'thighR', shin: 'shinR', foot: 'footR', arm: 'armR', fore: 'forearmR' },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const smoothi = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** state -> { dur (0 = looping), fade, exit } */
const STATES = {
  idle: { dur: 0, fade: 0.22 },
  run: { dur: 0, fade: 0.16 },
  sprint: { dur: 0, fade: 0.16 },
  celebrate: { dur: 0, fade: 0.18 },
  keeperIdle: { dur: 0, fade: 0.22 },

  kick: { dur: 0.42, fade: 0.055 },
  pass: { dur: 0.32, fade: 0.055 },
  dribble: { dur: 0.26, fade: 0.07 },
  header: { dur: 0.70, fade: 0.08 },
  throwIn: { dur: 1.00, fade: 0.14 },
  tackle: { dur: 1.05, fade: 0.06 },
  knocked: { dur: 1.15, fade: 0.05 },
  getup: { dur: 0.80, fade: 0.12 },
  keeperDive: { dur: 1.20, fade: 0.05 },
  keeperCatch: { dur: 0.85, fade: 0.07 },
};

// Fraction of the kick clip at which the boot meets the ball. Callers that want
// the strike to land exactly on the frame they launch the ball should read
// `animator.contactDelay` and start the clip that many seconds early.
const KICK_CONTACT = 0.17;
const PASS_CONTACT = 0.20;

// ---------------------------------------------------------------------------
// keyframe tracks. Module-level constants -> zero per-frame allocation.
// Each track is a flat array [t0,v0, t1,v1, ...] read by track().
// ---------------------------------------------------------------------------
function track(u, k) {
  const n = k.length;
  if (u <= k[0]) return k[1];
  for (let i = 2; i < n; i += 2) {
    if (u <= k[i]) {
      const t0 = k[i - 2], v0 = k[i - 1], t1 = k[i], v1 = k[i + 1];
      const s = smooth((u - t0) / (t1 - t0 || 1e-6));
      return v0 + (v1 - v0) * s;
    }
  }
  return k[n - 1];
}

/* KICK — anticipation, plant, hip-led whip, CONTACT AT u=0.17, a follow-through
   that carries the boot up past hip height, then a landing settle. Peaks are big
   on purpose: a chibi with a head this size needs exaggeration to read. */
const K_ROOT_PITCH = [0, 0.06, 0.10, 0.18, 0.17, 0.08, 0.33, -0.24, 0.52, -0.14, 0.74, 0.10, 1, 0.03];
const K_ROOT_Y = [0, 0, 0.10, 0.02, 0.17, 0.0, 0.33, 0.085, 0.52, 0.05, 0.70, 0.0, 1, 0];
const K_SQUASH = [0, 0, 0.09, -0.08, 0.17, 0.10, 0.33, 0.05, 0.55, -0.09, 0.72, 0.03, 1, 0];
const K_HIP_TWIST = [0, 0.10, 0.11, 0.62, 0.17, 0.16, 0.33, -0.55, 0.66, -0.30, 1, -0.05];
const K_TORSO_TWIST = [0, -0.08, 0.11, -0.55, 0.17, -0.12, 0.33, 0.52, 0.66, 0.28, 1, 0.04];
const K_TORSO_PITCH = [0, 0.08, 0.11, 0.26, 0.17, 0.06, 0.33, -0.20, 0.62, -0.06, 1, 0.05];
const K_TORSO_ROLL = [0, 0, 0.11, 0.16, 0.33, -0.24, 0.70, -0.08, 1, 0];
// kicking leg: cocked heel-to-seat, whipped straight through the ball, then high
const K_THIGH = [0, -0.05, 0.11, 1.10, 0.17, -0.34, 0.33, -1.50, 0.50, -1.24, 0.74, -0.40, 1, -0.06];
const K_SHIN = [0, 0.24, 0.11, 1.75, 0.17, 0.26, 0.26, 0.04, 0.42, 0.22, 0.72, 0.46, 1, 0.18];
const K_FOOT = [0, 0.10, 0.11, -0.20, 0.17, 0.46, 0.33, 0.34, 0.72, 0.08, 1, 0.04];
// plant leg: absorbs on contact, then rises onto the toe as the hips drive round
const K_PTHIGH = [0, -0.06, 0.11, -0.40, 0.17, -0.34, 0.33, -0.10, 0.62, -0.12, 1, -0.04];
const K_PSHIN = [0, 0.14, 0.11, 0.50, 0.17, 0.42, 0.33, 0.12, 0.62, 0.30, 1, 0.14];
// arms: opposite arm drives across the body, kicking-side arm counterweights back
const K_ARM_OPP = [0, -0.15, 0.11, 0.70, 0.17, -0.40, 0.33, -1.15, 0.66, -0.40, 1, -0.10];
const K_ARM_SAME = [0, -0.10, 0.11, -0.70, 0.17, 0.35, 0.33, 0.95, 0.66, 0.36, 1, 0.08];
const K_HEAD = [0, -0.02, 0.11, -0.16, 0.17, 0.22, 0.33, 0.02, 0.66, -0.10, 1, -0.04];

/* TACKLE — a foot-first slide, seated on the hip, legs out along the turf.
   Every joint below was solved so no geometry drops under y = 0. */
const T_PITCH = [0, 0.10, 0.09, -0.62, 0.22, -1.20, 0.62, -1.24, 0.80, -0.72, 1, 0.02];
const T_ROLL = [0, 0, 0.09, 0.22, 0.22, 0.42, 0.62, 0.38, 0.80, 0.18, 1, 0];
const T_ROOTY = [0, 0, 0.07, 0.16, 0.18, 0.07, 0.62, 0.06, 0.82, 0.12, 1, 0];
const T_HIPSY = [0, -0.02, 0.20, -0.05, 0.70, -0.04, 1, -0.02];
const T_TORSO = [0, 0.12, 0.22, 0.60, 0.62, 0.56, 0.82, 0.34, 1, 0.06];
const T_HEAD = [0, -0.05, 0.22, -0.36, 0.62, -0.32, 0.84, -0.16, 1, -0.04];
// extended (tackling) leg — thigh sits near horizontal, knee almost straight
const T_ETHIGH = [0, -0.25, 0.13, -0.42, 0.24, -0.32, 0.62, -0.30, 0.82, -0.34, 1, -0.05];
const T_ESHIN = [0, 0.65, 0.13, 0.22, 0.24, 0.09, 0.62, 0.10, 0.82, 0.60, 1, 0.16];
const T_EFOOT = [0, 0.05, 0.24, -0.22, 0.62, -0.18, 1, 0.02];
// tucked leg — knee up, heel under the seat
const T_TTHIGH = [0, -0.14, 0.16, -0.58, 0.24, -0.55, 0.62, -0.53, 0.84, -0.30, 1, -0.04];
const T_TSHIN = [0, 0.45, 0.16, 1.45, 0.24, 1.52, 0.62, 1.48, 0.84, 0.80, 1, 0.16];
const T_ARM_UP = [0, 0.10, 0.14, -0.95, 0.30, -0.82, 0.66, -0.66, 0.86, -0.22, 1, -0.06];
const T_ARM_BACK = [0, 0.10, 0.14, 0.75, 0.30, 1.00, 0.66, 0.92, 0.86, 0.38, 1, 0.06];

/* KNOCKED — swept off the feet: reels back, legs fly up, arms flail, then lands. */
const N_PITCH = [0, 0.05, 0.10, -0.46, 0.36, -1.26, 0.62, -1.38, 0.82, -1.34, 1, -1.30];
const N_ROOTY = [0, 0, 0.10, 0.08, 0.36, 0.15, 0.55, 0.11, 0.70, 0.15, 1, 0.14];
const N_SQUASH = [0, 0, 0.10, 0.09, 0.36, 0.05, 0.56, -0.11, 0.70, 0.04, 1, 0];
const N_ROLL = [0, 0, 0.30, 0.18, 0.62, 0.26, 1, 0.22];
const N_TORSO = [0, 0.10, 0.14, -0.22, 0.40, 0.28, 0.62, 0.34, 1, 0.20];
const N_HEAD = [0, 0, 0.12, -0.46, 0.34, -0.20, 0.58, 0.28, 1, 0.16];
const N_THIGH_A = [0, -0.10, 0.14, -1.05, 0.34, -0.72, 0.60, -0.22, 1, -0.12];
const N_SHIN_A = [0, 0.20, 0.14, 0.95, 0.34, 1.20, 0.60, 0.62, 1, 0.46];
const N_THIGH_B = [0, -0.10, 0.14, -0.72, 0.34, -0.34, 0.60, -0.02, 1, 0.00];
const N_SHIN_B = [0, 0.20, 0.14, 0.60, 0.34, 0.80, 0.60, 0.30, 1, 0.24];
const N_ARM = [0, 0.1, 0.13, 1.45, 0.34, 1.20, 0.60, 0.85, 1, 0.72];
const N_SPLAY = [0, 0.2, 0.13, 1.30, 0.40, 1.05, 1, 0.80];

/* KEEPER DIVE — explode sideways, hang, land and skid. */
const D_ROLL = [0, 0.05, 0.14, 0.38, 0.34, 1.18, 0.62, 1.22, 0.84, 1.04, 1, 0.98];
const D_ROOTY = [0, 0, 0.10, 0.18, 0.30, 0.56, 0.52, 0.48, 0.76, 0.24, 1, 0.21];
const D_ROOTX = [0, 0, 0.14, 0.06, 0.40, 0.24, 0.70, 0.34, 1, 0.36];
const D_PITCH = [0, 0.14, 0.12, 0.22, 0.34, -0.10, 0.70, -0.06, 1, 0.02];
const D_SQUASH = [0, 0, 0.09, -0.10, 0.20, 0.10, 0.40, 0.02, 0.72, -0.05, 0.86, 0.02, 1, 0];
const D_ARM_LEAD = [0, 1.0, 0.14, 1.55, 0.36, 2.45, 0.66, 2.55, 1, 2.35];
const D_ARM_TRAIL = [0, 1.0, 0.14, 0.55, 0.36, 1.60, 0.66, 1.85, 1, 1.70];
const D_THIGH_LEAD = [0, 0.10, 0.14, 0.55, 0.36, -0.10, 0.70, -0.16, 1, -0.10];
const D_SHIN_LEAD = [0, 0.45, 0.14, 1.10, 0.36, 0.42, 0.70, 0.30, 1, 0.26];
const D_THIGH_TRAIL = [0, 0.10, 0.14, 0.20, 0.36, -0.55, 0.70, -0.44, 1, -0.36];
const D_SHIN_TRAIL = [0, 0.45, 0.14, 0.95, 0.36, 0.95, 0.70, 0.80, 1, 0.70];

/* CELEBRATE — a looping fist-pump jump: crouch, launch, hang, land, squash. */
const CEL_Y = [0, 0, 0.15, -0.035, 0.30, 0.34, 0.46, 0.42, 0.62, 0.0, 0.70, -0.02, 1, 0];
const CEL_SQ = [0, 0, 0.15, -0.11, 0.30, 0.11, 0.50, 0.07, 0.64, -0.15, 0.76, 0.05, 1, 0];
const CEL_ARMZ = [0, 1.95, 0.15, 1.15, 0.32, 2.58, 0.50, 2.66, 0.72, 2.05, 1, 1.95];
const CEL_ARMX = [0, -0.20, 0.15, 0.40, 0.32, -0.50, 0.55, -0.40, 0.76, -0.12, 1, -0.20];
const CEL_FORE = [0, -0.35, 0.15, -0.95, 0.32, -0.18, 0.55, -0.22, 0.76, -0.60, 1, -0.35];
const CEL_THIGH = [0, -0.08, 0.15, -0.62, 0.30, -0.28, 0.48, -0.68, 0.64, -0.64, 0.78, -0.22, 1, -0.08];
const CEL_SHIN = [0, 0.18, 0.15, 1.15, 0.30, 0.26, 0.48, 1.10, 0.64, 1.05, 0.78, 0.45, 1, 0.18];
const CEL_TORSO = [0, -0.12, 0.15, 0.16, 0.32, -0.26, 0.55, -0.24, 0.76, 0.08, 1, -0.12];
const CEL_HEAD = [0, -0.20, 0.15, 0.06, 0.32, -0.36, 0.55, -0.32, 0.76, 0.02, 1, -0.20];

/* KEEPER CATCH — smother the ball, wrap it in. */
const C_PITCH = [0, 0.10, 0.18, 0.34, 0.45, 0.42, 0.75, 0.26, 1, 0.10];
const C_ROOTY = [0, 0, 0.14, 0.05, 0.40, 0, 1, 0];
const C_ARM = [0, -0.4, 0.18, -1.75, 0.45, -1.35, 0.75, -1.10, 1, -0.60];
const C_FORE = [0, -0.5, 0.18, -0.35, 0.45, -1.30, 0.80, -1.20, 1, -0.70];
const C_THIGH = [0, -0.10, 0.18, -0.65, 0.45, -0.70, 0.80, -0.40, 1, -0.10];
const C_SHIN = [0, 0.20, 0.18, 1.05, 0.45, 1.10, 0.80, 0.60, 1, 0.20];

/* GETUP — roll to a side, push up on one hand, plant, rise with an overshoot. */
const G_PITCH = [0, -1.30, 0.22, -1.05, 0.50, -0.62, 0.78, -0.10, 0.90, 0.10, 1, 0.02];
const G_ROOTY = [0, 0.14, 0.30, 0.085, 0.58, 0.025, 0.80, 0.0, 1, 0];
const G_TORSO = [0, 0.18, 0.30, 0.42, 0.60, 0.36, 0.84, -0.08, 1, 0.04];
const G_THIGH = [0, -0.05, 0.24, -0.70, 0.52, -0.95, 0.78, -0.30, 0.92, 0.10, 1, 0.02];
const G_SHIN = [0, 0.40, 0.24, 1.30, 0.52, 1.45, 0.78, 0.45, 1, 0.12];
const G_ARM = [0, -0.7, 0.26, 0.85, 0.55, 0.60, 0.80, -0.15, 1, -0.06];
const G_SQUASH = [0, 0, 0.5, 0.03, 0.80, 0.09, 0.90, -0.07, 1, 0];

/* HEADER — crouch, leap, snap the head through, land with a squash. */
const H_ROOTY = [0, 0, 0.14, -0.02, 0.28, 0.42, 0.46, 0.56, 0.66, 0.10, 0.78, 0, 1, 0];
const H_SQUASH = [0, 0, 0.14, -0.10, 0.30, 0.12, 0.50, 0.06, 0.68, -0.12, 0.82, 0.04, 1, 0];
const H_TORSO = [0, 0.10, 0.14, 0.22, 0.34, -0.34, 0.50, 0.30, 0.72, 0.16, 1, 0.06];
const H_HEAD = [0, 0, 0.16, -0.34, 0.34, -0.45, 0.50, 0.42, 0.72, 0.10, 1, -0.04];
const H_THIGH = [0, 0, 0.14, 0.55, 0.34, -0.35, 0.56, -0.10, 0.72, 0.32, 1, 0.04];
const H_SHIN = [0, 0.12, 0.14, 1.05, 0.34, 0.30, 0.56, 0.22, 0.72, 0.65, 1, 0.14];
const H_ARM = [0, -0.1, 0.14, 0.55, 0.34, -1.35, 0.56, -0.95, 0.78, -0.20, 1, -0.06];

/* THROW-IN — both arms overhead, arch back, whip forward. */
const W_ARM = [0, -0.4, 0.28, -2.55, 0.52, -2.75, 0.66, -1.20, 0.86, -0.55, 1, -0.25];
const W_FORE = [0, -0.6, 0.28, -1.15, 0.52, -1.45, 0.66, -0.25, 1, -0.35];
const W_TORSO = [0, 0.06, 0.28, -0.24, 0.52, -0.34, 0.68, 0.34, 0.86, 0.16, 1, 0.06];
const W_ROOTY = [0, 0, 0.52, 0.0, 0.66, 0.06, 0.80, 0, 1, 0];
const W_THIGH = [0, 0, 0.30, 0.20, 0.52, 0.24, 0.70, -0.30, 1, -0.05];

// ---------------------------------------------------------------------------

function emptyPose() {
  const p = {
    rootX: 0, rootY: 0, rootZ: 0,
    rootPitch: 0, rootYaw: 0, rootRoll: 0,
    hipsX: 0, hipsY: 0, hipsZ: 0,
    squash: 0,
  };
  for (let i = 0; i < NB; i++) p[BONES[i]] = [0, 0, 0];
  return p;
}

function copyPose(dst, src) {
  dst.rootX = src.rootX; dst.rootY = src.rootY; dst.rootZ = src.rootZ;
  dst.rootPitch = src.rootPitch; dst.rootYaw = src.rootYaw; dst.rootRoll = src.rootRoll;
  dst.hipsX = src.hipsX; dst.hipsY = src.hipsY; dst.hipsZ = src.hipsZ;
  dst.squash = src.squash;
  for (let i = 0; i < NB; i++) {
    const s = src[BONES[i]], d = dst[BONES[i]];
    d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
  }
}

function clearPose(p) {
  p.rootX = 0; p.rootY = 0; p.rootZ = 0;
  p.rootPitch = 0; p.rootYaw = 0; p.rootRoll = 0;
  p.hipsX = 0; p.hipsY = 0; p.hipsZ = 0;
  p.squash = 0;
  for (let i = 0; i < NB; i++) { const a = p[BONES[i]]; a[0] = 0; a[1] = 0; a[2] = 0; }
}

function blendPose(dst, a, b, t) {
  dst.rootX = lerp(a.rootX, b.rootX, t);
  dst.rootY = lerp(a.rootY, b.rootY, t);
  dst.rootZ = lerp(a.rootZ, b.rootZ, t);
  dst.rootPitch = lerp(a.rootPitch, b.rootPitch, t);
  dst.rootYaw = lerp(a.rootYaw, b.rootYaw, t);
  dst.rootRoll = lerp(a.rootRoll, b.rootRoll, t);
  dst.hipsX = lerp(a.hipsX, b.hipsX, t);
  dst.hipsY = lerp(a.hipsY, b.hipsY, t);
  dst.hipsZ = lerp(a.hipsZ, b.hipsZ, t);
  dst.squash = lerp(a.squash, b.squash, t);
  for (let i = 0; i < NB; i++) {
    const n = BONES[i], x = a[n], y = b[n], d = dst[n];
    d[0] = lerp(x[0], y[0], t);
    d[1] = lerp(x[1], y[1], t);
    d[2] = lerp(x[2], y[2], t);
  }
}

// ---------------------------------------------------------------------------

export function createAnimator(rig) {
  const live = emptyPose();     // what gets applied
  const from = emptyPose();     // snapshot taken when the state changed
  const gen = emptyPose();      // analytic pose for the current state

  let current = 'idle';
  let spec = STATES.idle;
  let stateTime = 0;
  let fadeT = 999;
  let oneShot = 0;
  let footSide = 1;             // +1 -> side 'R' kicks
  let diveDir = 1;

  let phase = 0;                // gait phase, radians. 0 = side R foot strike
  let sprintMix = 0;
  let gaitAmp = RUN_AMP;
  let speedSm = 0, lastSpeed = 0, accelSm = 0;
  let yawRateSm = 0, lastYaw = null;
  let planted = 0;              // 0..1 how upright the character is
  let ikW = 1;                  // 0..1 weight of the foot-grounding pass

  // secondary-motion springs (big chibi head lags and overshoots)
  let hPit = 0, hPitV = 0, hYaw = 0, hYawV = 0, hRol = 0, hRolV = 0;
  let prevRootPitch = 0, prevBodyYaw = 0, prevHipY = 0, hipVel = 0;

  const id = (rig.group && rig.group.userData && rig.group.userData.id) | 0;
  const seed = ((id * 0.618033988749895) % 1) * TAU;   // per-player desync

  // ------------------------------------------------------------- state entry
  function play(state, o) {
    const st = STATES[state];
    if (!st) return;
    const force = !!(o && o.force);
    if (state === current && !force) {
      if (o && o.foot) footSide = o.foot;
      return;
    }
    // don't let a fresh request stomp a one-shot that is still mid-swing
    if (!force && oneShot > 0.05 && spec.dur > 0) return;

    copyPose(from, live);
    current = state;
    spec = st;
    stateTime = 0;
    fadeT = 0;
    oneShot = st.dur;
    if (o) {
      if (o.foot) footSide = o.foot >= 0 ? 1 : -1;
      if (o.dir !== undefined) diveDir = o.dir >= 0 ? 1 : -1;
    }
  }

  function fallback(ctx) {
    if (current === 'knocked') return 'getup';
    if (current === 'keeperDive' || current === 'keeperCatch') return 'keeperIdle';
    if (ctx.isKeeper) return 'keeperIdle';
    if (ctx.moving) return ctx.sprinting ? 'sprint' : 'run';
    return 'idle';
  }

  // --------------------------------------------------------------- utilities

  /** keep the sole flat on the turf for a stance leg */
  function levelFoot(side, extra) {
    const th = gen[KEY[side].thigh][0];
    const sh = gen[KEY[side].shin][0];
    gen[KEY[side].foot][0] = -(gen.rootPitch + gen.hips[0] + th + sh) + extra;
  }

  function armSplay(l, r) {
    gen.armL[2] = SIDE.L * l;
    gen.armR[2] = SIDE.R * r;
  }

  /**
   * Sagittal-plane solve for the lowest point of one boot, in root space.
   * Used by the grounding pass so no pose ever buries a foot in the turf and
   * so push-off actually lifts the body (the run's rise comes from the legs).
   */
  const SOLE = -0.045;        // boot underside in the rest pose
  function footLow(side) {
    const a0 = live.rootPitch + live.hips[0];
    const t = a0 + live[KEY[side].thigh][0];
    const s = t + live[KEY[side].shin][0];
    const f = s + live[KEY[side].foot][0];
    const yHip = (HIP_Y + live.hipsY) * Math.cos(live.rootPitch);
    const yKnee = yHip - 0.30 * Math.cos(t);
    const yAnk = yKnee - 0.28 * Math.cos(s);
    const cf = Math.cos(f) * 0.11, sf = Math.sin(f);
    const toe = yAnk - cf - 0.24 * sf;
    const heel = yAnk - cf + 0.10 * sf;
    return toe < heel ? toe : heel;
  }

  // ------------------------------------------------------------- generators

  function poseIdle(t) {
    const T = t + seed;
    const br = Math.sin(T * 1.9);                 // breathing
    const bob = Math.sin(T * 3.1);                // light on the toes
    const sway = Math.sin(T * 0.72);              // weight shift between feet
    const sway2 = Math.sin(T * 0.72 - 0.9);

    gen.hipsY = -0.016 + br * 0.011 + bob * 0.010;
    gen.hipsX = sway * 0.030;
    gen.hips[1] = sway * 0.09;
    gen.hips[2] = -sway * 0.055;
    gen.torso[0] = 0.075 - br * 0.022;
    gen.torso[1] = -sway * 0.11;
    gen.torso[2] = sway * 0.030;

    gen.head[0] = -0.055 - br * 0.020;
    gen.head[1] = Math.sin(T * 0.47) * 0.30 + sway * 0.06;
    gen.head[2] = -sway * 0.045;

    gen.armL[0] = -0.06 + sway2 * 0.10;
    gen.armR[0] = -0.06 - sway2 * 0.10;
    armSplay(0.25 + br * 0.02, 0.23 + br * 0.02);
    gen.forearmL[0] = -0.42 - Math.max(0, sway2) * 0.10;
    gen.forearmR[0] = -0.42 - Math.max(0, -sway2) * 0.10;

    // staggered athletic stance: feet apart, toes out, knees softly bent
    gen.thighL[0] = -0.12 + sway * 0.055;
    gen.thighR[0] = 0.05 - sway * 0.055;
    gen.thighL[2] = SIDE.L * (0.26 + sway * 0.03);
    gen.thighR[2] = SIDE.R * (0.26 - sway * 0.03);
    gen.shinL[0] = 0.22 - sway * 0.05 - bob * 0.030;
    gen.shinR[0] = 0.15 + sway * 0.05 - bob * 0.030;
    gen.footL[1] = SIDE.L * 0.18;
    gen.footR[1] = SIDE.R * 0.18;
    levelFoot('L', 0.02);
    levelFoot('R', 0.02);
    gen.squash = -br * 0.012;
  }

  // --- gait solver ---------------------------------------------------------
  // The planted boot has to hold one fixed point on the turf for the whole of
  // stance, otherwise the character moonwalks. So the leg is *solved*, not
  // keyframed: pick the ball-of-foot target, pick the knee and ankle profile,
  // then invert the two-link chain for the hip angle. Stride length falls out
  // of that solve and sets the cycle rate, which is what keeps the feet locked
  // to the ground at any speed.
  const THIGH_L = 0.30, SHIN_L = 0.28;
  const BALL_Y = -0.11, BALL_Z = 0.12;      // ball of the foot, in foot space

  function stanceKnee(q) { return 0.10 + 0.44 * Math.sin(Math.PI * Math.pow(q, 0.85)); }
  /** world pitch of the sole through stance: heel strike, flat, toe-off */
  function soleAngle(q) {
    return q < 0.20
      ? lerp(-0.26, 0.0, smoothi(q / 0.20))
      : lerp(0.0, 0.78, smoothi((q - 0.20) / 0.80) ** 1.7);
  }
  /** reach of the thigh+shin chain for a given knee flexion */
  function chainReach(kn) {
    const a = THIGH_L + SHIN_L * Math.cos(kn);
    const b = SHIN_L * Math.sin(kn);
    return Math.sqrt(a * a + b * b);
  }
  function chainPhase(kn) {
    return Math.atan2(SHIN_L * Math.sin(kn), THIGH_L + SHIN_L * Math.cos(kn));
  }
  /** half a step: how far in front of the hip the contact point starts */
  function halfStride(amp) { return chainReach(stanceKnee(0.5)) * Math.sin(amp); }

  /**
   * p = 0 is the contact of this leg. Stance runs [0, duty], swing [duty, 1].
   */
  function legCycle(side, p, amp, kneeMax, duty, lean, zAdj) {
    let th, kn, ft;
    if (p < duty) {
      const q = p / duty;
      kn = stanceKnee(q);
      const F = soleAngle(q);
      // z of the ball of the foot measured from the ankle, once the sole is
      // rolled to F. Subtracting it makes the *contact* travel linearly.
      const off = BALL_Y * Math.sin(F) + BALL_Z * Math.cos(F);
      // zAdj cancels the pelvis twist/sway, which would otherwise drag the
      // planted boot back and forth along the turf.
      const zT = halfStride(amp) * (1 - 2 * q) - zAdj;
      const R = chainReach(kn);
      const A = Math.asin(clamp((off - zT) / R, -1, 1)) - chainPhase(kn);
      th = A - lean;
      ft = F - (A + kn);
    } else {
      // ---- swing: fast recovery, big knee tuck, ankle lifts for clearance
      const q = (p - duty) / (1 - duty);
      th = amp * Math.cos(Math.PI * q) * 0.92;
      kn = 0.10 + kneeMax * Math.sin(Math.PI * Math.pow(q, 0.78));
      ft = q < 0.55
        ? lerp(0.50, -0.30, smoothi(q / 0.55))
        : lerp(-0.30, -0.20, smoothi((q - 0.55) / 0.45));
    }
    gen[KEY[side].thigh][0] = th;
    gen[KEY[side].shin][0] = kn;
    gen[KEY[side].foot][0] = ft;
  }

  function poseLocomotion(fast) {
    const mix = fast ? 1 : 0;
    // gaitAmp is solved in update() from the actual ground speed, so a jog gets
    // short strides and a sprint gets long ones instead of one canned length.
    const amp = gaitAmp;
    const kneeMax = lerp(1.42, 1.75, mix) * clamp(amp / lerp(RUN_AMP, SPR_AMP, mix), 0.62, 1.06);
    const duty = lerp(RUN_DUTY, SPR_DUTY, mix);
    const bob = lerp(0.045, 0.070, mix);
    const armAmp = lerp(0.62, 0.92, mix);

    const lean = lerp(0.14, 0.26, mix);
    const pR = (((phase / TAU) % 1) + 1) % 1;
    const pL = (pR + 0.5) % 1;

    // Vertical. The stance dip already falls out of the knee solve + grounding
    // pass, so all that is authored here is the ballistic rise during flight —
    // the window where neither boot is down and the grounding pass is idle.
    const bobPhase = 2 * (phase - TAU * duty * 0.5);
    const g = pR % 0.5;
    const airW = g > duty ? Math.sin(Math.PI * (g - duty) / (0.5 - duty)) : 0;
    gen.hipsY = -0.030 + airW * lerp(0.055, 0.095, mix) - bob * 0.5 * (1 + Math.cos(bobPhase));
    gen.hipsX = Math.sin(phase) * lerp(0.030, 0.042, mix);
    gen.hipsZ = -Math.cos(bobPhase) * 0.012;

    // pelvis leads, shoulders counter-rotate
    const twist = Math.cos(phase);
    const pelvisYaw = twist * lerp(0.15, 0.22, mix);
    gen.hips[1] = pelvisYaw;
    gen.hips[2] = Math.sin(phase) * lerp(0.055, 0.075, mix);
    const sy = Math.sin(pelvisYaw) * 0.155;
    legCycle('R', pR, amp, kneeMax, duty, lean, gen.hipsZ - SIDE.R * sy);
    legCycle('L', pL, amp, kneeMax, duty, lean, gen.hipsZ - SIDE.L * sy);
    gen.torso[1] = -twist * lerp(0.26, 0.36, mix);
    gen.torso[2] = -Math.sin(phase) * 0.045;
    gen.torso[0] = lerp(0.14, 0.22, mix) + Math.cos(bobPhase) * 0.025;
    gen.rootPitch = lean;

    // head counter-rotates so the face stays up and readable
    gen.head[0] = -(gen.rootPitch + gen.torso[0]) * 0.72 - 0.02;
    gen.head[1] = -gen.torso[1] * 0.45;

    // contralateral arms, elbow flexes harder on the forward swing
    const aR = twist * armAmp;
    gen.armR[0] = aR;
    gen.armL[0] = -aR;
    armSplay(lerp(0.16, 0.10, mix), lerp(0.16, 0.10, mix));
    gen.armR[1] = -twist * 0.16;
    gen.armL[1] = -twist * 0.16;
    gen.forearmR[0] = -0.80 - Math.max(0, -aR) * lerp(0.9, 1.25, mix);
    gen.forearmL[0] = -0.80 - Math.max(0, aR) * lerp(0.9, 1.25, mix);

    // squash on contact, stretch through flight
    gen.squash = (airW * 1.25 - 0.5) * lerp(0.045, 0.070, mix);
  }

  function poseKick(u, hard) {
    const K = footSide >= 0 ? 'R' : 'L';
    const P = footSide >= 0 ? 'L' : 'R';
    const sgn = footSide >= 0 ? 1 : -1;
    const g = hard ? 1 : 0.72;

    gen.rootPitch = track(u, K_ROOT_PITCH) * g;
    gen.rootY = Math.max(0, track(u, K_ROOT_Y) * g);
    gen.rootYaw = -sgn * track(u, K_HIP_TWIST) * 0.45 * g;
    gen.squash = track(u, K_SQUASH) * g;

    gen.hips[1] = sgn * track(u, K_HIP_TWIST) * g;
    gen.hips[2] = -sgn * 0.06 * g;
    gen.hipsY = -0.035 - 0.02 * g;
    gen.torso[0] = track(u, K_TORSO_PITCH) * g;
    gen.torso[1] = sgn * track(u, K_TORSO_TWIST) * g;
    gen.torso[2] = sgn * track(u, K_TORSO_ROLL) * g;

    gen.head[0] = track(u, K_HEAD);
    gen.head[1] = -sgn * track(u, K_TORSO_TWIST) * 0.45;

    gen[KEY[K].thigh][0] = track(u, K_THIGH) * g;
    gen[KEY[K].shin][0] = Math.max(0, track(u, K_SHIN) * g);
    gen[KEY[K].foot][0] = track(u, K_FOOT);
    gen[KEY[K].thigh][1] = -sgn * 0.10 * g;

    gen[KEY[P].thigh][0] = track(u, K_PTHIGH);
    gen[KEY[P].shin][0] = Math.max(0.04, track(u, K_PSHIN));
    levelFoot(P, 0.04);

    gen[KEY[P].arm][0] = track(u, K_ARM_OPP) * g;
    gen[KEY[K].arm][0] = track(u, K_ARM_SAME) * g;
    armSplay(0.40 * g + 0.12, 0.40 * g + 0.12);
    gen.forearmL[0] = -0.55 - Math.max(0, -gen.armL[0]) * 0.5;
    gen.forearmR[0] = -0.55 - Math.max(0, -gen.armR[0]) * 0.5;
  }

  /** quick close-control touch while running — a poke, not a full swing */
  function poseDribble(u) {
    poseLocomotion(sprintMix > 0.5);
    const K = footSide >= 0 ? 'R' : 'L';
    const w = Math.sin(Math.PI * smoothi(u));          // 0 -> 1 -> 0
    const t = gen[KEY[K].thigh];
    t[0] = lerp(t[0], -0.62, w);
    gen[KEY[K].shin][0] = lerp(gen[KEY[K].shin][0], 0.16, w);
    gen[KEY[K].foot][0] = lerp(gen[KEY[K].foot][0], 0.24, w);
    gen.torso[0] += w * 0.10;
    gen.head[0] += w * 0.14;
    gen.squash += w * 0.02;
  }

  function poseTackle(u) {
    const E = footSide >= 0 ? 'R' : 'L';   // extended leg
    const T = footSide >= 0 ? 'L' : 'R';
    const sgn = footSide >= 0 ? 1 : -1;

    gen.rootPitch = track(u, T_PITCH);
    gen.rootRoll = sgn * track(u, T_ROLL);
    gen.rootY = Math.max(0, track(u, T_ROOTY));
    gen.hipsY = track(u, T_HIPSY);
    gen.torso[0] = track(u, T_TORSO);
    gen.torso[1] = -sgn * 0.28 * smoothi(u / 0.3);
    gen.torso[2] = -sgn * 0.14;
    gen.head[0] = track(u, T_HEAD);
    gen.head[1] = sgn * 0.24;

    gen[KEY[E].thigh][0] = track(u, T_ETHIGH);
    gen[KEY[E].shin][0] = Math.max(0.05, track(u, T_ESHIN));
    gen[KEY[E].foot][0] = track(u, T_EFOOT);
    gen[KEY[E].thigh][2] = sgn * 0.10;

    gen[KEY[T].thigh][0] = track(u, T_TTHIGH);
    gen[KEY[T].shin][0] = Math.max(0.05, track(u, T_TSHIN));
    gen[KEY[T].foot][0] = 0.18;

    // trailing arm braces back, leading arm swings up and across
    gen[KEY[T].arm][0] = track(u, T_ARM_UP);
    gen[KEY[E].arm][0] = track(u, T_ARM_BACK);
    armSplay(0.55, 0.55);
    gen.forearmL[0] = -0.55;
    gen.forearmR[0] = -0.45;
    gen.squash = -0.03 * smoothi(u / 0.25);
  }

  function poseKnocked(u) {
    const sgn = footSide >= 0 ? 1 : -1;
    gen.rootPitch = track(u, N_PITCH);
    gen.rootRoll = sgn * track(u, N_ROLL);
    gen.rootY = Math.max(0, track(u, N_ROOTY));
    gen.squash = track(u, N_SQUASH);
    gen.hipsY = -0.02;
    gen.torso[0] = track(u, N_TORSO);
    gen.torso[1] = -sgn * 0.18;
    gen.head[0] = track(u, N_HEAD);
    gen.head[1] = sgn * 0.30;
    gen.head[2] = sgn * 0.16;

    gen.thighR[0] = track(u, N_THIGH_A);
    gen.shinR[0] = track(u, N_SHIN_A);
    gen.thighL[0] = track(u, N_THIGH_B);
    gen.shinL[0] = track(u, N_SHIN_B);
    gen.thighR[2] = 0.16; gen.thighL[2] = -0.16;
    gen.footR[0] = -0.15; gen.footL[0] = -0.10;

    const a = track(u, N_ARM);
    const sp = track(u, N_SPLAY);
    gen.armL[0] = a; gen.armR[0] = a * 0.82;
    armSplay(sp, sp * 0.85);
    gen.forearmL[0] = -0.30 - Math.max(0, a) * 0.25;
    gen.forearmR[0] = -0.50 - Math.max(0, a) * 0.20;
  }

  function poseGetup(u) {
    const sgn = footSide >= 0 ? 1 : -1;
    gen.rootPitch = track(u, G_PITCH);
    gen.rootRoll = sgn * (1 - smoothi(u / 0.6)) * 0.22;
    gen.rootY = Math.max(0, track(u, G_ROOTY));
    gen.squash = track(u, G_SQUASH);
    gen.torso[0] = track(u, G_TORSO);
    gen.torso[1] = -sgn * 0.22 * (1 - smoothi(u / 0.7));
    gen.head[0] = -0.20 + 0.10 * smoothi(u / 0.8);
    gen.head[1] = sgn * 0.20 * (1 - smoothi(u / 0.7));

    const th = track(u, G_THIGH), sh = track(u, G_SHIN);
    gen.thighL[0] = th; gen.thighR[0] = th * 0.8;
    gen.shinL[0] = Math.max(0.05, sh); gen.shinR[0] = Math.max(0.05, sh * 0.85);
    levelFoot('L', 0.02); levelFoot('R', 0.02);

    const a = track(u, G_ARM);
    gen.armL[0] = a; gen.armR[0] = a * 0.55 - 0.15;
    armSplay(0.42, 0.30);
    gen.forearmL[0] = -0.35 - Math.max(0, a) * 0.5;
    gen.forearmR[0] = -0.60;
  }

  function poseCelebrate(t) {
    // one jump every 0.78 s, desynced per player so a squad does not pulse in
    // lockstep. Arms stay up between jumps and pump on the beat.
    const c = ((t * 1.282 + seed * 0.159) % 1 + 1) % 1;
    const wig = Math.sin(t * 4.3 + seed);
    const wig2 = Math.sin(t * 2.7 + seed * 1.7);

    gen.rootY = track(c, CEL_Y);
    gen.squash = track(c, CEL_SQ);
    gen.hipsY = -0.02;
    gen.rootPitch = -0.06 + track(c, CEL_TORSO) * 0.35;
    gen.rootYaw = wig2 * 0.20;
    gen.torso[0] = track(c, CEL_TORSO);
    gen.torso[1] = wig * 0.14;
    gen.torso[2] = wig2 * 0.06;

    gen.head[0] = track(c, CEL_HEAD);
    gen.head[1] = wig * 0.26;
    gen.head[2] = -wig2 * 0.10;

    // arms punched up and out in a V, elbows snapping on the launch
    const az = track(c, CEL_ARMZ);
    const ax = track(c, CEL_ARMX);
    const af = track(c, CEL_FORE);
    gen.armL[0] = ax; gen.armR[0] = ax;
    armSplay(az, az * 0.94);
    gen.forearmL[0] = af; gen.forearmR[0] = af * 0.9;
    gen.armL[1] = 0.22; gen.armR[1] = -0.22;

    const th = track(c, CEL_THIGH), sh = track(c, CEL_SHIN);
    gen.thighL[0] = th; gen.thighR[0] = th * 0.82;
    gen.shinL[0] = sh; gen.shinR[0] = sh * 0.85;
    gen.thighL[2] = SIDE.L * 0.12; gen.thighR[2] = SIDE.R * 0.12;
    gen.footL[0] = 0.10 + sh * 0.20;
    gen.footR[0] = 0.08 + sh * 0.18;
  }

  function poseKeeperIdle(t) {
    const T = t * 1.0 + seed;
    const b = Math.sin(T * 3.0);
    const sh = Math.sin(T * 1.35);
    // the crouch comes from the knees, not from dropping the pelvis — the
    // grounding pass then keeps the boots on the turf.
    gen.hipsY = -0.02 - b * 0.018;
    gen.hipsX = sh * 0.035;
    gen.rootPitch = 0.22;
    gen.hips[1] = sh * 0.10;
    gen.torso[0] = 0.10;
    gen.torso[1] = -sh * 0.13;
    gen.head[0] = -(0.22 + 0.10) * 0.85 - 0.02;
    gen.head[1] = sh * 0.14;

    // arms wide and low, elbows out — the classic set position
    gen.armL[0] = -0.42 - b * 0.05;
    gen.armR[0] = -0.42 - b * 0.05;
    armSplay(1.18 + b * 0.10, 1.18 + b * 0.10);
    gen.forearmL[0] = -0.95 - b * 0.08;
    gen.forearmR[0] = -0.95 - b * 0.08;

    gen.thighL[0] = -0.62 - b * 0.04; gen.thighR[0] = -0.62 - b * 0.04;
    gen.thighL[2] = SIDE.L * 0.26; gen.thighR[2] = SIDE.R * 0.26;
    gen.shinL[0] = 1.16 + b * 0.06; gen.shinR[0] = 1.16 + b * 0.06;
    gen.footL[1] = SIDE.L * 0.24; gen.footR[1] = SIDE.R * 0.24;
    levelFoot('L', 0.02); levelFoot('R', 0.02);
    gen.squash = -0.03 - b * 0.012;
  }

  /** which local X direction the dive travels, derived from the body's yaw */
  function diveLocalSign() {
    const yaw = rig.group ? rig.group.rotation.y : 0;
    const s = Math.sin(yaw);
    if (Math.abs(s) < 0.2) return diveDir;      // facing along Z, fall back
    return s < 0 ? diveDir : -diveDir;
  }

  function poseKeeperDive(u) {
    const s = diveLocalSign();
    const LEAD = s > 0 ? 'R' : 'L';             // 'R' sits at +X
    const TRAIL = s > 0 ? 'L' : 'R';

    gen.rootRoll = -s * track(u, D_ROLL);
    gen.rootY = Math.max(0, track(u, D_ROOTY));
    gen.rootX = s * track(u, D_ROOTX);
    gen.rootPitch = track(u, D_PITCH);
    gen.squash = track(u, D_SQUASH);
    gen.hipsY = -0.06;
    gen.hips[2] = -s * 0.14;
    gen.torso[2] = -s * 0.16;
    gen.torso[0] = 0.06;
    gen.head[0] = -0.22;
    gen.head[2] = -s * 0.22;
    gen.head[1] = s * 0.18;

    gen[KEY[LEAD].arm][2] = SIDE[LEAD] * track(u, D_ARM_LEAD);
    gen[KEY[TRAIL].arm][2] = SIDE[TRAIL] * track(u, D_ARM_TRAIL);
    gen[KEY[LEAD].arm][0] = -0.20;
    gen[KEY[TRAIL].arm][0] = -0.10;
    gen.forearmL[0] = -0.12;
    gen.forearmR[0] = -0.12;

    gen[KEY[LEAD].thigh][0] = track(u, D_THIGH_LEAD);
    gen[KEY[LEAD].shin][0] = Math.max(0.05, track(u, D_SHIN_LEAD));
    gen[KEY[TRAIL].thigh][0] = track(u, D_THIGH_TRAIL);
    gen[KEY[TRAIL].shin][0] = Math.max(0.05, track(u, D_SHIN_TRAIL));
    gen[KEY[LEAD].thigh][2] = SIDE[LEAD] * 0.26;
    gen[KEY[TRAIL].thigh][2] = SIDE[TRAIL] * 0.14;
    gen.footL[0] = 0.30; gen.footR[0] = 0.30;
  }

  function poseKeeperCatch(u) {
    gen.rootPitch = track(u, C_PITCH);
    gen.rootY = Math.max(0, track(u, C_ROOTY));
    gen.hipsY = -0.12;
    gen.torso[0] = 0.22;
    gen.head[0] = 0.10;
    const a = track(u, C_ARM);
    gen.armL[0] = a; gen.armR[0] = a;
    armSplay(0.30, 0.30);
    gen.forearmL[0] = track(u, C_FORE);
    gen.forearmR[0] = track(u, C_FORE);
    gen.armL[1] = 0.30; gen.armR[1] = -0.30;
    const th = track(u, C_THIGH), sh = track(u, C_SHIN);
    gen.thighL[0] = th; gen.thighR[0] = th;
    gen.shinL[0] = sh; gen.shinR[0] = sh;
    gen.thighL[2] = -0.14; gen.thighR[2] = 0.14;
    levelFoot('L', 0.04); levelFoot('R', 0.04);
    gen.squash = -0.03 * smoothi(u / 0.3);
  }

  function poseHeader(u) {
    gen.rootY = Math.max(0, track(u, H_ROOTY));
    gen.squash = track(u, H_SQUASH);
    gen.rootPitch = -0.05 + track(u, H_TORSO) * 0.3;
    gen.torso[0] = track(u, H_TORSO);
    gen.head[0] = track(u, H_HEAD);
    const th = track(u, H_THIGH), sh = track(u, H_SHIN);
    gen.thighL[0] = th; gen.thighR[0] = th * 0.85;
    gen.shinL[0] = Math.max(0.05, sh); gen.shinR[0] = Math.max(0.05, sh * 0.9);
    gen.footL[0] = 0.18; gen.footR[0] = 0.18;
    const a = track(u, H_ARM);
    gen.armL[0] = a; gen.armR[0] = a * 0.9;
    armSplay(0.45, 0.45);
    gen.forearmL[0] = -0.55; gen.forearmR[0] = -0.55;
  }

  function poseThrowIn(u) {
    const a = track(u, W_ARM);
    gen.rootY = Math.max(0, track(u, W_ROOTY));
    gen.torso[0] = track(u, W_TORSO);
    gen.rootPitch = gen.torso[0] * 0.35;
    gen.head[0] = -gen.torso[0] * 0.6 - 0.05;
    gen.armL[0] = a; gen.armR[0] = a;
    armSplay(0.22, 0.22);
    gen.forearmL[0] = track(u, W_FORE);
    gen.forearmR[0] = track(u, W_FORE);
    const th = track(u, W_THIGH);
    gen.thighL[0] = th; gen.thighR[0] = -th * 0.5 - 0.10;
    gen.shinL[0] = 0.22; gen.shinR[0] = 0.30;
    levelFoot('L', 0.02); levelFoot('R', 0.02);
    gen.hipsY = -0.03;
  }

  // ------------------------------------------------------------------ update

  function update(dt, ctx) {
    const c = ctx || 0;
    const isKeeper = !!(c && c.isKeeper);
    const rawSpeed = (c && c.speed) || 0;
    const step = dt > 0 ? dt : 0;

    stateTime += step;
    fadeT += step;

    if (spec.dur > 0) {
      oneShot = Math.max(0, spec.dur - stateTime);
      if (oneShot <= 0) {
        const nxt = fallback(c || { isKeeper });
        copyPose(from, live);
        current = nxt;
        spec = STATES[nxt];
        stateTime = 0;
        fadeT = 0;
        oneShot = spec.dur;
      }
    } else {
      oneShot = 0;
    }

    // ---- measured signals -------------------------------------------------
    const kSm = step > 0 ? 1 - Math.exp(-step * 14) : 1;
    speedSm += (rawSpeed - speedSm) * kSm;
    if (step > 0) {
      const acc = (rawSpeed - lastSpeed) / step;
      accelSm += (acc - accelSm) * (1 - Math.exp(-step * 9));
    }
    lastSpeed = rawSpeed;

    const bodyYaw = rig.group ? rig.group.rotation.y : 0;
    if (lastYaw === null) lastYaw = bodyYaw;
    let dy = bodyYaw - lastYaw;
    while (dy > Math.PI) dy -= TAU;
    while (dy < -Math.PI) dy += TAU;
    lastYaw = bodyYaw;
    if (step > 0) {
      const yr = dy / step;
      yawRateSm += (yr - yawRateSm) * (1 - Math.exp(-step * 10));
    }

    const locomotion = current === 'run' || current === 'sprint' || current === 'dribble';
    sprintMix += ((current === 'sprint' ? 1 : 0) - sprintMix) * (step > 0 ? 1 - Math.exp(-step * 7) : 1);

    // ---- gait phase from distance travelled -------------------------------
    if (locomotion) {
      const fast = current === 'sprint';
      const duty = fast ? SPR_DUTY : RUN_DUTY;
      const baseAmp = fast ? SPR_AMP : RUN_AMP;
      // scenario setups park players in 'run' with zero velocity; give them a
      // nominal gait so they read as athletes instead of statues.
      const eff = rawSpeed > 0.8 ? rawSpeed : (fast ? 10.4 : 7.0);
      // short strides for a jog, long ones for a sprint
      const k = clamp(eff / (fast ? 11.6 : 8.2), 0.22, 1.30);
      const wantAmp = clamp(baseAmp * Math.sqrt(k), 0.40, baseAmp * 1.06);
      gaitAmp += (wantAmp - gaitAmp) * (step > 0 ? 1 - Math.exp(-step * 8) : 1);
      // The contact travels 2*halfStride while the leg is down, so stance must
      // last exactly that long: cycles/s = speed * duty / stride. Solving it
      // this way is what stops the boots from skating over the turf.
      const stride = 2 * halfStride(gaitAmp);
      let cyc = (eff * duty) / stride;
      cyc = clamp(cyc, 0.8, 4.2);
      phase += step * cyc * TAU;
      if (phase > TAU * 1024) phase -= TAU * 1024;
    } else if (current === 'idle' || current === 'keeperIdle') {
      // park the cycle just after a foot strike so the next run starts clean
      const targetP = 0;
      const p = ((phase % TAU) + TAU) % TAU;
      const d = targetP - (p > Math.PI ? p - TAU : p);
      phase += d * Math.min(1, step * 3);
    }

    // ---- generate ---------------------------------------------------------
    clearPose(gen);
    const dur = spec.dur || 1;
    const u = clamp(stateTime / dur, 0, 1);

    switch (current) {
      case 'run': poseLocomotion(false); break;
      case 'sprint': poseLocomotion(true); break;
      case 'dribble': poseDribble(u); break;
      case 'kick': poseKick(u, true); break;
      case 'pass': poseKick(u, false); break;
      case 'header': poseHeader(u); break;
      case 'throwIn': poseThrowIn(u); break;
      case 'tackle': poseTackle(u); break;
      case 'knocked': poseKnocked(u); break;
      case 'getup': poseGetup(u); break;
      case 'celebrate': poseCelebrate(stateTime); break;
      case 'keeperIdle': poseKeeperIdle(stateTime); break;
      case 'keeperDive': poseKeeperDive(u); break;
      case 'keeperCatch': poseKeeperCatch(u); break;
      default: poseIdle(stateTime); break;
    }

    // ---- additive lean layers (locomotion + standing only) ----------------
    const grounded = current === 'knocked' || current === 'getup'
      || current === 'tackle' || current === 'keeperDive';
    planted += ((grounded ? 0 : 1) - planted) * (step > 0 ? 1 - Math.exp(-step * 10) : 1);

    if (planted > 0.01) {
      // lean into acceleration, rock back when braking hard
      const accLean = clamp(accelSm * 0.016, -0.30, 0.26) * planted;
      gen.rootPitch += accLean;
      gen.torso[0] -= accLean * 0.55;
      gen.head[0] -= accLean * 0.35;

      // bank into the turn; arms and pelvis follow
      const turn = clamp(yawRateSm, -3.4, 3.4);
      const bank = -turn * 0.085 * clamp(speedSm / 6, 0, 1) * planted;
      gen.rootRoll += bank;
      gen.torso[2] += bank * 0.45;
      gen.head[2] -= bank * 0.65;
      gen.head[1] += clamp(turn * 0.07, -0.28, 0.28) * planted;
      gen.hips[1] += clamp(turn * 0.045, -0.20, 0.20) * planted;
    }

    // ---- cross-fade -------------------------------------------------------
    const w = spec.fade > 0 ? smoothi(fadeT / spec.fade) : 1;
    if (w >= 1) copyPose(live, gen);
    else blendPose(live, from, gen, w);

    // ---- secondary motion: the big head lags, overshoots and settles ------
    // driven by how fast the torso/root is changing plus vertical hip accel
    const dPitch = step > 0 ? (live.rootPitch - prevRootPitch) / step : 0;
    prevRootPitch = live.rootPitch;
    let dYaw = bodyYaw - prevBodyYaw;
    while (dYaw > Math.PI) dYaw -= TAU;
    while (dYaw < -Math.PI) dYaw += TAU;
    prevBodyYaw = bodyYaw;
    const hipY = live.rootY + live.hipsY;
    const dHip = step > 0 ? (hipY - prevHipY) / step : 0;
    prevHipY = hipY;
    const hipAcc = step > 0 ? (dHip - hipVel) / step : 0;
    hipVel = dHip;

    if (step > 0) {
      // critically-ish damped springs with deliberate overshoot
      const kS = 210, cS = 20;
      const tPit = clamp(-dPitch * 0.045 - clamp(hipAcc, -60, 60) * 0.0016, -0.30, 0.30);
      const tYaw = clamp(-(step > 0 ? dYaw / step : 0) * 0.055, -0.30, 0.30);
      const tRol = clamp(-yawRateSm * 0.030, -0.20, 0.20);
      hPitV += ((tPit - hPit) * kS - hPitV * cS) * step; hPit += hPitV * step;
      hYawV += ((tYaw - hYaw) * kS - hYawV * cS) * step; hYaw += hYawV * step;
      hRolV += ((tRol - hRol) * kS - hRolV * cS) * step; hRol += hRolV * step;
      hPit = clamp(hPit, -0.45, 0.45);
      hYaw = clamp(hYaw, -0.45, 0.45);
      hRol = clamp(hRol, -0.30, 0.30);
    }
    const secondary = planted * 0.9 + 0.1;
    live.head[0] += hPit * secondary;
    live.head[1] += hYaw * secondary;
    live.head[2] += hRol * secondary;

    // ---- grounding pass ---------------------------------------------------
    // States that are deliberately on the floor opt out; everything else gets
    // its feet planted on the turf, which is also what gives push-off its rise.
    let wantIk = 1;
    if (current === 'knocked' || current === 'keeperDive') wantIk = 0;
    else if (current === 'tackle') wantIk = smoothi((u - 0.78) / 0.22);
    else if (current === 'getup') wantIk = smoothi((u - 0.32) / 0.34);
    ikW += (wantIk - ikW) * (step > 0 ? 1 - Math.exp(-step * 16) : 1);
    if (ikW > 0.01) {
      const lo = Math.min(footLow('L'), footLow('R'));
      const need = SOLE - lo;
      if (need > 0) live.rootY += Math.min(need, 0.30) * ikW;
    }

    // ---- apply ------------------------------------------------------------
    const sq = live.squash;
    rig.root.position.set(live.rootX, live.rootY, live.rootZ);
    rig.root.rotation.set(live.rootPitch, live.rootYaw, live.rootRoll);
    rig.root.scale.set(1 - sq * 0.45, 1 + sq, 1 - sq * 0.45);
    rig.hips.position.set(live.hipsX, HIP_Y + live.hipsY, live.hipsZ);

    for (let i = 0; i < NB; i++) {
      const bone = rig[BONES[i]];
      if (!bone) continue;
      const p = live[BONES[i]];
      bone.rotation.set(p[0], p[1], p[2]);
    }
  }

  // prime the pose so the very first frame is not a T-pose
  clearPose(gen);
  poseIdle(0);
  copyPose(live, gen);
  copyPose(from, gen);

  return {
    play, update,
    get current() { return current; },
    get busy() { return oneShot > 0; },
    get stateTime() { return stateTime; },
    get lift() { return live.rootY; },
    get phase() { return phase; },
    /** seconds between play('kick') and the boot meeting the ball */
    get contactDelay() { return STATES.kick.dur * KICK_CONTACT; },
    get passContactDelay() { return STATES.pass.dur * PASS_CONTACT; },
  };
}
