// Chibi player rig — geometry build + kit/skin/hair variation.
//
//   createPlayer(cfg) -> { group, rig, config, setSelected(b), syncShadow(),
//                          setExpression(k), dispose() }
//     cfg: { team, number, skin, hair, hairColor, isKeeper, faceVariant, beard,
//            kitStyle, bootColor, build, girth, headScale }
//
// Proportions (total height 2.0 world units, bobblehead chibi):
//   sole 0.00 -> ankle 0.06 -> knee 0.34 -> hip 0.64 -> shoulder 1.07
//   head centre 1.492, chin 1.05, crown 2.01 -> head is 0.96 tall == 48 %.
//
// The rig exposes named bones (plain Object3D): root, hips, torso, head,
// armL/R, forearmL/R, thighL/R, shinL/R, footL/R. animation.js drives only these.
//
// Surfacing lives in ./player-textures.js. Limbs are bodies of revolution
// (LatheGeometry) so kit textures get a clean u-around / v-along mapping:
// u = 0.25 is the chest, u = 0.75 the back, v = 1 the top of the part.
//
// HEAD. The skull is an analytic form (skullR) with a jaw, chin, cheekbones,
// temples, a brow ridge and two carved eye dishes. Each dish holds a real
// eyeball sphere and a real eyelid shell whose inner rim lands exactly on the
// ball, so the eyes are geometry, not a decal. Ears, nose and hands are modelled.
//
// Cost: 16 meshes per player, ~13k triangles. Materials, textures and the
// fabric normal map are cached and shared.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { softCircle } from '../core/assets.js';
import { TEAMS } from '../core/constants.js';
import {
  headTexture, eyeTexture, hairAtlas, shirtTexture, armTexture, shortsTexture,
  sockTexture, fabricNormal, warpU, warpV, mixHex, darken, lighten, contrastOn,
  SKIN_TONES, HAIR_COLORS, HAIR_STYLES, EYE_COLORS, BOOT_COLORS,
  FACE_ANCHORS, EYE_PROJ_S, BROW_SHAPES, KIT_RECIPES,
} from './player-textures.js';

export { SKIN_TONES, HAIR_COLORS, HAIR_STYLES };

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const FA = FACE_ANCHORS;

export const HEAD_R = 0.49;
const HIP_Y = 0.64;
const THIGH_L = 0.30;
const SHIN_L = 0.28;
const TORSO_H = 0.47;
const HEAD_BONE_Y = 0.50;       // relative to the torso bone
const HEAD_CENTER = 0.352;      // relative to the head bone
// egg, not beachball: taller than it is wide, flattened front-to-back
const HEAD_SX = 0.945, HEAD_SY = 1.055, HEAD_SZ = 0.955;
const JAW_TAPER = 0.288;

// eye dish (a smooth, low-frequency depression the skull mesh can resolve)
const DISH_H = 0.300, DISH_UP = 0.185, DISH_DN = 0.235, DISH_D = 0.110;
// eyeball, in world units
const EYE_R = FA.eyeR * HEAD_R;
const EYE_C = FA.eyeC * HEAD_R;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const bump = (x) => { const a = 1 - x * x; return a > 0 ? a * a : 0; };

// ---------------------------------------------------------------------------
// shared material cache
// ---------------------------------------------------------------------------

const matCache = new Map();
function sharedMat(key, make) {
  let m = matCache.get(key);
  if (!m) { m = make(); matCache.set(key, m); }
  return m;
}

function fabricMat(key, map, { rough = 0.86, repeat = [4, 3], normalScale = 0.55 } = {}) {
  return sharedMat(key, () => {
    const nrm = fabricNormal().clone();
    nrm.needsUpdate = true;
    nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping;
    nrm.repeat.set(repeat[0], repeat[1]);
    return new THREE.MeshStandardMaterial({
      map, normalMap: nrm, normalScale: new THREE.Vector2(normalScale, normalScale),
      roughness: rough, metalness: 0.0,
    });
  });
}

const skinMat = (skin) => sharedMat('skin:' + skin, () => new THREE.MeshStandardMaterial({
  color: skin, roughness: 0.78, metalness: 0.0,
}));

// one material for every head of hair — colour lives in vertex colours, and the
// atlas carries both the opaque strand streaks and the alpha strand cards.
const hairMat = () => sharedMat('hair', () => new THREE.MeshStandardMaterial({
  color: 0xffffff, vertexColors: true, map: hairAtlas(),
  alphaTest: 0.42, side: THREE.DoubleSide,
  roughness: 0.52, metalness: 0.04,
}));

const bootMat = () => sharedMat('boot', () => new THREE.MeshStandardMaterial({
  color: 0xffffff, vertexColors: true, roughness: 0.33, metalness: 0.03,
}));

const eyeMat = (col) => sharedMat('eye:' + col, () => new THREE.MeshStandardMaterial({
  map: eyeTexture({ color: col }), roughness: 0.16, metalness: 0.0,
}));

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

function tint(geo, hexColor) {
  const c = new THREE.Color(hexColor).convertSRGBToLinear();
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

/** default UV lands in the opaque half of the hair atlas */
function ensureUv(geo, u = 0.25, v = 0.5) {
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position').count;
    const a = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { a[i * 2] = u; a[i * 2 + 1] = v; }
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(a, 2));
  }
  return geo;
}

function setUv(geo, u, v) {
  const n = geo.getAttribute('position').count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = u; a[i * 2 + 1] = v; }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(a, 2));
  return geo;
}

/**
 * Sample a key list into `n` evenly spaced lathe points so the generated
 * uv.y (= index / (n-1)) is a clean 0..1 ramp along the part.
 * keys: [[t, radius, y], ...] with t ascending 0 -> 1.
 */
function profile(keys, n = 14) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let k = 0;
    while (k < keys.length - 2 && keys[k + 1][0] < t) k++;
    const a = keys[k], b = keys[k + 1];
    const raw = clamp((t - a[0]) / ((b[0] - a[0]) || 1), 0, 1);
    const f = raw * raw * (3 - 2 * raw);
    pts.push(new THREE.Vector2(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f));
  }
  return pts;
}

/** lathe with u = 0.25 at +Z (chest / front), u = 0.75 at -Z (back) */
function lathe(keys, segs = 18, n = 14) {
  return new THREE.LatheGeometry(profile(keys, n), segs, -Math.PI / 2, TAU);
}

/** spherical projection UV for parts that never cross the -Z seam */
function projectUV(geo, cy = 0) {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i) - cy, z = pos.getZ(i);
    const r = Math.hypot(x, y, z) || 1e-6;
    uv[i * 2] = warpU(0.25 + Math.atan2(x, z) / TAU);
    uv[i * 2 + 1] = warpV(1 - Math.acos(clamp(y / r, -1, 1)) / Math.PI);
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

/** cylindrical UV around Y, for merged limb detail (hands, cuffs) */
function cylUV(geo, v) {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = 0.25 + Math.atan2(pos.getX(i), pos.getZ(i)) / TAU;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

const blobGeo = (r, seg = 8) => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2));

// ---------------------------------------------------------------------------
// skull shape — one analytic function drives the head mesh, the eye dishes AND
// every hair shell, so hair hugs the actual skull instead of an ideal sphere.
// ---------------------------------------------------------------------------

/** unit direction for (azimuth from +Z toward +X, polar from the crown) */
function dirOf(az, th) {
  const st = Math.sin(th);
  return [st * Math.sin(az), Math.cos(th), st * Math.cos(az)];
}

