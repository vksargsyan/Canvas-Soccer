// Goal frame + net. The back panel is a small verlet cloth so the net bulges when
// the ball hits it; side and top panels are static.
//
//   createGoal(side) -> { group, side, update(dt, ballPos, ballVel), impulse(p, v),
//                         posts, dispose() }
//
// `side` is +1 (goal at x = +HALF_W) or -1.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { netTexture } from '../core/assets.js';
import { HALF_W, GOAL_HALF_W, GOAL_H, GOAL_DEPTH, POST_R, BALL_R } from '../core/constants.js';

const NX = 11;   // net grid columns (across Z)
const NY = 8;    // net grid rows (down Y)

function netMaterial(repeatX, repeatY) {
  const map = netTexture(20);
  const m = new THREE.MeshBasicMaterial({
    map,
    alphaMap: map,
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  // clone the texture so each panel can have its own repeat
  const t = map.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  m.map = t; m.alphaMap = t;
  return m;
}

export function createGoal(side = 1) {
  const group = new THREE.Group();
  group.name = 'goal' + (side > 0 ? 'R' : 'L');
  const gx = side * HALF_W;

  // ---- frame (posts + crossbar merged into one draw) ----------------------
  const parts = [];
  const post = new THREE.CylinderGeometry(POST_R, POST_R, GOAL_H, 12, 1);
  const p1 = post.clone(); p1.translate(0, GOAL_H / 2, -GOAL_HALF_W);
  const p2 = post.clone(); p2.translate(0, GOAL_H / 2, GOAL_HALF_W);
  parts.push(p1, p2);

  const bar = new THREE.CylinderGeometry(POST_R, POST_R, GOAL_HALF_W * 2 + POST_R * 2, 12, 1);
  bar.rotateX(Math.PI / 2);
  bar.translate(0, GOAL_H, 0);
  parts.push(bar);

  // back stanchions
  const backPost = new THREE.CylinderGeometry(POST_R * 0.55, POST_R * 0.55, GOAL_H * 0.72, 8, 1);
  for (const z of [-GOAL_HALF_W, GOAL_HALF_W]) {
    const b = backPost.clone();
    b.translate(side * GOAL_DEPTH, GOAL_H * 0.36, z);
    parts.push(b);
  }
  // top rails from crossbar to back posts
  const rail = new THREE.CylinderGeometry(POST_R * 0.45, POST_R * 0.45, GOAL_DEPTH * 1.06, 8, 1);
  rail.rotateZ(Math.PI / 2);
  for (const z of [-GOAL_HALF_W, GOAL_HALF_W]) {
    const r = rail.clone();
    r.translate(side * GOAL_DEPTH * 0.5, GOAL_H * 0.93, z);
    parts.push(r);
  }

  const frameGeo = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  post.dispose(); bar.dispose(); backPost.dispose(); rail.dispose();

  const frame = new THREE.Mesh(frameGeo, new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.34, metalness: 0.12,
  }));
  frame.castShadow = true;
  frame.position.x = gx;
  group.add(frame);

  // ---- back net panel (verlet) -------------------------------------------
  const backGeo = new THREE.PlaneGeometry(GOAL_HALF_W * 2, GOAL_H, NX - 1, NY - 1);
  backGeo.rotateY(side > 0 ? -Math.PI / 2 : Math.PI / 2);

  const pos = backGeo.getAttribute('position');
  const count = pos.count;
  const rest = new Float32Array(count * 3);
  const cur = new Float32Array(count * 3);
  const prev = new Float32Array(count * 3);
  const pinned = new Uint8Array(count);

  const backX = gx + side * GOAL_DEPTH;
  for (let i = 0; i < count; i++) {
    // PlaneGeometry after the rotateY sits in the YZ plane centred on origin
    const y = pos.getY(i) + GOAL_H / 2;
    const z = pos.getZ(i);
    rest[i * 3] = backX; rest[i * 3 + 1] = y; rest[i * 3 + 2] = z;
    cur[i * 3] = backX; cur[i * 3 + 1] = y; cur[i * 3 + 2] = z;
    prev[i * 3] = backX; prev[i * 3 + 1] = y; prev[i * 3 + 2] = z;
    const col = i % NX, row = Math.floor(i / NX);
    pinned[i] = (col === 0 || col === NX - 1 || row === 0 || row === NY - 1) ? 1 : 0;
  }

  const back = new THREE.Mesh(backGeo, netMaterial(6, 4));
  back.frustumCulled = false;
  back.renderOrder = 3;
  group.add(back);
  writeBack();

  function writeBack() {
    for (let i = 0; i < count; i++) {
      pos.setXYZ(i, cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
    }
    pos.needsUpdate = true;
    backGeo.computeVertexNormals();
  }

  // ---- static side + top panels ------------------------------------------
  function panel(w, h, repX, repY) {
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h, 1, 1), netMaterial(repX, repY));
  }

  // Side panels lie in the XY plane already (X = depth, Y = height) so they need
  // no rotation — only a Z offset out to each post.
  for (const z of [-GOAL_HALF_W, GOAL_HALF_W]) {
    const sidePanel = panel(GOAL_DEPTH, GOAL_H, 4, 4);
    sidePanel.position.set(gx + side * GOAL_DEPTH / 2, GOAL_H / 2, z);
    sidePanel.renderOrder = 3;
    group.add(sidePanel);
  }

  // Top panel: rotate the GEOMETRY (not the object) so X stays depth and Y
  // becomes Z. Composing two object Eulers here silently swaps the axes.
  const topGeo = new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_HALF_W * 2, 1, 1);
  topGeo.rotateX(-Math.PI / 2);
  const top = new THREE.Mesh(topGeo, netMaterial(4, 6));
  top.position.set(gx + side * GOAL_DEPTH / 2, GOAL_H - 0.06, 0);
  top.renderOrder = 3;
  group.add(top);

  // ---- verlet step --------------------------------------------------------
  const REST_K = 0.30;     // pull back toward the rest shape
  const DAMP = 0.90;
  const tmp = new THREE.Vector3();

  function impulse(px, py, pz, vx, vy, vz, strength = 1) {
    for (let i = 0; i < count; i++) {
      if (pinned[i]) continue;
      const dx = cur[i * 3] - px, dy = cur[i * 3 + 1] - py, dz = cur[i * 3 + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const falloff = Math.exp(-d2 * 0.55);
      if (falloff < 0.004) continue;
      const k = 0.0075 * strength * falloff;
      cur[i * 3] += vx * k;
      cur[i * 3 + 1] += vy * k;
      cur[i * 3 + 2] += vz * k;
    }
  }

  let settled = true;

  function update(dt, ballPos, ballVel) {
    if (ballPos) {
      const insideX = side > 0
        ? (ballPos.x > gx - 0.2 && ballPos.x < backX + 0.9)
        : (ballPos.x < gx + 0.2 && ballPos.x > backX - 0.9);
      if (insideX && Math.abs(ballPos.z) < GOAL_HALF_W + 0.4 && ballPos.y < GOAL_H + 0.4) {
        const near = Math.abs(ballPos.x - backX);
        if (near < BALL_R + 0.6) {
          impulse(ballPos.x, ballPos.y, ballPos.z,
            ballVel ? ballVel.x : side * 4, ballVel ? ballVel.y : 0, ballVel ? ballVel.z : 0, 1);
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
        let v = (c - prev[o + a]) * DAMP;
        prev[o + a] = c;
        const toRest = (rest[o + a] - c) * REST_K;
        cur[o + a] = c + v + toRest;
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
    if (Math.abs(z) > GOAL_HALF_W - BALL_R * 0.4) return false;
    if (y > GOAL_H - BALL_R * 0.4) return false;
    return side > 0 ? x > HALF_W + BALL_R * 0.35 : x < -HALF_W - BALL_R * 0.35;
  }

  return {
    group, side, frame, back,
    posts: [
      { x: gx, z: -GOAL_HALF_W, r: POST_R },
      { x: gx, z: GOAL_HALF_W, r: POST_R },
    ],
    crossbarY: GOAL_H,
    backX,
    contains,
    impulse: (p, v, s) => { impulse(p.x, p.y, p.z, v.x, v.y, v.z, s); settled = false; },
    update,
    reset() {
      for (let i = 0; i < count * 3; i++) { cur[i] = rest[i]; prev[i] = rest[i]; }
      writeBack(); settled = true;
    },
    dispose() {
      group.traverse((o) => {
        if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
      });
    },
  };
}
