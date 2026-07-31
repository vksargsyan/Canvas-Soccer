// Chibi player rig — geometry build + kit/skin/hair variation.
//
//   createPlayer(cfg) -> { group, rig, config, setSelected(b), syncShadow(), dispose() }
//     cfg: { team, number, skin, hair, hairColor, isKeeper, faceVariant, beard,
//            kitStyle, bootColor, build }
//
// Proportions (total height 2.0 world units, chibi bobblehead):
//   sole 0.00 -> ankle 0.06 -> knee 0.34 -> hip 0.64 -> shoulder 1.02
//   head centre 1.546, chin 1.186, crown 2.02  ->  head is 0.83 tall == 42 %.
//
// The rig exposes named bones (plain Object3D): root, hips, torso, head,
// armL/R, forearmL/R, thighL/R, shinL/R, footL/R. animation.js drives only these.
//
// Surfacing lives in ./player-textures.js. Every limb is a body of revolution
// (LatheGeometry) so the kit textures get a clean u-around / v-along mapping:
// u = 0.25 is the chest, u = 0.75 the back, v = 1 the top of the part.
//
// Cost: 14 meshes + selection ring + contact blob per player, ~7k triangles.
// Materials, textures and the fabric normal map are cached and shared.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { softCircle } from '../core/assets.js';
import { TEAMS } from '../core/constants.js';
import {
  headTexture, shirtTexture, armTexture, shortsTexture, sockTexture, gloveTexture,
  fabricNormal, warpU, warpV, mixHex, darken, lighten, contrastOn,
  SKIN_TONES, HAIR_COLORS, HAIR_STYLES, EYE_COLORS, BOOT_COLORS,
} from './player-textures.js';

export { SKIN_TONES, HAIR_COLORS, HAIR_STYLES };

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

export const HEAD_R = 0.46;
const HIP_Y = 0.64;
const THIGH_L = 0.30;
const SHIN_L = 0.28;
const TORSO_H = 0.47;
const HEAD_BONE_Y = 0.50;       // relative to the torso bone
const HEAD_CENTER = 0.406;      // relative to the head bone
const HEAD_SY = 1.03, HEAD_SZ = 0.95;
const JAW_TAPER = 0.24;

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
  color: skin, roughness: 0.70, metalness: 0.0,
}));

// one material for every head of hair — the colour lives in vertex colours
const hairMat = () => sharedMat('hair', () => new THREE.MeshStandardMaterial({
  color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0.0,
}));

const bootMat = () => sharedMat('boot', () => new THREE.MeshStandardMaterial({
  color: 0xffffff, vertexColors: true, roughness: 0.33, metalness: 0.03,
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

function ensureUv(geo) {
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position').count;
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2).fill(0.5), 2));
  }
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

/** spherical projection UV for small parts that never cross the -Z seam */
function projectUV(geo, cy) {
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

const blobGeo = (r, seg = 8) => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2));

// ---------------------------------------------------------------------------
// skull shape — one analytic function drives the head mesh AND every hair
// shell, so hair hugs the actual skull instead of an idealised sphere.
// ---------------------------------------------------------------------------

function skullR(nx, ny, nz) {
  let m = 1.0;
  const jaw = smooth(-0.10, -0.94, ny);
  m *= 1 - JAW_TAPER * jaw;                                             // jaw taper
  m *= 1 + 0.055 * bump((ny + 0.10) / 0.46) * clamp(nz, 0, 1);          // cheeks
  m += 0.048 * bump((ny - 0.16) / 0.20) * bump(nx / 0.66) * smooth(0.25, 0.85, nz); // brow
  m += 0.060 * bump((ny + 0.58) / 0.34) * bump(nx / 0.48) * smooth(0.05, 0.55, nz); // chin
  m += 0.032 * clamp(-nz, 0, 1) * bump((ny - 0.10) / 1.15);             // occiput
  m -= 0.028 * bump((ny - 0.58) / 0.48) * clamp(nz, 0, 1);              // flatter forehead
  return m;
}