/** local frame of each eye: axis e, in-plane right r, in-plane up u */
const EYE_FRAME = [-1, 1].map((s) => {
  const e = dirOf(s * FA.eyeAz, FA.eyeTh);
  let rx = e[2], rz = -e[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  const r = [rx, 0, rz];
  const u = [
    e[1] * r[2] - e[2] * r[1],
    e[2] * r[0] - e[0] * r[2],
    e[0] * r[1] - e[1] * r[0],
  ];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  return { s, e, r, u: [u[0] / ul, u[1] / ul, u[2] / ul] };
});

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** how deep the eye dish cuts at direction n, in skull radii */
function eyeDish(nx, ny, nz) {
  const n = [nx, ny, nz];
  let d = 0;
  for (const f of EYE_FRAME) {
    if (dot3(n, f.e) < 0.55) continue;
    const dh = dot3(n, f.r);
    const dv = dot3(n, f.u);
    const av = dv > 0 ? DISH_UP : DISH_DN;
    const e2 = (dh / DISH_H) * (dh / DISH_H) + (dv / av) * (dv / av);
    if (e2 < 1) { const k = 1 - e2; d += DISH_D * k * Math.sqrt(k); }
  }
  return d;
}

function skullR(nx, ny, nz) {
  let m = 1.0;
  const jaw = smooth(-0.08, -0.95, ny);
  m *= 1 - JAW_TAPER * jaw;                                              // jaw taper
  const ax = Math.abs(nx);
  m -= 0.058 * bump((ny - 0.34) / 0.52) * bump((ax - 0.84) / 0.32);      // temples
  m += 0.074 * bump((ny + 0.10) / 0.26) * bump((ax - 0.52) / 0.40)
    * smooth(-0.10, 0.72, nz);                                           // cheekbones
  // Buccal hollow under the cheekbone. This is the single term that separates
  // a sculpted head from a puffy one: without a dip beneath the zygomatic the
  // whole lower face reads as one continuous balloon.
  m -= 0.046 * bump((ny + 0.40) / 0.26) * bump((ax - 0.46) / 0.32)
    * smooth(0.05, 0.78, nz);
  m += 0.056 * bump((ny + 0.56) / 0.28) * bump((ax - 0.44) / 0.36)
    * smooth(-0.60, 0.30, nz);                                           // jaw corners
  m += 0.062 * bump((ny - 0.40) / 0.22) * bump(nx / 0.62)
    * smooth(0.22, 0.88, nz);                                            // brow ridge
  m += 0.086 * bump((ny + 0.62) / 0.30) * bump(nx / 0.44)
    * smooth(0.05, 0.60, nz);                                            // chin
  m -= 0.032 * bump((ny + 0.44) / 0.18) * bump(nx / 0.34)
    * smooth(0.35, 0.90, nz);                                            // mento-labial crease
  m += 0.030 * bump((ny + 0.14) / 0.40) * bump(nx / 0.38)
    * smooth(0.58, 0.96, nz);                                            // muzzle mass
  m += 0.038 * clamp(-nz, 0, 1) * bump((ny - 0.06) / 1.10);              // occiput
  m -= 0.034 * bump((ny - 0.62) / 0.46) * clamp(nz, 0, 1);               // flatter forehead
  m -= eyeDish(nx, ny, nz);                                              // eye sockets
  return m;
}

/** world offset of the skull surface at (azimuth from +Z, polar from crown) */
function skullPoint(az, th, lift = 0) {
  const [nx, ny, nz] = dirOf(az, th);
  const m = HEAD_R * (skullR(nx, ny, nz) + lift);
  return [nx * m * HEAD_SX, ny * m * HEAD_SY, nz * m * HEAD_SZ];
}

/** same point in the ROUND frame — for parts that go through finishFacePart(),
 *  which applies the HEAD_S* squash itself after UV projection */
function skullPointRound(az, th, lift = 0) {
  const [nx, ny, nz] = dirOf(az, th);
  const m = HEAD_R * (skullR(nx, ny, nz) + lift);
  return [nx * m, ny * m, nz * m];
}

function buildHead() {
  const g = new THREE.SphereGeometry(HEAD_R, 44, 32);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = Math.hypot(x, y, z) || 1e-6;
    const nx = x / r, ny = y / r, nz = z / r;
    const m = skullR(nx, ny, nz) * HEAD_R;
    pos.setXYZ(i, nx * m * HEAD_SX, ny * m * HEAD_SY, nz * m * HEAD_SZ);
  }
  // warp the sphere's own (seam-correct) UVs into face-dense texture space
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, warpU(uv.getX(i)), warpV(uv.getY(i)));
  uv.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(0, HEAD_CENTER, 0);
  return g;
}

/** UV-project in the round frame, then squash with the skull — keeps paint aligned */
function finishFacePart(parts) {
  const m = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (parts.length > 1) parts.forEach((p) => p.dispose());
  projectUV(m, 0);
  m.scale(HEAD_SX, HEAD_SY, HEAD_SZ);
  m.computeVertexNormals();
  m.translate(0, HEAD_CENTER, 0);
  return m;
}

// ---------------------------------------------------------------------------
// EYES — the dish, the ball and the lid.
// ---------------------------------------------------------------------------

/** where a ray along `n` leaves the eyeball of frame `f` (0 if it misses) */
function ballHit(n, f) {
  const cd = EYE_C * dot3(n, f.e);
  const disc = EYE_R * EYE_R - EYE_C * EYE_C + cd * cd;
  return disc <= 0 ? 0 : cd + Math.sqrt(disc);
}

/** direction on the rim ellipse at parameter phi, scaled outward by k */
function rimDir(f, phi, k) {
  const ch = Math.cos(phi), sh = Math.sin(phi);
  const ah = FA.rimH * k;
  const av = (sh > 0 ? FA.rimUp : FA.rimDn) * k;
  const x = f.e[0] + f.r[0] * ah * ch + f.u[0] * av * sh;
  const y = f.e[1] + f.r[1] * ah * ch + f.u[1] * av * sh;
  const z = f.e[2] + f.r[2] * ah * ch + f.u[2] * av * sh;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * Eyelid: a ring that starts exactly on the eyeball at the eye rim and fans out
 * until it is tucked under the skull at the edge of the dish. Because its inner
 * edge lies on the ball there is no gap, no decal and no floating outline — the
 * lash line is a real crease between two surfaces.
 */
function buildLids() {
  const parts = [];
  const NU = 32, NV = 5;
  const K_OUT = 2.16;                     // rim ellipse -> dish edge
  for (const f of EYE_FRAME) {
    const pos = [], idx = [];
    for (let i = 0; i <= NU; i++) {
      const phi = (i / NU) * TAU;
      // the two ends are fixed per phi: the inner edge lies ON the eyeball, the
      // outer edge is tucked just under the skull at the edge of the dish.
      const nIn = rimDir(f, phi, 1);
      const nOut = rimDir(f, phi, K_OUT);
      const rIn = ballHit(nIn, f) + 0.0022;
      const rOut = HEAD_R * skullR(nOut[0], nOut[1], nOut[2]) * 0.996;
      for (let j = 0; j <= NV; j++) {
        const t = j / NV;
        const n = rimDir(f, phi, 1 + (K_OUT - 1) * t);
        // ease from the ball out to the skull, with a little lid volume on top
        const e = t * t * (3 - 2 * t);
        const bulge = 0.009 * Math.sin(Math.PI * Math.pow(t, 0.75))
          * (Math.sin(phi) > 0 ? 1 : 0.45);
        const r = rIn + (rOut - rIn) * e + bulge * (1 - e * e);
        pos.push(n[0] * r * HEAD_SX, n[1] * r * HEAD_SY, n[2] * r * HEAD_SZ);
      }
    }
    const rows = NV + 1;
    for (let i = 0; i < NU; i++) {
      for (let j = 0; j < NV; j++) {
        const a = i * rows + j, b = a + rows;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    parts.push(g);
  }
  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  projectUV(m, 0);
  m.computeVertexNormals();
  m.translate(0, HEAD_CENTER, 0);
  return m;
}

/** the two eyeballs, UV-projected down each eye's look axis */
function buildEyeballs() {
  const parts = [];
  for (const f of EYE_FRAME) {
    const g = new THREE.SphereGeometry(EYE_R, 22, 16);
    // planar patch UV about +Z before the sphere is oriented
    const pos = g.getAttribute('position');
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) / EYE_R, dy = pos.getY(i) / EYE_R;
      uv[i * 2] = clamp(0.5 + (0.5 * dx) / EYE_PROJ_S, 0.001, 0.999);
      uv[i * 2 + 1] = clamp(0.5 + (0.5 * dy) / EYE_PROJ_S, 0.001, 0.999);
    }
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));

    // aim the look axis slightly inward of the socket axis so the pair converges
    const look = dirOf(f.s * FA.eyeAz * 0.70, FA.eyeTh + 0.012);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(look[0], look[1], look[2]));
    g.applyQuaternion(q);
    g.translate(f.e[0] * EYE_C, f.e[1] * EYE_C, f.e[2] * EYE_C);
    parts.push(g);
  }
  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  m.scale(HEAD_SX, HEAD_SY, HEAD_SZ);
  m.computeVertexNormals();
  m.translate(0, HEAD_CENTER, 0);
  return m;
}

// ---------------------------------------------------------------------------
// NOSE / EARS / NECK
// ---------------------------------------------------------------------------

/**
 * NOSE. The reference noses are not blobs — they have a root between the brows,
 * a bridge that runs down and catches a hard specular, a distinct ball, and
 * wings that flare. The whole assembly has to break the skull silhouette by
 * ~15 % of the head radius or the profile reads as a face decal on an egg.
 */
