// Goal frame + net.
//
//   createGoal(side) -> { group, side, posts, crossbarY, backX, contains(),
//                         impulse(p, v, s), update(dt, ballPos, ballVel),
//                         reset(), dispose() }
//
// `side` is +1 (goal at x = +HALF_W) or -1.
//
// The net is a real 3D volume, not a transparent quad standing behind the line:
// it hangs from a back rail close to the crossbar and runs out and DOWN to the
// ground further back, so the two side panels are trapezoids and the whole thing
// has visible depth from any angle. Every panel is a subdivided grid carrying a
// catenary sag, and the back panel is additionally a verlet cloth so a shot
// bulges it.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { netTexture } from './stadium-tex.js';
import { HALF_W, GOAL_HALF_W, GOAL_H, GOAL_DEPTH, POST_R, BALL_R } from '../core/constants.js';

const D_TOP = 1.05;              // how far back the net's top rail sits
const D_BOT = GOAL_DEPTH;        // how far back the net meets the ground
const clampNum = (v, a, b) => (v < a ? a : v > b ? b : v);
const NET_CELL = 0.19;           // world size of one net mesh cell

const NX = 15;                   // back panel columns (across Z)
const NY = 11;                   // back panel rows (top -> ground)
const SX = 9;                    // side / top panel resolution
const SY = 9;

const netMap = () => netTexture(16);

