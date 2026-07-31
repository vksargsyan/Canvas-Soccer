// Camera director: framing modes, critically-damped follow, impact shake and
// cinematic cuts.
//
//   createDirector(camera) -> { update(dt, focus), shake(a, dirX, dirZ),
//                               cut(mode, opts), snap(), place(...), mode }
//
// `focus` is { ball, hero, action, leadX, goalX, goalZ }.
//
// Smoothing is a critically-damped spring, not an exponential lerp. Both settle
// without overshoot, but a spring also eases *in*: when the ball suddenly leaves
// a tackle at 30 m/s the camera accelerates over ~0.2 s instead of snapping to a
// new velocity on the first frame. That is the difference between a broadcast
// camera and a security camera, and it is what stops long follows feeling
// nauseating. Everything is driven off the fixed timestep, so a settled scenario
// frames identically on every run.

import * as THREE from 'three';
import { HALF_W, HALF_D } from '../core/constants.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// see MODES.wide / the 'wide' case below
const WIDE_YAW_BIAS = 0.66;

/**
 * Analytic critically-damped spring (Game Programming Gems 4, 1.10).
 * Unconditionally stable at any dt, and exact at the limit — no overshoot,
 * no jitter, no tuning per frame rate.
 */
class Damp3 {
  constructor(x = 0, y = 0, z = 0) {
    this.v = new THREE.Vector3(x, y, z);
    this.d = new THREE.Vector3();
  }
  step(target, omega, dt) {
    const x = omega * dt;
    const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    for (const k of ['x', 'y', 'z']) {
      const change = this.v[k] - target[k];
      const temp = (this.d[k] + omega * change) * dt;
      this.d[k] = (this.d[k] - omega * temp) * e;
      this.v[k] = target[k] + (change + temp) * e;
    }
    return this.v;
  }
  set(x, y, z) { this.v.set(x, y, z); this.d.set(0, 0, 0); }
  copy(o) { this.v.copy(o); this.d.set(0, 0, 0); }
}

// NOTE: the stand roofs sit at y = 30.4 with their inner edge 34 units out from
// the bowl core rect, and the floodlight masts top out at y = 54. `broadcast`
// has to stay under the roof; `wide` is deliberately placed OUTSIDE and ABOVE
// the roofline with a near-horizontal look so the roof, the jumbotrons and the
// pylons are all in frame — the establishing shot in minifootball_16.
//
//   omega : spring stiffness (rad/s). higher = tighter tracking.
//   lead  : seconds of ball velocity the camera anticipates.
export const MODES = {
  broadcast: { fov: 45, height: 28, back: 38, lead: 0.30, look: 1.0, omega: 2.6 },
  follow: { fov: 42, height: 15.5, back: 19.5, lead: 0.42, look: 1.2, omega: 4.4 },
  chase: { fov: 46, height: 9.0, back: 15.0, lead: 0.55, look: 1.4, omega: 5.6 },
  closeup: { fov: 32, height: 1.55, back: 5.0, lead: 0, look: 1.02, omega: 7.0 },
  keeper: { fov: 46, height: 4.2, back: 8.2, lead: 0.15, look: 1.5, omega: 4.4 },
  wide: { fov: 50, height: 43, back: 74, lead: 0, look: 15.0, omega: 1.5 },
  goal: { fov: 36, height: 5.5, back: 12.0, lead: 0, look: 1.5, omega: 3.6 },
  tackle: { fov: 36, height: 3.2, back: 8.0, lead: 0, look: 1.1, omega: 5.4 },
  replay: { fov: 38, height: 4.6, back: 11.0, lead: 0, look: 1.3, omega: 3.0 },
};