function buildNose(w = 1) {
  const parts = [];
  const R = HEAD_R;
  const add = (g, sx, sy, sz, x, y, z) => { g.scale(sx, sy, sz); g.translate(x, y, z); parts.push(g); };
  // root: the pinch between the brows, narrow and set back
  add(new THREE.SphereGeometry(R * 0.082, 10, 8), 0.78 * w, 1.85, 0.96, 0, R * 0.225, R * 0.850);
  // bridge — a long ridge running down to the ball. Narrow across, so the two
  // side planes stay steep enough to hold shadow while the crest stays lit.
  add(new THREE.SphereGeometry(R * 0.098, 10, 8), 0.80 * w, 2.30, 1.06, 0, R * 0.090, R * 0.900);
  add(new THREE.SphereGeometry(R * 0.126, 10, 8), 0.86 * w, 1.55, 1.10, 0, -R * 0.010, R * 0.952);
  // ball of the nose: the mass that reads at gameplay distance
  add(new THREE.SphereGeometry(R * 0.168, 14, 11), 1.00 * w, 0.94, 1.16, 0, -R * 0.112, R * 0.975);
  // septum / underside, so the tip has a shadow line beneath it
  add(new THREE.SphereGeometry(R * 0.070, 8, 6), 0.90 * w, 0.72, 0.86, 0, -R * 0.196, R * 0.945);
  // nostril wings — buried most of the way into the muzzle so they read as a
  // flare on the base of the nose, not as two spheres flanking it
  for (const s of [-1, 1]) {
    add(new THREE.SphereGeometry(R * 0.098, 9, 7), 0.88, 0.72, 0.74,
      s * R * 0.128 * w, -R * 0.166, R * 0.862);
  }
  return finishFacePart(parts);
}

/**
 * BROW RIDGE — skin, not hair.
 *
 * The reference brows are not dark shapes stuck onto a sphere: they are a
 * raised bony ridge with brow hair growing on it. So this is part of the HEAD
 * mesh, carries the skin material and takes the head texture, which paints the
 * hair on top. That way the ridge catches its own highlight along the crest and
 * throws its own shadow into the socket beneath — form first, colour second.
 *
 * Built as a closed lens (a full loop of section rings that pinch to a point at
 * both ends) so there is no open border to catch light.
 */