function netMaterial() {
  const map = netMap();
  return new THREE.MeshBasicMaterial({
    map,
    color: 0xffffff,
    transparent: true,
    opacity: 0.96,
    alphaTest: 0.02,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
}

/** Build an indexed grid geometry from a (u,v) -> {x,y,z} function. */
function gridGeometry(cols, rows, fn, uRep, vRep) {
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1), v = j / (rows - 1);
      const p = fn(u, v);
      const k = j * cols + i;
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      uv[k * 2] = u * uRep; uv[k * 2 + 1] = v * vRep;
    }
  }
  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createGoal(side = 1) {
  const group = new THREE.Group();
  group.name = 'goal' + (side > 0 ? 'R' : 'L');
  const gx = side * HALF_W;
  const HW = GOAL_HALF_W;

  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  // ---- frame -------------------------------------------------------------
  // Posts are oval in section (flattened along the pitch axis) like real goals.
  const parts = [];
  const mkPost = (h, r) => {
    const g = new THREE.CylinderGeometry(r, r, h, 14, 1);
    g.scale(0.74, 1, 1);   // oval section
    return g;
  };
  for (const z of [-HW, HW]) {
    const p = mkPost(GOAL_H, POST_R);
    p.translate(0, GOAL_H / 2, z);
    parts.push(p);
  }
  {
    const bar = new THREE.CylinderGeometry(POST_R, POST_R, HW * 2 + POST_R * 2, 14, 1);
    bar.rotateX(Math.PI / 2);
    bar.scale(0.74, 1, 1);
    bar.translate(0, GOAL_H, 0);
    parts.push(bar);
  }
  // back top rail
  {
    const rail = new THREE.CylinderGeometry(POST_R * 0.5, POST_R * 0.5, HW * 2, 8, 1);
    rail.rotateX(Math.PI / 2);
    rail.translate(side * D_TOP, GOAL_H - 0.02, 0);
    parts.push(rail);
  }
  // top stringers crossbar -> back rail
  for (const z of [-HW, HW]) {
    const r = new THREE.CylinderGeometry(POST_R * 0.42, POST_R * 0.42, D_TOP, 8, 1);
    r.rotateZ(Math.PI / 2);
    r.translate(side * D_TOP * 0.5, GOAL_H - 0.01, z);
    parts.push(r);
  }
  // rear stanchions: slope from the top rail down to the ground line
  for (const z of [-HW, HW]) {
    const dx = (D_BOT - D_TOP), dy = GOAL_H;
    const len = Math.hypot(dx, dy);
    const s = new THREE.CylinderGeometry(POST_R * 0.5, POST_R * 0.5, len, 8, 1);
    s.rotateZ(-side * Math.atan2(dx, dy));
    s.translate(side * (D_TOP + dx / 2), dy / 2, z);
    parts.push(s);
  }
  // ground bar along the back of the net
  {
    const g = new THREE.CylinderGeometry(POST_R * 0.45, POST_R * 0.45, HW * 2, 8, 1);
    g.rotateX(Math.PI / 2);
    g.translate(side * D_BOT, POST_R * 0.45, 0);
    parts.push(g);
  }
  // ground bars along each side
  for (const z of [-HW, HW]) {
    const g = new THREE.CylinderGeometry(POST_R * 0.4, POST_R * 0.4, D_BOT, 8, 1);
    g.rotateZ(Math.PI / 2);
    g.translate(side * D_BOT * 0.5, POST_R * 0.4, z);
    parts.push(g);
  }

  const frameGeo = track(mergeGeometries(parts, false));
  parts.forEach((g) => g.dispose());
  const frameMat = track(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.28, metalness: 0.10,
  }));
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.castShadow = true;
  frame.position.x = gx;
  group.add(frame);

  // ---- net panels --------------------------------------------------------
  const backX = gx + side * D_BOT;

  // Back panel: hangs from (D_TOP, GOAL_H) down to (D_BOT, 0), bowed outward.
  const backDepth = (v) => D_TOP + (D_BOT - D_TOP) * v;
  const backShape = (u, v) => {
    const bow = Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * 0.16;
    return {
      x: gx + side * (backDepth(v) + bow),
      y: GOAL_H * (1 - v),
      z: -HW + u * HW * 2,
    };
  };
  const backGeo = track(gridGeometry(
    NX, NY, backShape, (HW * 2) / (NET_CELL * 16), (GOAL_H * 1.15) / (NET_CELL * 16)));
  const backMat = track(netMaterial());
  const back = new THREE.Mesh(backGeo, backMat);
  back.frustumCulled = false;
  back.renderOrder = 3;
  group.add(back);

  // Side panels: quadrilaterals from the front post to the sloping back edge.
  const staticParts = [];
  for (const z of [-HW, HW]) {
    const sgn = Math.sign(z);
    staticParts.push(gridGeometry(SX, SY, (u, v) => {
      const d = backDepth(v) * u;
      const bow = Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * 0.11 * sgn;
      return { x: gx + side * d, y: GOAL_H * (1 - v), z: z + bow };
    }, (D_BOT * 1.1) / (NET_CELL * 16), (GOAL_H * 1.15) / (NET_CELL * 16)));
  }
  // Top panel: crossbar back to the top rail, sagging between them.
  staticParts.push(gridGeometry(SX, SY, (u, v) => {
    const sag = Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * 0.13;
    return {
      x: gx + side * (D_TOP * u),
      y: GOAL_H - 0.03 - sag,
      z: -HW + v * HW * 2,
    };
  }, (D_TOP * 1.1) / (NET_CELL * 16), (HW * 2) / (NET_CELL * 16)));

  const staticGeo = track(mergeGeometries(staticParts, false));
  staticParts.forEach((g) => g.dispose());
  const staticMat = track(netMaterial());
  const staticNet = new THREE.Mesh(staticGeo, staticMat);
  staticNet.renderOrder = 3;
  group.add(staticNet);

  // ---- verlet on the back panel ------------------------------------------
  const pos = backGeo.getAttribute('position');
  const count = pos.count;
  const rest = new Float32Array(count * 3);
  const cur = new Float32Array(count * 3);
  const prev = new Float32Array(count * 3);
  const pinned = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    rest[o] = pos.getX(i); rest[o + 1] = pos.getY(i); rest[o + 2] = pos.getZ(i);
    cur[o] = rest[o]; cur[o + 1] = rest[o + 1]; cur[o + 2] = rest[o + 2];
    prev[o] = rest[o]; prev[o + 1] = rest[o + 1]; prev[o + 2] = rest[o + 2];
    const c = i % NX, r = Math.floor(i / NX);
    pinned[i] = (c === 0 || c === NX - 1 || r === 0 || r === NY - 1) ? 1 : 0;
  }

  function writeBack() {
    for (let i = 0; i < count; i++) {
      pos.setXYZ(i, cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
    }
    pos.needsUpdate = true;
    backGeo.computeVertexNormals();
  }

  const REST_K = 0.30;
  const DAMP = 0.90;
  let settled = true;

  function impulse(px, py, pz, vx, vy, vz, strength = 1) {
    for (let i = 0; i < count; i++) {
      if (pinned[i]) continue;
      const o = i * 3;
      const dx = cur[o] - px, dy = cur[o + 1] - py, dz = cur[o + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const falloff = Math.exp(-d2 * 0.5);
      if (falloff < 0.004) continue;
      const k = 0.0080 * strength * falloff;
      cur[o] += vx * k; cur[o + 1] += vy * k; cur[o + 2] += vz * k;
    }
  }

  function update(dt, ballPos, ballVel) {
    if (ballPos) {
      const inX = side > 0
        ? (ballPos.x > gx - 0.2 && ballPos.x < backX + 1.0)
        : (ballPos.x < gx + 0.2 && ballPos.x > backX - 1.0);
      if (inX && Math.abs(ballPos.z) < HW + 0.4 && ballPos.y < GOAL_H + 0.4) {
        // distance to the sloped back sheet at the ball's height
        const v = Math.max(0, Math.min(1, 1 - ballPos.y / GOAL_H));
        const sheetX = gx + side * backDepth(v);
        if (Math.abs(ballPos.x - sheetX) < BALL_R + 0.7) {
          impulse(ballPos.x, ballPos.y, ballPos.z,
            ballVel ? ballVel.x : side * 4, ballVel ? ballVel.y : 0,
            ballVel ? ballVel.z : 0, 1);
          settled = false;
        }
      }
    }
    if (settled) return;

    let motion = 0;
    for (let i = 0; i < count; i++) {
      if (pinned[i]) continue;
      const o = i * 3;
      for (let a = 0; a < 3; a++) {
        const c = cur[o + a];
        const v = (c - prev[o + a]) * DAMP;
        prev[o + a] = c;
        cur[o + a] = c + v + (rest[o + a] - c) * REST_K;
        motion += Math.abs(v);
      }
    }
    writeBack();
    if (motion < 0.0012) {
      settled = true;
      for (let i = 0; i < count * 3; i++) { cur[i] = rest[i]; prev[i] = rest[i]; }
      writeBack();
    }
  }

  /** Does a point sit inside the goal mouth (i.e. is it a goal)? */
  function contains(x, y, z) {
    if (Math.abs(z) > HW - BALL_R * 0.4) return false;
    if (y > GOAL_H - BALL_R * 0.4) return false;
    return side > 0 ? x > HALF_W + BALL_R * 0.35 : x < -HALF_W - BALL_R * 0.35;
  }

  return {
    group, side, frame, back,
    posts: [
      { x: gx, z: -HW, r: POST_R },
      { x: gx, z: HW, r: POST_R },
    ],
    crossbarY: GOAL_H,
    backX,
    /**
     * Depth (metres behind the goal line) of the sloping back sheet at height y.
     * The sim must call this instead of approximating the slope, so the net
     * response tracks the real geometry if D_TOP / D_BOT ever change.
     */
    sheetDepthAt(y) {
      const v = 1 - clampNum(y / GOAL_H, 0, 1);   // v = 0 at the crossbar
      return D_TOP + (D_BOT - D_TOP) * v;
    },
    depthTop: D_TOP,
    depthBottom: D_BOT,
    contains,
    impulse: (p, v, s) => { impulse(p.x, p.y, p.z, v.x, v.y, v.z, s); settled = false; },
    update,
    reset() {
      for (let i = 0; i < count * 3; i++) { cur[i] = rest[i]; prev[i] = rest[i]; }
      writeBack(); settled = true;
    },
    dispose() { for (const d of disposables) if (d && d.dispose) d.dispose(); },
  };
}
