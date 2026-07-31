// Procedural animation state machine.
//
//   createAnimator(rig) -> { play(state, opts), update(dt, ctx), current }
//
// States: idle | run | sprint | kick | pass | tackle | knocked | getup |
//         celebrate | keeperIdle | keeperDive | keeperCatch
//
// Poses are computed analytically each step into a scratch pose object, then the
// live bone rotations are exponentially smoothed toward it. That gives free
// blending between states and stays deterministic under a fixed timestep.

const BONES = [
  'hips', 'torso', 'head',
  'armL', 'armR', 'forearmL', 'forearmR',
  'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR',
];

const ONE_SHOT = {
  kick: 0.46, pass: 0.34, tackle: 0.95, knocked: 1.15, getup: 0.75, keeperDive: 1.15, keeperCatch: 0.8,
};

function emptyPose() {
  const p = { rootY: 0, rootPitch: 0, rootRoll: 0, hipsY: 0 };
  for (const b of BONES) p[b] = [0, 0, 0];
  return p;
}

function copyPose(dst, src) {
  dst.rootY = src.rootY; dst.rootPitch = src.rootPitch;
  dst.rootRoll = src.rootRoll; dst.hipsY = src.hipsY;
  for (const b of BONES) { const s = src[b], d = dst[b]; d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

export function createAnimator(rig) {
  const pose = emptyPose();       // live (smoothed)
  const target = emptyPose();     // computed this step
  let current = 'idle';
  let stateTime = 0;
  let phase = 0;                  // gait cycle phase
  let oneShot = 0;                // remaining time of a one-shot state
  let opts = {};
  let footSide = 1;               // which leg kicks
  let bounce = 0;

  function play(state, o = {}) {
    if (state === current && ONE_SHOT[state] && oneShot > 0.06 && !o.force) return;
    current = state;
    stateTime = 0;
    opts = o;
    oneShot = ONE_SHOT[state] || 0;
    if (o.foot) footSide = o.foot;
  }

  // ---- pose generators ---------------------------------------------------

  function poseIdle(t, ctx) {
    const b = Math.sin(t * 2.1) * 0.5 + 0.5;
    target.hipsY = -0.012 + b * 0.014;
    target.torso[0] = 0.05 - b * 0.03;
    target.head[0] = -0.04 + Math.sin(t * 1.6) * 0.03;
    target.head[1] = Math.sin(t * 0.7) * 0.22;
    target.armL[2] = 0.20 + b * 0.03; target.armR[2] = -0.20 - b * 0.03;
    target.armL[0] = -0.10; target.armR[0] = -0.10;
    target.forearmL[0] = -0.34; target.forearmR[0] = -0.34;
    target.thighL[0] = 0.04; target.thighR[0] = -0.04;
    target.shinL[0] = -0.06; target.shinR[0] = -0.06;
    target.footL[0] = 0.02; target.footR[0] = 0.02;
  }

  function poseRun(t, ctx, fast) {
    const speed = fast ? 13.2 : 10.0;
    const amp = fast ? 1.05 : 0.80;
    const s = Math.sin(phase), c = Math.cos(phase);
    const lift = Math.abs(Math.sin(phase)) * (fast ? 0.075 : 0.05);

    target.hipsY = -0.02 + lift;
    target.rootPitch = fast ? 0.18 : 0.10;
    target.torso[1] = -s * 0.16;
    target.torso[0] = fast ? 0.10 : 0.06;
    target.head[1] = s * 0.10;
    target.head[0] = fast ? -0.10 : -0.06;

    target.thighL[0] = s * amp;
    target.thighR[0] = -s * amp;
    target.shinL[0] = -clamp(Math.max(0, -c) * amp * 1.5, 0, 1.7);
    target.shinR[0] = -clamp(Math.max(0, c) * amp * 1.5, 0, 1.7);
    target.footL[0] = 0.22 - s * 0.28;
    target.footR[0] = 0.22 + s * 0.28;

    target.armL[0] = -s * amp * 0.85;
    target.armR[0] = s * amp * 0.85;
    target.armL[2] = 0.24; target.armR[2] = -0.24;
    target.forearmL[0] = -0.75 - Math.max(0, -s) * 0.5;
    target.forearmR[0] = -0.75 - Math.max(0, s) * 0.5;
    return speed;
  }

  function poseKick(u, hard) {
    // u in 0..1 : wind-up (0-0.35), strike (0.35-0.6), follow-through
    const wind = Math.min(1, u / 0.35);
    const strike = clamp((u - 0.3) / 0.3, 0, 1);
    const follow = clamp((u - 0.55) / 0.45, 0, 1);
    const sw = -wind * 1.25 + strike * 2.55 - follow * 0.9;
    const kickL = footSide < 0;
    const K = kickL ? 'L' : 'R';
    const P = kickL ? 'R' : 'L';

    target.hipsY = -0.03;
    target.rootPitch = 0.10 - strike * 0.16 + follow * 0.08;
    target.torso[1] = (kickL ? 1 : -1) * (0.28 - strike * 0.55);
    target.torso[0] = -0.12 + strike * 0.30;
    target.head[0] = 0.12;

    target['thigh' + K][0] = sw * (hard ? 1.0 : 0.72);
    target['shin' + K][0] = -Math.max(0, -sw) * 1.5 - (1 - strike) * 0.25;
    target['foot' + K][0] = 0.30 + strike * 0.25;

    target['thigh' + P][0] = -0.12 - wind * 0.1;
    target['shin' + P][0] = -0.30;
    target['foot' + P][0] = 0.12;

    target['arm' + P][0] = -sw * 0.55;
    target['arm' + K][0] = sw * 0.35;
    target.armL[2] = 0.55; target.armR[2] = -0.55;
    target.forearmL[0] = -0.5; target.forearmR[0] = -0.5;
  }

  function poseTackle(u) {
    const slide = Math.min(1, u / 0.25);
    const rec = clamp((u - 0.6) / 0.4, 0, 1);
    const down = slide * (1 - rec);
    target.rootY = -0.30 * down;
    target.rootPitch = -0.30 * down;
    target.rootRoll = 0.85 * down;
    target.hipsY = -0.10 * down;
    target.torso[0] = 0.35 * down;
    target.head[0] = -0.30 * down;
    target.thighR[0] = 1.35 * down;
    target.shinR[0] = -0.25 * down;
    target.footR[0] = 0.55 * down;
    target.thighL[0] = 0.35 * down;
    target.shinL[0] = -1.45 * down;
    target.armL[2] = 0.9 * down + 0.2;
    target.armR[2] = -1.2 * down - 0.2;
    target.armR[0] = -0.6 * down;
    target.forearmL[0] = -0.4; target.forearmR[0] = -0.3;
  }

  function poseKnocked(u) {
    const fall = Math.min(1, u / 0.3);
    target.rootY = -0.55 * fall;
    target.rootRoll = 1.35 * fall;
    target.rootPitch = -0.25 * fall;
    target.torso[0] = 0.25 * fall;
    target.head[0] = -0.35 * fall;
    target.thighL[0] = 0.9 * fall; target.thighR[0] = 0.55 * fall;
    target.shinL[0] = -1.0 * fall; target.shinR[0] = -0.7 * fall;
    target.armL[2] = 1.5 * fall; target.armR[2] = -1.5 * fall;
  }

  function poseGetup(u) {
    const k = 1 - Math.min(1, u / 0.7);
    poseKnocked(0.35);
    target.rootY *= k; target.rootRoll *= k; target.rootPitch *= k;
    target.thighL[0] *= k; target.thighR[0] *= k;
    target.shinL[0] *= k; target.shinR[0] *= k;
    target.armL[2] = lerp(0.2, 1.5, k); target.armR[2] = lerp(-0.2, -1.5, k);
  }

  function poseCelebrate(t) {
    const b = Math.max(0, Math.sin(t * 6.2));
    target.rootY = b * 0.34;
    target.hipsY = -0.02 - (1 - b) * 0.05;
    target.torso[0] = -0.16;
    target.head[0] = -0.22;
    target.armL[2] = 2.45 + Math.sin(t * 8) * 0.18;
    target.armR[2] = -2.45 - Math.sin(t * 8) * 0.18;
    target.armL[0] = -0.25; target.armR[0] = -0.25;
    target.forearmL[0] = -0.25; target.forearmR[0] = -0.25;
    target.thighL[0] = -0.25 + b * 0.5; target.thighR[0] = -0.25 + b * 0.35;
    target.shinL[0] = -0.55 * b; target.shinR[0] = -0.4 * b;
  }

  function poseKeeperIdle(t) {
    const b = Math.sin(t * 3.1) * 0.5 + 0.5;
    target.hipsY = -0.13 - b * 0.03;
    target.rootPitch = 0.16;
    target.torso[0] = 0.10;
    target.head[0] = -0.14;
    target.armL[2] = 1.15 + b * 0.12; target.armR[2] = -1.15 - b * 0.12;
    target.armL[0] = -0.35; target.armR[0] = -0.35;
    target.forearmL[0] = -0.85; target.forearmR[0] = -0.85;
    target.thighL[0] = 0.30; target.thighR[0] = -0.30;
    target.shinL[0] = -0.55; target.shinR[0] = -0.55;
    target.footL[0] = 0.24; target.footR[0] = 0.24;
    target.hips[1] = 0;
  }

  function poseKeeperDive(u, dir) {
    const launch = Math.min(1, u / 0.28);
    const air = clamp((u - 0.15) / 0.5, 0, 1);
    const land = clamp((u - 0.7) / 0.3, 0, 1);
    const d = dir >= 0 ? 1 : -1;
    target.rootY = launch * 0.75 - land * 0.5;
    target.rootRoll = d * (launch * 1.45);
    target.rootPitch = -0.15 * launch;
    target.torso[0] = -0.2 * air;
    target.head[0] = -0.25;
    target.armL[2] = d > 0 ? 2.7 * launch + 0.2 : 0.35;
    target.armR[2] = d > 0 ? -0.35 : -2.7 * launch - 0.2;
    target.forearmL[0] = -0.15; target.forearmR[0] = -0.15;
    target.thighL[0] = -0.35 * air; target.thighR[0] = 0.55 * air;
    target.shinL[0] = -0.55 * air; target.shinR[0] = -0.9 * air;
  }

  function poseKeeperCatch(u) {
    const k = Math.sin(Math.min(1, u / 0.4) * Math.PI * 0.5);
    target.hipsY = -0.10;
    target.rootPitch = 0.22 * k;
    target.torso[0] = 0.30 * k;
    target.head[0] = 0.10;
    target.armL[2] = 0.55; target.armR[2] = -0.55;
    target.armL[0] = -1.5 * k; target.armR[0] = -1.5 * k;
    target.forearmL[0] = -0.25; target.forearmR[0] = -0.25;
    target.thighL[0] = 0.5 * k; target.thighR[0] = 0.5 * k;
    target.shinL[0] = -0.8 * k; target.shinR[0] = -0.8 * k;
  }

  // ---- update ------------------------------------------------------------

  function update(dt, ctx = {}) {
    stateTime += dt;
    if (oneShot > 0) {
      oneShot -= dt;
      if (oneShot <= 0) {
        oneShot = 0;
        if (current === 'knocked') play('getup');
        else if (current === 'keeperDive' || current === 'keeperCatch') play('keeperIdle');
        else current = ctx.moving ? (ctx.sprinting ? 'sprint' : 'run') : (ctx.isKeeper ? 'keeperIdle' : 'idle');
      }
    }

    // reset target
    target.rootY = 0; target.rootPitch = 0; target.rootRoll = 0; target.hipsY = 0;
    for (const b of BONES) { const a = target[b]; a[0] = 0; a[1] = 0; a[2] = 0; }

    const speed = ctx.speed || 0;
    let gait = 0;

    switch (current) {
      case 'run': gait = poseRun(stateTime, ctx, false); break;
      case 'sprint': gait = poseRun(stateTime, ctx, true); break;
      case 'kick': poseKick(clamp(stateTime / ONE_SHOT.kick, 0, 1), true); break;
      case 'pass': poseKick(clamp(stateTime / ONE_SHOT.pass, 0, 1), false); break;
      case 'tackle': poseTackle(clamp(stateTime / ONE_SHOT.tackle, 0, 1)); break;
      case 'knocked': poseKnocked(clamp(stateTime / ONE_SHOT.knocked, 0, 1)); break;
      case 'getup': poseGetup(clamp(stateTime / ONE_SHOT.getup, 0, 1)); break;
      case 'celebrate': poseCelebrate(stateTime); break;
      case 'keeperIdle': poseKeeperIdle(stateTime); break;
      case 'keeperDive': poseKeeperDive(clamp(stateTime / ONE_SHOT.keeperDive, 0, 1), opts.dir ?? 1); break;
      case 'keeperCatch': poseKeeperCatch(clamp(stateTime / ONE_SHOT.keeperCatch, 0, 1)); break;
      default: poseIdle(stateTime, ctx); break;
    }

    if (gait) phase += dt * (gait * clamp(speed / 9, 0.55, 1.45));
    else phase += dt * 0.0;

    // blend live pose toward the target
    const k = 1 - Math.exp(-dt * (ONE_SHOT[current] ? 26 : 13));
    pose.rootY = lerp(pose.rootY, target.rootY, k);
    pose.rootPitch = lerp(pose.rootPitch, target.rootPitch, k);
    pose.rootRoll = lerp(pose.rootRoll, target.rootRoll, k);
    pose.hipsY = lerp(pose.hipsY, target.hipsY, k);
    for (const b of BONES) {
      const p = pose[b], t = target[b];
      p[0] = lerp(p[0], t[0], k);
      p[1] = lerp(p[1], t[1], k);
      p[2] = lerp(p[2], t[2], k);
    }

    // apply
    rig.root.position.y = pose.rootY;
    rig.root.rotation.set(pose.rootPitch, 0, pose.rootRoll);
    rig.hips.position.y = 0.64 + pose.hipsY;
    for (const b of BONES) {
      const bone = rig[b];
      if (!bone) continue;
      const p = pose[b];
      bone.rotation.set(p[0], p[1], p[2]);
    }
    bounce = pose.rootY;
  }

  return {
    play, update,
    get current() { return current; },
    get busy() { return oneShot > 0; },
    get stateTime() { return stateTime; },
    get lift() { return bounce; },
  };
}