function buildBrowGeo(variant) {
  const bs = BROW_SHAPES[variant % BROW_SHAPES.length];
  const parts = [];
  const NU = 16, NV = 6;
  for (const s of [-1, 1]) {
    const pos = [], idx = [];
    for (let i = 0; i <= NU; i++) {
      const t = i / NU;                                   // 0 inner -> 1 outer
      const az = s * (FA.eyeAz + (t - 0.52) * 2 * bs.w);
      // arch: the peak sits about a third of the way out from the inner end
      const arch = Math.sin(Math.pow(t, 0.80) * Math.PI) ** 0.65;
      const thC = FA.browTh - bs.arch * bs.th * arch * 1.5
        + bs.ang * (t - 0.5) * bs.th * 2.2;
      // pointed at both ends, fullest just inside the peak
      const taper = Math.sin(Math.PI * clamp(t, 0, 1)) ** 0.42;
      const half = bs.th * (0.06 + 0.94 * taper);
      const rise = 0.052 * taper;
      for (let j = 0; j <= NV; j++) {
        const a = (j / NV) * TAU;                        // around the section
        const th = thC + half * Math.cos(a);
        // sunk under the skull below, standing proud above: the ridge crest
        // is the top of the section, which is what catches the key light
        const lift = rise * (0.42 + 0.58 * Math.sin(a + Math.PI / 2)) - 0.020;
        const p = skullPointRound(az, th, lift);
        pos.push(p[0], p[1], p[2]);
      }
    }
    const rows = NV + 1;
    for (let i = 0; i < NU; i++) {
      for (let j = 0; j < NV; j++) {
        const a = i * rows + j, b = a + rows;
        if (s < 0) idx.push(a, a + 1, b, a + 1, b + 1, b);
        else idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    parts.push(g);
  }
  return parts;
}


function buildEars() {
  const parts = [];
  const R = HEAD_R;
  for (const s of [-1, 1]) {
    // outer plate — thin, tilted back, standing proud of the skull
    const plate = new THREE.SphereGeometry(R * 0.300, 12, 12);
    plate.scale(0.30, 1.00, 0.66);
    plate.rotateY(-s * 0.28);
    plate.translate(s * R * 0.985, R * 0.010, -R * 0.060);
    parts.push(plate);
    // helix rim — one clean closed loop around the plate. The old build stacked
    // a partial torus, an antihelix torus and a tragus blob at this scale, and
    // the overlapping shells resolved into crumpled noise, not an ear.
    const helix = new THREE.TorusGeometry(R * 0.215, R * 0.058, 7, 20);
    helix.rotateY(Math.PI / 2);
    helix.scale(0.34, 1.05, 0.74);
    helix.rotateX(0.10);
    helix.rotateZ(-s * 0.12);
    helix.translate(s * R * 1.000, R * 0.010, -R * 0.058);
    parts.push(helix);
    // lobe
    const lobe = new THREE.SphereGeometry(R * 0.118, 9, 8);
    lobe.scale(0.40, 0.92, 0.72);
    lobe.translate(s * R * 0.975, -R * 0.222, -R * 0.052);
    parts.push(lobe);
  }
  return finishFacePart(parts);
}

/** neck: its own cylindrical UVs sample the dark band under the chin */
function buildNeck() {
  const g = new THREE.CylinderGeometry(0.158, 0.198, 0.36, 16, 1, true, -Math.PI / 2, TAU);
  g.translate(0, -0.052, 0);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, warpU(uv.getX(i)), warpV(0.020 + uv.getY(i) * 0.130));
  }
  uv.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------------------
// HAIR
// ---------------------------------------------------------------------------

const H_OPAQUE_U0 = 0.030, H_OPAQUE_U1 = 0.470;
const H_CARD_U0 = 0.525, H_CARD_U1 = 0.975;

/**
 * A shell wrapped onto skullR().
 * @param inner (az) -> polar angle of the top edge, radians from the crown
 * @param outer (az) -> polar angle of the bottom edge (hairline / nape)
 * @param puff  (az, t) -> extra thickness in head radii
 */
function hairShell({ inner, outer, puff, nu = 34, nv = 9, shadeBias = 0, streak = 5 }) {
  const pos = [], nor = [], uvs = [], shade = [], idx = [];
  const rows = nv + 1;
  for (let i = 0; i <= nu; i++) {
    const az = (i / nu) * TAU;
    const sa = Math.sin(az), ca = Math.cos(az);
    const t0 = inner(az), t1 = outer(az);
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      const th = t0 + (t1 - t0) * t;
      const st = Math.sin(th), ct = Math.cos(th);
      const nx = st * sa, ny = ct, nz = st * ca;
      // The rim must never graze the scalp or the two surfaces z-fight into a
      // dashed fringe: scale the radius down hard at the very end so the edge
      // is buried in the painted scalp underneath.
      const rim = smooth(0.86, 1.0, t);
      const m = HEAD_R * (skullR(nx, ny, nz) + puff(az, t)) * (1 - 0.22 * rim);
      pos.push(nx * m * HEAD_SX, ny * m * HEAD_SY, nz * m * HEAD_SZ);
      nor.push(nx, ny, nz);
      // strand streaks run down the shell
      const su = ((i * streak) / nu) % 1;
      uvs.push(H_OPAQUE_U0 + su * (H_OPAQUE_U1 - H_OPAQUE_U0), 1 - t);
      shade.push(0.46 * t + 0.10 * Math.sin(az * 11 + t * 2.6)
        + 0.06 * Math.sin(az * 27 + 1.7) + 0.16 + shadeBias);
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * rows + j, b = a + rows;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.userData.shade = shade;
  return g;
}

/**
 * An alpha strand card tangent to the skull at (az, th). This is what turns a
 * solid shell into hair: a soft, feathered silhouette with visible strands.
 */
function hairCard(az, th, o = {}) {
  const w = o.w ?? 0.24, len = o.len ?? 0.24, lift = o.lift ?? 0.03;
  const sweep = o.sweep ?? 0, curl = o.curl ?? 0.30, bow = o.bow ?? 0.05;
  const nu = 3, nv = 4;
  const h = 0.02;
  const P = skullPoint(az, th, lift);
  const pa = skullPoint(az + h, th, lift), pb = skullPoint(az - h, th, lift);
  const pc = skullPoint(az, th + h, lift), pd = skullPoint(az, th - h, lift);
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const S = norm([pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]]);
  const D = norm([pc[0] - pd[0], pc[1] - pd[1], pc[2] - pd[2]]);
  let N = norm([
    S[1] * D[2] - S[2] * D[1],
    S[2] * D[0] - S[0] * D[2],
    S[0] * D[1] - S[1] * D[0],
  ]);
  if (dot3(N, P) < 0) N = [-N[0], -N[1], -N[2]];

  const pos = [], uvs = [], shade = [], idx = [];
  for (let i = 0; i <= nu; i++) {
    const a = (i / nu - 0.5) * w;
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      const b = t * len;
      const out = bow * (1 - 4 * (a / w) * (a / w)) + curl * len * t * t;
      const sw = sweep * len * t * t;
      pos.push(
        P[0] + S[0] * (a + sw) + D[0] * b + N[0] * out,
        P[1] + S[1] * (a + sw) + D[1] * b + N[1] * out,
        P[2] + S[2] * (a + sw) + D[2] * b + N[2] * out,
      );
      uvs.push(H_CARD_U0 + (i / nu) * (H_CARD_U1 - H_CARD_U0), 1 - t);
      shade.push(0.72 - 0.46 * t);
    }
  }
  const rows = nv + 1;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * rows + j, b2 = a + rows;
      idx.push(a, a + 1, b2, a + 1, b2 + 1, b2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.shade = shade;
  return g;
}

/** merge hair parts, carrying the per-vertex shade ramp across */
function mergeShaded(parts) {
  const shades = [];
  for (const p of parts) {
    const n = p.getAttribute('position').count;
    const s = p.userData.shade;
    for (let i = 0; i < n; i++) shades.push(s ? s[i] : 0.38);
    p.userData.shade = null;
  }
  if (parts.length === 1) { parts[0].userData.shade = shades; return parts[0]; }
  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  m.userData.shade = shades;
  return m;
}

/** turn the stored shade ramp into vertex colours around `color` */
function shadeHair(geo, color) {
  const shade = geo.userData.shade;
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  const light = new THREE.Color(lighten(color, 0.30)).convertSRGBToLinear();
  const dark = new THREE.Color(darken(color, 0.58)).convertSRGBToLinear();
  for (let i = 0; i < n; i++) {
    const t = clamp(shade ? shade[i] : 0.45, 0, 1);
    arr[i * 3] = light.r + (dark.r - light.r) * t;
    arr[i * 3 + 1] = light.g + (dark.g - light.g) * t;
    arr[i * 3 + 2] = light.b + (dark.b - light.b) * t;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  geo.userData.shade = null;
  return geo;
}

/** drop a lump onto the skull at (azimuth, polar) */
function onSkull(geo, az, th, lift = 0) {
  const p = skullPoint(az, th, lift);
  geo.translate(p[0], p[1], p[2]);
  return ensureUv(geo);
}

/** hairline: `f` degrees from the crown at the face, `b` at the nape */
const line = (f, b) => (az) => (f + (b - f) * (1 - Math.cos(az)) / 2) * D2R;
// deterministic scatter for curl / dread placement
const h1 = (i) => (Math.sin(i * 12.9898) * 43758.5453) % 1;
const hs = (i) => Math.abs(h1(i));
// smooth pseudo-noise for organic shell displacement
const n3 = (a, b, c) => 0.5 + 0.5 * (
  Math.sin(a * 3.1 + b * 1.7 + c) * 0.55
  + Math.sin(a * 7.3 - b * 4.1 + c * 2.3) * 0.30
  + Math.sin(a * 13.7 + b * 9.3 - c * 1.4) * 0.15);

/**
 * @returns { geo, hairline: {front, back}, fringe }
 * `hairline` is handed to the face texture, which paints the scalp and a
 * feathered fringe underneath — that is what removes the shell seam.
 */
function buildHairGeo(style, seed = 0) {
  const parts = [];
  const front = (az) => Math.cos(az);          // +1 face, -1 nape
  const jitter = (hs(seed * 7 + 3) - 0.5);
  const partSide = hs(seed * 5 + 1) > 0.5 ? 1 : -1;
  let hl = { front: 51 * D2R, back: 104 * D2R };
  let fringe = 0.5;

  const fringeCards = (n, spread, opts) => {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const az = (t - 0.5) * 2 * spread + jitter * 0.12;
      parts.push(hairCard(az, hl.front + 0.03, {
        w: 0.20 + 0.10 * hs(i * 3 + seed),
        len: (opts.len ?? 0.20) * (0.72 + 0.56 * hs(i * 5 + seed * 2)),
        lift: 0.055,
        sweep: partSide * (0.22 + 0.30 * hs(i * 7 + seed)),
        curl: opts.curl ?? 0.22,
        bow: 0.05,
      }));
    }
  };
  const napeCards = (n, len = 0.16) => {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const az = Math.PI + (t - 0.5) * 2.1;
      parts.push(hairCard(az, hl.back - 0.06, {
        w: 0.24, len: len * (0.7 + 0.6 * hs(i * 11 + seed)),
        lift: 0.04, sweep: (hs(i * 13 + seed) - 0.5) * 0.4, curl: 0.18, bow: 0.04,
      }));
    }
  };
  const flyaways = (n, len = 0.15) => {
    for (let i = 0; i < n; i++) {
      const az = hs(i * 17 + seed * 3) * TAU;
      const th = (14 + 26 * hs(i * 19 + seed)) * D2R;
      parts.push(hairCard(az, th, {
        w: 0.16, len: len * (0.6 + 0.8 * hs(i * 23 + seed)),
        lift: 0.05, sweep: (hs(i * 29 + seed) - 0.5) * 0.9, curl: -0.55, bow: 0.03,
      }));
    }
  };

  switch (style) {
    case 'bald':
      return { geo: null, hairline: null, fringe: 0 };

    case 'buzz':
      hl = { front: (49 + jitter * 4) * D2R, back: 104 * D2R };
      fringe = 0.16;
      parts.push(hairShell({
        inner: () => 0, outer: line(hl.front / D2R, hl.back / D2R),
        puff: () => 0.042, streak: 9,
      }));
      fringeCards(5, 0.75, { len: 0.06, curl: 0.1 });
      break;

    case 'fade':
      hl = { front: (46 + jitter * 4) * D2R, back: 110 * D2R };
      fringe = 0.22;
      parts.push(hairShell({
        inner: () => 0, outer: line(hl.front / D2R, hl.back / D2R),
        puff: (az, t) => 0.075 * (1 - smooth(0.24, 0.86, t)) + 0.032,
        shadeBias: 0.16, streak: 7,
      }));
      fringeCards(6, 0.8, { len: 0.09, curl: 0.12 });
      break;

    case 'crop':
      hl = { front: (53 + jitter * 5) * D2R, back: 104 * D2R };
      fringe = 0.55;
      parts.push(hairShell({
        inner: () => 0,
        outer: (az) => line(53, 104)(az) + 3.5 * Math.sin(az * 6 + seed) * D2R,
        puff: (az, t) => 0.095 * (1 - smooth(0.55, 1.0, t)) + 0.036
          + 0.030 * (n3(Math.cos(az) * 2, Math.sin(az) * 2, t * 3) - 0.5),
        streak: 6,
      }));
      fringeCards(9, 1.05, { len: 0.17, curl: 0.20 });
      napeCards(4, 0.11);
      flyaways(3, 0.12);
      break;

    case 'quiff':
      hl = { front: (48 + jitter * 4) * D2R, back: 104 * D2R };
      fringe = 0.7;
      parts.push(hairShell({
        inner: () => 0, outer: line(48, 104), nv: 12,
        puff: (az, t) => 0.080 * (1 - smooth(0.62, 1.0, t)) + 0.034
          + 0.20 * clamp((front(az) + 0.18) / 1.18, 0, 1) ** 1.1
            * Math.sin(clamp(t / 0.55, 0, 1) * Math.PI) ** 0.8,
        streak: 5,
      }));
      // the swept-up front is built from cards so it has real strand edges
      for (let i = 0; i < 9; i++) {
        const t = (i + 0.5) / 9;
        const az = (t - 0.5) * 1.9;
        parts.push(hairCard(az, 0.34, {
          w: 0.22, len: 0.30 + 0.10 * hs(i * 3 + seed), lift: 0.16,
          sweep: partSide * 0.35, curl: -0.85, bow: 0.06,
        }));
      }
      napeCards(4, 0.10);
      break;

    case 'curls':
      hl = { front: (52 + jitter * 5) * D2R, back: 100 * D2R };
      fringe = 0.85;
      parts.push(hairShell({
        inner: () => 0, outer: line(52, 100), nu: 40, nv: 11,
        puff: (az, t) => 0.155 * (1 - smooth(0.74, 1.0, t)) + 0.036
          + 0.075 * (n3(Math.cos(az) * 3.2, Math.sin(az) * 3.2, t * 4.4) - 0.5)
            * (1 - smooth(0.62, 1.0, t)),
        streak: 4,
      }));
      // irregular clumps, never a bead necklace: overlapping, varied, sunk in
      for (let i = 0; i < 22; i++) {
        const az = hs(i * 3 + 1 + seed) * TAU;
        const rim = line(52, 100)(az) / D2R;
        const th = (10 + hs(i * 7 + 5 + seed) * (rim - 18)) * D2R;
        const b = blobGeo(HEAD_R * (0.105 + 0.075 * hs(i * 11 + 3 + seed)), 7);
        b.scale(1 + 0.5 * hs(i * 13 + seed), 0.72 + 0.5 * hs(i * 17 + seed), 1);
        b.rotateY(hs(i * 19 + seed) * TAU);
        parts.push(onSkull(b, az, th, 0.055));
      }
      for (let i = 0; i < 16; i++) {
        const az = hs(i * 23 + seed * 5) * TAU;
        const rim = line(52, 100)(az);
        const th = 0.25 + hs(i * 29 + seed) * (rim - 0.3);
        parts.push(hairCard(az, th, {
          w: 0.20, len: 0.13 + 0.07 * hs(i * 31 + seed), lift: 0.12,
          sweep: (hs(i * 37 + seed) - 0.5) * 1.2, curl: -0.4, bow: 0.05,
        }));
      }
      fringeCards(7, 1.0, { len: 0.15, curl: 0.3 });
      break;

    case 'afro':
      hl = { front: (56 + jitter * 4) * D2R, back: 104 * D2R };
      fringe = 0.9;
      parts.push(hairShell({
        inner: () => 0, outer: line(56, 104), nu: 44, nv: 12,
        puff: (az, t) => (0.36 + 0.10 * (n3(Math.cos(az) * 2.6, Math.sin(az) * 2.6, t * 3.1) - 0.5) * 2
          + 0.05 * Math.sin(az * 9 + seed)) * (1 - smooth(0.60, 1.0, t)) + 0.038,
        streak: 3,
      }));
      // fuzz the whole silhouette with cards instead of stacking spheres
      for (let i = 0; i < 34; i++) {
        const az = hs(i * 5 + 9 + seed) * TAU;
        const rim = line(56, 104)(az);
        const th = 0.16 + hs(i * 13 + 2 + seed) * (rim - 0.22);
        parts.push(hairCard(az, th, {
          w: 0.26, len: 0.16 + 0.10 * hs(i * 3 + 7 + seed),
          lift: 0.30 + 0.09 * hs(i * 17 + 1 + seed),
          sweep: (hs(i * 7 + seed) - 0.5) * 1.4, curl: -0.5, bow: 0.06,
        }));
      }
      break;

    case 'dreads':
      hl = { front: (53 + jitter * 4) * D2R, back: 100 * D2R };
      fringe = 0.6;
      parts.push(hairShell({
        inner: () => 0, outer: line(53, 100),
        puff: (az, t) => 0.085 * (1 - smooth(0.74, 1.0, t)) + 0.038, streak: 5,
      }));
      for (let i = 0; i < 18; i++) {
        const az = 1.9 + (i / 17) * (TAU - 3.8);
        const len = 0.24 + 0.20 * hs(i * 5 + 2 + seed);
        const strand = new THREE.CylinderGeometry(HEAD_R * 0.072, HEAD_R * 0.050, len, 6, 1);
        strand.translate(0, -len * 0.46, 0);
        strand.rotateZ(Math.sin(az) * 0.20);
        parts.push(onSkull(strand, az, (76 + 20 * hs(i * 9 + 4 + seed)) * D2R, 0.055));
        parts.push(hairCard(az, (74 + 22 * hs(i * 11 + seed)) * D2R, {
          w: 0.12, len: len * 0.9, lift: 0.09,
          sweep: (hs(i * 3 + seed) - 0.5) * 0.5, curl: 0.10, bow: 0.02,
        }));
      }
      break;

    case 'bun': {
      hl = { front: (54 + jitter * 5) * D2R, back: 114 * D2R };
      fringe = 0.35;
      parts.push(hairShell({
        inner: () => 0, outer: line(54, 114), nv: 11,
        puff: (az, t) => 0.062 * (1 - smooth(0.60, 1.0, t)) + 0.036, streak: 8,
      }));
      const knot = blobGeo(HEAD_R * 0.33, 14);
      knot.scale(1, 0.86, 1);
      parts.push(onSkull(knot, Math.PI, 40 * D2R, 0.26));
      const band = new THREE.TorusGeometry(HEAD_R * 0.22, HEAD_R * 0.046, 6, 14);
      band.rotateX(Math.PI * 0.46);
      parts.push(onSkull(band, Math.PI, 52 * D2R, 0.12));
      // strands sweeping back into the knot + loose wisps at the nape
      for (let i = 0; i < 10; i++) {
        const az = (i / 9 - 0.5) * 2.4 + Math.PI;
        parts.push(hairCard(az, 0.9, {
          w: 0.18, len: 0.22, lift: 0.05,
          sweep: (hs(i * 3 + seed) - 0.5) * 0.6, curl: 0.15, bow: 0.03,
        }));
      }
      fringeCards(5, 0.8, { len: 0.10, curl: 0.15 });
      break;
    }

    case 'long':
      hl = { front: (50 + jitter * 4) * D2R, back: 150 * D2R };
      fringe = 0.95;
      parts.push(hairShell({
        inner: () => 0, outer: line(50, 150), nv: 15,
        puff: (az, t) => 0.062 * (1 - smooth(0.92, 1.0, t)) + 0.038
          + 0.15 * Math.max(0, -front(az)) * smooth(0.26, 1.0, t)
          + 0.035 * (n3(Math.cos(az) * 3, Math.sin(az) * 3, t * 2) - 0.5),
        streak: 4,
      }));
      for (let i = 0; i < 14; i++) {
        const az = Math.PI + (i / 13 - 0.5) * 4.0;
        parts.push(hairCard(az, 2.05, {
          w: 0.22, len: 0.26 + 0.12 * hs(i * 5 + seed), lift: 0.05,
          sweep: (hs(i * 7 + seed) - 0.5) * 0.5, curl: 0.20, bow: 0.03,
        }));
      }
      fringeCards(8, 1.1, { len: 0.22, curl: 0.24 });
      break;

    case 'mohawk': {
      hl = { front: (56 + jitter * 4) * D2R, back: 104 * D2R };
      fringe = 0.25;
      // shaved sides: thin and dark, but still hair
      parts.push(hairShell({
        inner: () => 0, outer: line(56, 104),
        puff: () => 0.042, shadeBias: 0.34, streak: 11,
      }));
      // crest: a ridge of cards standing up along the centre line
      for (let i = 0; i <= 12; i++) {
        const s = i / 12;
        const ang = (s - 0.42) / 0.58;
        const az = ang < 0 ? 0 : Math.PI;
        const th = Math.abs(ang) * (ang < 0 ? 46 : 62) * D2R;
        const h = Math.sin(s ** 0.8 * Math.PI) ** 0.55;
        const blade = blobGeo(HEAD_R * 0.150, 9);
        blade.scale(0.72, 0.50 + h * 1.35, 1.25);
        parts.push(onSkull(blade, az, th, h * 0.24));
        parts.push(hairCard(az, th, {
          w: 0.10, len: 0.10 + h * 0.26, lift: 0.05 + h * 0.20,
          sweep: 0, curl: -0.25, bow: 0.02,
        }));
      }
      break;
    }

    default:
      hl = { front: 51 * D2R, back: 102 * D2R };
      parts.push(hairShell({
        inner: () => 0, outer: line(51, 102),
        puff: (az, t) => 0.065 * (1 - smooth(0.60, 1.0, t)) + 0.036,
      }));
      fringeCards(7, 0.95, { len: 0.15, curl: 0.2 });
  }
  return { geo: mergeShaded(parts.map((p) => ensureUv(p))), hairline: hl, fringe };
}