/** world offset of the skull surface at (azimuth from +Z, polar from crown) */
function skullPoint(az, th, lift = 0) {
  const st = Math.sin(th), ct = Math.cos(th);
  const nx = st * Math.sin(az), ny = ct, nz = st * Math.cos(az);
  const m = HEAD_R * (skullR(nx, ny, nz) + lift);
  return [nx * m, ny * m * HEAD_SY, nz * m * HEAD_SZ];
}

function buildHead() {
  const g = new THREE.SphereGeometry(HEAD_R, 30, 22);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = Math.hypot(x, y, z) || 1e-6;
    const nx = x / r, ny = y / r, nz = z / r;
    const m = skullR(nx, ny, nz) * HEAD_R;
    pos.setXYZ(i, nx * m, ny * m * HEAD_SY, nz * m * HEAD_SZ);
  }
  // warp the sphere's own (seam-correct) UVs into face-dense texture space
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, warpU(uv.getX(i)), warpV(uv.getY(i)));
  uv.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(0, HEAD_CENTER, 0);
  return g;
}

function buildNose(w = 1) {
  const parts = [];
  const R = HEAD_R;
  const add = (g, sx, sy, sz, x, y, z) => { g.scale(sx, sy, sz); g.translate(x, y, z); parts.push(g); };
  add(new THREE.SphereGeometry(R * 0.100, 10, 8), 0.80 * w, 2.20, 1.00, 0, R * 0.055, R * 0.845);
  add(new THREE.SphereGeometry(R * 0.118, 12, 9), 1.02 * w, 0.92, 1.05, 0, -R * 0.095, R * 0.895);
  for (const s of [-1, 1]) {
    add(new THREE.SphereGeometry(R * 0.076, 8, 6), 1.0, 0.86, 0.92,
      s * R * 0.090 * w, -R * 0.118, R * 0.840);
  }
  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  m.translate(0, HEAD_CENTER, 0);
  return m;
}

function buildEars() {
  const parts = [];
  const R = HEAD_R;
  for (const s of [-1, 1]) {
    const outer = new THREE.SphereGeometry(R * 0.250, 10, 10);
    outer.scale(0.42, 1.00, 0.66);
    outer.translate(s * R * 1.005, -R * 0.015, -R * 0.055);
    parts.push(outer);
    const lobe = new THREE.SphereGeometry(R * 0.108, 8, 6);
    lobe.scale(0.48, 1.0, 0.78);
    lobe.translate(s * R * 0.985, -R * 0.215, -R * 0.045);
    parts.push(lobe);
  }
  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  m.translate(0, HEAD_CENTER, 0);
  return m;
}

/** neck: its own cylindrical UVs sample the dark band at the bottom of the face map */
function buildNeck() {
  const g = new THREE.CylinderGeometry(0.152, 0.188, 0.34, 14, 1, true, -Math.PI / 2, TAU);
  g.translate(0, -0.030, 0);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, warpU(uv.getX(i)), warpV(0.030 + uv.getY(i) * 0.145));
  }
  uv.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------------------
// HAIR
// ---------------------------------------------------------------------------

/**
 * A shell wrapped onto skullR().
 * @param inner (az) -> polar angle of the top edge, radians from the crown
 * @param outer (az) -> polar angle of the bottom edge (hairline / nape)
 * @param puff  (az, t) -> extra thickness in head radii; 0 hugs the skull,
 *              negative buries the strip inside the head (used to hide the
 *              collapsed columns of a partial shell like a beard).
 */
