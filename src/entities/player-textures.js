// Procedural surfacing for the chibi players — faces, kits, shorts, socks,
// sleeves, gloves and the shared fabric normal map.
//
// Owned by the CHARS domain together with entities/player.js. Everything here is
// canvas-2D generated at runtime; no binary assets, no Math.random.
//
// ---------------------------------------------------------------------------
// HEAD UV CONVENTION
// ---------------------------------------------------------------------------
// The head mesh (sphere + nose + ears + brow + neck) is UV'd by spherical
// projection from the head centre:
//
//     u = 0.25  -> +Z, the face          u = 0.75 -> back of the skull
//     u = 0.50  -> +X, player's right ear
//     u = 0.00  -> -X, player's left ear
//     v = 1     -> crown,  v = 0 -> under the chin
//
// A plain equirectangular layout wastes ~75 % of the pixels on the back of the
// head. `warpU` / `warpV` bend the mapping so the face gets ~1.7x the texel
// density it otherwise would; both are smooth, monotonic and fix-pointed at the
// seam, so nothing tears. player.js applies exactly the same warp when it
// projects the geometry, so the two always agree.

import * as THREE from 'three';

const cache = new Map();
function memo(key, make) {
  let v = cache.get(key);
  if (v === undefined) { v = make(); cache.set(key, v); }
  return v;
}

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d') };
}

function tex(c, opts = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso ?? 8;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------

export function css(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6); }
const R8 = (n) => (n >> 16) & 255, G8 = (n) => (n >> 8) & 255, B8 = (n) => n & 255;

export function mixHex(a, b, t) {
  const r = Math.round(R8(a) + (R8(b) - R8(a)) * t);
  const g = Math.round(G8(a) + (G8(b) - G8(a)) * t);
  const bl = Math.round(B8(a) + (B8(b) - B8(a)) * t);
  return (r << 16) | (g << 8) | bl;
}
export const darken = (n, t) => mixHex(n, 0x000000, t);
export const lighten = (n, t) => mixHex(n, 0xffffff, t);
export function luma(n) { return (0.299 * R8(n) + 0.587 * G8(n) + 0.114 * B8(n)) / 255; }
/** pick whichever of black / white reads better on top of `n` */
export const contrastOn = (n) => (luma(n) > 0.58 ? 0x14171c : 0xffffff);

function rgba(n, a) { return `rgba(${R8(n)},${G8(n)},${B8(n)},${a})`; }

// deterministic value noise (no Math.random anywhere in this file)
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// ---------------------------------------------------------------------------
// rosters
// ---------------------------------------------------------------------------

/** Broad, evenly spaced skin range — the reference roster is diverse. */
export const SKIN_TONES = [
  0xffd9bd, 0xf6c9a4, 0xeeb489, 0xdd9b6d, 0xc4834f,
  0xa96a3c, 0x8a5330, 0x6b3d22, 0x4e2c18,
];

export const HAIR_COLORS = [
  0x14100c, 0x241a12, 0x3a2415, 0x5a3418, 0x7d4c1e,
  0xa8722e, 0xd0a85e, 0xe4c98c, 0x9a9aa2, 0xd9d9dd, 0xa8391a, 0x3d2b3a,
];

export const HAIR_STYLES = [
  'buzz', 'fade', 'crop', 'quiff', 'curls', 'afro', 'bun', 'long', 'mohawk', 'dreads', 'bald',
];

export const EYE_COLORS = [0x3f2a16, 0x2c1c10, 0x5a4520, 0x3d6b3a, 0x2f5f86, 0x6a7c8c];

export const BOOT_COLORS = [
  0xf3f5f8, 0x14161b, 0xf2c318, 0xff4d8d, 0x2fd06a, 0x2a6cf5, 0xff6a1f, 0xc0143c,
];

// ---------------------------------------------------------------------------
// head UV warp — shared with player.js
// ---------------------------------------------------------------------------

const WARP_U = 0.75;
const WARP_V = 0.60;
const TAU = Math.PI * 2;

/** sphere u (face at 0.25) -> texture u, face region stretched ~1.75x */
export function warpU(u) {
  let d = u - 0.25;
  d -= Math.floor(d + 0.5);              // wrap into [-0.5, 0.5)
  return 0.25 + d + (WARP_U * Math.sin(TAU * d)) / TAU;
}
/** sphere v -> texture v, equator band stretched ~1.6x */
export function warpV(v) {
  const e = v - 0.5;
  return 0.5 + e + (WARP_V * Math.sin(TAU * e)) / TAU;
}

// ---------------------------------------------------------------------------
// FACE
// ---------------------------------------------------------------------------

const FACE_W = 1024, FACE_H = 640;
// pixels per unit of arc length (in head radii) at the face
const AX = (FACE_W * (1 + WARP_U)) / TAU;
const AY = (FACE_H * (1 + WARP_V)) / Math.PI;

// texture pixel from sphere uv
const FX = (u) => {
  let x = warpU(u);
  x -= Math.floor(x);
  return x * FACE_W;
};
const FY = (v) => (1 - warpV(v)) * FACE_H;

