// Procedural sprite sheets for the VFX layer.
//
// Everything here is drawn with canvas 2D at boot and memoised. No binary assets.
// The shapes are traced off the Mini Football reference:
//
//   * `impactStar`  — the four-point white/pink star-burst that pops on a tackle
//                     or a struck ball. Long needle spikes, a hot white core and
//                     a magenta fringe that only shows on the outer third.
//   * `swooshStrip` — the tapered pink-white streak that trails a struck ball.
//                     Drawn once as a horizontal strip so a single stretched quad
//                     can represent the whole trail.
//   * `softGlow`    — cheap additive bloom seed under flashes and floodlight pops.
//   * `puff`        — soft turf-dust blob with a bitten, non-circular silhouette.
//   * `blade`       — a torn grass fleck for scuff sprays.
//   * `confettiChip`— a small rounded rectangle with a highlight, so falling
//                     confetti reads as paper rather than as dots.
//   * `selectRing`  — the green ground ellipse under the controlled player.
//   * `slideMark`   — the scraped ground decal a slide tackle leaves behind.
//   * `smokePuff`   — coarse, dark-edged smoke for the goal pyro.
//
// All sprites are premultiplied-safe RGBA on a transparent background and are
// used with either additive (energy) or normal (matter) blending.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

const cache = new Map();
function memo(key, build) {
  let v = cache.get(key);
  if (!v) { v = build(); cache.set(key, v); }
  return v;
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}

