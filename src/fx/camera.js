// Camera director: framing modes, smooth follow, shake and cinematic cuts.
//
//   createDirector(camera) -> { update(dt, focus), shake(a), cut(mode, opts),
//                               snap(), mode }
//
// `focus` is { ball: Vector3, hero: Vector3|null, action: Vector3|null }.
// All smoothing is exponential on the fixed timestep, so a scenario settles to the
// same framing every run.

import * as THREE from 'three';
import { HALF_W, HALF_D } from '../core/constants.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// NOTE: the stand roofs sit at y = 31 with their inner edge 29 units out, so
// `broadcast` has to stay under them and `wide` has to be steep enough to look
// over them (height/back > ~1.07). See world/stadium.js ROOF_Y / ROOF_IN.
export const MODES = {
  broadcast: { fov: 45, height: 28, back: 38, lead: 0.35, look: 1.0, lag: 3.0 },
  follow: { fov: 42, height: 15.5, back: 19.5, lead: 0.55, look: 1.2, lag: 5.0 },
  chase: { fov: 46, height: 9.0, back: 15.0, lead: 0.8, look: 1.4, lag: 6.5 },
  closeup: { fov: 32, height: 1.55, back: 5.0, lead: 0, look: 1.02, lag: 8.0 },
  keeper: { fov: 46, height: 4.2, back: 8.2, lead: 0.2, look: 1.5, lag: 5.0 },
  wide: { fov: 44, height: 66, back: 54, lead: 0, look: 0.0, lag: 1.6 },
  goal: { fov: 36, height: 5.5, back: 12.0, lead: 0, look: 1.5, lag: 4.0 },
  tackle: { fov: 36, height: 3.2, back: 8.0, lead: 0, look: 1.1, lag: 6.0 },
};

export function createDirector(camera) {
  let mode = 'broadcast';
  let cfg = MODES.broadcast;
  let sideSign = 1;             // which touchline the broadcast camera sits on
  let yawOffset = 0;            // extra orbit for cinematic modes
  let heightMul = 1;
  let distMul = 1;

  const pos = new THREE.Vector3(0, 26, 40);
  const look = new THREE.Vector3(0, 1, 0);
  const wantPos = new THREE.Vector3();
  const wantLook = new THREE.Vector3();
  const shakeOff = new THREE.Vector3();

  let shakeAmt = 0;
  let t = 0;

  function cut(m, opts = {}) {
    if (MODES[m]) { mode = m; cfg = MODES[m]; }
    if (opts.side !== undefined) sideSign = opts.side;
    if (opts.yaw !== undefined) yawOffset = opts.yaw;
    heightMul = opts.heightMul ?? 1;
    distMul = opts.distMul ?? 1;
    if (opts.snap) snapNext = true;
  }

  let snapNext = false;
  function snap() { snapNext = true; }

  function shake(a) { shakeAmt = Math.min(1.4, shakeAmt + a); }

  function update(dt, focus = {}) {
    t += dt;
    const ball = focus.ball || new THREE.Vector3();
    const hero = focus.hero || null;
    const action = focus.action || ball;

    const h = cfg.height * heightMul;
    const back = cfg.back * distMul;

    switch (mode) {
      case 'closeup': {
        const p = hero || action;
        const yaw = yawOffset;
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
        wantPos.set(Math.sin(yawOffset) * back, h, Math.cos(yawOffset) * back);
        wantLook.set(0, 3, 0);
        break;
      }
      case 'goal': {
        const p = action;
        wantPos.set(p.x + Math.sin(yawOffset) * back, h, p.z + Math.cos(yawOffset) * back);
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
        const cx = clamp(ball.x + (focus.leadX || 0) * cfg.lead, -HALF_W + 4, HALF_W - 4);
        const cz = clamp(ball.z * 0.55, -HALF_D + 3, HALF_D - 3);
        wantPos.set(cx * 0.92, h, cz + sideSign * back);
        wantLook.set(cx, cfg.look, cz * 0.9);
        break;
      }
      default: {
        const cx = clamp(ball.x * 0.72, -22, 22);
        const cz = clamp(ball.z * 0.30, -7, 7);
        wantPos.set(cx, h, cz + sideSign * back);
        wantLook.set(cx * 0.9, cfg.look, cz * 0.5);
        break;
      }
    }

    const k = snapNext ? 1 : 1 - Math.exp(-dt * cfg.lag);
    snapNext = false;
    pos.lerp(wantPos, k);
    look.lerp(wantLook, k);

    // shake
    shakeAmt = Math.max(0, shakeAmt - dt * 2.6);
    if (shakeAmt > 0.001) {
      const s = shakeAmt * shakeAmt;
      shakeOff.set(
        Math.sin(t * 61.3) * s * 0.85,
        Math.sin(t * 47.7 + 1.3) * s * 0.65,
        Math.sin(t * 53.1 + 2.7) * s * 0.85,
      );
    } else shakeOff.set(0, 0, 0);

    camera.position.copy(pos).add(shakeOff);
    camera.lookAt(look);
    if (Math.abs(camera.fov - cfg.fov) > 0.01) {
      camera.fov += (cfg.fov - camera.fov) * (snapNext ? 1 : Math.min(1, dt * 5));
      camera.updateProjectionMatrix();
    }
  }

  return {
    update, shake, cut, snap,
    get mode() { return mode; },
    get position() { return pos; },
    get target() { return look; },
    /** teleport instantly (scenario setup) */
    place(px, py, pz, lx, ly, lz) {
      pos.set(px, py, pz); look.set(lx, ly, lz);
      camera.position.copy(pos); camera.lookAt(look);
      camera.fov = cfg.fov; camera.updateProjectionMatrix();
      shakeAmt = 0;
    },
  };
}
