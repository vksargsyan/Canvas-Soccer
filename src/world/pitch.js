// The playing surface: mow stripes, painted markings, wear decals.
//
//   createPitch() -> { group, materials, update(dt), dispose() }
//
// Stripes are built as alternating meshes rather than baked into a texture so the
// banding stays crisp from any camera distance. All painted lines are merged into a
// single geometry, so the whole pitch costs ~STRIPES + 2 draw calls.

import * as THREE from 'three';
import { turfTextures, wearTexture } from '../core/assets.js';
import {
  FIELD_W, FIELD_D, HALF_W, HALF_D, STRIPES, STRIPE_W,
  LINE_T, CENTER_R, BOX_W, BOX_D, SIX_W, SIX_D, PEN_SPOT, CORNER_R,
  GOAL_HALF_W,
} from '../core/constants.js';

const TILE = 1.8; // world units per turf texture tile

// ---------------------------------------------------------------------------
// painted-line geometry builder (flat quads in the XZ plane, y = 0)
// ---------------------------------------------------------------------------

function paintBuilder() {
  const pos = [];
  const uv = [];
  const idx = [];

  // NOTE winding: in the XZ plane a CCW-in-XZ loop is clockwise seen from +Y, so
  // the indices below are reversed to keep the paint facing up.
  function quad(ax, az, bx, bz, cx, cz, dx, dz) {
    const o = pos.length / 3;
    pos.push(ax, 0, az, bx, 0, bz, cx, 0, cz, dx, 0, dz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
  }

  /** axis-aligned or arbitrary segment of thickness t */
  function seg(x1, z1, x2, z2, t = LINE_T) {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * (t / 2), nz = (dx / len) * (t / 2);
    quad(x1 - nx, z1 - nz, x2 - nx, z2 - nz, x2 + nx, z2 + nz, x1 + nx, z1 + nz);
  }

  function arc(cx, cz, r, a0, a1, t = LINE_T, steps = 48) {
    let px = cx + Math.cos(a0) * r, pz = cz + Math.sin(a0) * r;
    for (let i = 1; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      seg(px, pz, x, z, t);
      px = x; pz = z;
    }
  }

  function disc(cx, cz, r, steps = 20) {
    const o = pos.length / 3;
    pos.push(cx, 0, cz); uv.push(0.5, 0.5);
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      pos.push(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r);
      uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let i = 1; i <= steps; i++) idx.push(o, o + i + 1, o + i);
  }

  function build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // flat surface: force straight-up normals so paint lights identically to turf
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    n.needsUpdate = true;
    return g;
  }

  return { seg, arc, disc, build };
}

function markingsGeometry() {
  const b = paintBuilder();
  const T = LINE_T;

  // touchlines + goal lines
  b.seg(-HALF_W, -HALF_D, HALF_W, -HALF_D, T);
  b.seg(-HALF_W, HALF_D, HALF_W, HALF_D, T);
  b.seg(-HALF_W, -HALF_D, -HALF_W, HALF_D, T);
  b.seg(HALF_W, -HALF_D, HALF_W, HALF_D, T);

  // halfway line + centre circle + spot
  b.seg(0, -HALF_D, 0, HALF_D, T);
  b.arc(0, 0, CENTER_R, 0, Math.PI * 2, T, 72);
  b.disc(0, 0, 0.22);

  for (const s of [-1, 1]) {
    const gl = s * HALF_W;                 // goal line x
    const bx = s * (HALF_W - BOX_W);       // penalty area far edge
    const sx = s * (HALF_W - SIX_W);       // six-yard far edge

    // penalty area
    b.seg(gl, -BOX_D / 2, bx, -BOX_D / 2, T);
    b.seg(gl, BOX_D / 2, bx, BOX_D / 2, T);
    b.seg(bx, -BOX_D / 2, bx, BOX_D / 2, T);

    // six-yard box
    b.seg(gl, -SIX_D / 2, sx, -SIX_D / 2, T);
    b.seg(gl, SIX_D / 2, sx, SIX_D / 2, T);
    b.seg(sx, -SIX_D / 2, sx, SIX_D / 2, T);

    // penalty spot + D
    const px = s * (HALF_W - PEN_SPOT);
    b.disc(px, 0, 0.20);
    const R = 6.2;
    const cut = Math.acos(Math.min(1, Math.abs(px - bx) / R));
    if (s > 0) b.arc(px, 0, R, Math.PI / 2 + cut, Math.PI * 1.5 - cut, T, 30);
    else b.arc(px, 0, R, -Math.PI / 2 + cut, Math.PI / 2 - cut, T, 30);

    // corner arcs
    b.arc(gl, -HALF_D, CORNER_R, s > 0 ? Math.PI * 0.5 : 0, s > 0 ? Math.PI : Math.PI * 0.5, T, 12);
    b.arc(gl, HALF_D, CORNER_R, s > 0 ? Math.PI : Math.PI * 1.5, s > 0 ? Math.PI * 1.5 : Math.PI * 2, T, 12);

    // goal-line ticks either side of the goal mouth
    b.seg(gl, -GOAL_HALF_W, gl - s * 0.9, -GOAL_HALF_W, T * 0.8);
    b.seg(gl, GOAL_HALF_W, gl - s * 0.9, GOAL_HALF_W, T * 0.8);
  }

  return b.build();
}