/**
 * Beard shell. Azimuths outside the front arc collapse onto a ring buried
 * inside the skull (puff < 0), so no sheet stretches across the head.
 */
/**
 * BEARD. The old version wrapped one shell across the whole lower face, which
 * is exactly why it read as a solid brown helmet strap. A real beard is a
 * *band that follows the jaw*: it starts high and thin at the sideburn, thickens
 * along the mandible, is fullest under the chin, and its upper edge dissolves
 * into stubble rather than ending on a hard line.
 *
 * So this builds:
 *   - a jaw band whose top edge tracks the mandible and whose thickness ramps
 *     from nearly nothing at the sideburn to full under the chin,
 *   - a separate moustache with a philtrum gap,
 *   - a soul patch,
 *   - and ~50 alpha strand cards feathering BOTH edges, so the silhouette is
 *     hair and the transition into skin is a gradient, not a border.
 */
function buildBeard(density = 1) {
  const parts = [];
  const cw = (az) => Math.cos(az);                 // +1 chin, -1 nape
  const inArc = (az) => cw(az) > -0.22;
  // how much beard there is at this azimuth: none at the back, thin at the
  // sideburn, full at the chin
  const dens = (az) => clamp((cw(az) + 0.18) / 1.10, 0, 1) ** 0.80;
  // Upper edge follows the mandible. It must stay WELL below the eye line
  // (eyeTh = 81 deg) at every azimuth, or the beard climbs the cheek and turns
  // back into the brown mask the reference never has.
  const top = (az) => (95 + 17 * Math.max(0, cw(az)) ** 1.35) * D2R;
  const bot = (az) => (117 + (13 + 15 * density) * Math.max(0, cw(az))) * D2R;

  parts.push(hairShell({
    inner: (az) => (inArc(az) ? top(az) : bot(az)),
    outer: bot,
    nu: 40, nv: 10, streak: 7,
    puff: (az, t) => {
      if (!inArc(az)) return -0.14;
      const d = dens(az);
      // thin and hugging at the top edge, full and standing off at the jaw
      const body = (0.010 + 0.062 * density * d) * Math.sin(Math.min(1, t * 1.04) * Math.PI) ** 0.7;
      // bury the top edge under the skin so the boundary is a gradient of
      // painted stubble, never a drawn border
      return body + 0.026 - 0.060 * (1 - smooth(0.0, 0.30, t));
    },
  }));

  // moustache: two wings with a philtrum gap between them
  for (const s of [-1, 1]) {
    parts.push(hairShell({
      inner: () => 88 * D2R,
      outer: (az) => {
        const w = s * Math.sin(az);
        return (w > 0.035 && w < 0.30 && Math.cos(az) > 0.80) ? 101 * D2R : 88 * D2R;
      },
      nu: 16, nv: 3, streak: 4,
      puff: (az, t) => {
        const w = s * Math.sin(az);
        if (!(w > 0.035 && w < 0.30 && Math.cos(az) > 0.80)) return -0.12;
        return 0.052 * density * Math.sin(t * Math.PI) ** 0.6 + 0.030;
      },
    }));
  }
  // soul patch under the lower lip
  parts.push(hairShell({
    inner: () => 111 * D2R,
    outer: (az) => (Math.abs(Math.sin(az)) < 0.10 && Math.cos(az) > 0.90 ? 121 * D2R : 111 * D2R),
    nu: 14, nv: 3, streak: 4,
    puff: (az, t) => (Math.abs(Math.sin(az)) < 0.10 && Math.cos(az) > 0.90
      ? 0.044 * density * Math.sin(t * Math.PI) ** 0.6 + 0.028 : -0.10),
  }));

  // Strand cards break the outer silhouette along the jaw so the edge is hair
  // rather than a drawn contour. They are laid DENSE and SHORT and their length
  // varies smoothly with azimuth: scattered long cards on a regular azimuth
  // grid read as a zigzag saw-tooth, which is worse than no cards at all.
  const NC = 34;
  for (let i = 0; i < NC; i++) {
    const az = (i / (NC - 1) - 0.5) * 2.55;
    const d = dens(az);
    if (d < 0.14) continue;
    // smooth length envelope + a small, bounded jitter
    const env = d * (0.80 + 0.20 * Math.sin(az * 5.3 + 1.1));
    parts.push(hairCard(az, bot(az) - 0.055, {
      w: 0.15,
      len: (0.048 + 0.062 * density) * env,
      lift: 0.034 + 0.022 * d,
      sweep: Math.sin(az * 3.7) * 0.22, curl: 0.16, bow: 0.025,
    }));
  }
  return mergeShaded(parts);
}