function hairShell({ inner, outer, puff, nu = 30, nv = 8 }) {
  const pos = [], nor = [], shade = [], idx = [];
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
      const tuck = 1 - 0.06 * smooth(0.70, 1.0, t);
      const m = HEAD_R * (skullR(nx, ny, nz) * tuck + puff(az, t));
      pos.push(nx * m, ny * m * HEAD_SY, nz * m * HEAD_SZ);
      nor.push(nx, ny, nz);
      shade.push(0.52 * t + 0.16 * Math.sin(az * 7 + t * 3) + 0.14);
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * rows + j, b = a + rows;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  ensureUv(g);
  g.userData.shade = shade;
  return g;
}

/** merge hair parts, carrying the per-vertex shade ramp across */
function mergeShaded(parts) {
  const shades = [];
  for (const p of parts) {
    const n = p.getAttribute('position').count;
    const s = p.userData.shade;
    for (let i = 0; i < n; i++) shades.push(s ? s[i] : 0.46);
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
  const light = new THREE.Color(lighten(color, 0.34)).convertSRGBToLinear();
  const dark = new THREE.Color(darken(color, 0.55)).convertSRGBToLinear();
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

function buildHairGeo(style) {
  const parts = [];
  const front = (az) => Math.cos(az);          // +1 face, -1 nape

  switch (style) {
    case 'bald':
      return null;

    case 'buzz':
      parts.push(hairShell({
        inner: () => 0,
        outer: line(50, 102),
        puff: () => 0.024,
      }));
      break;

    case 'fade':
      parts.push(hairShell({
        inner: () => 0,
        outer: line(47, 108),
        puff: (az, t) => 0.065 * (1 - smooth(0.28, 0.90, t)) + 0.014,
      }));
      break;

    case 'crop':
      parts.push(hairShell({
        inner: () => 0,
        outer: (az) => line(53, 104)(az) + 3.5 * Math.sin(az * 6) * D2R,
        puff: (az, t) => 0.085 * (1 - smooth(0.55, 1.0, t)) + 0.016,
      }));
      break;

    case 'quiff':
      parts.push(hairShell({
        inner: () => 0,
        outer: line(49, 104),
        nv: 11,
        puff: (az, t) => 0.075 * (1 - smooth(0.62, 1.0, t)) + 0.016
          + 0.34 * Math.max(0, front(az)) ** 1.6 * bump((t - 0.26) / 0.34),
      }));
      break;

    case 'curls':
      parts.push(hairShell({
        inner: () => 0,
        outer: line(52, 100),
        puff: (az, t) => 0.10 * (1 - smooth(0.74, 1.0, t)) + 0.016,
      }));
      // lumps scattered across the whole cap, not a bead necklace at the rim
      for (let i = 0; i < 26; i++) {
        const az = hs(i * 3 + 1) * TAU;
        const rim = line(52, 100)(az) / D2R;
        const th = (8 + hs(i * 7 + 5) * (rim - 14)) * D2R;
        parts.push(onSkull(blobGeo(HEAD_R * (0.115 + 0.045 * hs(i * 11 + 3)), 7), az, th, 0.075));
      }
      break;

    case 'afro':
      parts.push(hairShell({
        inner: () => 0,
        outer: line(56, 104),
        nu: 34, nv: 10,
        puff: (az, t) => (0.30 + 0.055 * Math.sin(az * 5) + 0.04 * Math.sin(az * 11 + 1.3)
          + 0.03 * Math.sin(t * 9 + az * 3)) * (1 - smooth(0.58, 1.0, t)) + 0.018,
      }));
      break;

    case 'dreads':
      parts.push(hairShell({
        inner: () => 0,
        outer: line(53, 100),
        puff: (az, t) => 0.075 * (1 - smooth(0.74, 1.0, t)) + 0.018,
      }));
      for (let i = 0; i < 14; i++) {
        const az = 0.95 + (i / 14) * (TAU - 1.9);
        const len = 0.28 + 0.14 * hs(i * 5 + 2);
        const strand = new THREE.CylinderGeometry(HEAD_R * 0.070, HEAD_R * 0.050, len, 6, 1);
        strand.translate(0, -len * 0.46, 0);
        strand.rotateZ(Math.sin(az) * 0.22);
        parts.push(onSkull(strand, az, (74 + 14 * hs(i * 9 + 4)) * D2R, 0.055));
      }
      break;

    case 'bun': {
      parts.push(hairShell({
        inner: () => 0,
        outer: line(53, 112),
        puff: (az, t) => 0.055 * (1 - smooth(0.60, 1.0, t)) + 0.016,
      }));
      const knot = blobGeo(HEAD_R * 0.32, 12);
      knot.scale(1, 0.88, 1);
      parts.push(onSkull(knot, Math.PI, 40 * D2R, 0.26));
      const band = new THREE.TorusGeometry(HEAD_R * 0.21, HEAD_R * 0.045, 6, 12);
      band.rotateX(Math.PI * 0.46);
      parts.push(onSkull(band, Math.PI, 52 * D2R, 0.12));
      break;
    }

    case 'long':
      parts.push(hairShell({
        inner: () => 0,
        outer: line(50, 150),
        nv: 13,
        puff: (az, t) => 0.055 * (1 - smooth(0.90, 1.0, t)) + 0.018
          + 0.13 * Math.max(0, -front(az)) * smooth(0.28, 1.0, t),
      }));
      break;

    case 'mohawk': {
      // shaved sides: a thin, dark shell that still reads as hair
      parts.push(hairShell({
        inner: () => 0,
        outer: line(56, 104),
        puff: () => 0.016,
      }));
      // crest: a chunky ridge over the crown, front to back
      for (let i = 0; i <= 11; i++) {
        const s = i / 11;                      // 0 front, 1 back
        const ang = (s - 0.5) * 2;             // -1 .. 1
        const az = ang < 0 ? 0 : Math.PI;
        const th = Math.abs(ang) * 74 * D2R;
        const h = Math.sin(Math.min(1, 0.08 + s * 0.98) * Math.PI) ** 0.5;
        const blade = blobGeo(HEAD_R * 0.17, 8);
        blade.scale(0.55, 0.55 + h * 1.5, 1.25);
        parts.push(onSkull(blade, az, th, h * 0.30));
      }
      break;
    }

    default:
      parts.push(hairShell({
        inner: () => 0,
        outer: line(51, 102),
        puff: (az, t) => 0.06 * (1 - smooth(0.60, 1.0, t)) + 0.016,
      }));
  }
  return mergeShaded(parts.map(ensureUv));
}

/**
 * Beard shell. Azimuths outside the front arc collapse onto a single ring that
 * is buried inside the skull (puff < 0), so no sheet stretches across the head.
 */
function buildBeard(density = 1) {
  const inArc = (az) => Math.cos(az) > -0.12;
  const top = (az) => (72 - 10 * Math.cos(az)) * D2R;
  const chin = hairShell({
    inner: top,
    outer: (az) => (inArc(az) ? (116 + (16 + 18 * density) * Math.cos(az)) * D2R : top(az)),
    nu: 28, nv: 7,
    puff: (az, t) => (inArc(az)
      ? (0.018 + 0.055 * density) * Math.sin(Math.min(1, t * 1.08) * Math.PI) + 0.012
      : -0.10),
  });
  const mtop = () => 96 * D2R;
  const tache = hairShell({
    inner: mtop,
    outer: (az) => (Math.cos(az) > 0.60 ? 107 * D2R : mtop(az)),
    nu: 22, nv: 3,
    puff: (az, t) => (Math.cos(az) > 0.60 ? 0.05 * Math.sin(t * Math.PI) + 0.018 : -0.10),
  });
  return mergeShaded([ensureUv(chin), ensureUv(tache)]);
}

// ---------------------------------------------------------------------------
// BOOT — vertex-coloured so every player shares one material.
// Built so the sole plane sits at y = -0.06 (the foot bone lives at y = 0.06).
// ---------------------------------------------------------------------------

function buildBoot(main, accent, sole) {
  const parts = [];
  const body = new THREE.BoxGeometry(0.180, 0.100, 0.235);
  body.translate(0, 0.008, 0.045);
  parts.push(tint(body, main));

  const toe = blobGeo(0.096, 10);
  toe.scale(0.94, 0.60, 1.12);
  toe.translate(0, 0.006, 0.168);
  parts.push(tint(toe, main));

  const heel = blobGeo(0.090, 10);
  heel.scale(1.02, 0.72, 0.95);
  heel.translate(0, 0.018, -0.068);
  parts.push(tint(heel, main));

  const collar = new THREE.TorusGeometry(0.076, 0.023, 6, 12);
  collar.rotateX(Math.PI / 2);
  collar.translate(0, 0.056, -0.028);
  parts.push(tint(collar, accent));

  const plate = new THREE.BoxGeometry(0.192, 0.028, 0.350);
  plate.translate(0, -0.046, 0.048);
  parts.push(tint(plate, sole));

  for (const s of [-1, 1]) {
    const flash = new THREE.BoxGeometry(0.016, 0.034, 0.150);
    flash.translate(s * 0.089, 0.006, 0.058);
    parts.push(tint(flash, accent));
  }
  const lace = new THREE.BoxGeometry(0.058, 0.014, 0.105);
  lace.translate(0, 0.054, 0.078);
  parts.push(tint(lace, accent));

  const m = mergeGeometries(parts.map(ensureUv), false);
  parts.forEach((p) => p.dispose());
  return m;
}

// ---------------------------------------------------------------------------

let uid = 0;

export function createPlayer(cfg = {}) {
  const team = TEAMS[cfg.team ?? 0];
  const isKeeper = !!cfg.isKeeper;
  const number = cfg.number ?? 9;
  const skin = cfg.skin ?? SKIN_TONES[3];
  const hairColor = cfg.hairColor ?? HAIR_COLORS[0];
  const hairStyle = cfg.hair ?? HAIR_STYLES[0];
  const faceVariant = cfg.faceVariant ?? 0;
  const beard = cfg.beard ?? 0;             // 0 clean, 1 stubble, 2 full beard
  const kitStyle = cfg.kitStyle ?? 'plain';
  const build = cfg.build ?? 1.0;

  const kitColor = isKeeper ? team.keeper : team.kit;
  const kitAlt = isKeeper ? darken(team.keeper, 0.42) : (team.kitDark ?? darken(team.kit, 0.4));
  const shortsColor = isKeeper ? team.keeperShorts : team.shorts;
  const sockColor = isKeeper ? team.keeper : team.socks;
  const trimColor = isKeeper ? lighten(team.keeper, 0.72) : team.trim;
  const sockTrim = isKeeper ? darken(team.keeper, 0.5)
    : (contrastOn(sockColor) === 0xffffff ? 0xffffff : darken(sockColor, 0.45));

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
    [0.00, 0.298, -0.170],
    [0.12, 0.322, -0.140],
    [0.40, 0.320, -0.085],
    [0.72, 0.314, -0.015],
    [1.00, 0.294, 0.048],
  ], 20, 12);
  shortsGeo.scale(1, 1, 0.86);
  addMesh(hips, shortsGeo,
    fabricMat(`shortsM:${shortsColor}:${trimColor}:${number}`,
      shortsTexture({ color: shortsColor, trim: trimColor, number }),
      { rough: 0.88, repeat: [5, 2], normalScale: 0.5 }), true);

  // plug the open bottom of the shorts lathe
  const gusset = blobGeo(0.27, 12);
  gusset.scale(1, 0.52, 0.86);
  gusset.translate(0, -0.135, 0);
  addMesh(hips, ensureUv(gusset), skinMat(skin));

  // ---- torso --------------------------------------------------------------
  const torsoGeo = lathe([
    [0.00, 0.302, -0.030],
    [0.10, 0.318, 0.030],
    [0.32, 0.334, 0.170],
    [0.56, 0.354, 0.315],
    [0.74, 0.363, 0.420],
    [0.87, 0.318, 0.495],
    [0.95, 0.210, 0.540],
    [1.00, 0.040, 0.562],
  ], 24, 16);
  torsoGeo.scale(1, 1, 0.80);
  const torsoMesh = addMesh(torso, torsoGeo,
    fabricMat(`shirtM:${kitColor}:${trimColor}:${kitAlt}:${number}:${kitStyle}`,
      shirtTexture({ kit: kitColor, trim: trimColor, alt: kitAlt, number, style: kitStyle }),
      { rough: 0.84, repeat: [6, 3], normalScale: 0.6 }), true);

  // ---- head ---------------------------------------------------------------
  const headParts = [
    buildHead(),
    projectUV(buildNose(1 + (faceVariant % 3) * 0.08), HEAD_CENTER),
    projectUV(buildEars(), HEAD_CENTER),
    buildNeck(),
  ];
  const headMerged = mergeGeometries(headParts, false);
  headParts.forEach((p) => p.dispose());
  const eyeIdx = (faceVariant + (number % 3)) % EYE_COLORS.length;
  addMesh(head, headMerged,
    sharedMat(`headM:${skin}:${faceVariant}:${hairColor}:${beard}:${eyeIdx}`, () =>
      new THREE.MeshStandardMaterial({
        map: headTexture({
          skin, variant: faceVariant, browColor: hairColor,
          eyeColor: EYE_COLORS[eyeIdx], stubble: beard,
        }),
        roughness: 0.60, metalness: 0.0,
      })), true);

  // ---- hair + beard -------------------------------------------------------
  const hairParts = [];
  const hairGeo = buildHairGeo(hairStyle);
  if (hairGeo) hairParts.push(shadeHair(hairGeo, hairColor));
  if (beard === 2) hairParts.push(shadeHair(buildBeard(1), mixHex(hairColor, 0x24160e, 0.30)));
  if (hairParts.length) {
    let merged;
    if (hairParts.length === 1) merged = hairParts[0];
    else { merged = mergeGeometries(hairParts, false); hairParts.forEach((p) => p.dispose()); }
    merged.translate(0, HEAD_CENTER, 0);
    addMesh(head, merged, hairMat(), true);
  }

  // ---- arms ---------------------------------------------------------------
  const bones = {};
  const armMat = fabricMat(`armM:${kitColor}:${trimColor}:${skin}:${isKeeper ? 1 : 0}`,
    armTexture({ kit: kitColor, trim: trimColor, skin, long: isKeeper }),
    { rough: 0.78, repeat: [3, 1], normalScale: 0.35 });
  const handMat = isKeeper
    ? fabricMat(`gloveM:${team.keeper}`,
      gloveTexture({ color: lighten(team.keeper, 0.72), accent: darken(team.keeper, 0.45) }),
      { rough: 0.55, repeat: [2, 2], normalScale: 0.4 })
    : skinMat(skin);

  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const arm = new THREE.Object3D();
    arm.name = 'arm' + side;
    arm.position.set(s * 0.322, TORSO_H - 0.08, 0);
    torso.add(arm);
    bones['arm' + side] = arm;

    addMesh(arm, lathe([
      [0.00, 0.030, -0.250],
      [0.07, 0.080, -0.238],
      [0.28, 0.089, -0.178],
      [0.55, 0.098, -0.104],
      [0.78, 0.110, -0.034],
      [0.92, 0.112, 0.014],
      [1.00, 0.045, 0.058],
    ], 14, 14), armMat);

    const fore = new THREE.Object3D();
    fore.name = 'forearm' + side;
    fore.position.y = -0.222;
    arm.add(fore);
    bones['forearm' + side] = fore;

    const foreGeo = lathe([
      [0.00, 0.032, -0.250],
      [0.07, 0.076, -0.238],
      [0.18, 0.099, -0.210],
      [0.32, 0.084, -0.174],
      [0.46, 0.076, -0.144],
      [0.72, 0.084, -0.074],
      [0.92, 0.094, -0.012],
      [1.00, 0.050, 0.016],
    ], 14, 14);
    {   // flatten the hand into a paddle (and inflate it for a keeper glove)
      const p = foreGeo.getAttribute('position');
      const hs = isKeeper ? 1.30 : 1.0;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        if (y < -0.150) {
          const k = smooth(-0.150, -0.235, y);
          const g1 = (1 + 0.34 * k) * (1 + (hs - 1) * k);
          const g2 = (1 - 0.28 * k) * (1 + (hs - 1) * k * 0.6);
          p.setXYZ(i, p.getX(i) * g1, y, p.getZ(i) * g2);
        }
      }
      p.needsUpdate = true;
      foreGeo.computeVertexNormals();
    }
    const thumb = blobGeo(isKeeper ? 0.054 : 0.043, 8);
    thumb.scale(1, 1.5, 0.9);
    thumb.translate(-s * (isKeeper ? 0.108 : 0.090), -0.178, 0.024);
    const foreMerged = mergeGeometries([foreGeo, ensureUv(thumb)], false);
    foreGeo.dispose(); thumb.dispose();
    addMesh(fore, foreMerged, handMat);
  }

  // ---- legs ---------------------------------------------------------------
  const sockMat = fabricMat(`sockM:${sockColor}:${sockTrim}`,
    sockTexture({ color: sockColor, trim: sockTrim }),
    { rough: 0.9, repeat: [2, 1], normalScale: 0.5 });
  const bootMain = cfg.bootColor ?? BOOT_COLORS[0];
  const bright = contrastOn(bootMain) === 0xffffff;
  const bootAccent = cfg.bootAccent ?? (bright ? 0xffffff : 0x1a1d24);
  const bootSole = cfg.bootSole ?? (bright ? 0xe9edf3 : 0x2b3038);
  const bootGeo = buildBoot(bootMain, bootAccent, bootSole);

  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const thigh = new THREE.Object3D();
    thigh.name = 'thigh' + side;
    thigh.position.set(s * 0.148, -0.02, 0);
    hips.add(thigh);
    bones['thigh' + side] = thigh;

    addMesh(thigh, lathe([
      [0.00, 0.072, -0.300],
      [0.10, 0.108, -0.284],
      [0.34, 0.121, -0.216],
      [0.64, 0.134, -0.120],
      [0.88, 0.146, -0.034],
      [1.00, 0.118, 0.018],
    ], 14, 12), skinMat(skin), true);

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
    isKeeper, faceVariant, beard, kitStyle, build,
  };

  return {
    group, rig, config, meshes, ring, blob,
    setSelected(v) { ring.visible = !!v; },
    syncShadow() {
      blob.position.x = 0;
      blob.position.z = 0;
      const lift = Math.max(0, root.position.y);
      const k = 1 / (1 + lift * 1.4);
      blob.scale.setScalar(0.55 + 0.45 * k);
      blob.material.opacity = 0.58 * k;
    },
    dispose() {
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
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
  const kitStyle = teamIndex % 2 === 0 ? 'plain' : 'stripes';

  for (let i = 0; i < numbers.length; i++) {
    const isKeeper = i === 0;
    const hair = hairs[i];
    squad.push(createPlayer({
      team: teamIndex,
      number: numbers[i],
      isKeeper,
      skin: skins[i],
      hair,
      hairColor: rng.pick(HAIR_COLORS),
      faceVariant: (i * 2 + teamIndex * 3 + rng.int(2)) % 6,
      beard: rng.chance(0.26) ? 2 : rng.chance(0.34) ? 1 : 0,
      kitStyle: isKeeper ? 'plain' : kitStyle,
      bootColor: boots[i],
      build: 0.955 + rng.float() * 0.09,
    }));
  }
  return squad;
}
