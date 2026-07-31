// Procedural asset factory. Everything the game draws with is baked here at runtime
// from canvas 2D — the repo contains no binary assets.
//
// Every exported function is memoised: calling it twice returns the identical
// THREE.Texture instance, so materials share GPU resources.

import * as THREE from 'three';
import { makeRng } from './rng.js';

// Texture bakes use their own streams so they never perturb gameplay randomness.
const trng = makeRng(0x51ed);

const cache = new Map();
function memo(key, make) {
  if (cache.has(key)) return cache.get(key);
  const v = make();
  cache.set(key, v);
  return v;
}

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  return { c, g };
}

function tex(c, { repeat = 1, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (repeat !== 1) t.repeat.set(repeat, repeat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

// ---------------------------------------------------------------------------
// tileable value noise
// ---------------------------------------------------------------------------

function lattice(size, seed) {
  const r = makeRng(seed);
  const a = new Float32Array(size * size);
  for (let i = 0; i < a.length; i++) a[i] = r.float();
  return a;
}

function smooth(t) { return t * t * (3 - 2 * t); }

function noise2(a, size, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const i0 = ((xi % size) + size) % size, j0 = ((yi % size) + size) % size;
  const i1 = (i0 + 1) % size, j1 = (j0 + 1) % size;
  const v00 = a[j0 * size + i0], v10 = a[j0 * size + i1];
  const v01 = a[j1 * size + i0], v11 = a[j1 * size + i1];
  return (v00 * (1 - xf) + v10 * xf) * (1 - yf) + (v01 * (1 - xf) + v11 * xf) * yf;
}

/** tileable fbm sampled in [0,1) UV space */
function fbm(uv_x, uv_y, octaves, base, seedTables) {
  let sum = 0, amp = 1, norm = 0, freq = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(seedTables[o], freq, uv_x * freq, uv_y * freq);
    norm += amp;
    amp *= 0.52;
    freq *= 2;
  }
  return sum / norm;
}

function tables(count, seed, base) {
  const out = [];
  let f = base;
  for (let i = 0; i < count; i++) { out.push(lattice(f, seed + i * 7919)); f *= 2; }
  return out;
}

// ---------------------------------------------------------------------------
// normal map from a height field
// ---------------------------------------------------------------------------

function normalFromHeight(height, size, strength) {
  const { c, g } = canvas2d(size, size);
  const img = g.createImageData(size, size);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// TURF — albedo + normal + roughness. Tileable over a 2.5 unit square.
// Mow stripes are NOT baked here; world/pitch.js builds them as separate
// alternating stripe meshes so the banding stays crisp at any camera distance.
// ---------------------------------------------------------------------------

export function turfTextures(opts = {}) {
  const size = opts.size || 512;
  return memo('turf:' + size, () => {
    const T = tables(4, 1201, 8);
    const Tf = tables(3, 4402, 32);
    const height = new Float32Array(size * size);
    const { c, g } = canvas2d(size, size);
    const img = g.createImageData(size, size);
    const { c: rc, g: rg } = canvas2d(size, size);
    const rimg = rg.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        const broad = fbm(u, v, 4, 8, T);          // clumping
        const fine = fbm(u, v, 3, 32, Tf);         // grain
        // blade streaks: high-frequency along +Z with slight wander
        const blade = Math.sin((v * size * 0.85) + broad * 9.0) * 0.5 + 0.5;
        const blade2 = Math.sin((v * size * 2.4) + fine * 14.0) * 0.5 + 0.5;
        const h = clamp01(broad * 0.32 + fine * 0.24 + blade * 0.24 + blade2 * 0.20);
        height[y * size + x] = h;

        // keep albedo variation tight — the mow stripes do the heavy lifting
        const shade = 0.90 + h * 0.20;
        const r = clamp01(0.470 * shade) * 255;
        const gr = clamp01(0.800 * shade) * 255;
        const b = clamp01(0.330 * shade) * 255;

        const i = (y * size + x) * 4;
        img.data[i] = r; img.data[i + 1] = gr; img.data[i + 2] = b; img.data[i + 3] = 255;

        const rough = clamp01(0.80 + (1 - h) * 0.16) * 255;
        rimg.data[i] = rough; rimg.data[i + 1] = rough; rimg.data[i + 2] = rough; rimg.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    rg.putImageData(rimg, 0, 0);

    const map = tex(c, { srgb: true, aniso: 16 });
    const normalMap = tex(normalFromHeight(height, size, 2.6), { srgb: false, aniso: 8 });
    const roughnessMap = tex(rc, { srgb: false, aniso: 4 });
    return { map, normalMap, roughnessMap };
  });
}

/** Broad, low-frequency wear/scuff overlay for the whole pitch (alpha only). */
export function wearTexture() {
  return memo('wear', () => {
    const S = 512;
    const { c, g } = canvas2d(S, S);
    g.clearRect(0, 0, S, S);
    const T = tables(4, 777, 4);
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = fbm(x / S, y / S, 4, 4, T);
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
        img.data[i + 3] = clamp01((n - 0.55) * 1.1) * 46;
      }
    }
    g.putImageData(img, 0, 0);
    // goalmouth + centre-circle wear
    g.globalCompositeOperation = 'source-over';
    const worn = (cx, cy, rx, ry, a) => {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
      gr.addColorStop(0, `rgba(120,96,58,${a})`);
      gr.addColorStop(0.6, `rgba(120,96,58,${a * 0.35})`);
      gr.addColorStop(1, 'rgba(120,96,58,0)');
      g.save(); g.translate(cx, cy); g.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
      g.translate(-cx, -cy); g.fillStyle = gr; g.fillRect(0, 0, S, S); g.restore();
    };
    worn(18, S / 2, 40, 70, 0.22);
    worn(S - 18, S / 2, 40, 70, 0.22);
    worn(S / 2, S / 2, 58, 58, 0.09);
    return tex(c, { srgb: true, aniso: 2 });
  });
}

// ---------------------------------------------------------------------------
// AD BOARDS
// ---------------------------------------------------------------------------

export function boardTexture(text = 'CANVAS SOCCER') {
  return memo('board:' + text, () => {
    const W = 1024, H = 192;
    const { c, g } = canvas2d(W, H);
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1f7fe0');
    grad.addColorStop(0.45, '#0e5cc0');
    grad.addColorStop(0.55, '#0a4ea8');
    grad.addColorStop(1, '#083f8a');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);

    // diagonal sheen
    g.save();
    g.globalAlpha = 0.12; g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(-40, H); g.lineTo(W * 0.35, 0); g.lineTo(W * 0.52, 0); g.lineTo(W * 0.17, H);
    g.closePath(); g.fill(); g.restore();

    const shield = (cx, cy, s) => {
      g.save(); g.translate(cx, cy); g.scale(s, s);
      g.beginPath();
      g.moveTo(-26, -30); g.lineTo(26, -30); g.lineTo(26, 8);
      g.quadraticCurveTo(26, 30, 0, 40); g.quadraticCurveTo(-26, 30, -26, 8);
      g.closePath();
      g.fillStyle = '#ffffff'; g.fill();
      g.lineWidth = 5; g.strokeStyle = '#0a4ea8'; g.stroke();
      g.beginPath(); g.arc(0, -2, 12, 0, Math.PI * 2);
      g.fillStyle = '#0e5cc0'; g.fill();
      g.beginPath(); g.arc(0, -2, 5.5, 0, Math.PI * 2);
      g.fillStyle = '#ffffff'; g.fill();
      g.restore();
    };

    const words = text.split(' ');
    const drawWord = (cx) => {
      g.save();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#ffffff';
      g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 6; g.shadowOffsetY = 3;
      if (words.length > 1) {
        g.font = 'italic 900 52px "Trebuchet MS", sans-serif';
        g.fillText(words[0], cx, H * 0.33);
        g.fillText(words.slice(1).join(' '), cx, H * 0.7);
      } else {
        g.font = 'italic 900 74px "Trebuchet MS", sans-serif';
        g.fillText(words[0], cx, H * 0.5);
      }
      g.restore();
    };

    drawWord(W * 0.25);
    shield(W * 0.55, H * 0.5, 1.25);
    drawWord(W * 0.82);

    // top/bottom rails
    g.fillStyle = 'rgba(255,255,255,0.28)'; g.fillRect(0, 0, W, 6);
    g.fillStyle = 'rgba(0,0,0,0.30)'; g.fillRect(0, H - 8, W, 8);

    const t = tex(c);
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

// ---------------------------------------------------------------------------
// CROWD — sprite sheet of chibi spectators, used for far tiers.
// ---------------------------------------------------------------------------

export function crowdSpriteSheet() {
  return memo('crowd', () => {
    const cols = 8, rows = 4, cell = 96;
    const { c, g } = canvas2d(cols * cell, rows * cell);
    g.clearRect(0, 0, c.width, c.height);
    const skins = ['#f2c9a0', '#e0a878', '#c07f4e', '#8d5525', '#5f3517', '#ffdcb8'];
    const shirts = ['#d8262c', '#2450c8', '#ffffff', '#f5d020', '#22a05a', '#eb6d1f',
      '#7c3ec9', '#111827', '#28b8c8', '#f06fa0'];
    const hairs = ['#1b1109', '#3d2314', '#7a4a1e', '#c8a35a', '#0d0d0d', '#8a8a8a'];
    for (let ry = 0; ry < rows; ry++) {
      for (let cx0 = 0; cx0 < cols; cx0++) {
        const ox = cx0 * cell, oy = ry * cell;
        g.save(); g.translate(ox + cell / 2, oy + cell);
        const skin = trng.pick(skins), shirt = trng.pick(shirts), hair = trng.pick(hairs);
        // torso
        g.fillStyle = shirt;
        g.beginPath();
        g.moveTo(-24, -2); g.lineTo(-20, -38); g.lineTo(20, -38); g.lineTo(24, -2);
        g.closePath(); g.fill();
        // arms
        g.fillStyle = shirt;
        g.fillRect(-32, -36, 10, 26); g.fillRect(22, -36, 10, 26);
        g.fillStyle = skin;
        g.fillRect(-32, -14, 10, 12); g.fillRect(22, -14, 10, 12);
        // head
        g.fillStyle = skin;
        g.beginPath(); g.arc(0, -54, 19, 0, Math.PI * 2); g.fill();
        // hair
        g.fillStyle = hair;
        g.beginPath(); g.arc(0, -57, 19, Math.PI * 1.06, Math.PI * 1.94); g.fill();
        g.fillRect(-19, -60, 38, 6);
        // face dots
        g.fillStyle = 'rgba(30,20,14,0.75)';
        g.beginPath(); g.arc(-6.5, -52, 2.4, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(6.5, -52, 2.4, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return { texture: t, cols, rows };
  });
}

/** A dense, tileable crowd wall used for the deep tiers (cheap, one draw). */
export function crowdWallTexture() {
  return memo('crowdwall', () => {
    const W = 512, H = 256;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = '#141a24'; g.fillRect(0, 0, W, H);
    const skins = ['#f2c9a0', '#e0a878', '#c07f4e', '#8d5525', '#5f3517'];
    const shirts = ['#d8262c', '#2450c8', '#ffffff', '#f5d020', '#22a05a', '#eb6d1f',
      '#7c3ec9', '#1b2a4a', '#28b8c8', '#e8e8e8', '#b21f2a', '#17357f'];
    const rows = 11;
    for (let r = rows - 1; r >= 0; r--) {
      const y = H - 6 - r * (H / (rows + 1)) * 0.92;
      const s = 0.55 + r * 0.045;
      const per = 26;
      const dark = 1 - r * 0.028;
      for (let i = -1; i <= per; i++) {
        const x = (i + (r % 2) * 0.5) * (W / per) + trng.range(-3, 3);
        g.save(); g.translate(x, y); g.scale(s, s);
        const sk = trng.pick(skins), sh = trng.pick(shirts);
        g.globalAlpha = 1;
        g.fillStyle = shadeHex(sh, dark);
        g.beginPath(); g.moveTo(-11, 0); g.lineTo(-9, -19); g.lineTo(9, -19); g.lineTo(11, 0);
        g.closePath(); g.fill();
        g.fillStyle = shadeHex(sk, dark);
        g.beginPath(); g.arc(0, -27, 9, 0, Math.PI * 2); g.fill();
        g.fillStyle = shadeHex('#20140c', dark);
        g.beginPath(); g.arc(0, -29, 9, Math.PI * 1.05, Math.PI * 1.95); g.fill();
        g.restore();
      }
      // step shadow
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(0, y, W, 2);
    }
    return tex(c, { aniso: 8 });
  });
}

function shadeHex(h, k) {
  const n = parseInt(h.slice(1), 16);
  const r = Math.round(Math.min(255, ((n >> 16) & 255) * k));
  const g = Math.round(Math.min(255, ((n >> 8) & 255) * k));
  const b = Math.round(Math.min(255, (n & 255) * k));
  return `rgb(${r},${g},${b})`;
}

// ---------------------------------------------------------------------------
// BALL
// ---------------------------------------------------------------------------

export function ballTexture(style = 'classic') {
  return memo('ball:' + style, () => {
    const W = 1024, H = 512;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = '#f6f7f9'; g.fillRect(0, 0, W, H);

    // subtle panel seams / dirt
    g.strokeStyle = 'rgba(150,158,170,0.55)'; g.lineWidth = 3;

    const dark = style === 'match' ? '#123a86' : '#16181d';
    const accent = style === 'match' ? '#f5d020' : '#16181d';

    const hexAt = (cx, cy, r, rot, fill) => {
      g.save(); g.translate(cx, cy); g.rotate(rot);
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.92;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.fillStyle = fill; g.fill();
      g.lineWidth = 4; g.strokeStyle = 'rgba(20,22,28,0.35)'; g.stroke();
      g.restore();
    };

    // pentagon band — 5 around the equator, 1 near each pole
    for (let i = 0; i < 5; i++) {
      hexAt((i + 0.5) * (W / 5), H * 0.34, 62, 0, dark);
      hexAt((i + 1.0) * (W / 5), H * 0.68, 62, Math.PI, i % 2 ? accent : dark);
    }
    hexAt(W * 0.5, H * 0.045, 52, 0, dark);
    hexAt(W * 0.5, H * 0.955, 52, Math.PI, dark);

    // seam lines
    g.globalAlpha = 0.25; g.strokeStyle = '#8b93a3'; g.lineWidth = 5;
    for (let i = 0; i <= 5; i++) {
      g.beginPath();
      g.moveTo(i * (W / 5), 0); g.lineTo(i * (W / 5) - 40, H); g.stroke();
    }
    g.globalAlpha = 1;

    // grime
    const T = tables(3, 313, 16);
    g.globalAlpha = 0.10;
    for (let y = 0; y < H; y += 4) {
      for (let x = 0; x < W; x += 4) {
        const n = fbm(x / W, y / H, 3, 16, T);
        if (n > 0.62) { g.fillStyle = '#7d848f'; g.fillRect(x, y, 4, 4); }
      }
    }
    g.globalAlpha = 1;
    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// FACES / KITS / HAIR — chibi character surfacing
// ---------------------------------------------------------------------------

export const SKIN_TONES = [0xffd9b3, 0xf2c39a, 0xe0a878, 0xc98a52, 0xa66b39, 0x7a4a26, 0x53301a];
export const HAIR_COLORS = [0x181008, 0x2e1a0c, 0x4a2a12, 0x7b4a1c, 0xc9a45c, 0x0f0f10, 0x8e8e92, 0xa63c1c];
export const HAIR_STYLES = ['buzz', 'bun', 'afro', 'curls', 'bald', 'swoop', 'mohawk'];

/**
 * Head texture: mapped onto a SphereGeometry. The face sits at u = 0.25 (the +Z
 * side of the sphere). A solid patch at v > 0.93 is reserved for hair geometry UVs
 * so head + hair can share one mesh via vertex colours.
 */
export function faceTexture(skin = SKIN_TONES[1], variant = 0) {
  return memo(`face:${skin}:${variant}`, () => {
    const S = 512;
    const { c, g } = canvas2d(S, S);
    const base = hex(skin);
    g.fillStyle = base; g.fillRect(0, 0, S, S);

    // reserved solid-white strip at the top (v > 0.93) for hair/other geometry
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S * 0.06);

    // gentle ambient occlusion under the jaw
    const ao = g.createLinearGradient(0, S * 0.78, 0, S);
    ao.addColorStop(0, 'rgba(90,50,25,0)');
    ao.addColorStop(1, 'rgba(90,50,25,0.35)');
    g.fillStyle = ao; g.fillRect(0, S * 0.78, S, S * 0.22);

    // NOTE canvas y=0 is v=1 (top of sphere).
    const U = (u) => u * S;
    const V = (v) => (1 - v) * S;

    // The hairline sits at v ~ 0.60 (see entities/player.js buildHair), so every
    // facial feature has to live below that.
    const cx = U(0.25);
    const eyeY = V(0.515);
    const eyeDx = S * 0.034;
    const browCol = shadeHex(hex(skin), 0.30);

    // blush
    g.globalAlpha = 0.18; g.fillStyle = '#e2705f';
    g.beginPath(); g.ellipse(cx - eyeDx * 2.0, eyeY + 26, 17, 10, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(cx + eyeDx * 2.0, eyeY + 26, 17, 10, 0, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;

    const eye = (dx) => {
      g.save(); g.translate(cx + dx, eyeY);
      g.fillStyle = '#ffffff';
      g.beginPath(); g.ellipse(0, 0, 15.5, 17.5, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = variant % 3 === 0 ? '#3b5c2a' : variant % 3 === 1 ? '#4a2d16' : '#2b4a72';
      g.beginPath(); g.arc(0, 2.0, 9.6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0d0d11';
      g.beginPath(); g.arc(0, 2.0, 5.4, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(-3.4, -3.2, 3.0, 0, Math.PI * 2); g.fill();
      // lash / eyelid line
      g.strokeStyle = 'rgba(22,15,9,0.92)'; g.lineWidth = 3.6; g.lineCap = 'round';
      g.beginPath(); g.arc(0, 0.5, 16, Math.PI * 1.03, Math.PI * 1.97); g.stroke();
      g.restore();
    };
    eye(-eyeDx * 1.30);
    eye(eyeDx * 1.30);

    // brows
    g.strokeStyle = browCol; g.lineWidth = 8; g.lineCap = 'round';
    const brow = (dx, tilt) => {
      g.save(); g.translate(cx + dx, eyeY - 30); g.rotate(tilt);
      g.beginPath(); g.moveTo(-16, 3); g.quadraticCurveTo(0, -6, 16, 1); g.stroke();
      g.restore();
    };
    brow(-eyeDx * 1.30, variant % 2 ? 0.12 : 0.04);
    brow(eyeDx * 1.30, variant % 2 ? -0.12 : -0.04);

    // nose shadow (the geometric bump sits just under the eye line)
    g.strokeStyle = shadeHex(base, 0.70); g.lineWidth = 5.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx + 1, eyeY + 16); g.quadraticCurveTo(cx + 6, eyeY + 30, cx - 2, eyeY + 33); g.stroke();

    // mouth
    g.strokeStyle = '#8a3a34'; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath();
    if (variant % 4 === 0) { g.moveTo(cx - 17, eyeY + 52); g.quadraticCurveTo(cx, eyeY + 68, cx + 17, eyeY + 52); }
    else { g.moveTo(cx - 14, eyeY + 56); g.quadraticCurveTo(cx, eyeY + 63, cx + 14, eyeY + 56); }
    g.stroke();

    // ears (silhouette hint at u = 0 and u = 0.5)
    g.fillStyle = shadeHex(base, 0.86);
    g.beginPath(); g.ellipse(U(0.0), eyeY + 8, 11, 22, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(U(0.5), eyeY + 8, 11, 22, 0, 0, Math.PI * 2); g.fill();

    return tex(c, { aniso: 8 });
  });
}

/**
 * Torso texture, mapped onto a CylinderGeometry: u = 0 is the chest (+Z),
 * u = 0.5 is the back (where the shirt number goes).
 */
export function kitTexture(kitHex, trimHex, number, style = 'plain') {
  return memo(`kit:${kitHex}:${trimHex}:${number}:${style}`, () => {
    const W = 768, H = 384;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = hex(kitHex); g.fillRect(0, 0, W, H);

    if (style === 'stripes') {
      g.fillStyle = shadeHex(hex(kitHex), 0.62);
      for (let i = 0; i < 12; i++) g.fillRect((i * 2 + 0.6) * (W / 24), 0, W / 24, H);
    } else if (style === 'sash') {
      g.save(); g.globalAlpha = 0.9; g.fillStyle = hex(trimHex);
      g.beginPath(); g.moveTo(0, H); g.lineTo(W * 0.35, 0); g.lineTo(W * 0.52, 0); g.lineTo(W * 0.17, H);
      g.closePath(); g.fill(); g.restore();
    } else if (style === 'hoops') {
      g.fillStyle = shadeHex(hex(kitHex), 0.6);
      for (let i = 0; i < 4; i++) g.fillRect(0, (i * 2 + 0.8) * (H / 8), W, H / 12);
    }

    // vertical shading so the cylinder reads round even in flat light
    const sh = g.createLinearGradient(0, 0, W, 0);
    sh.addColorStop(0.00, 'rgba(255,255,255,0.10)');
    sh.addColorStop(0.25, 'rgba(0,0,0,0.16)');
    sh.addColorStop(0.50, 'rgba(255,255,255,0.06)');
    sh.addColorStop(0.75, 'rgba(0,0,0,0.16)');
    sh.addColorStop(1.00, 'rgba(255,255,255,0.10)');
    g.fillStyle = sh; g.fillRect(0, 0, W, H);

    // collar (top of cylinder = v 1 = canvas y 0)
    g.fillStyle = hex(trimHex); g.fillRect(0, 0, W, H * 0.075);
    // hem
    g.fillStyle = shadeHex(hex(kitHex), 0.55); g.fillRect(0, H * 0.94, W, H * 0.06);

    // number on the back (u = 0.5)
    const n = String(number);
    g.save();
    g.translate(W * 0.5, H * 0.46);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '900 190px "Trebuchet MS", Impact, sans-serif';
    g.lineWidth = 14; g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.strokeText(n, 0, 0);
    g.fillStyle = hex(trimHex) === '#ffffff' ? '#ffffff' : '#ffffff';
    g.fillText(n, 0, 0);
    g.restore();

    // small crest on the chest (u = 0)
    const crest = (cx) => {
      g.save(); g.translate(cx, H * 0.30); g.scale(0.5, 0.5);
      g.beginPath();
      g.moveTo(-26, -30); g.lineTo(26, -30); g.lineTo(26, 8);
      g.quadraticCurveTo(26, 30, 0, 40); g.quadraticCurveTo(-26, 30, -26, 8); g.closePath();
      g.fillStyle = hex(trimHex); g.fill();
      g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.4)'; g.stroke();
      g.restore();
    };
    crest(W * 0.075);
    crest(W * 0.925);

    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// MISC SURFACES
// ---------------------------------------------------------------------------

export function concreteTexture() {
  return memo('concrete', () => {
    const S = 512;
    const { c, g } = canvas2d(S, S);
    const T = tables(4, 9091, 8);
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = fbm(x / S, y / S, 4, 8, T);
        const fine = fbm(x / S, y / S, 2, 64, T);
        const v = clamp01(0.55 + (n - 0.5) * 0.32 + (fine - 0.5) * 0.14);
        const i = (y * S + x) * 4;
        img.data[i] = v * 214; img.data[i + 1] = v * 214; img.data[i + 2] = v * 208; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return tex(c, { aniso: 8 });
  });
}

/** Fine white net weave with alpha. */
export function netTexture(cells = 26) {
  return memo('net:' + cells, () => {
    const S = 256;
    const { c, g } = canvas2d(S, S);
    g.clearRect(0, 0, S, S);
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.lineWidth = 2.2;
    const step = S / cells;
    g.beginPath();
    for (let i = 0; i <= cells; i++) {
      g.moveTo(i * step, 0); g.lineTo(i * step, S);
      g.moveTo(0, i * step); g.lineTo(S, i * step);
    }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 5; g.stroke();
    const t = tex(c, { aniso: 4 });
    return t;
  });
}

/** Radial soft blob for contact shadows / glows. */
export function softCircle(inner = 'rgba(0,0,0,0.55)', outer = 'rgba(0,0,0,0)') {
  return memo('soft:' + inner + outer, () => {
    const S = 128;
    const { c, g } = canvas2d(S, S);
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, inner);
    gr.addColorStop(0.55, inner.replace(/[\d.]+\)$/, '0.28)'));
    gr.addColorStop(1, outer);
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    const t = tex(c, { aniso: 2 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Four/eight point star flash used for impacts. */
export function starTexture(points = 4) {
  return memo('star:' + points, () => {
    const S = 256;
    const { c, g } = canvas2d(S, S);
    g.clearRect(0, 0, S, S);
    g.translate(S / 2, S / 2);
    const spike = (len, wide, rot, col) => {
      g.save(); g.rotate(rot);
      const gr = g.createLinearGradient(0, 0, 0, -len);
      gr.addColorStop(0, col);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(-wide, 0); g.quadraticCurveTo(0, -len * 0.45, 0, -len);
      g.quadraticCurveTo(0, -len * 0.45, wide, 0); g.closePath(); g.fill();
      g.restore();
    };
    for (let i = 0; i < points; i++) {
      const r = (i / points) * Math.PI * 2;
      spike(120, 17, r, 'rgba(255,255,255,0.95)');
      spike(74, 26, r + Math.PI / points, 'rgba(255,170,220,0.75)');
    }
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, 46);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.4, 'rgba(255,214,238,0.75)');
    gr.addColorStop(1, 'rgba(255,120,190,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 46, 0, Math.PI * 2); g.fill();
    const t = tex(c, { aniso: 2 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Thin bright ring — the shot "swoosh". */
export function ringTexture() {
  return memo('ring', () => {
    const S = 256;
    const { c, g } = canvas2d(S, S);
    g.clearRect(0, 0, S, S);
    g.translate(S / 2, S / 2);
    g.lineWidth = 11;
    const gr = g.createRadialGradient(0, 0, 84, 0, 0, 118);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    gr.addColorStop(1, 'rgba(255,120,190,0)');
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.arc(0, 0, 100, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 24; g.strokeStyle = 'rgba(255,150,205,0.45)';
    g.beginPath(); g.arc(0, 0, 100, 0, Math.PI * 2); g.stroke();
    const t = tex(c, { aniso: 2 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Small soft particle sprite (dust / grass / confetti share it). */
export function particleTexture() {
  return memo('particle', () => {
    const S = 64;
    const { c, g } = canvas2d(S, S);
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    const t = tex(c, { aniso: 1 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Jumbotron / scoreboard face. Redrawn on demand (not memoised by score). */
export function jumbotronTexture() {
  return memo('jumbo', () => {
    const W = 1024, H = 512;
    const { c, g } = canvas2d(W, H);
    const t = tex(c, { aniso: 8 });
    t.userData.draw = (a, b, clock, nameA, nameB) => {
      g.fillStyle = '#06080e'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#0d1524'; g.fillRect(18, 18, W - 36, H - 36);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#e8f0ff';
      g.font = '900 150px "Trebuchet MS", Impact, sans-serif';
      g.fillText(`${a} : ${b}`, W / 2, H * 0.42);
      g.font = '700 64px "Trebuchet MS", sans-serif';
      g.fillStyle = '#7fd7ff';
      g.fillText(clock, W / 2, H * 0.72);
      g.font = '900 56px "Trebuchet MS", sans-serif';
      g.fillStyle = '#ff6b6b'; g.fillText(nameA, W * 0.18, H * 0.42);
      g.fillStyle = '#6b9bff'; g.fillText(nameB, W * 0.82, H * 0.42);
      // scanlines
      g.globalAlpha = 0.10; g.fillStyle = '#000';
      for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
      g.globalAlpha = 1;
      t.needsUpdate = true;
    };
    t.userData.draw(0, 0, '3:00', 'RED', 'BLU');
    return t;
  });
}

// ---------------------------------------------------------------------------
// SKY / ENVIRONMENT
// ---------------------------------------------------------------------------

export function skyTexture() {
  return memo('sky', () => {
    const W = 64, H = 512;
    const { c, g } = canvas2d(W, H);
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0.00, '#2f7ad6');
    gr.addColorStop(0.34, '#69b2ec');
    gr.addColorStop(0.58, '#a9d8f5');
    gr.addColorStop(0.72, '#dff0fb');
    gr.addColorStop(1.00, '#f7e9cf');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const t = tex(c, { aniso: 1 });
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** PMREM environment probe baked from a small procedural sky scene. */
export function envMap(renderer) {
  return memo('env', () => {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const scene = new THREE.Scene();
      const sky = new THREE.Mesh(
        new THREE.SphereGeometry(50, 24, 16),
        new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false }),
      );
      scene.add(sky);
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(48, 24),
        new THREE.MeshBasicMaterial({ color: 0x3f7a30, side: THREE.DoubleSide, fog: false }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -1;
      scene.add(ground);
      const rt = pmrem.fromScene(scene, 0.04);
      sky.geometry.dispose(); sky.material.dispose();
      ground.geometry.dispose(); ground.material.dispose();
      pmrem.dispose();
      return rt.texture;
    } catch (e) {
      return null;
    }
  });
}

export function disposeAssets() {
  for (const v of cache.values()) {
    if (v && v.isTexture) v.dispose();
    else if (v && v.texture && v.texture.isTexture) v.texture.dispose();
    else if (v && v.map) { v.map.dispose(); v.normalMap?.dispose(); v.roughnessMap?.dispose(); }
  }
  cache.clear();
}