export function createDirector(camera) {
  let mode = 'broadcast';
  let cfg = MODES.broadcast;
  let sideSign = 1;             // which touchline the broadcast camera sits on
  let yawOffset = 0;            // extra orbit for cinematic modes
  let heightMul = 1;
  let distMul = 1;
  let orbitRate = 0;            // rad/s, replay orbit

  const posD = new Damp3(0, 26, 40);
  const lookD = new Damp3(0, 1, 0);
  const wantPos = new THREE.Vector3();
  const wantLook = new THREE.Vector3();
  const shakeOff = new THREE.Vector3();
  const upVec = new THREE.Vector3(0, 1, 0);

  // shake state: an impulse decays over ~0.45 s and is re-projected into camera
  // space every frame so a hit always reads as a jolt of the lens, never as the
  // world sliding sideways.
  let shakeAmt = 0;
  let shakeDirX = 0, shakeDirZ = 0;
  let shakeRoll = 0;
  let fovKick = 0;
  let t = 0;
  let snapNext = false;

  // dynamic framing: pull back on a fast break, tighten near the penalty area
  let frameMul = 1;

  function cut(m, opts = {}) {
    if (MODES[m]) { mode = m; cfg = MODES[m]; }
    if (opts.side !== undefined) sideSign = opts.side;
    if (opts.yaw !== undefined) yawOffset = opts.yaw;
    heightMul = opts.heightMul ?? 1;
    distMul = opts.distMul ?? 1;
    orbitRate = opts.orbit ?? (m === 'replay' ? 0.42 : 0);
    if (opts.snap) snapNext = true;
  }

  function snap() { snapNext = true; }

  /**
   * Impact shake. `a` is 0..1-ish; an optional world direction biases the jolt
   * so a tackle shoves the frame the way the tackle went.
   */
  function shake(a, dirX = 0, dirZ = 0) {
    shakeAmt = Math.min(1.4, shakeAmt + a);
    const l = Math.hypot(dirX, dirZ);
    if (l > 1e-4) { shakeDirX = dirX / l; shakeDirZ = dirZ / l; }
    fovKick = Math.min(2.4, fovKick + a * 1.8);
  }

  function update(dt, focus = {}) {
    t += dt;
    const ball = focus.ball || wantPos;
    const hero = focus.hero || null;
    const action = focus.action || ball;

    // ---- dynamic framing --------------------------------------------------
    // Fast ball -> more of the pitch in frame so the run has somewhere to go.
    // Ball deep in either box -> tighten, because the interesting radius is
    // small and a wide shot there just shows empty grass.
    if (mode === 'follow' || mode === 'chase' || mode === 'broadcast') {
      const spd = Math.abs(focus.leadX || 0);
      const boxT = clamp((Math.abs(ball.x) - 12) / 14, 0, 1);
      const want = 1 + clamp(spd / 26, 0, 1) * 0.22 - boxT * 0.14;
      frameMul += (want - frameMul) * Math.min(1, dt * 1.6);
    } else {
      frameMul += (1 - frameMul) * Math.min(1, dt * 3);
    }

    const h = cfg.height * heightMul * (mode === 'wide' ? 1 : frameMul);
    const back = cfg.back * distMul * (mode === 'wide' ? 1 : frameMul);

    switch (mode) {
      case 'closeup': {
        const p = hero || action;
        const yaw = yawOffset + orbitRate * t;
        wantPos.set(
          p.x + Math.sin(yaw) * back,
          p.y + h,
          p.z + Math.cos(yaw) * back,
        );
        wantLook.set(p.x, p.y + cfg.look, p.z);
        break;
      }
      case 'keeper': {
        // over the attacker's shoulder, looking at the goal
        const p = hero || action;
        const gx = Math.sign(focus.goalX ?? HALF_W) * HALF_W;
        const dx = gx - p.x, dz = (focus.goalZ ?? 0) - p.z;
        const len = Math.hypot(dx, dz) || 1;
        wantPos.set(p.x - (dx / len) * back, p.y + h, p.z - (dz / len) * back + yawOffset);
        wantLook.set(p.x + (dx / len) * 6, cfg.look, p.z + (dz / len) * 6);
        break;
      }
      case 'wide': {
        // Outside the bowl, just over the roofline, looking almost level across
        // the stadium: the pitch sits in the lower third, the far stand fills
        // the middle and the roof, jumbotron and pylons crown the frame.
        //
        // The azimuth is biased onto the bowl's diagonal (the core rect is
        // 28 x 18, so its corner lies at atan2(28,18) = 1.00 rad). Sitting on
        // the diagonal is not cosmetic: the roof-mounted jumbotrons are parked
        // on the short axis at z = +/-56 and are 27 m wide, so a camera on that
        // axis puts a black slab across a third of the establishing shot.
        const yaw = yawOffset + WIDE_YAW_BIAS + orbitRate * t;
        wantPos.set(Math.sin(yaw) * back * 1.10, h, Math.cos(yaw) * back * 0.92);
        wantLook.set(0, cfg.look, 0);
        break;
      }
      case 'replay': {
        const p = action;
        const yaw = yawOffset + orbitRate * t;
        wantPos.set(p.x + Math.sin(yaw) * back, h, p.z + Math.cos(yaw) * back);
        wantLook.set(p.x, cfg.look, p.z);
        break;
      }
      case 'goal': {
        const p = action;
        const yaw = yawOffset + orbitRate * t;
        wantPos.set(p.x + Math.sin(yaw) * back, h, p.z + Math.cos(yaw) * back);
        wantLook.set(p.x * 0.85, cfg.look, p.z * 0.6);
        break;
      }
      case 'tackle': {
        const p = action;
        wantPos.set(p.x + Math.sin(yawOffset) * back, h, p.z + Math.cos(yawOffset) * back);
        wantLook.set(p.x, cfg.look, p.z);
        break;
      }
      case 'chase':
      case 'follow': {
        const lead = (focus.leadX || 0) * cfg.lead;
        const cx = clamp(ball.x + lead, -HALF_W + 4, HALF_W - 4);
        const cz = clamp(ball.z * 0.55, -HALF_D + 3, HALF_D - 3);
        wantPos.set(cx * 0.92, h, cz + sideSign * back);
        wantLook.set(cx, cfg.look, cz * 0.9);
        break;
      }
      default: {
        const lead = (focus.leadX || 0) * cfg.lead;
        const cx = clamp((ball.x + lead) * 0.72, -22, 22);
        const cz = clamp(ball.z * 0.30, -7, 7);
        wantPos.set(cx, h, cz + sideSign * back);
        wantLook.set(cx * 0.9, cfg.look, cz * 0.5);
        break;
      }
    }

    if (snapNext) {
      posD.copy(wantPos); lookD.copy(wantLook);
      snapNext = false;
    } else {
      posD.step(wantPos, cfg.omega, dt);
      lookD.step(wantLook, cfg.omega * 1.25, dt);
    }

    // ---- shake ------------------------------------------------------------
    shakeAmt = Math.max(0, shakeAmt - dt * 2.9);
    fovKick = Math.max(0, fovKick - dt * 7.0);
    if (shakeAmt > 0.002) {
      const s = shakeAmt * shakeAmt;
      // two incommensurate frequencies per axis so it never reads as a loop
      const a = Math.sin(t * 61.3) * 0.65 + Math.sin(t * 27.1 + 1.9) * 0.35;
      const b = Math.sin(t * 47.7 + 1.3) * 0.62 + Math.sin(t * 19.4 + 0.4) * 0.38;
      const c = Math.sin(t * 53.1 + 2.7) * 0.66 + Math.sin(t * 23.7 + 2.2) * 0.34;
      // biased along the impact direction, so a slide tackle shoves the frame
      shakeOff.set(
        (a * 0.62 + shakeDirX * b * 0.5) * s * 0.80,
        b * s * 0.52,
        (c * 0.62 + shakeDirZ * b * 0.5) * s * 0.80,
      );
      shakeRoll = a * s * 0.028;
    } else {
      shakeOff.set(0, 0, 0);
      shakeRoll *= Math.max(0, 1 - dt * 10);
    }

    camera.position.copy(posD.v).add(shakeOff);
    camera.up.set(0, 1, 0);
    camera.lookAt(lookD.v);
    if (Math.abs(shakeRoll) > 1e-5) camera.rotateZ(shakeRoll);

    const wantFov = cfg.fov - fovKick;
    if (Math.abs(camera.fov - wantFov) > 0.01) {
      camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 6);
      camera.updateProjectionMatrix();
    }
  }

  return {
    update, shake, cut, snap,
    get mode() { return mode; },
    get position() { return posD.v; },
    get target() { return lookD.v; },
    /** teleport instantly (scenario setup) */
    place(px, py, pz, lx, ly, lz) {
      posD.set(px, py, pz); lookD.set(lx, ly, lz);
      camera.position.copy(posD.v);
      camera.up.set(0, 1, 0);
      camera.lookAt(lookD.v);
      camera.fov = cfg.fov; camera.updateProjectionMatrix();
      shakeAmt = 0; fovKick = 0; shakeRoll = 0; frameMul = 1;
    },
  };
}
