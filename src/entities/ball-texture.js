// Procedural football skin — owned by the BALL domain.
//
//   ballSkin(style) -> { map, normalMap, roughnessMap }
//
// The panel layout is a real truncated icosahedron, computed analytically as a
// spherical Voronoi diagram of 32 seed directions:
//   * 12 icosahedron vertices    -> pentagon panels
//   * 20 icosahedron face centres-> hexagon panels
// For every texel we find the nearest and second-nearest seed; the difference of
// the two angular distances is the distance to the panel boundary, which gives a
// constant-width seam everywhere on the sphere with no visible pole pinching and
// no wrap seam. The same field drives a height map, so the seams are pressed into
// a real normal map and catch the key light.
//
// Everything is generated once and memoised. No binary assets, no Math.random.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

const cache = new Map();

// ---------------------------------------------------------------------------
// truncated icosahedron seeds
// ---------------------------------------------------------------------------

function seeds() {
  const P = (1 + Math.sqrt(5)) / 2;
  const verts = [];
  const push = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    verts.push([x / l, y / l, z / l]);
  };
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      push(0, s1, s2 * P);
      push(s1, s2 * P, 0);
      push(s2 * P, 0, s1);
    }
  }
  // faces: every mutually-adjacent triple (adjacent <=> dot ~= 1/sqrt(5))
  const faces = [];
  const adj = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0.4;
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      if (!adj(verts[i], verts[j])) continue;
      for (let k = j + 1; k < 12; k++) {
        if (!adj(verts[i], verts[k]) || !adj(verts[j], verts[k])) continue;
        const x = verts[i][0] + verts[j][0] + verts[k][0];
        const y = verts[i][1] + verts[j][1] + verts[k][1];
        const z = verts[i][2] + verts[j][2] + verts[k][2];
        const l = Math.hypot(x, y, z);
        faces.push([x / l, y / l, z / l]);
      }
    }
  }
  // Rotate the whole cage a little so no panel centre sits exactly on a pole:
  // an exact pole centre makes the equirect projection look suspiciously regular.
  const ca = Math.cos(0.36), sa = Math.sin(0.36);
  const cb = Math.cos(0.21), sb = Math.sin(0.21);
  const rot = (v) => {
    const y = v[1] * ca - v[2] * sa, z = v[1] * sa + v[2] * ca;
    const x = v[0] * cb - z * sb, z2 = v[0] * sb + z * cb;
    return [x, y, z2];
  };
  return {
    pent: verts.map(rot),
    hex: faces.map(rot),
  };
}

// ---------------------------------------------------------------------------

const PALETTES = {
  // white ball, black pentagons — the Mini Football / Telstar look
  classic: {
    light: [246, 247, 249], lightEdge: [214, 218, 226],
    dark: [22, 24, 30], darkEdge: [8, 9, 12],
    seam: [46, 50, 58], grime: [150, 152, 150],
  },
  // dark star-panelled variant
  star: {
    light: [30, 33, 42], lightEdge: [16, 18, 24],
    dark: [242, 208, 48], darkEdge: [198, 160, 26],
    seam: [10, 11, 14], grime: [70, 72, 80],
  },
  // white / blue match ball
  match: {
    light: [248, 249, 252], lightEdge: [212, 220, 236],
    dark: [24, 68, 158], darkEdge: [12, 40, 104],
    seam: [40, 58, 96], grime: [156, 162, 172],
  },
};