function tex(c, { srgb = true, mips = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// impact star
// ---------------------------------------------------------------------------

/**
 * Four long needles + four short ones, a white core and a magenta rim.
 * `hue` 0 = pure white/pink (tackle), 1 = warmer gold (goal blast).
 */
export function impactStar(variant = 'pink') {
  return memo('star:' + variant, () => {
    const S = 512, h = S / 2;
    const c = canvas(S);
    const g = c.getContext('2d');
    const fringe = variant === 'gold' ? '255,190,86' : '255,72,190';
    const mid = variant === 'gold' ? '255,228,160' : '255,166,228';

    // --- soft core glow ---------------------------------------------------
    const core = g.createRadialGradient(h, h, 0, h, h, h * 0.26);
    core.addColorStop(0.00, 'rgba(255,255,255,1)');
    core.addColorStop(0.20, 'rgba(255,255,255,0.85)');
    core.addColorStop(0.44, `rgba(${mid},0.50)`);
    core.addColorStop(0.76, `rgba(${fringe},0.20)`);
    core.addColorStop(1.00, `rgba(${fringe},0)`);
    g.fillStyle = core;
    g.fillRect(0, 0, S, S);

    // --- needles ----------------------------------------------------------
    // Each spike is two mirrored quadratics meeting at the tip, so the silhouette
    // is concave (thin waist, sharp point) exactly like the reference burst.
    function spike(angle, len, wide, alpha) {
      g.save();
      g.translate(h, h);
      g.rotate(angle);
      const grad = g.createLinearGradient(0, 0, len, 0);
      grad.addColorStop(0.00, `rgba(255,255,255,${alpha})`);
      grad.addColorStop(0.13, `rgba(255,255,255,${alpha * 0.92})`);
      grad.addColorStop(0.40, `rgba(${mid},${alpha * 0.72})`);
      grad.addColorStop(0.74, `rgba(${fringe},${alpha * 0.40})`);
      grad.addColorStop(1.00, `rgba(${fringe},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, -wide);
      g.quadraticCurveTo(len * 0.42, -wide * 0.16, len, 0);
      g.quadraticCurveTo(len * 0.42, wide * 0.16, 0, wide);
      g.closePath();
      g.fill();
      g.restore();
    }

    const R = h * 0.98;
    for (let i = 0; i < 4; i++) spike(i * Math.PI / 2, R, h * 0.098, 1.0);
    for (let i = 0; i < 4; i++) spike(Math.PI / 4 + i * Math.PI / 2, R * 0.46, h * 0.052, 0.7);
    // eight hairline glints between the majors keeps it from looking like a plus sign
    for (let i = 0; i < 8; i++) spike(Math.PI / 8 + i * Math.PI / 4, R * 0.26, h * 0.018, 0.45);

    // --- hot centre on top -------------------------------------------------
    const hot = g.createRadialGradient(h, h, 0, h, h, h * 0.13);
    hot.addColorStop(0, 'rgba(255,255,255,1)');
    hot.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    hot.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hot;
    g.fillRect(0, 0, S, S);

    return tex(c);
  });
}

// ---------------------------------------------------------------------------
// swoosh streak (drawn as a horizontal strip: u=0 tail, u=1 head)
// ---------------------------------------------------------------------------

export function swooshStrip() {
  return memo('swoosh', () => {
    const W = 512, H = 128;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const cy = H / 2;

    // body: tapers from a point at the tail to full thickness at the head
    g.beginPath();
    g.moveTo(0, cy);
    for (let i = 0; i <= 64; i++) {
      const u = i / 64;
      const t = Math.pow(u, 0.72) * (H * 0.34);
      g.lineTo(u * W, cy - t);
    }
    for (let i = 64; i >= 0; i--) {
      const u = i / 64;
      const t = Math.pow(u, 0.72) * (H * 0.34);
      g.lineTo(u * W, cy + t);
    }
    g.closePath();
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0.00, 'rgba(255,110,190,0)');
    grad.addColorStop(0.18, 'rgba(255,124,196,0.30)');
    grad.addColorStop(0.62, 'rgba(255,140,206,0.80)');
    grad.addColorStop(0.90, 'rgba(255,190,228,0.98)');
    grad.addColorStop(1.00, 'rgba(255,240,250,0.62)');
    g.fillStyle = grad;
    g.fill();

    // hot spine
    g.globalCompositeOperation = 'lighter';
    const spine = g.createLinearGradient(0, 0, W, 0);
    spine.addColorStop(0.0, 'rgba(255,255,255,0)');
    spine.addColorStop(0.72, 'rgba(255,236,250,0.40)');
    spine.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = spine;
    g.fillRect(0, cy - H * 0.055, W, H * 0.11);

    // soften the vertical edge so the strip has no hard cut
    const soft = g.createLinearGradient(0, 0, 0, H);
    soft.addColorStop(0, 'rgba(0,0,0,0)');
    soft.addColorStop(0.5, 'rgba(0,0,0,0)');
    soft.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = soft;
    g.fillRect(0, 0, W, H);

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  });
}

// ---------------------------------------------------------------------------
// soft glow
// ---------------------------------------------------------------------------

export function softGlow() {
  return memo('glow', () => {
    const S = 256, h = S / 2;
    const c = canvas(S);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0.00, 'rgba(255,255,255,1)');
    grad.addColorStop(0.16, 'rgba(255,255,255,0.62)');
    grad.addColorStop(0.42, 'rgba(255,255,255,0.20)');
    grad.addColorStop(0.72, 'rgba(255,255,255,0.05)');
    grad.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    return tex(c, { mips: false });
  });
}

// ---------------------------------------------------------------------------
// particle atlas — 2x2: [puff, blade, chip, spark]
// ---------------------------------------------------------------------------

export const ATLAS_COLS = 2;
export const ATLAS_ROWS = 2;
export const SPRITE = { PUFF: 0, BLADE: 1, CHIP: 2, SPARK: 3 };

export function particleAtlas() {
  return memo('atlas', () => {
    const T = 128;                 // one tile
    const S = T * 2;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rng = makeRng(0x51de);

    // ---- tile 0: dust puff ------------------------------------------------
    g.save();
    g.translate(0, 0);
    for (let i = 0; i < 7; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = rng.range(0, T * 0.14);
      const x = T / 2 + Math.cos(a) * r;
      const y = T / 2 + Math.sin(a) * r;
      const rad = rng.range(T * 0.20, T * 0.34);
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0.0, 'rgba(255,255,255,0.34)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.15)');
      grad.addColorStop(1.0, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    g.restore();

    // ---- tile 1: grass blade fleck ---------------------------------------
    g.save();
    g.translate(T, 0);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(T * 0.5, T * 0.10);
    g.quadraticCurveTo(T * 0.72, T * 0.42, T * 0.58, T * 0.90);
    g.quadraticCurveTo(T * 0.50, T * 0.72, T * 0.42, T * 0.90);
    g.quadraticCurveTo(T * 0.30, T * 0.44, T * 0.5, T * 0.10);
    g.closePath();
    g.fill();
    g.restore();

    // ---- tile 2: confetti chip -------------------------------------------
    g.save();
    g.translate(0, T);
    const w = T * 0.34, hgt = T * 0.56;
    g.translate(T / 2, T / 2);
    g.rotate(0.4);
    g.fillStyle = '#ffffff';
    g.beginPath();
    const r = T * 0.06;
    g.moveTo(-w / 2 + r, -hgt / 2);
    g.arcTo(w / 2, -hgt / 2, w / 2, hgt / 2, r);
    g.arcTo(w / 2, hgt / 2, -w / 2, hgt / 2, r);
    g.arcTo(-w / 2, hgt / 2, -w / 2, -hgt / 2, r);
    g.arcTo(-w / 2, -hgt / 2, w / 2, -hgt / 2, r);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(-w / 2, -hgt / 2, w * 0.34, hgt);
    g.restore();

    // ---- tile 3: spark ----------------------------------------------------
    g.save();
    g.translate(T, T);
    const gx = T / 2, gy = T / 2;
    const sp = g.createRadialGradient(gx, gy, 0, gx, gy, T * 0.42);
    sp.addColorStop(0.0, 'rgba(255,255,255,1)');
    sp.addColorStop(0.28, 'rgba(255,255,255,0.55)');
    sp.addColorStop(0.65, 'rgba(255,255,255,0.10)');
    sp.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = sp;
    g.fillRect(0, 0, T, T);
    // two short crossed glints
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(gx - T * 0.40, gy - T * 0.018, T * 0.80, T * 0.036);
    g.fillRect(gx - T * 0.018, gy - T * 0.40, T * 0.036, T * 0.80);
    g.restore();

    const t = tex(c, { mips: true });
    // gl_PointCoord has its origin top-left; keeping the upload unflipped means
    // the tile lookup in the point shader needs no vertical correction.
    t.flipY = false;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  });
}

// ---------------------------------------------------------------------------
// ground sprites
// ---------------------------------------------------------------------------

export function selectRingTexture() {
  return memo('selring', () => {
    const S = 256, h = S / 2;
    const c = canvas(S);
    const g = c.getContext('2d');

    // outer soft halo
    const halo = g.createRadialGradient(h, h, h * 0.55, h, h, h * 0.99);
    halo.addColorStop(0.0, 'rgba(120,255,150,0)');
    halo.addColorStop(0.55, 'rgba(120,255,150,0.30)');
    halo.addColorStop(1.0, 'rgba(120,255,150,0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(h, h, h, 0, Math.PI * 2); g.fill();

    // crisp band
    g.lineWidth = S * 0.075;
    g.strokeStyle = 'rgba(150,255,170,0.95)';
    g.beginPath(); g.arc(h, h, h * 0.76, 0, Math.PI * 2); g.stroke();
    g.lineWidth = S * 0.032;
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.arc(h, h, h * 0.76, 0, Math.PI * 2); g.stroke();

    // faint inner wash so the player sits in a pool of light
    const inner = g.createRadialGradient(h, h, 0, h, h, h * 0.72);
    inner.addColorStop(0.0, 'rgba(110,255,150,0.16)');
    inner.addColorStop(0.75, 'rgba(110,255,150,0.06)');
    inner.addColorStop(1.0, 'rgba(110,255,150,0)');
    g.fillStyle = inner;
    g.beginPath(); g.arc(h, h, h * 0.72, 0, Math.PI * 2); g.fill();

    return tex(c);
  });
}

export function slideMarkTexture() {
  return memo('slidemark', () => {
    const W = 256, H = 128;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const rng = makeRng(0x5111);
    // two gouges with torn edges and scattered divots
    for (let s = 0; s < 2; s++) {
      const cy = H * (0.36 + s * 0.28);
      g.beginPath();
      g.moveTo(W * 0.03, cy);
      for (let i = 0; i <= 40; i++) {
        const u = i / 40;
        const t = Math.sin(Math.PI * u) * H * (0.10 + 0.05 * s) * rng.range(0.7, 1.15);
        g.lineTo(W * (0.03 + u * 0.94), cy - t);
      }
      for (let i = 40; i >= 0; i--) {
        const u = i / 40;
        const t = Math.sin(Math.PI * u) * H * (0.10 + 0.05 * s) * rng.range(0.7, 1.15);
        g.lineTo(W * (0.03 + u * 0.94), cy + t);
      }
      g.closePath();
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0.0, 'rgba(74,54,32,0)');
      grad.addColorStop(0.25, 'rgba(74,54,32,0.72)');
      grad.addColorStop(0.75, 'rgba(88,66,40,0.62)');
      grad.addColorStop(1.0, 'rgba(88,66,40,0)');
      g.fillStyle = grad;
      g.fill();
    }
    for (let i = 0; i < 60; i++) {
      const x = rng.range(W * 0.06, W * 0.94);
      const y = rng.range(H * 0.18, H * 0.82);
      const r = rng.range(1.2, 4.2);
      g.fillStyle = `rgba(60,44,26,${rng.range(0.10, 0.42)})`;
      g.beginPath(); g.ellipse(x, y, r * 1.6, r, rng.float() * 3, 0, Math.PI * 2); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  });
}

export function smokeTexture() {
  return memo('smoke', () => {
    const S = 256, h = S / 2;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rng = makeRng(0x5309);
    for (let i = 0; i < 14; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = rng.range(0, h * 0.30);
      const x = h + Math.cos(a) * r, y = h + Math.sin(a) * r;
      const rad = rng.range(h * 0.22, h * 0.44);
      const grad = g.createRadialGradient(x, y, rad * 0.1, x, y, rad);
      const v = rng.range(0.16, 0.30);
      grad.addColorStop(0.0, `rgba(255,255,255,${v})`);
      grad.addColorStop(0.6, `rgba(255,255,255,${v * 0.4})`);
      grad.addColorStop(1.0, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    // fade the frame so no square edge survives
    const mask = g.createRadialGradient(h, h, h * 0.55, h, h, h);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = mask;
    g.fillRect(0, 0, S, S);
    return tex(c, { mips: false });
  });
}

export function scuffDecalTexture() {
  return memo('scuffdecal', () => {
    const S = 128, h = S / 2;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rng = makeRng(0x77aa);
    for (let i = 0; i < 26; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = rng.range(0, h * 0.7);
      const x = h + Math.cos(a) * r, y = h + Math.sin(a) * r;
      g.fillStyle = `rgba(72,52,30,${rng.range(0.12, 0.4) * (1 - r / h)})`;
      g.beginPath();
      g.ellipse(x, y, rng.range(3, 11), rng.range(2, 6), rng.float() * 3, 0, Math.PI * 2);
      g.fill();
    }
    return tex(c, { mips: false });
  });
}