// ---------------------------------------------------------------------------
// HANDS — a real palm with fingers, a thumb and a wrist. Merged into the
// forearm mesh so they cost no extra draw call; UV'd into the bare-skin (or
// glove) band of the arm texture.
// ---------------------------------------------------------------------------

function buildHand(s, keeper) {
  const parts = [];
  const K = keeper ? 1.26 : 1.0;
  const y0 = -0.196;                                   // wrist

  // wrist — a real joint, wider than the forearm end so the hand reads as a
  // separate mass rather than a continuation of the tube
  const cuff = new THREE.CylinderGeometry(0.093 * K, 0.086 * K, 0.036, 14, 1);
  cuff.translate(0, y0 + 0.014, 0);
  parts.push(cuff);

  // palm block — chibi hands are mitts: broad across, thin front-to-back
  const palm = blobGeo(0.106 * K, 14);
  palm.scale(1.02, 0.94, 0.60);
  palm.translate(s * 0.006 * K, y0 - 0.078 * K, 0.008 * K);
  parts.push(palm);

  // heel of the hand under the little finger
  const heel = blobGeo(0.062 * K, 9);
  heel.scale(0.86, 1.05, 0.70);
  heel.translate(s * 0.062 * K, y0 - 0.088 * K, -0.004 * K);
  parts.push(heel);

  // four fingers as one curled mass plus grooves between them: at this scale a
  // readable finger block beats four thin tubes that alias into mush
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const len = (0.108 - Math.abs(t - 0.30) * 0.030) * K;
    const r = 0.0300 * K;
    const f = new THREE.CapsuleGeometry(r, len, 3, 8);
    f.translate(0, -len * 0.5, 0);
    f.rotateX(-0.74 - t * 0.10);
    f.rotateZ(-s * (t - 0.5) * 0.24);
    f.translate(s * (0.062 - t * 0.042) * K, y0 - 0.132 * K, 0.012 * K);
    parts.push(f);
  }
  // knuckle ridge across the top of the fingers
  const kn = blobGeo(0.070 * K, 10);
  kn.scale(1.42, 0.58, 0.74);
  kn.translate(s * 0.004 * K, y0 - 0.140 * K, 0.020 * K);
  parts.push(kn);

  // thumb — the single silhouette cue that says "hand". Swings out and forward.
  const th = new THREE.CapsuleGeometry(0.036 * K, 0.084 * K, 3, 8);
  th.translate(0, -0.044 * K, 0);
  th.rotateZ(s * 1.02);
  th.rotateX(-0.50);
  th.translate(-s * 0.086 * K, y0 - 0.082 * K, 0.036 * K);
  parts.push(th);
  // thenar pad at the base of the thumb
  const pad = blobGeo(0.050 * K, 8);
  pad.scale(0.90, 1.05, 0.75);
  pad.translate(-s * 0.070 * K, y0 - 0.070 * K, 0.026 * K);
  parts.push(pad);

  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return m;
}

// ---------------------------------------------------------------------------
// BOOT — vertex-coloured so every player shares one material.
// The sole plane sits at y = -0.06 (the foot bone lives at y = 0.06).
// ---------------------------------------------------------------------------

/**
 * BOOT. The reference boots carry a toe cap, a side flash, a heel counter, a
 * laced tongue and a studded sole that reads even at gameplay distance. The old
 * build was a box with one stripe and a slab sole that rendered as a black
 * rectangle under every foot.
 */
function buildBoot(main, accent, sole) {
  const parts = [];
  const body = new THREE.BoxGeometry(0.176, 0.098, 0.230);
  body.translate(0, 0.008, 0.045);
  parts.push(tint(body, main));

  // rounded upper so the boot is not a brick
  const upper = blobGeo(0.096, 12);
  upper.scale(0.92, 0.62, 1.24);
  upper.translate(0, 0.014, 0.062);
  parts.push(tint(upper, main));

  const toe = blobGeo(0.090, 12);
  toe.scale(0.94, 0.58, 1.06);
  toe.translate(0, 0.002, 0.170);
  parts.push(tint(toe, accent));                     // contrast toe cap

  const heel = blobGeo(0.088, 11);
  heel.scale(1.00, 0.72, 0.92);
  heel.translate(0, 0.018, -0.068);
  parts.push(tint(heel, main));
  // heel counter in the accent colour
  const counter = blobGeo(0.072, 10);
  counter.scale(1.02, 0.66, 0.52);
  counter.translate(0, 0.020, -0.098);
  parts.push(tint(counter, accent));

  const collar = new THREE.TorusGeometry(0.074, 0.021, 6, 14);
  collar.rotateX(Math.PI / 2);
  collar.translate(0, 0.058, -0.026);
  parts.push(tint(collar, accent));

  // sole: thinner, inset from the upper, with a raised outsole rim
  const plate = new THREE.BoxGeometry(0.166, 0.019, 0.300);
  plate.translate(0, -0.046, 0.048);
  parts.push(tint(plate, sole));
  const midsole = new THREE.BoxGeometry(0.176, 0.013, 0.288);
  midsole.translate(0, -0.033, 0.048);
  parts.push(tint(midsole, accent));

  // studs — six nubs, so the underside is not a flat black slab
  for (const [sx, sz] of [[-1, 0.155], [1, 0.155], [-1, 0.030], [1, 0.030],
    [-1, -0.088], [1, -0.088]]) {
    const stud = new THREE.CylinderGeometry(0.019, 0.014, 0.026, 6, 1);
    stud.translate(sx * 0.058, -0.066, sz);
    parts.push(tint(stud, sole));
  }

  // three side flashes, the universal boot signature
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const flash = new THREE.BoxGeometry(0.013, 0.030, 0.040);
      flash.rotateX(0.22);
      flash.translate(s * 0.088, 0.004 - i * 0.004, 0.020 + i * 0.052);
      parts.push(tint(flash, accent));
    }
  }
  // tongue + laces
  const tongue = new THREE.BoxGeometry(0.066, 0.016, 0.098);
  tongue.rotateX(-0.14);
  tongue.translate(0, 0.056, 0.060);
  parts.push(tint(tongue, accent));
  for (let i = 0; i < 3; i++) {
    const lace = new THREE.BoxGeometry(0.062, 0.009, 0.012);
    lace.rotateX(-0.14);
    lace.translate(0, 0.064 - i * 0.003, 0.028 + i * 0.036);
    parts.push(tint(lace, sole));
  }

  const m = mergeGeometries(parts.map((p) => ensureUv(p)), false);
  parts.forEach((p) => p.dispose());
  return m;
}