const W = 1024;
const H = 512;
const SEAM = 0.044;          // seam half-width in radians on the unit sphere
const EDGE_AO = 0.115;       // panel edge shading falloff, radians

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function build(style) {
  const pal = PALETTES[style] || PALETTES.classic;
  const { pent, hex } = seeds();
  const all = [];
  for (const p of pent) all.push([p[0], p[1], p[2], 1]);
  for (const h of hex) all.push([h[0], h[1], h[2], 0]);
  const N = all.length;

  const rng = makeRng(90210);
  // low-frequency scuff field, sampled on a coarse lattice and bilinearly read
  const GN = 32;
  const grid = new Float32Array(GN * GN);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.float();
  const noise = (u, v) => {
    const x = u * GN, y = v * GN;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const g = (a, b) => grid[((b % GN) + GN) % GN * GN + (((a % GN) + GN) % GN)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
    const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };

  const rgba = new Uint8ClampedArray(W * H * 4);
  const rough = new Uint8ClampedArray(W * H * 4);
  const height = new Float32Array(W * H);

  const cosA = new Float32Array(W), sinA = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const a = ((x + 0.5) / W) * Math.PI * 2;
    cosA[x] = Math.cos(a); sinA[x] = Math.sin(a);
  }

  for (let y = 0; y < H; y++) {
    const pol = ((y + 0.5) / H) * Math.PI;
    const sp = Math.sin(pol), ny = Math.cos(pol);
    for (let x = 0; x < W; x++) {
      const nx = sp * cosA[x], nz = sp * sinA[x];

      let d1 = -2, d2 = -2, isPent = 0;
      for (let i = 0; i < N; i++) {
        const s = all[i];
        const d = nx * s[0] + ny * s[1] + nz * s[2];
        if (d > d1) { d2 = d1; d1 = d; isPent = s[3]; }
        else if (d > d2) { d2 = d; }
      }
      const a1 = Math.acos(Math.min(1, Math.max(-1, d1)));
      const a2 = Math.acos(Math.min(1, Math.max(-1, d2)));
      const edge = (a2 - a1) * 0.5;            // distance to the panel boundary

      const seam = 1 - smoothstep(SEAM * 0.35, SEAM, edge);
      const ao = 1 - 0.10 * (1 - smoothstep(SEAM, EDGE_AO, edge));

      const base = isPent ? pal.dark : pal.light;
      const bedge = isPent ? pal.darkEdge : pal.lightEdge;
      // panels are very slightly domed: brighter in the middle, darker at the rim
      const dome = smoothstep(0.0, EDGE_AO * 1.9, edge);

      const u = (x + 0.5) / W, v = (y + 0.5) / H;
      const grime = noise(u * 2.3, v * 2.3);
      const scuff = Math.max(0, grime - 0.60) * (isPent ? 0.5 : 1.0);

      let r = (bedge[0] + (base[0] - bedge[0]) * dome) * ao;
      let g = (bedge[1] + (base[1] - bedge[1]) * dome) * ao;
      let b = (bedge[2] + (base[2] - bedge[2]) * dome) * ao;
      // dirt
      r += (pal.grime[0] - r) * scuff * 0.42;
      g += (pal.grime[1] - g) * scuff * 0.42;
      b += (pal.grime[2] - b) * scuff * 0.42;
      // seam ink
      r += (pal.seam[0] - r) * seam;
      g += (pal.seam[1] - g) * seam;
      b += (pal.seam[2] - b) * seam;

      const o = (y * W + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;

      // stitching: the seam groove is interrupted by regular thread bumps
      const along = (a1 * 62 + a2 * 11);
      const stitch = seam * Math.max(0, Math.sin(along) * 0.5 + 0.5) ** 3;
      height[y * W + x] = -seam * 1.0 + stitch * 0.55 + dome * 0.16;

      // seams and dirt are matte; the panel faces keep a slight sheen
      const rr = 138 + seam * 62 + scuff * 46;
      rough[o] = rr; rough[o + 1] = rr; rough[o + 2] = rr; rough[o + 3] = 255;
    }
  }

  // ---- height field -> tangent-space normal map ---------------------------
  const nrm = new Uint8ClampedArray(W * H * 4);
  const S = 3.1;
  for (let y = 0; y < H; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < H - 1 ? y + 1 : H - 1;
    for (let x = 0; x < W; x++) {
      const xm = (x - 1 + W) % W, xp = (x + 1) % W;
      const dx = (height[y * W + xp] - height[y * W + xm]) * S;
      const dy = (height[yp * W + x] - height[ym * W + x]) * S;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * W + x) * 4;
      nrm[o] = (nx * 0.5 + 0.5) * 255;
      nrm[o + 1] = (ny * 0.5 + 0.5) * 255;
      nrm[o + 2] = (nz * 0.5 + 0.5) * 255;
      nrm[o + 3] = 255;
    }
  }

  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };

  return { map: mk(rgba, true), normalMap: mk(nrm, false), roughnessMap: mk(rough, false) };
}

export function ballSkin(style = 'classic') {
  const key = 'skin:' + style;
  if (!cache.has(key)) cache.set(key, build(style));
  return cache.get(key);
}
