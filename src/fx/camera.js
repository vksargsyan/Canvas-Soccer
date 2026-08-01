// Camera director: framing modes, critically-damped follow, impact emphasis and
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
//
// FRAMING. The old follow simply pointed at the ball plus a slug of its
// velocity. At shooting speed that lead threw the striker out of frame left,
// parked the goal on the right edge and left the middle of the picture as bare
// grass. What replaces it is a weighted centre of interest — ball, ball-carrier
// and, once play enters the final third, the goal mouth — clamped so that the
// subject can never leave the frame and the goal can never crawl past the outer
// third. Composition is computed against the real projected frame width, not
// guessed, so it holds at any FOV or aspect.
//
// The director also publishes `camera.userData.dof`: the focal distance and
// aperture the render engine should use. Focus follows the shot rather than the
// screen centre, so a hero closeup throws the stand out of focus while a wide
// establishing shot keeps everything crisp.

import * as THREE from 'three';
import { HALF_W, HALF_D } from '../core/constants.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = Math.PI / 180;

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
//   omega    : spring stiffness (rad/s). higher = tighter tracking.
//   lead     : seconds of ball velocity the camera anticipates.
//   goalPull : how strongly the attacking goal drags the composition, 0..1.
//   dof      : { range, near, max, haze } handed to the render engine.
//              range = fraction of the focal distance that stays sharp
//              near  = extra blur multiplier in front of the focal plane
//              max   = blur radius as a fraction of frame height
//              haze  = aerial-perspective density
export const MODES = {
  broadcast: {
    fov: 45, height: 27, back: 39, lead: 0.16, look: 1.0, omega: 2.6, goalPull: 0.35,
    dof: { range: 0.62, near: 1.7, max: 0.0060, haze: 0.0042 },
  },
  follow: {
    fov: 42, height: 13.6, back: 23.0, lead: 0.14, look: 1.2, omega: 4.4, goalPull: 1.0,
    dof: { range: 0.50, near: 1.9, max: 0.0080, haze: 0.0050 },
  },
  chase: {
    fov: 46, height: 8.4, back: 15.5, lead: 0.18, look: 1.4, omega: 5.6, goalPull: 1.0,
    dof: { range: 0.42, near: 2.0, max: 0.0092, haze: 0.0055 },
  },
  closeup: {
    fov: 32, height: 1.55, back: 5.0, lead: 0, look: 1.02, omega: 7.0, goalPull: 0,
    dof: { range: 0.16, near: 2.2, max: 0.0165, haze: 0.0070 },
  },
  keeper: {
    fov: 46, height: 3.9, back: 8.6, lead: 0.10, look: 1.5, omega: 4.4, goalPull: 0,
    dof: { range: 0.34, near: 2.4, max: 0.0110, haze: 0.0060 },
  },
  wide: {
    fov: 52, height: 40, back: 76, lead: 0, look: 21.0, omega: 1.5, goalPull: 0,
    dof: { range: 0.85, near: 1.2, max: 0.0042, haze: 0.0030 },
  },
  goal: {
    fov: 38, height: 6.6, back: 15.0, lead: 0, look: 1.7, omega: 3.6, goalPull: 0,
    dof: { range: 0.30, near: 2.6, max: 0.0130, haze: 0.0060 },
  },
  tackle: {
    fov: 35, height: 3.05, back: 7.6, lead: 0, look: 1.05, omega: 5.4, goalPull: 0,
    dof: { range: 0.26, near: 2.4, max: 0.0125, haze: 0.0060 },
  },
  replay: {
    fov: 38, height: 4.6, back: 11.0, lead: 0, look: 1.3, omega: 3.0, goalPull: 0,
    dof: { range: 0.32, near: 2.2, max: 0.0120, haze: 0.0060 },
  },
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
  const dollyV = new THREE.Vector3();

  // shake state: an impulse decays over ~0.7 s and is re-projected into camera
  // space every frame so a hit always reads as a jolt of the lens, never as the
  // world sliding sideways. `punch` is the slower partner — a short dolly-in and
  // FOV squeeze that survives long enough to actually be seen on the frame after
  // a strike, which a 0.15 s FOV blip never was.
  let shakeAmt = 0;
  let shakeDirX = 0, shakeDirZ = 0;
  let shakeRoll = 0;
  let punch = 0;
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
   * Impact emphasis. `a` is 0..1-ish; an optional world direction biases the
   * jolt so a tackle shoves the frame the way the tackle went.
   */
  function shake(a, dirX = 0, dirZ = 0) {
    shakeAmt = Math.min(1.4, shakeAmt + a);
    const l = Math.hypot(dirX, dirZ);
    if (l > 1e-4) { shakeDirX = dirX / l; shakeDirZ = dirZ / l; }
    punch = Math.min(1.0, punch + a * 2.6);
  }

  /** half-width of the frame, in world units, at distance `dist` */
  function halfWidthAt(dist, fov) {
    return Math.tan(fov * 0.5 * DEG) * (camera.aspect || 16 / 9) * dist;
  }

  // -------------------------------------------------------------------------
  // Composition for the tracking modes
  // -------------------------------------------------------------------------
  // Returns the along-pitch centre of the frame. Three interests are averaged —
  // ball, carrier and (weighted by how deep play is) the goal mouth — then the
  // result is clamped twice: the goal is not allowed outside the outer third,
  // and after that the subject is not allowed outside the frame at all. The
  // subject clamp runs last on purpose: if the two ever disagree, losing the
  // striker is a worse picture than losing the goalposts.
  function composeX(focus, ball, hero, dist, fov) {
    const gx = focus.goalX ?? HALF_W;
    const ax = gx >= 0 ? 1 : -1;
    const bx = ball.x;
    const hx = hero ? hero.x : bx;

    const gt = clamp((bx * ax - 4) / 20, 0, 1) * (cfg.goalPull ?? 0);
    const wB = 1.0, wH = 0.55, wG = 0.85 * gt;
    let cx = (bx * wB + hx * wH + gx * 0.93 * wG) / (wB + wH + wG);

    // lead room, but only a taste of it — this is the term that used to throw
    // the striker off the left edge on every shot.
    cx += clamp((focus.leadX || 0) * cfg.lead, -4.6, 4.6);

    const halfW = halfWidthAt(dist, fov);
    if (gt > 0.30) {
      const limit = gx - ax * halfW * 0.74;
      cx = ax > 0 ? Math.max(cx, limit) : Math.min(cx, limit);
    }
    const lo = Math.max(bx, hx) - halfW * 0.78;
    const hi = Math.min(bx, hx) + halfW * 0.78;
    if (lo <= hi) cx = clamp(cx, lo, hi);
    return clamp(cx, -HALF_W - 2, HALF_W + 2);
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
      const want = 1 + clamp(spd / 26, 0, 1) * 0.20 - boxT * 0.13;
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
        // Head high, feet and ball with room under them: the look point sits a
        // shade below the head so the subject reads on the upper third instead
        // of dead centre.
        wantLook.set(p.x, p.y + cfg.look, p.z);
        break;
      }
      case 'keeper': {
        // Over the attacker's shoulder, framed on the GOAL — the shot is about
        // where the ball is going, not about the back of a shirt. The camera is
        // pushed off the shooter-to-goal axis so the shooter falls into the
        // lower-left third instead of masking the target.
        const p = hero || action;
        const gx = (focus.goalX ?? HALF_W);
        const gz = focus.goalZ ?? 0;
        const dx = gx - p.x, dz = gz - p.z;
        const len = Math.hypot(dx, dz) || 1;
        const ux = dx / len, uz = dz / len;
        const rx = uz, rz = -ux;              // camera-right in the ground plane
        const lateral = 1.7;
        wantPos.set(
          p.x - ux * back + rx * lateral,
          p.y + h,
          p.z - uz * back + rz * lateral + yawOffset * 0.0,
        );
        wantLook.set(gx - ux * 1.6, cfg.look, gz * 0.5 + rz * lateral * 0.35);
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
        // Wide enough that the nearest celebrating player is a mid-ground figure
        // and not a head cropped across the lower third; the look point is
        // pulled off the ball, back toward the pitch, so the net, the scorer and
        // the confetti column all sit inside the frame.
        const p = action;
        const yaw = yawOffset + orbitRate * t;
        const ax = p.x >= 0 ? 1 : -1;
        wantPos.set(p.x + Math.sin(yaw) * back, h, p.z + Math.cos(yaw) * back);
        wantLook.set(p.x - ax * 3.2, cfg.look, p.z * 0.5);
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
        const dist = Math.hypot(back, h);
        const cx = composeX(focus, ball, hero, dist, cfg.fov);
        const hz = hero ? hero.z : ball.z;
        const cz = clamp((ball.z * 1.0 + hz * 0.55) / 1.55 * 0.5, -HALF_D + 3, HALF_D - 3);
        wantPos.set(cx - (focus.goalX >= 0 ? 1 : -1) * 1.1, h, cz + sideSign * back);
        wantLook.set(cx, cfg.look, cz * 0.9);
        break;
      }
      default: {
        const dist = Math.hypot(back, h);
        const cx = composeX(focus, ball, hero, dist, cfg.fov);
        const cz = clamp(ball.z * 0.30, -7, 7);
        wantPos.set(cx * 0.86, h, cz + sideSign * back);
        wantLook.set(cx * 0.94, cfg.look, cz * 0.5);
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

    // ---- impact ------------------------------------------------------------
    shakeAmt = Math.max(0, shakeAmt - dt * 2.0);
    punch = Math.max(0, punch - dt * 1.1);
    if (shakeAmt > 0.002) {
      // 1.4 rather than a square: a square is so forgiving in the mid range that
      // a 0.5 hit is already invisible two frames later.
      const s = Math.pow(shakeAmt, 1.4);
      // two incommensurate frequencies per axis so it never reads as a loop
      const a = Math.sin(t * 61.3) * 0.65 + Math.sin(t * 27.1 + 1.9) * 0.35;
      const b = Math.sin(t * 47.7 + 1.3) * 0.62 + Math.sin(t * 19.4 + 0.4) * 0.38;
      const c = Math.sin(t * 53.1 + 2.7) * 0.66 + Math.sin(t * 23.7 + 2.2) * 0.34;
      // biased along the impact direction, so a slide tackle shoves the frame
      shakeOff.set(
        (a * 0.62 + shakeDirX * b * 0.5) * s * 1.20,
        b * s * 0.80,
        (c * 0.62 + shakeDirZ * b * 0.5) * s * 1.20,
      );
      shakeRoll = a * s * 0.050;
    } else {
      shakeOff.set(0, 0, 0);
      shakeRoll *= Math.max(0, 1 - dt * 10);
    }

    camera.position.copy(posD.v).add(shakeOff);
    // Push-in: the lens crashes toward the action on a strike and eases back
    // out. Distance and FOV move together, so the subject grows faster than a
    // pure zoom would and the background stretches — a hit, not a jump cut.
    if (punch > 0.001) {
      dollyV.copy(lookD.v).sub(camera.position);
      const L = dollyV.length() || 1;
      camera.position.addScaledVector(dollyV, (punch * 1.1) / L);
    }
    camera.up.set(0, 1, 0);
    camera.lookAt(lookD.v);
    if (Math.abs(shakeRoll) > 1e-5) camera.rotateZ(shakeRoll);

    const wantFov = cfg.fov - punch * 4.0;
    if (Math.abs(camera.fov - wantFov) > 0.01) {
      camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 9);
      camera.updateProjectionMatrix();
    }

    // ---- publish focus for the depth-of-field pass -------------------------
    const d = cfg.dof;
    const focal = camera.position.distanceTo(lookD.v);
    const u = camera.userData.dof || (camera.userData.dof = {});
    // Ease the focal distance so a cut or a fast follow does not strobe the
    // background in and out of focus.
    u.focus = u.focus > 0 ? u.focus + (focal - u.focus) * Math.min(1, dt * 5) : focal;
    u.range = d.range;
    u.near = d.near;
    u.max = d.max;
    u.haze = d.haze;
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
      shakeAmt = 0; punch = 0; shakeRoll = 0; frameMul = 1;
      const u = camera.userData.dof || (camera.userData.dof = {});
      u.focus = camera.position.distanceTo(lookD.v);
      u.range = cfg.dof.range; u.near = cfg.dof.near;
      u.max = cfg.dof.max; u.haze = cfg.dof.haze;
    },
  };
}