/**
 * headTexture — the whole face is painted, so it survives a tight closeup while
 * the geometry stays cheap. Geometry (brow ridge, nose, ears, jaw) is sculpted
 * to match, so the paint sits on real form rather than floating on an egg.
 */
export function headTexture(o = {}) {
  const skin = o.skin ?? SKIN_TONES[2];
  const variant = o.variant ?? 0;
  const brow = o.browColor ?? 0x241a12;
  const eyeCol = o.eyeColor ?? EYE_COLORS[variant % EYE_COLORS.length];
  const stubble = o.stubble ?? 0;
  const key = `head:${skin}:${variant}:${brow}:${eyeCol}:${stubble}`;

  return memo(key, () => {
    const { c, g } = canvas2d(FACE_W, FACE_H);
    const W = FACE_W, H = FACE_H;

    const shadow = mixHex(skin, 0x5d2a18, 0.34);
    const deep = mixHex(skin, 0x40180d, 0.52);
    const hi = lighten(skin, 0.22);

    // ---- base skin with a soft top-lit gradient --------------------------
    g.fillStyle = css(skin); g.fillRect(0, 0, W, H);
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.00, rgba(lighten(skin, 0.16), 0.30));
    grd.addColorStop(0.30, rgba(hi, 0.10));
    grd.addColorStop(0.60, 'rgba(0,0,0,0)');
    grd.addColorStop(1.00, rgba(deep, 0.55));
    g.fillStyle = grd; g.fillRect(0, 0, W, H);

    // faint skin grain
    g.save();
    g.globalAlpha = 0.05;
    for (let y = 0; y < H; y += 4) {
      for (let x = 0; x < W; x += 4) {
        const n = vnoise(x / 12, y / 12);
        g.fillStyle = n > 0.5 ? '#ffffff' : '#000000';
        g.fillRect(x, y, 4, 4);
      }
    }
    g.restore();

    const cx = FX(0.25);
    // ---- feature anchors (sphere uv) -------------------------------------
    const V_EYE = 0.558, V_BROW = 0.612, V_NOSE = 0.500, V_MOUTH = 0.443;
    const eyeY = FY(V_EYE);
    const sep = 0.255;                   // eye centre offset, in head radii of arc

    // ---- cranial / cheek shaping ----------------------------------------
    // temple shadow either side of the face
    for (const s of [-1, 1]) {
      const tg = g.createRadialGradient(cx + s * 0.62 * AX, eyeY - 0.10 * AY, 6,
        cx + s * 0.62 * AX, eyeY - 0.10 * AY, 0.55 * AX);
      tg.addColorStop(0, rgba(shadow, 0.30));
      tg.addColorStop(1, rgba(shadow, 0));
      g.fillStyle = tg;
      g.fillRect(cx + s * 0.20 * AX - (s < 0 ? 0.95 * AX : 0), eyeY - 0.7 * AY, 0.95 * AX, 1.5 * AY);
    }
    // jaw / under-chin occlusion
    const jg = g.createLinearGradient(0, FY(0.40), 0, FY(0.24));
    jg.addColorStop(0, rgba(shadow, 0));
    jg.addColorStop(1, rgba(deep, 0.75));
    g.fillStyle = jg; g.fillRect(0, FY(0.40), W, FY(0.24) - FY(0.40));
    // neck: everything below v 0.28 is in shadow
    g.fillStyle = rgba(deep, 0.55); g.fillRect(0, FY(0.26), W, H - FY(0.26));

    // cheek warmth
    g.save();
    g.globalAlpha = 0.20;
    for (const s of [-1, 1]) {
      const bg = g.createRadialGradient(cx + s * 0.40 * AX, eyeY + 0.30 * AY, 4,
        cx + s * 0.40 * AX, eyeY + 0.30 * AY, 0.34 * AX);
      bg.addColorStop(0, 'rgba(214,96,74,1)');
      bg.addColorStop(1, 'rgba(214,96,74,0)');
      g.fillStyle = bg;
      g.fillRect(cx + s * 0.40 * AX - 0.36 * AX, eyeY - 0.1 * AY, 0.72 * AX, 0.9 * AY);
    }
    g.restore();

    // ---- stubble / beard shadow (under the mouth paint, over the skin) ----
    if (stubble > 0) {
      const dens = stubble >= 2 ? 1.0 : 0.5;
      const beardCol = mixHex(skin, darken(brow, 0.10), 0.52 + dens * 0.34);
      g.save();
      g.beginPath();
      g.moveTo(cx - 0.74 * AX, FY(0.615));
      g.quadraticCurveTo(cx - 0.62 * AX, FY(0.412), cx, FY(0.386));
      g.quadraticCurveTo(cx + 0.62 * AX, FY(0.412), cx + 0.74 * AX, FY(0.615));
      g.lineTo(cx + 0.74 * AX, FY(0.225));
      g.lineTo(cx - 0.74 * AX, FY(0.225));
      g.closePath();
      g.clip();
      g.globalAlpha = 0.40 + dens * 0.45;
      g.fillStyle = css(beardCol);
      g.fillRect(cx - 0.8 * AX, FY(0.65), 1.6 * AX, FY(0.18) - FY(0.65));
      g.globalAlpha = 0.26 + dens * 0.14;
      const y0 = FY(0.63), y1 = FY(0.20);
      for (let y = y0; y < y1; y += 3) {
        for (let x = cx - 0.78 * AX; x < cx + 0.78 * AX; x += 3) {
          const n = vnoise(x / 3.1, y / 3.1);
          if (n > 0.60) { g.fillStyle = css(darken(beardCol, 0.40)); g.fillRect(x, y, 2, 2); }
          else if (n < 0.30) { g.fillStyle = css(lighten(beardCol, 0.22)); g.fillRect(x, y, 2, 2); }
        }
      }
      g.restore();
    }

    // ---- brow ridge shading (the geometry has a real ridge under this) ---
    g.save();
    g.globalAlpha = 0.20;
    for (const s of [-1, 1]) {
      g.fillStyle = rgba(shadow, 1);
      g.beginPath();
      g.ellipse(cx + s * sep * AX, eyeY - 0.03 * AY, 0.27 * AX, 0.17 * AY, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    // upper-lid highlight
    g.save();
    g.globalAlpha = 0.30;
    for (const s of [-1, 1]) {
      g.fillStyle = rgba(hi, 1);
      g.beginPath();
      g.ellipse(cx + s * sep * AX, eyeY - 0.20 * AY, 0.26 * AX, 0.10 * AY, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // ---- eyes -------------------------------------------------------------
    const eyeW = 0.200 * AX, eyeH = 0.122 * AY;
    const tilt = [0.00, 0.05, -0.03, 0.07, 0.02, 0.09][variant % 6];
    const irisR = 0.076 * AX;

    function drawEye(s) {
      const ex = cx + s * sep * AX;
      g.save();
      g.translate(ex, eyeY);
      g.rotate(s * tilt);

      // socket shadow
      g.fillStyle = rgba(shadow, 0.16);
      g.beginPath(); g.ellipse(0, 0, eyeW * 1.20, eyeH * 1.45, 0, 0, Math.PI * 2); g.fill();

      // sclera — almond, flatter on top
      g.beginPath();
      g.moveTo(-eyeW, eyeH * 0.05);
      g.quadraticCurveTo(-eyeW * 0.55, -eyeH * 1.02, 0, -eyeH * 0.98);
      g.quadraticCurveTo(eyeW * 0.60, -eyeH * 0.94, eyeW, eyeH * 0.02);
      g.quadraticCurveTo(eyeW * 0.55, eyeH * 1.02, -eyeW * 0.05, eyeH * 1.00);
      g.quadraticCurveTo(-eyeW * 0.62, eyeH * 0.92, -eyeW, eyeH * 0.05);
      g.closePath();
      g.fillStyle = '#f3f0ec'; g.fill();
      g.save(); g.clip();

      // sclera shading from the lid
      const sg = g.createLinearGradient(0, -eyeH, 0, eyeH);
      sg.addColorStop(0, 'rgba(96,80,66,0.38)');
      sg.addColorStop(0.45, 'rgba(140,124,110,0.06)');
      sg.addColorStop(1, 'rgba(160,142,126,0.14)');
      g.fillStyle = sg; g.fillRect(-eyeW, -eyeH * 1.2, eyeW * 2, eyeH * 2.4);

      // iris
      const gx = (variant % 3 - 1) * irisR * 0.22;
      g.fillStyle = css(darken(eyeCol, 0.35));
      g.beginPath(); g.arc(gx, eyeH * 0.06, irisR, 0, Math.PI * 2); g.fill();
      const ig = g.createRadialGradient(gx - irisR * 0.25, eyeH * 0.06 - irisR * 0.3, irisR * 0.1,
        gx, eyeH * 0.06, irisR);
      ig.addColorStop(0, css(lighten(eyeCol, 0.42)));
      ig.addColorStop(0.62, css(eyeCol));
      ig.addColorStop(1, css(darken(eyeCol, 0.55)));
      g.fillStyle = ig;
      g.beginPath(); g.arc(gx, eyeH * 0.06, irisR * 0.92, 0, Math.PI * 2); g.fill();
      // pupil
      g.fillStyle = '#0b0c10';
      g.beginPath(); g.arc(gx, eyeH * 0.06, irisR * 0.44, 0, Math.PI * 2); g.fill();
      // specular
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.beginPath(); g.arc(gx - irisR * 0.36, eyeH * 0.06 - irisR * 0.42, irisR * 0.30, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.42)';
      g.beginPath(); g.arc(gx + irisR * 0.30, eyeH * 0.06 + irisR * 0.34, irisR * 0.16, 0, Math.PI * 2); g.fill();
      g.restore();

      // upper lash line
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = 'rgba(38,25,18,0.92)';
      g.lineWidth = eyeH * 0.25;
      g.beginPath();
      g.moveTo(-eyeW * 1.02, eyeH * 0.02);
      g.quadraticCurveTo(-eyeW * 0.5, -eyeH * 1.16, 0.02, -eyeH * 1.06);
      g.quadraticCurveTo(eyeW * 0.62, -eyeH * 1.02, eyeW * 1.03, eyeH * 0.0);
      g.stroke();
      // lower lid, soft
      g.strokeStyle = rgba(deep, 0.55);
      g.lineWidth = eyeH * 0.16;
      g.beginPath();
      g.moveTo(-eyeW * 0.86, eyeH * 0.72);
      g.quadraticCurveTo(0, eyeH * 1.26, eyeW * 0.90, eyeH * 0.60);
      g.stroke();
      // crease above the lid
      g.strokeStyle = rgba(shadow, 0.45);
      g.lineWidth = eyeH * 0.13;
      g.beginPath();
      g.moveTo(-eyeW * 0.80, -eyeH * 0.92);
      g.quadraticCurveTo(0, -eyeH * 1.62, eyeW * 0.86, -eyeH * 0.86);
      g.stroke();

      g.restore();
    }
    drawEye(-1); drawEye(1);

    // ---- brows ------------------------------------------------------------
    const browShapes = [
      { th: 0.115, arch: 0.30, ang: 0.10 },
      { th: 0.145, arch: 0.16, ang: 0.18 },
      { th: 0.095, arch: 0.42, ang: 0.04 },
      { th: 0.165, arch: 0.10, ang: 0.24 },
      { th: 0.125, arch: 0.34, ang: 0.14 },
      { th: 0.105, arch: 0.24, ang: 0.02 },
    ];
    const bs = browShapes[variant % browShapes.length];
    const browY = FY(V_BROW);
    for (const s of [-1, 1]) {
      g.save();
      g.translate(cx + s * sep * AX, browY);
      g.rotate(s * bs.ang);
      const bw = 0.285 * AX, bt = bs.th * AY;
      g.beginPath();
      g.moveTo(-bw, bt * 0.55);
      g.quadraticCurveTo(-bw * 0.25, -bt * (0.6 + bs.arch), bw * 0.55, -bt * 0.30);
      g.quadraticCurveTo(bw * 0.92, -bt * 0.05, bw, bt * 0.32);
      g.quadraticCurveTo(bw * 0.5, bt * 0.34, -bw * 0.1, bt * 0.86);
      g.quadraticCurveTo(-bw * 0.62, bt * 1.02, -bw, bt * 0.55);
      g.closePath();
      g.fillStyle = css(darken(brow, 0.10)); g.fill();
      // a couple of stray hairs so the brow is not a flat blob
      g.strokeStyle = rgba(lighten(brow, 0.35), 0.5);
      g.lineWidth = Math.max(1.5, bt * 0.11);
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        const px = -bw + t * bw * 1.9;
        g.beginPath();
        g.moveTo(px, bt * 0.5);
        g.lineTo(px + bw * 0.06, -bt * (0.35 + bs.arch * (1 - Math.abs(t - 0.45) * 1.6)));
        g.stroke();
      }
      g.restore();
    }

    // ---- nose -------------------------------------------------------------
    const noseY = FY(V_NOSE);
    const noseW = (0.115 + (variant % 3) * 0.012) * AX;
    // side shadows down the bridge
    g.save();
    g.globalAlpha = 0.55;
    for (const s of [-1, 1]) {
      const ng = g.createLinearGradient(cx + s * noseW * 1.5, 0, cx + s * noseW * 0.35, 0);
      ng.addColorStop(0, rgba(shadow, 0));
      ng.addColorStop(1, rgba(shadow, 1));
      g.fillStyle = ng;
      g.beginPath();
      g.moveTo(cx + s * noseW * 0.30, browY);
      g.lineTo(cx + s * noseW * 1.55, noseY + 0.06 * AY);
      g.lineTo(cx + s * noseW * 0.20, noseY + 0.10 * AY);
      g.closePath(); g.fill();
    }
    g.restore();
    // bridge highlight
    g.save();
    g.globalAlpha = 0.30;
    const bhg = g.createLinearGradient(cx - noseW * 0.5, 0, cx + noseW * 0.5, 0);
    bhg.addColorStop(0, rgba(hi, 0)); bhg.addColorStop(0.5, rgba(hi, 1)); bhg.addColorStop(1, rgba(hi, 0));
    g.fillStyle = bhg;
    g.fillRect(cx - noseW * 0.5, browY - 0.05 * AY, noseW, noseY - browY + 0.12 * AY);
    g.restore();
    // tip shading + nostrils
    g.fillStyle = rgba(shadow, 0.40);
    g.beginPath();
    g.ellipse(cx, noseY + 0.055 * AY, noseW * 1.30, 0.075 * AY, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = rgba(deep, 0.85);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * noseW * 0.78, noseY + 0.070 * AY, noseW * 0.30, 0.030 * AY, s * 0.4, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = rgba(lighten(skin, 0.45), 0.55);
    g.beginPath();
    g.ellipse(cx, noseY - 0.005 * AY, noseW * 0.55, 0.045 * AY, 0, 0, Math.PI * 2); g.fill();

    // ---- mouth ------------------------------------------------------------
    const mY = FY(V_MOUTH);
    const mW = (0.30 + (variant % 4) * 0.012) * AX;
    const smile = [0.16, 0.05, 0.24, 0.10, 0.18, 0.02][variant % 6];
    // philtrum
    g.strokeStyle = rgba(shadow, 0.30);
    g.lineWidth = Math.max(2, 0.014 * AY);
    g.beginPath();
    g.moveTo(cx, noseY + 0.085 * AY); g.lineTo(cx, mY - 0.075 * AY); g.stroke();
    // lips
    const lip = mixHex(skin, 0x9b3a34, 0.42);
    g.fillStyle = css(lip);
    g.beginPath();
    g.moveTo(cx - mW, mY);
    g.quadraticCurveTo(cx - mW * 0.45, mY - 0.062 * AY, cx - mW * 0.10, mY - 0.020 * AY);
    g.quadraticCurveTo(cx, mY - 0.045 * AY, cx + mW * 0.10, mY - 0.020 * AY);
    g.quadraticCurveTo(cx + mW * 0.45, mY - 0.062 * AY, cx + mW, mY);
    g.quadraticCurveTo(cx + mW * 0.5, mY + (0.075 + smile * 0.16) * AY, cx, mY + (0.082 + smile * 0.20) * AY);
    g.quadraticCurveTo(cx - mW * 0.5, mY + (0.075 + smile * 0.16) * AY, cx - mW, mY);
    g.closePath(); g.fill();
    // mouth line
    g.strokeStyle = rgba(darken(lip, 0.62), 0.9);
    g.lineWidth = Math.max(2.4, 0.020 * AY);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - mW * 0.97, mY - 0.004 * AY);
    g.quadraticCurveTo(cx, mY + smile * 0.16 * AY, cx + mW * 0.97, mY - 0.004 * AY);
    g.stroke();
    // corner dimples
    g.fillStyle = rgba(shadow, 0.5);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * mW * 1.02, mY + 0.004 * AY, 0.020 * AX, 0.022 * AY, 0, 0, Math.PI * 2);
      g.fill();
    }
    // lower lip highlight
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.beginPath();
    g.ellipse(cx, mY + 0.045 * AY, mW * 0.5, 0.022 * AY, 0, 0, Math.PI * 2); g.fill();
    // chin shadow + crease
    g.fillStyle = rgba(shadow, 0.22);
    g.beginPath();
    g.ellipse(cx, mY + 0.185 * AY, mW * 0.95, 0.085 * AY, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = rgba(hi, 0.20);
    g.beginPath();
    g.ellipse(cx, mY + 0.150 * AY, mW * 0.55, 0.045 * AY, 0, 0, Math.PI * 2); g.fill();

    // ---- ears --------------------------------------------------------------
    // painted at u = 0.5 (+X) and u = 0.0/1.0 (-X); the ear geometry projects here
    const earPositions = [FX(0.5), FX(0.0), FX(0.0) - W];
    for (let i = 0; i < earPositions.length; i++) {
      const ex = earPositions[i];
      const s = i === 0 ? 1 : -1;
      const eY = FY(0.525);
      const ew = 0.105 * AX, eh = 0.26 * AY;
      g.save();
      g.translate(ex, eY);
      // outer shading
      g.fillStyle = rgba(shadow, 0.30);
      g.beginPath(); g.ellipse(0, 0, ew * 1.15, eh * 1.05, 0, 0, Math.PI * 2); g.fill();
      // concha bowl
      g.fillStyle = rgba(deep, 0.45);
      g.beginPath(); g.ellipse(-s * ew * 0.10, eh * 0.06, ew * 0.55, eh * 0.55, 0, 0, Math.PI * 2); g.fill();
      // helix rim highlight
      g.strokeStyle = rgba(hi, 0.55);
      g.lineWidth = Math.max(2, ew * 0.16);
      g.beginPath();
      g.ellipse(0, 0, ew * 0.86, eh * 0.86, 0, Math.PI * 0.15, Math.PI * 1.75);
      g.stroke();
      // lobe
      g.fillStyle = rgba(shadow, 0.22);
      g.beginPath(); g.ellipse(0, eh * 0.72, ew * 0.45, eh * 0.22, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    // ---- scalp: slightly desaturated on top so a bald head is not flat ----
    const sg2 = g.createLinearGradient(0, 0, 0, FY(0.72));
    sg2.addColorStop(0, rgba(mixHex(skin, 0x6b4a35, 0.20), 0.45));
    sg2.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg2; g.fillRect(0, 0, W, FY(0.72));

    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// FABRIC — shared weave normal + roughness
// ---------------------------------------------------------------------------

export function fabricNormal() {
  return memo('fabricN', () => {
    const S = 256;
    const { c, g } = canvas2d(S, S);
    const img = g.createImageData(S, S);
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        // plain weave: over/under threads plus a little fibre noise
        const wu = Math.sin((x / S) * TAU * 24);
        const wv = Math.sin((y / S) * TAU * 24);
        const weave = (Math.abs(wu) > Math.abs(wv) ? wu : wv) * 0.5;
        h[y * S + x] = weave * 0.55 + (vnoise(x / 2.2, y / 2.2) - 0.5) * 0.5
          + (vnoise(x / 9, y / 9) - 0.5) * 0.35;
      }
    }
    const at = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * 1.6;
        const dy = (at(x, y + 1) - at(x, y - 1)) * 1.6;
        let nx = -dx, ny = -dy, nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l; nz /= l;
        const i = (y * S + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return tex(c, { data: true, aniso: 4 });
  });
}

/** faint woven tone laid over a kit panel so it is not flat plastic */
function weaveOverlay(g, W, H, alpha = 0.10) {
  g.save();
  g.globalAlpha = alpha;
  for (let y = 0; y < H; y += 3) {
    g.fillStyle = y % 6 === 0 ? '#ffffff' : '#000000';
    g.fillRect(0, y, W, 1.4);
  }
  g.globalAlpha = alpha * 0.7;
  for (let x = 0; x < W; x += 3) {
    g.fillStyle = x % 6 === 0 ? '#ffffff' : '#000000';
    g.fillRect(x, 0, 1.4, H);
  }
  g.globalAlpha = alpha * 1.6;
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      const n = vnoise(x / 5, y / 5);
      if (n > 0.62) { g.fillStyle = '#ffffff'; g.fillRect(x, y, 2, 2); }
      else if (n < 0.36) { g.fillStyle = '#000000'; g.fillRect(x, y, 2, 2); }
    }
  }
  g.restore();
}

/** cylindrical AO: darker at the sides so a lathe body reads round */
function roundShade(g, W, H, front = 0.25) {
  const sh = g.createLinearGradient(0, 0, W, 0);
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    const a = Math.cos((u - front) * TAU);        // 1 facing camera-front
    const v = a * 0.5 + 0.5;
    const c = v > 0.5 ? `rgba(255,255,255,${(v - 0.5) * 0.26})` : `rgba(0,0,0,${(0.5 - v) * 0.42})`;
    sh.addColorStop(u, c);
  }
  g.fillStyle = sh; g.fillRect(0, 0, W, H);
}

function outlinedNumber(g, n, x, y, size, fill, stroke) {
  g.save();
  g.translate(x, y);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `900 ${size}px "Arial Black", "Trebuchet MS", Impact, sans-serif`;
  g.lineJoin = 'round';
  g.lineWidth = size * 0.13;
  g.strokeStyle = 'rgba(0,0,0,0.30)';
  g.strokeText(String(n), 0, size * 0.045);
  g.lineWidth = size * 0.10;
  g.strokeStyle = css(stroke);
  g.strokeText(String(n), 0, 0);
  g.fillStyle = css(fill);
  g.fillText(String(n), 0, 0);
  g.restore();
}

function crest(g, x, y, s, main, accent) {
  g.save();
  g.translate(x, y); g.scale(s, s);
  g.beginPath();
  g.moveTo(-22, -26); g.lineTo(22, -26); g.lineTo(22, 6);
  g.quadraticCurveTo(22, 26, 0, 34); g.quadraticCurveTo(-22, 26, -22, 6);
  g.closePath();
  g.fillStyle = css(main); g.fill();
  g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.45)'; g.stroke();
  g.beginPath();
  g.moveTo(-11, -14); g.lineTo(11, -14); g.lineTo(0, 16); g.closePath();
  g.fillStyle = css(accent); g.fill();
  g.restore();
}

// ---------------------------------------------------------------------------
// SHIRT
// ---------------------------------------------------------------------------
// Torso is a LatheGeometry with phiStart = -PI/2, so:
//   u = 0.25 -> chest (+Z)   u = 0.75 -> back (-Z)   u = 0 -> player's left side
//   v = 0    -> hem          v = 1    -> collar

export function shirtTexture(o = {}) {
  const kit = o.kit ?? 0xd8262c;
  const trim = o.trim ?? 0xffffff;
  const alt = o.alt ?? darken(kit, 0.42);
  const number = o.number ?? 9;
  const style = o.style ?? 'plain';
  const key = `shirt:${kit}:${trim}:${alt}:${number}:${style}`;

  return memo(key, () => {
    const W = 1024, H = 512;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = css(kit); g.fillRect(0, 0, W, H);

    if (style === 'stripes') {
      g.fillStyle = css(alt);
      for (let i = 0; i < 8; i++) g.fillRect((i * 2 + 0.55) * (W / 16), 0, W / 16, H);
    } else if (style === 'hoops') {
      g.fillStyle = css(alt);
      for (let i = 0; i < 4; i++) g.fillRect(0, H * (0.12 + i * 0.21), W, H * 0.10);
    } else if (style === 'sash') {
      g.save();
      g.fillStyle = css(trim);
      g.beginPath();
      g.moveTo(W * 0.05, H); g.lineTo(W * 0.42, 0); g.lineTo(W * 0.56, 0); g.lineTo(W * 0.19, H);
      g.closePath(); g.fill();
      g.restore();
    } else if (style === 'halves') {
      g.fillStyle = css(alt);
      g.fillRect(0, 0, W * 0.25, H); g.fillRect(W * 0.75, 0, W * 0.25, H);
    } else if (style === 'shoulders') {
      g.fillStyle = css(alt);
      g.fillRect(0, 0, W, H * 0.20);
    }

    // pinstripe accent for plain kits so they still have texture interest
    if (style === 'plain' || style === 'shoulders') {
      g.save(); g.globalAlpha = 0.10; g.fillStyle = css(darken(kit, 0.5));
      for (let x = 0; x < W; x += 22) g.fillRect(x, 0, 7, H);
      g.restore();
    }

    weaveOverlay(g, W, H, 0.050);
    roundShade(g, W, H, 0.25);

    // hem
    g.fillStyle = rgba(darken(kit, 0.45), 0.85); g.fillRect(0, H * 0.955, W, H * 0.045);
    g.fillStyle = rgba(trim, 0.9); g.fillRect(0, H * 0.940, W, H * 0.016);

    // collar band + V notch at the chest
    g.fillStyle = css(trim); g.fillRect(0, 0, W, H * 0.075);
    g.fillStyle = rgba(darken(trim, 0.35), 0.55); g.fillRect(0, H * 0.070, W, H * 0.014);
    const front = W * 0.25;
    g.fillStyle = css(darken(kit, 0.30));
    g.beginPath();
    g.moveTo(front - W * 0.055, H * 0.075);
    g.lineTo(front + W * 0.055, H * 0.075);
    g.lineTo(front, H * 0.185);
    g.closePath(); g.fill();
    g.strokeStyle = css(trim); g.lineWidth = H * 0.017; g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(front - W * 0.058, H * 0.072);
    g.lineTo(front, H * 0.190);
    g.lineTo(front + W * 0.058, H * 0.072);
    g.stroke();

    // shoulder yoke shadow so the lathe top does not read as a bald dome
    const yg = g.createLinearGradient(0, 0, 0, H * 0.26);
    yg.addColorStop(0, 'rgba(255,255,255,0.16)');
    yg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = yg; g.fillRect(0, 0, W, H * 0.26);

    // squad number — big on the back, medium on the chest
    const numFill = contrastOn(kit) === 0xffffff ? 0xffffff : 0x15181d;
    const numEdge = numFill === 0xffffff ? darken(kit, 0.55) : lighten(kit, 0.6);
    outlinedNumber(g, number, W * 0.75, H * 0.45, H * 0.40, numFill, numEdge);
    outlinedNumber(g, number, W * 0.25, H * 0.46, H * 0.235, numFill, numEdge);

    // crest on the wearer's right chest (slightly off the V)
    crest(g, W * 0.318, H * 0.20, 0.62, trim, kit);
    // maker mark on the other side
    g.save();
    g.globalAlpha = 0.85; g.fillStyle = css(trim);
    g.beginPath();
    g.moveTo(W * 0.186, H * 0.20); g.lineTo(W * 0.204, H * 0.175);
    g.lineTo(W * 0.216, H * 0.205); g.lineTo(W * 0.196, H * 0.222);
    g.closePath(); g.fill();
    g.restore();

    // back-of-shirt name strip
    g.save();
    g.globalAlpha = 0.9;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${H * 0.070}px "Trebuchet MS", sans-serif`;
    g.fillStyle = css(numFill);
    g.fillText(o.name ?? '', W * 0.75, H * 0.185);
    g.restore();

    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// SLEEVE / ARM
// ---------------------------------------------------------------------------
// The upper arm is one lathe: v = 1 at the shoulder, v = 0 at the elbow. The
// texture fades sleeve -> trim band -> bare skin so short sleeves need no extra
// mesh (and long sleeves are the same texture with the band pushed down).

export function armTexture(o = {}) {
  const kit = o.kit ?? 0xd8262c;
  const trim = o.trim ?? 0xffffff;
  const skin = o.skin ?? SKIN_TONES[2];
  const long = !!o.long;
  const key = `arm:${kit}:${trim}:${skin}:${long ? 1 : 0}`;

  return memo(key, () => {
    const W = 256, H = 256;
    const { c, g } = canvas2d(W, H);
    const cuff = long ? 0.10 : 0.44;

    g.fillStyle = css(skin); g.fillRect(0, 0, W, H);
    // subtle skin shading down the arm
    const skg = g.createLinearGradient(0, H * (1 - cuff), 0, H);
    skg.addColorStop(0, rgba(darken(skin, 0.20), 0.55));
    skg.addColorStop(0.4, 'rgba(0,0,0,0)');
    g.fillStyle = skg; g.fillRect(0, H * (1 - cuff), W, H * cuff);

    // sleeve
    g.fillStyle = css(kit); g.fillRect(0, 0, W, H * (1 - cuff));
    weaveOverlay(g, W, H * (1 - cuff), 0.09);
    // trim cuff
    g.fillStyle = css(trim);
    g.fillRect(0, H * (1 - cuff) - H * 0.055, W, H * 0.055);
    g.fillStyle = rgba(darken(kit, 0.5), 0.5);
    g.fillRect(0, H * (1 - cuff) - H * 0.068, W, H * 0.014);
    // shoulder trim stripe
    g.fillStyle = rgba(trim, 0.85);
    g.fillRect(0, H * 0.06, W, H * 0.035);

    roundShade(g, W, H, 0.25);
    return tex(c, { aniso: 8 });
  });
}

export function gloveTexture(o = {}) {
  const base = o.color ?? 0xf2f4f7;
  const accent = o.accent ?? 0xff3b30;
  return memo(`glove:${base}:${accent}`, () => {
    const W = 128, H = 128;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = css(base); g.fillRect(0, 0, W, H);
    g.fillStyle = css(accent); g.fillRect(0, H * 0.72, W, H * 0.14);
    g.fillStyle = rgba(darken(base, 0.5), 0.55);
    for (let i = 0; i < 4; i++) g.fillRect(W * (0.10 + i * 0.22), 0, W * 0.02, H * 0.66);
    weaveOverlay(g, W, H, 0.12);
    roundShade(g, W, H, 0.25);
    return tex(c, { aniso: 4 });
  });
}

// ---------------------------------------------------------------------------
// SHORTS  (lathe: u 0.25 front, 0.75 back; v 1 waist, v 0 hem)
// ---------------------------------------------------------------------------

export function shortsTexture(o = {}) {
  const base = o.color ?? 0xf2f2f2;
  const trim = o.trim ?? 0xd8262c;
  const number = o.number ?? 9;
  return memo(`shorts:${base}:${trim}:${number}`, () => {
    const W = 768, H = 384;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = css(base); g.fillRect(0, 0, W, H);
    weaveOverlay(g, W, H, 0.085);

    // side stripes at the hips (u = 0 and u = 0.5)
    g.fillStyle = rgba(trim, 0.92);
    for (const u of [0.0, 0.5, 1.0]) {
      g.fillRect(W * u - W * 0.018, H * 0.10, W * 0.036, H * 0.78);
    }
    g.fillStyle = rgba(darken(trim, 0.4), 0.35);
    for (const u of [0.0, 0.5, 1.0]) {
      g.fillRect(W * u + W * 0.018, H * 0.10, W * 0.008, H * 0.78);
    }

    // waistband
    g.fillStyle = css(darken(base, 0.18)); g.fillRect(0, 0, W, H * 0.13);
    g.fillStyle = css(trim); g.fillRect(0, H * 0.105, W, H * 0.030);
    // drawstring at the front
    g.strokeStyle = rgba(trim, 0.9); g.lineWidth = H * 0.016; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(W * 0.235, H * 0.045); g.lineTo(W * 0.25, H * 0.10); g.lineTo(W * 0.265, H * 0.045);
    g.stroke();
    // hem
    g.fillStyle = rgba(darken(base, 0.32), 0.7); g.fillRect(0, H * 0.93, W, H * 0.07);

    // number on the wearer's right-front thigh
    const nf = contrastOn(base) === 0xffffff ? 0xffffff : 0x15181d;
    outlinedNumber(g, number, W * 0.36, H * 0.50, H * 0.25, nf, darken(trim, 0.2));

    roundShade(g, W, H, 0.25);
    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// SOCKS  (shin lathe: v 1 knee, v 0 ankle)
// ---------------------------------------------------------------------------

export function sockTexture(o = {}) {
  const base = o.color ?? 0xd8262c;
  const trim = o.trim ?? 0xffffff;
  return memo(`sock:${base}:${trim}`, () => {
    const W = 256, H = 256;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = css(base); g.fillRect(0, 0, W, H);

    // turnover band at the knee
    g.fillStyle = css(trim); g.fillRect(0, 0, W, H * 0.20);
    g.fillStyle = rgba(darken(base, 0.35), 0.55); g.fillRect(0, H * 0.20, W, H * 0.035);
    g.fillStyle = rgba(trim, 0.75); g.fillRect(0, H * 0.30, W, H * 0.05);

    // rib knit
    g.save(); g.globalAlpha = 0.16;
    for (let x = 0; x < W; x += 7) {
      g.fillStyle = '#000000'; g.fillRect(x, 0, 3, H);
      g.fillStyle = '#ffffff'; g.fillRect(x + 3, 0, 2, H);
    }
    g.restore();
    weaveOverlay(g, W, H, 0.07);

    // ankle shading
    const ag = g.createLinearGradient(0, H * 0.80, 0, H);
    ag.addColorStop(0, 'rgba(0,0,0,0)');
    ag.addColorStop(1, rgba(darken(base, 0.5), 0.7));
    g.fillStyle = ag; g.fillRect(0, H * 0.80, W, H * 0.2);

    roundShade(g, W, H, 0.25);
    return tex(c, { aniso: 8 });
  });
}

export function skinMaterialColor(skin) { return skin; }