// ---------------------------------------------------------------------------

export function createPitch() {
  const group = new THREE.Group();
  group.name = 'pitch';

  const turf = turfTextures();

  const base = {
    map: turf.map,
    normalMap: turf.normalMap,
    roughnessMap: turf.roughnessMap,
    normalScale: new THREE.Vector2(1.15, 1.15),
    roughness: 0.95,
    metalness: 0.0,
  };

  const light = new THREE.MeshStandardMaterial({ ...base, color: 0x7ccf43 });
  const dark = new THREE.MeshStandardMaterial({ ...base, color: 0x4e9628 });

  // Stripe geometry: one shared plane whose UVs tile seamlessly across neighbours.
  const stripeGeo = new THREE.PlaneGeometry(STRIPE_W, FIELD_D, 1, 1);
  stripeGeo.rotateX(-Math.PI / 2);
  {
    const uv = stripeGeo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * (STRIPE_W / TILE), uv.getY(i) * (FIELD_D / TILE));
    }
    uv.needsUpdate = true;
  }

  const stripes = [];
  for (let i = 0; i < STRIPES; i++) {
    const m = new THREE.Mesh(stripeGeo, i % 2 ? dark : light);
    m.position.x = -HALF_W + (i + 0.5) * STRIPE_W;
    m.receiveShadow = true;
    m.name = 'stripe' + i;
    group.add(m);
    stripes.push(m);
  }

  // Wear / scuff overlay
  const wear = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD_W, FIELD_D),
    new THREE.MeshBasicMaterial({
      map: wearTexture(), transparent: true, opacity: 0.42,
      depthWrite: false, blending: THREE.NormalBlending,
    }),
  );
  wear.rotation.x = -Math.PI / 2;
  wear.position.y = 0.008;
  wear.renderOrder = 1;
  group.add(wear);

  // Painted markings
  const paint = new THREE.Mesh(
    markingsGeometry(),
    new THREE.MeshStandardMaterial({
      color: 0xfbfdfb, roughness: 0.68, metalness: 0.0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }),
  );
  paint.position.y = 0.016;
  paint.receiveShadow = true;
  paint.renderOrder = 2;
  paint.name = 'markings';
  group.add(paint);

  return {
    group,
    stripes,
    materials: { light, dark, paint: paint.material },
    /** world-space bounds test helper */
    inPlay(x, z) { return Math.abs(x) <= HALF_W && Math.abs(z) <= HALF_D; },
    update() { /* static for now — wear decals accumulate in fx/vfx.js */ },
    dispose() {
      stripeGeo.dispose(); light.dispose(); dark.dispose();
      paint.geometry.dispose(); paint.material.dispose();
      wear.geometry.dispose(); wear.material.dispose();
    },
  };
}