// ---------------------------------------------------------------------------

let uid = 0;

const NAMES = ['SILVA', 'KANE', 'MBAPPE', 'HALLER', 'DIAZ', 'ROSSI', 'MULLER',
  'OKAFOR', 'TANAKA', 'NOVAK', 'BRUNO', 'LEWIN'];

export function createPlayer(cfg = {}) {
  const team = TEAMS[cfg.team ?? 0];
  const isKeeper = !!cfg.isKeeper;
  const number = cfg.number ?? 9;
  const skin = cfg.skin ?? SKIN_TONES[3];
  const hairColor = cfg.hairColor ?? HAIR_COLORS[0];
  const hairStyle = cfg.hair ?? HAIR_STYLES[0];
  const faceVariant = cfg.faceVariant ?? 0;
  const beard = cfg.beard ?? 0;             // 0 clean, 1 stubble, 2 full beard
  const kitStyle = isKeeper ? 'keeper' : (cfg.kitStyle ?? 'plain');
  // the club's construction recipe: body graphic, shoulder, collar, sleeve,
  // crest silhouette and sock banding. This is what stops the two teams from
  // being one template in two palettes.
  const recipe = KIT_RECIPES[isKeeper ? 'keeper' : (cfg.team ?? 0) % 2] ?? KIT_RECIPES[0];
  const build = cfg.build ?? 1.0;
  const girth = cfg.girth ?? 1.0;
  const headScale = cfg.headScale ?? 1.0;
  const seed = (number * 7 + (cfg.team ?? 0) * 13 + faceVariant * 3) % 97;

  const kitColor = isKeeper ? team.keeper : team.kit;
  const kitAlt = isKeeper ? darken(team.keeper, 0.42) : (team.kitDark ?? darken(team.kit, 0.4));
  const shortsColor = isKeeper ? team.keeperShorts : team.shorts;
  const sockColor = isKeeper ? darken(team.keeper, 0.30) : team.socks;
  const trimColor = isKeeper ? lighten(team.keeper, 0.72) : team.trim;
  const sockTrim = isKeeper ? lighten(team.keeper, 0.6)
    : (contrastOn(sockColor) === 0xffffff ? 0xffffff : darken(sockColor, 0.45));
  const gloveColor = lighten(team.keeper, 0.78);

  const group = new THREE.Group();
  group.name = `player-${team.name}-${number}`;
  group.userData.id = uid++;
  group.scale.setScalar(build);

  const root = new THREE.Object3D(); root.name = 'root';
  group.add(root);
  const hips = new THREE.Object3D(); hips.name = 'hips';
  hips.position.y = HIP_Y;
  root.add(hips);
  const torso = new THREE.Object3D(); torso.name = 'torso';
  hips.add(torso);
  const head = new THREE.Object3D(); head.name = 'head';
  head.position.y = HEAD_BONE_Y;
  head.scale.setScalar(headScale);
  torso.add(head);

  const meshes = [];
  const addMesh = (parent, geo, mat, cast = false) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = false;
    parent.add(m);
    meshes.push(m);
    return m;
  };

  // ---- shorts (mid-thigh) -------------------------------------------------
  const shortsGeo = lathe([
    [0.00, 0.316, -0.212],
    [0.14, 0.324, -0.175],
    [0.44, 0.316, -0.100],
    [0.76, 0.306, -0.022],
    [1.00, 0.292, 0.048],
  ], 22, 12);
  shortsGeo.scale(girth, 1, 0.86 * girth);
  if (isKeeper) shortsGeo.scale(1.04, 1.10, 1.04);
  addMesh(hips, shortsGeo,
    fabricMat(`shortsM:${shortsColor}:${trimColor}:${kitColor}:${isKeeper ? 1 : 0}`,
      shortsTexture({ color: shortsColor, trim: trimColor, kit: kitColor, long: isKeeper }),
      { rough: 0.88, repeat: [5, 2], normalScale: 0.5 }), true);

  // plug the open bottom of the shorts lathe
  const gusset = blobGeo(0.30, 12);
  gusset.scale(girth, 0.50, 0.86 * girth);
  gusset.translate(0, -0.175, 0);
  addMesh(hips, ensureUv(gusset), skinMat(darken(skin, 0.22)));

  // ---- torso --------------------------------------------------------------
  const torsoParts = [];
  const torsoGeo = lathe([
    [0.00, 0.302, -0.030],
    [0.10, 0.320, 0.030],
    [0.32, 0.342, 0.170],
    [0.56, 0.368, 0.315],
    [0.76, 0.384, 0.428],
    [0.88, 0.330, 0.502],
    [0.95, 0.215, 0.546],
    [1.00, 0.040, 0.566],
  ], 30, 16);
  torsoGeo.scale(girth, 1, 0.80 * girth);
  torsoParts.push(torsoGeo);
  // real collar: a ring around the neck, UV'd into the shirt's trim band
  const collar = new THREE.TorusGeometry(0.176, 0.042, 8, 22);
  collar.rotateX(Math.PI / 2);
  collar.scale(1.06 * girth, 1, 0.92 * girth);
  collar.translate(0, 0.520, 0);
  torsoParts.push(cylUV(collar, 0.985));
  const torsoMerged = mergeGeometries(torsoParts, false);
  torsoParts.forEach((p) => p.dispose());
  const torsoMesh = addMesh(torso, torsoMerged,
    fabricMat(`shirtM:${kitColor}:${trimColor}:${kitAlt}:${number}:${kitStyle}:${team.id}`,
      shirtTexture({
        kit: kitColor, trim: trimColor, alt: kitAlt, number, style: kitStyle, recipe,
        letter: (team.short || team.name || 'C')[0], name: NAMES[number % NAMES.length],
      }),
      { rough: 0.84, repeat: [6, 3], normalScale: 0.6 }), true);

  // ---- head ---------------------------------------------------------------
  const headParts = [
    buildHead(),
    buildNose(1 + (faceVariant % 3) * 0.08),
    buildEars(),
    buildLids(),
    buildNeck(),
    // the brow ridge is skin: form for the head texture to paint hair onto
    finishFacePart(buildBrowGeo(faceVariant)),
  ];
  const headMerged = mergeGeometries(headParts, false);
  headParts.forEach((p) => p.dispose());

  const hairInfo = buildHairGeo(hairStyle, seed);
  const scalp = hairInfo.hairline
    ? { color: hairColor, front: hairInfo.hairline.front, back: hairInfo.hairline.back, fringe: hairInfo.fringe }
    : null;
  const faceOpts = { skin, variant: faceVariant, browColor: hairColor, stubble: beard, scalp };
  const headMat = new THREE.MeshStandardMaterial({
    map: headTexture({ ...faceOpts, expr: 'set' }),
    roughness: 0.80, metalness: 0.0,
  });
  addMesh(head, headMerged, headMat, true);

  // ---- eyeballs -----------------------------------------------------------
  const eyeIdx = (faceVariant + (number % 3)) % EYE_COLORS.length;
  const eyeMesh = addMesh(head, buildEyeballs(), eyeMat(EYE_COLORS[eyeIdx]));

  // ---- hair + beard -------------------------------------------------------
  const hairParts = [];
  if (hairInfo.geo) hairParts.push(shadeHair(hairInfo.geo, hairColor));
  if (beard === 2) hairParts.push(shadeHair(buildBeard(1), mixHex(hairColor, 0x24160e, 0.30)));
  else if (beard === 1) hairParts.push(shadeHair(buildBeard(0.30), mixHex(hairColor, 0x24160e, 0.44)));
  if (hairParts.length) {
    let merged;
    if (hairParts.length === 1) merged = hairParts[0];
    else { merged = mergeGeometries(hairParts, false); hairParts.forEach((p) => p.dispose()); }
    merged.translate(0, HEAD_CENTER, 0);
    addMesh(head, merged, hairMat(), true);
  }

  // ---- arms ---------------------------------------------------------------
  const bones = {};
  const armMat = fabricMat(
    `armM:${kitColor}:${trimColor}:${skin}:${kitAlt}:${isKeeper ? 1 : 0}:${kitStyle}`,
    armTexture({
      kit: kitColor, trim: trimColor, skin, alt: kitAlt, recipe,
      long: isKeeper, style: kitStyle, glove: isKeeper ? gloveColor : 0,
    }),
    { rough: 0.78, repeat: [3, 1], normalScale: 0.35 });

  // the arm must clear the torso lathe (radius ~0.38 * girth at shoulder height)
  // or it disappears into the shirt and the figure reads as armless.
  const shoulderX = 0.344 + 0.066 * girth;
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const arm = new THREE.Object3D();
    arm.name = 'arm' + side;
    arm.position.set(s * shoulderX, TORSO_H - 0.075, 0);
    torso.add(arm);
    bones['arm' + side] = arm;

    // shoulder -> elbow, strongly tapered: a deltoid, not a pipe
    const upper = lathe([
      [0.00, 0.040, -0.252],
      [0.06, 0.104, -0.240],
      [0.24, 0.113, -0.186],
      [0.50, 0.128, -0.112],
      [0.72, 0.148, -0.048],
      [0.88, 0.168, 0.004],
      [0.96, 0.164, 0.038],
      [1.00, 0.060, 0.062],
    ], 18, 14);
    addMesh(arm, upper, armMat);

    const fore = new THREE.Object3D();
    fore.name = 'forearm' + side;
    fore.position.y = -0.222;
    arm.add(fore);
    bones['forearm' + side] = fore;

    // elbow -> wrist, tapering into the hand
    const foreGeo = lathe([
      [0.00, 0.052, -0.206],
      [0.10, 0.086, -0.198],
      [0.28, 0.096, -0.166],
      [0.50, 0.108, -0.118],
      [0.74, 0.124, -0.058],
      [0.92, 0.136, -0.008],
      [1.00, 0.070, 0.018],
    ], 18, 14);
    // the forearm samples only the bare-skin (or glove) band of the arm strip
    {
      const uv = foreGeo.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        uv.setY(i, (isKeeper ? 0.16 + uv.getY(i) * 0.66 : 0.06 + uv.getY(i) * 0.42));
      }
      uv.needsUpdate = true;
    }
    const hand = buildHand(s, isKeeper);
    cylUV(hand, isKeeper ? 0.055 : 0.045);
    const foreMerged = mergeGeometries([foreGeo, hand], false);
    foreGeo.dispose(); hand.dispose();
    foreMerged.computeVertexNormals();
    addMesh(fore, foreMerged, armMat, true);
  }

  // ---- legs ---------------------------------------------------------------
  const sockMat = fabricMat(`sockM:${sockColor}:${sockTrim}:${recipe.sockBands}`,
    sockTexture({ color: sockColor, trim: sockTrim, bands: recipe.sockBands }),
    { rough: 0.9, repeat: [2, 1], normalScale: 0.5 });
  const bootMain = cfg.bootColor ?? BOOT_COLORS[0];
  const bright = contrastOn(bootMain) === 0xffffff;
  const bootAccent = cfg.bootAccent ?? (bright ? 0xffffff : 0x1a1d24);
  const bootSole = cfg.bootSole ?? (bright ? 0xe9edf3 : 0x2b3038);
  const bootGeo = buildBoot(bootMain, bootAccent, bootSole);
  const thighMat = skinMat(skin);

  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const thigh = new THREE.Object3D();
    thigh.name = 'thigh' + side;
    thigh.position.set(s * 0.148 * girth, -0.02, 0);
    hips.add(thigh);
    bones['thigh' + side] = thigh;

    addMesh(thigh, lathe([
      [0.00, 0.072, -0.300],
      [0.10, 0.108, -0.284],
      [0.34, 0.121, -0.216],
      [0.64, 0.136, -0.120],
      [0.88, 0.150, -0.034],
      [1.00, 0.118, 0.018],
    ], 14, 12), thighMat, true);

    const shin = new THREE.Object3D();
    shin.name = 'shin' + side;
    shin.position.y = -THIGH_L;
    thigh.add(shin);
    bones['shin' + side] = shin;

    addMesh(shin, lathe([
      [0.00, 0.070, -0.286],
      [0.10, 0.084, -0.268],
      [0.30, 0.093, -0.214],
      [0.60, 0.105, -0.128],
      [0.86, 0.119, -0.042],
      [1.00, 0.128, 0.012],
    ], 14, 12), sockMat, true);

    const foot = new THREE.Object3D();
    foot.name = 'foot' + side;
    foot.position.y = -SHIN_L;
    shin.add(foot);
    bones['foot' + side] = foot;

    addMesh(foot, bootGeo.clone(), bootMat());
  }
  bootGeo.dispose();

  // ---- selection ring + contact shadow ------------------------------------
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.50, 0.68, 32),
    new THREE.MeshBasicMaterial({
      color: 0x4dff72, transparent: true, opacity: 0.92,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.scale.set(1, 1, 0.62);
  ring.position.y = 0.03;
  ring.visible = false;
  ring.renderOrder = 4;
  group.add(ring);

  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1.35, 1.35),
    new THREE.MeshBasicMaterial({
      map: softCircle('rgba(0,0,0,0.5)'), transparent: true,
      depthWrite: false, opacity: 0.58,
    }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.012;
  blob.renderOrder = 3;
  group.add(blob);

  const rig = {
    root, hips, torso, head,
    armL: bones.armL, armR: bones.armR,
    forearmL: bones.forearmL, forearmR: bones.forearmR,
    thighL: bones.thighL, thighR: bones.thighR,
    shinL: bones.shinL, shinR: bones.shinR,
    footL: bones.footL, footR: bones.footR,
    group,
    torsoMesh,
  };

  const config = {
    team: team.id, teamData: team, number, skin, hair: hairStyle, hairColor,
    isKeeper, faceVariant, beard, kitStyle, build, girth, headScale,
  };

  // ---- expression ---------------------------------------------------------
  // The rig is the only per-frame signal player.js gets, and it is enough:
  // root pitch says "on the floor", root lift and the arm yaw say "celebrating".
  const restExpr = (seed % 3 === 0) ? 'focus' : 'set';
  let expr = 'set';
  let squint = 0;

  function setExpression(kind) {
    if (kind === expr) return;
    expr = kind;
    headMat.map = headTexture({ ...faceOpts, expr: kind });
  }

  function pickExpression() {
    const pitch = root.rotation.x;
    const lift = root.position.y;
    if (pitch < -0.40) return 'strain';
    if (isKeeper) return lift > 0.13 ? 'strain' : restExpr;
    if (lift > 0.11 || Math.abs(bones.armL.rotation.y) > 0.10) return 'joy';
    return restExpr;
  }

  return {
    group, rig, config, meshes, ring, blob, setExpression,
    get expression() { return expr; },
    setSelected(v) { ring.visible = !!v; },
    syncShadow() {
      setExpression(pickExpression());
      // squinting is real: pulling the balls back into the dishes narrows the
      // openings, so a grin or a grimace closes the eyes down.
      const want = { set: 0.06, focus: 0.24, joy: 0.62, strain: 0.58 }[expr] ?? 0.06;
      squint += (want - squint) * 0.22;
      eyeMesh.position.z = -0.020 * squint;
      eyeMesh.position.y = -0.004 * squint;

      blob.position.x = 0;
      blob.position.z = 0;
      const lift = Math.max(0, root.position.y);
      const k = 1 / (1 + lift * 1.4);
      blob.scale.setScalar(0.55 + 0.45 * k);
      blob.material.opacity = 0.58 * k;
    },
    dispose() {
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      headMat.dispose();
      ring.material.dispose();
      blob.material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// squad — every player on the pitch must read as a different person
// ---------------------------------------------------------------------------

const SQUAD_NUMBERS = [[1, 4, 6, 8, 10, 11], [1, 3, 5, 7, 9, 14]];

/** Fisher-Yates over a copy, driven by the seeded rng */
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

export function createSquad(teamIndex, rng) {
  const squad = [];
  const numbers = SQUAD_NUMBERS[teamIndex % 2];
  // sample without replacement so no two team-mates share a look
  const skins = shuffled(SKIN_TONES, rng).slice(0, 6);
  const hairs = shuffled(HAIR_STYLES, rng).slice(0, 6);
  const boots = shuffled(BOOT_COLORS, rng).slice(0, 6);
  // the club's look now comes from KIT_RECIPES, keyed off the team index
  const kitStyle = 'club';

  for (let i = 0; i < numbers.length; i++) {
    const isKeeper = i === 0;
    // build, girth and head size vary enough that the silhouettes differ at a
    // glance: a short stocky number 6 next to a tall lean number 10.
    const tall = 0.90 + rng.float() * 0.20;
    squad.push(createPlayer({
      team: teamIndex,
      number: numbers[i],
      isKeeper,
      skin: skins[i],
      hair: hairs[i],
      hairColor: rng.pick(HAIR_COLORS),
      faceVariant: (i * 2 + teamIndex * 3 + rng.int(2)) % 6,
      beard: rng.chance(0.30) ? 2 : rng.chance(0.34) ? 1 : 0,
      kitStyle: isKeeper ? 'keeper' : kitStyle,
      bootColor: boots[i],
      build: tall,
      girth: 1.14 - (tall - 0.90) * 0.55 + (rng.float() - 0.5) * 0.10,
      headScale: 1.06 - (tall - 0.90) * 0.35,
    }));
  }
  return squad;
}
