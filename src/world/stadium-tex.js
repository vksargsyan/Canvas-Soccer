// Procedural canvas-2D textures owned by the STADIUM domain.
//
// Everything here is generated once at runtime and memoised. No binary assets.
// Branding is our own: "CANVAS SOCCER" plus an original chevron/ball crest.
// (Deliberately NOT a copy of anyone else's trade dress.)

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

const cache = new Map();

function memo(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

function c2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d') };
}

function tex(c, { srgb = true, aniso = 8, wrap = THREE.RepeatWrapping } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function shade(hex, k) {
  const n = typeof hex === 'string' ? parseInt(hex.slice(1), 16) : hex;
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `rgb(${r},${g},${b})`;
}

function noise(g, w, h, amount, rng, size = 1) {
  g.save();
  for (let i = 0; i < (w * h) / (26 * size * size); i++) {
    const a = rng.range(-amount, amount);
    g.fillStyle = a > 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${-a})`;
    g.fillRect(rng.range(0, w), rng.range(0, h), size, size);
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// CREST — original mark: shield, chevron, ball, "CS" bar.
// ---------------------------------------------------------------------------

/** Draws the crest centred on (0,0) in a ~80x96 box. Call inside save/translate/scale. */
export function drawCrest(g, opts = {}) {
  const light = opts.light || '#ffffff';
  const dark = opts.dark || '#0a4ea8';
  const mid = opts.mid || '#1f7fe0';

  g.beginPath();
  g.moveTo(-34, -40); g.lineTo(34, -40); g.lineTo(34, 6);
  g.bezierCurveTo(34, 32, 16, 44, 0, 50);
  g.bezierCurveTo(-16, 44, -34, 32, -34, 6);
  g.closePath();
  g.fillStyle = light; g.fill();
  g.lineWidth = 4; g.strokeStyle = dark; g.stroke();

  // inner field
  g.save();
  g.clip();
  g.fillStyle = dark;
  g.fillRect(-40, -46, 80, 100);
  // chevron
  g.fillStyle = mid;
  g.beginPath();
  g.moveTo(-40, -6); g.lineTo(0, -26); g.lineTo(40, -6);
  g.lineTo(40, 8); g.lineTo(0, -12); g.lineTo(-40, 8);
  g.closePath(); g.fill();
  g.restore();

  // ball
  g.beginPath(); g.arc(0, -12, 13, 0, Math.PI * 2);
  g.fillStyle = light; g.fill();
  g.fillStyle = dark;
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
    const x = Math.cos(a) * 5.6, y = -12 + Math.sin(a) * 5.6;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath(); g.fill();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + ((i + 0.5) / 5) * Math.PI * 2;
    g.beginPath();
    g.arc(Math.cos(a) * 10.2, -12 + Math.sin(a) * 10.2, 2.4, 0, Math.PI * 2);
    g.fill();
  }

  // lower bar with monogram
  g.fillStyle = light;
  g.fillRect(-22, 10, 44, 16);
  g.fillStyle = dark;
  g.font = '900 15px "Trebuchet MS", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('CS', 0, 19);
}

// ---------------------------------------------------------------------------
// PERIMETER AD BOARDS
// ---------------------------------------------------------------------------

/**
 * Seamless board strip. One texture repeat = one "CANVAS SOCCER + crest" unit
 * pair, so it tiles cleanly around the bowl.
 */
export function adBoardTexture() {
  return memo('adboard', () => {
    const W = 2048, H = 256;
    const { c, g } = c2d(W, H);
    const rng = makeRng(0xadb0);

    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0.00, '#2c93ef');
    grad.addColorStop(0.34, '#1272d8');
    grad.addColorStop(0.52, '#0b58b8');
    grad.addColorStop(1.00, '#073c88');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);

    // soft vertical light falloff bands (LED board look)
    g.globalAlpha = 0.10;
    for (let x = 0; x < W; x += 8) {
      g.fillStyle = x % 16 === 0 ? '#ffffff' : '#000000';
      g.fillRect(x, 0, 4, H);
    }
    g.globalAlpha = 1;

    // diagonal sheens
    g.save();
    g.globalAlpha = 0.13; g.fillStyle = '#ffffff';
    for (let i = 0; i < 4; i++) {
      const x0 = i * (W / 4) - 60;
      g.beginPath();
      g.moveTo(x0, H); g.lineTo(x0 + 150, 0); g.lineTo(x0 + 215, 0); g.lineTo(x0 + 65, H);
      g.closePath(); g.fill();
    }
    g.restore();

    const unit = W / 2;
    for (let u = 0; u < 2; u++) {
      const ox = u * unit;
      // wordmark
      g.save();
      g.translate(ox + unit * 0.31, H * 0.5);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = 'rgba(2,20,50,0.55)'; g.shadowBlur = 10; g.shadowOffsetY = 5;
      g.fillStyle = '#ffffff';
      g.font = 'italic 900 78px "Trebuchet MS", Arial Black, sans-serif';
      g.fillText('CANVAS', 0, -42);
      g.fillText('SOCCER', 0, 42);
      g.restore();

      // crest
      g.save();
      g.translate(ox + unit * 0.76, H * 0.47);
      g.scale(2.05, 2.05);
      g.shadowColor = 'rgba(2,20,50,0.5)'; g.shadowBlur = 8; g.shadowOffsetY = 4;
      drawCrest(g);
      g.restore();
    }

    // rails
    g.fillStyle = 'rgba(255,255,255,0.42)'; g.fillRect(0, 0, W, 7);
    g.fillStyle = 'rgba(160,215,255,0.30)'; g.fillRect(0, 8, W, 3);
    g.fillStyle = 'rgba(0,0,0,0.38)'; g.fillRect(0, H - 12, W, 12);
    noise(g, W, H, 0.05, rng, 2);

    const t = tex(c, { aniso: 16 });
    t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Dark LED fascia ring that runs under the roof — same brand, low key. */
export function fasciaTexture() {
  return memo('fascia', () => {
    const W = 1024, H = 128;
    const { c, g } = c2d(W, H);
    g.fillStyle = '#0a1120'; g.fillRect(0, 0, W, H);
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#131f36'); grad.addColorStop(1, '#060b16');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let u = 0; u < 2; u++) {
      const ox = u * (W / 2);
      g.fillStyle = '#7fd0ff';
      g.font = 'italic 900 46px "Trebuchet MS", sans-serif';
      g.fillText('CANVAS SOCCER', ox + W * 0.25, H * 0.5);
      g.save();
      g.translate(ox + W * 0.44, H * 0.5); g.scale(0.62, 0.62);
      drawCrest(g, { light: '#cfe9ff', dark: '#0d2a55', mid: '#2a7fd6' });
      g.restore();
    }
    g.globalAlpha = 0.16; g.fillStyle = '#000';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
    g.globalAlpha = 1;
    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// CROWD
// ---------------------------------------------------------------------------

const SKINS = ['#ffdcb8', '#f4c79c', '#e3ab78', '#cb8b53', '#a96b3c', '#7d4a26', '#54301a'];
const HAIRS = ['#150d06', '#2a1a0d', '#4a2c14', '#7a4a1e', '#b98a3e', '#d8c48a',
  '#1a1a1a', '#6b6b6b', '#c9c9c9', '#8c2b16'];

/**
 * Spectator sprite sheet — 8x4 cells of chibi fans in assorted poses.
 * Transparent background, drawn with a dark keyline so they read at distance.
 */
export function crowdSheet() {
  return memo('crowdsheet2', () => {
    const COLS = 8, ROWS = 6, CELL = 128;
    const { c, g } = c2d(COLS * CELL, ROWS * CELL);
    const rng = makeRng(0xc0ffee);

    // Rows are grouped by allegiance so the stadium can build real colour
    // blocks: 0-1 home, 2-3 away, 4-5 neutral. Skin and hair stay per-cell, so
    // the instance tint only has to carry shading.
    const HOME_S = ['#d8262c', '#e8474d', '#ffffff', '#f2dede', '#9c1218',
      '#f0c93a', '#c0272d', '#ffffff'];
    const AWAY_S = ['#2450c8', '#3a6ae0', '#ffffff', '#f5d020', '#17357f',
      '#9fc0ff', '#2a5fd8', '#ffffff'];
    const NEU_S = ['#22a05a', '#eb6d1f', '#7c3ec9', '#28b8c8', '#e2e6ea',
      '#40464e', '#0f8f6d', '#ff9b2f'];
    const groupOf = (ry) => (ry < 2 ? HOME_S : ry < 4 ? AWAY_S : NEU_S);

    for (let ry = 0; ry < ROWS; ry++) {
      for (let cx = 0; cx < COLS; cx++) {
        const pal = groupOf(ry);
        const ox = cx * CELL + CELL / 2;
        const oy = ry * CELL + CELL - 5;
        const skin = rng.pick(SKINS);
        const hair = rng.pick(HAIRS);
        const shirt = pal[(cx + ry * 3) % pal.length];
        const pose = (cx + ry) % 8;

        g.save();
        g.translate(ox, oy);
        g.lineJoin = 'round';
        g.lineWidth = 4.0;
        g.strokeStyle = 'rgba(20,14,9,0.5)';

        const armUp = pose === 1 || pose === 4 || pose === 6;
        const oneUp = pose === 7;
        const seated = pose === 3;
        g.rotate(pose === 5 ? 0.13 : 0);

        const bodyTop = seated ? -42 : -50;

        const torso = new Path2D();
        torso.moveTo(-23, -2); torso.lineTo(-18, bodyTop); torso.lineTo(18, bodyTop);
        torso.lineTo(23, -2); torso.closePath();
        g.fillStyle = shirt; g.stroke(torso); g.fill(torso);

        g.save();
        g.clip(torso);
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(-30, -16, 60, 20);
        g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(-30, bodyTop, 60, 7);
        g.restore();

        const arm = (sx, up) => {
          const p = new Path2D();
          if (up) {
            p.moveTo(sx * 16, bodyTop + 6);
            p.lineTo(sx * 26, bodyTop - 29);
            p.lineTo(sx * 36, bodyTop - 25);
            p.lineTo(sx * 27, bodyTop + 10);
          } else {
            p.moveTo(sx * 17, bodyTop + 4);
            p.lineTo(sx * 28, bodyTop + 6);
            p.lineTo(sx * 30, -6);
            p.lineTo(sx * 19, -6);
          }
          p.closePath();
          g.fillStyle = shirt; g.stroke(p); g.fill(p);
          g.fillStyle = skin;
          const hx = up ? sx * 31 : sx * 24.5;
          const hy = up ? bodyTop - 29 : -6;
          g.beginPath(); g.arc(hx, hy, 7.2, 0, Math.PI * 2);
          g.stroke(); g.fill();
        };
        arm(-1, armUp);
        arm(1, armUp || oneUp);

        const hy = bodyTop - 17;
        g.fillStyle = skin;
        const head = new Path2D();
        head.ellipse(0, hy, 20, 21, 0, 0, Math.PI * 2);
        g.stroke(head); g.fill(head);
        // ears
        g.beginPath(); g.ellipse(-19.5, hy + 2, 3.5, 5, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(19.5, hy + 2, 3.5, 5, 0, 0, Math.PI * 2); g.fill();

        const cap = new Path2D();
        if (pose === 2) {
          cap.ellipse(0, hy - 3, 20.5, 19, 0, Math.PI * 1.02, Math.PI * 1.98);
          cap.closePath(); g.fillStyle = hair; g.fill(cap);
          g.beginPath(); g.arc(0, hy - 23, 8.5, 0, Math.PI * 2); g.fill();
        } else if (pose === 6) {
          g.fillStyle = shirt;
          g.beginPath(); g.ellipse(0, hy - 5, 21, 15, 0, Math.PI, Math.PI * 2); g.fill();
          g.fillRect(-25, hy - 7, 50, 6);
        } else {
          cap.ellipse(0, hy - 2, 20.5, 20, 0, Math.PI * 1.04, Math.PI * 1.96);
          cap.closePath(); g.fillStyle = hair; g.fill(cap);
          if (pose === 5) { g.beginPath(); g.ellipse(-17, hy + 2, 6.5, 10, 0, 0, Math.PI * 2); g.fill(); }
        }

        g.fillStyle = 'rgba(34,22,14,0.82)';
        g.beginPath(); g.ellipse(-6.5, hy + 2, 2.5, 3.1, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(6.5, hy + 2, 2.5, 3.1, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(34,22,14,0.6)'; g.lineWidth = 2.2;
        g.beginPath();
        if (armUp) g.arc(0, hy + 7, 5.2, 0.15, Math.PI - 0.15);
        else { g.moveTo(-4, hy + 10); g.lineTo(4, hy + 10); }
        g.stroke();

        if (pose === 4) {
          g.fillStyle = shirt;
          g.strokeStyle = 'rgba(18,12,8,0.5)'; g.lineWidth = 3;
          const p = new Path2D();
          p.moveTo(-33, bodyTop - 30); p.lineTo(33, bodyTop - 30);
          p.lineTo(33, bodyTop - 16); p.lineTo(-33, bodyTop - 12);
          p.closePath();
          g.fill(p); g.stroke(p);
          g.fillStyle = 'rgba(255,255,255,0.7)';
          for (let i = -2; i <= 2; i++) g.fillRect(i * 12 - 2, bodyTop - 28, 4, 12);
        }
        g.restore();
      }
    }
    const t = tex(c, { aniso: 8 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return {
      texture: t, cols: COLS, rows: ROWS,
      // NOTE: textures are uploaded with flipY, so aCell row r samples canvas
      // row (ROWS-1-r). These indices are already in aCell space.
      groups: { home: [5, 4], away: [3, 2], neutral: [1, 0] },
    };
  });
}

/** Dense tileable crowd wall for the deepest / cheapest tiers. */
export function crowdWallTexture() {
  return memo('crowdwall2', () => {
    const W = 512, H = 256;
    const { c, g } = c2d(W, H);
    const rng = makeRng(0x77a11);
    g.fillStyle = '#10151f'; g.fillRect(0, 0, W, H);
    const shirts = ['#d8262c', '#2450c8', '#ffffff', '#f5d020', '#22a05a', '#eb6d1f',
      '#7c3ec9', '#1b2a4a', '#28b8c8', '#e8e8e8', '#b21f2a', '#17357f'];
    const rows = 13;
    for (let r = rows - 1; r >= 0; r--) {
      const y = H - 4 - r * (H / (rows + 0.6)) * 0.95;
      const s = 0.5 + r * 0.04;
      const per = 30;
      const k = 0.62 + r * 0.031;
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, y - 1, W, 3);
      for (let i = -1; i <= per; i++) {
        if (rng.float() < 0.06) continue;
        const x = (i + (r % 2) * 0.5) * (W / per) + rng.range(-2.5, 2.5);
        g.save(); g.translate(x, y + rng.range(-1, 1)); g.scale(s, s);
        const sk = rng.pick(SKINS), sh = rng.pick(shirts), ha = rng.pick(HAIRS);
        g.fillStyle = shade(sh, k);
        g.beginPath(); g.moveTo(-12, 0); g.lineTo(-10, -21); g.lineTo(10, -21); g.lineTo(12, 0);
        g.closePath(); g.fill();
        g.fillStyle = shade(sk, k);
        g.beginPath(); g.arc(0, -29, 9.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = shade(ha, k * 0.9);
        g.beginPath(); g.arc(0, -31, 9.5, Math.PI * 1.03, Math.PI * 1.97); g.fill();
        g.restore();
      }
    }
    noise(g, W, H, 0.08, rng, 1);
    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// STRUCTURE
// ---------------------------------------------------------------------------

/** Precast concrete with panel seams, grime and rebar staining. */
export function concreteTexture() {
  return memo('sconcrete', () => {
    const S = 512;
    const { c, g } = c2d(S, S);
    const rng = makeRng(0xc0c0);
    g.fillStyle = '#b9bdb9'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 240; i++) {
      const r = rng.range(18, 90);
      g.globalAlpha = rng.range(0.02, 0.07);
      g.fillStyle = rng.float() < 0.5 ? '#8e938f' : '#d8dbd6';
      g.beginPath(); g.arc(rng.range(0, S), rng.range(0, S), r, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    // panel seams
    g.strokeStyle = 'rgba(70,74,72,0.55)'; g.lineWidth = 3;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo((i * S) / 4, 0); g.lineTo((i * S) / 4, S); g.stroke();
    }
    g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo((i * S) / 4 + 3, 0); g.lineTo((i * S) / 4 + 3, S); g.stroke();
    }
    // vertical grime streaks
    for (let i = 0; i < 60; i++) {
      const x = rng.range(0, S);
      g.globalAlpha = rng.range(0.03, 0.10);
      g.fillStyle = '#6d716e';
      g.fillRect(x, rng.range(0, S * 0.6), rng.range(1, 4), rng.range(40, 200));
    }
    g.globalAlpha = 1;
    noise(g, S, S, 0.10, rng, 1);
    return tex(c, { aniso: 8 });
  });
}

/**
 * Seat bank texture — one tile = one seat. Applied to the tread rings so empty
 * gaps in the crowd read as actual seats rather than flat colour.
 */
export function seatTexture() {
  return memo('seats', () => {
    const S = 128;
    const { c, g } = c2d(S, S);
    const rng = makeRng(0x5ea75);
    // concrete tread with a seat bolted to the back half
    g.fillStyle = '#a7aca6'; g.fillRect(0, 0, S, S);
    g.fillStyle = 'rgba(255,255,255,0.30)'; g.fillRect(0, 0, S, 7);
    g.fillStyle = 'rgba(40,44,42,0.35)'; g.fillRect(0, 7, S, 5);
    // shadow the seat casts forward onto the tread
    g.fillStyle = 'rgba(20,26,34,0.30)'; g.fillRect(6, 44, S - 12, 20);
    // seat shell (back panel + squab)
    const seat = (base, hi) => {
      g.fillStyle = base;
      g.beginPath();
      g.moveTo(14, 52); g.lineTo(S - 14, 52); g.lineTo(S - 18, S - 4); g.lineTo(18, S - 4);
      g.closePath(); g.fill();
      g.fillStyle = hi;
      g.fillRect(16, 54, S - 32, 10);
      g.fillStyle = 'rgba(0,0,0,0.34)';
      g.fillRect(18, S - 24, S - 36, 9);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, 46, 6, S - 46); g.fillRect(S - 6, 46, 6, S - 46);
    };
    seat('#1b3d63', 'rgba(120,175,225,0.35)');
    noise(g, S, S, 0.09, rng, 1);
    return tex(c, { aniso: 8 });
  });
}

/** Light concrete stairway with tread nosings. */
export function stairTexture() {
  return memo('stairs', () => {
    const W = 64, H = 128;
    const { c, g } = c2d(W, H);
    const rng = makeRng(0x57a15);
    g.fillStyle = '#c8cdc9'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 4; i++) {
      const y = (i * H) / 4;
      g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(0, y, W, 5);
      g.fillStyle = 'rgba(60,66,64,0.45)'; g.fillRect(0, y + 5, W, 4);
    }
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 0, 4, H); g.fillRect(W - 4, 0, 4, H);
    noise(g, W, H, 0.09, rng, 1);
    return tex(c, { aniso: 8 });
  });
}

/** Ribbed metal roof deck, seen from below and above. */
export function roofTexture() {
  return memo('roof', () => {
    const W = 256, H = 256;
    const { c, g } = c2d(W, H);
    const rng = makeRng(0x20f);
    g.fillStyle = '#9aa3a9'; g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 16) {
      g.fillStyle = 'rgba(255,255,255,0.28)'; g.fillRect(x, 0, 5, H);
      g.fillStyle = 'rgba(40,48,54,0.30)'; g.fillRect(x + 10, 0, 5, H);
    }
    g.strokeStyle = 'rgba(50,58,64,0.45)'; g.lineWidth = 2;
    for (let y = 0; y < H; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    noise(g, W, H, 0.07, rng, 1);
    return tex(c, { aniso: 8 });
  });
}

/** Ground outside the bowl: asphalt, bays, paths, grass patches. Big & tileable. */
export function groundsTexture() {
  return memo('grounds', () => {
    const S = 1024;
    const { c, g } = c2d(S, S);
    const rng = makeRng(0x6204d);
    g.fillStyle = '#4a5352'; g.fillRect(0, 0, S, S);
    // grass blocks
    for (let i = 0; i < 26; i++) {
      const w = rng.range(70, 260), h = rng.range(70, 240);
      g.fillStyle = rng.float() < 0.6 ? '#3f6b34' : '#4d7a3c';
      g.fillRect(rng.range(0, S - w), rng.range(0, S - h), w, h);
    }
    // asphalt roads
    g.fillStyle = '#3a4142';
    for (let i = 0; i < 5; i++) {
      if (rng.float() < 0.5) g.fillRect(0, rng.range(0, S), S, rng.range(24, 54));
      else g.fillRect(rng.range(0, S), 0, rng.range(24, 54), S);
    }
    // parking bays
    g.strokeStyle = 'rgba(230,230,220,0.45)'; g.lineWidth = 2;
    for (let b = 0; b < 8; b++) {
      const x0 = rng.range(20, S - 240), y0 = rng.range(20, S - 140);
      const n = Math.floor(rng.range(6, 14));
      for (let i = 0; i <= n; i++) {
        g.beginPath(); g.moveTo(x0 + i * 17, y0); g.lineTo(x0 + i * 17, y0 + 44); g.stroke();
      }
      // parked cars
      for (let i = 0; i < n; i++) {
        if (rng.float() < 0.45) continue;
        g.fillStyle = shade(rng.pick(['#c8c8cc', '#2b3038', '#8e2222', '#1f4d8f', '#d8d2c0']), 1);
        g.fillRect(x0 + i * 17 + 3, y0 + 7, 11, 30);
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(x0 + i * 17 + 4, y0 + 13, 9, 12);
      }
    }
    // trees
    for (let i = 0; i < 70; i++) {
      const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(6, 15);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.arc(x + 3, y + 4, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = shade('#2f5c2a', rng.range(0.8, 1.25));
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    noise(g, S, S, 0.12, rng, 2);
    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// NET
// ---------------------------------------------------------------------------

/** Fine hex-ish goal net: crisp bright cords with a soft shadow side. */
export function netTexture(cells = 16) {
  return memo('net:' + cells, () => {
    const S = 256;
    const { c, g } = c2d(S, S);
    g.clearRect(0, 0, S, S);
    const step = S / cells;
    g.lineCap = 'round';
    // shadow pass
    g.strokeStyle = 'rgba(40,50,60,0.55)';
    g.lineWidth = Math.max(1.6, step * 0.20);
    for (let i = 0; i <= cells; i++) {
      const p = i * step + 1.1;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    // bright pass
    g.strokeStyle = 'rgba(255,255,255,0.98)';
    g.lineWidth = Math.max(1.4, step * 0.17);
    for (let i = 0; i <= cells; i++) {
      const p = i * step;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    // knots
    g.fillStyle = 'rgba(255,255,255,1)';
    for (let i = 0; i <= cells; i++) {
      for (let j = 0; j <= cells; j++) {
        g.beginPath(); g.arc(i * step, j * step, Math.max(1.0, step * 0.12), 0, Math.PI * 2); g.fill();
      }
    }
    const t = tex(c, { srgb: true, aniso: 16 });
    return t;
  });
}

// ---------------------------------------------------------------------------
// MISC
// ---------------------------------------------------------------------------

/** Radial glow sprite for floodlight lamps. */
export function glowTexture() {
  return memo('glow', () => {
    const S = 128;
    const { c, g } = c2d(S, S);
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0.00, 'rgba(255,252,235,1)');
    gr.addColorStop(0.14, 'rgba(255,245,205,0.72)');
    gr.addColorStop(0.42, 'rgba(255,232,170,0.22)');
    gr.addColorStop(1.00, 'rgba(255,225,160,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    const t = tex(c, { aniso: 1 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Supporter banner / flag cloth with our crest and stripes. */
export function bannerTexture(a = '#e0353b', b = '#ffffff') {
  return memo('banner:' + a + b, () => {
    const W = 256, H = 160;
    const { c, g } = c2d(W, H);
    g.fillStyle = b; g.fillRect(0, 0, W, H);
    g.fillStyle = a;
    for (let i = 0; i < 5; i++) g.fillRect(i * (W / 5), 0, W / 10, H);
    g.save();
    g.translate(W / 2, H / 2); g.scale(1.05, 1.05);
    drawCrest(g, { light: '#ffffff', dark: '#12305e', mid: '#2a7fd6' });
    g.restore();
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
    const t = tex(c, { aniso: 4 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Jumbotron face. Returns { texture, draw(a,b,clock,nameA,nameB) }. */
export function jumbotron() {
  return memo('jumbo2', () => {
    const W = 1024, H = 512;
    const { c, g } = c2d(W, H);
    const t = tex(c, { aniso: 8 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const draw = (a, b, clock, nameA, nameB) => {
      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#0a1526'); bg.addColorStop(1, '#04070e');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);

      // header bar
      g.fillStyle = '#12224a'; g.fillRect(0, 0, W, 96);
      g.fillStyle = '#7fd0ff';
      g.font = 'italic 900 54px "Trebuchet MS", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('CANVAS SOCCER', W / 2, 48);

      // score plate
      g.fillStyle = '#0d1b33';
      g.fillRect(60, 140, W - 120, 230);
      g.strokeStyle = '#2f6bb8'; g.lineWidth = 6;
      g.strokeRect(60, 140, W - 120, 230);

      g.fillStyle = '#ffffff';
      g.font = '900 168px "Trebuchet MS", Impact, sans-serif';
      g.fillText(`${a}`, W * 0.40, 258);
      g.fillText(`${b}`, W * 0.60, 258);
      g.fillStyle = '#7fd0ff';
      g.font = '900 108px "Trebuchet MS", sans-serif';
      g.fillText('-', W * 0.5, 250);

      g.font = '900 60px "Trebuchet MS", sans-serif';
      g.fillStyle = '#ff7a7a'; g.fillText(nameA, W * 0.19, 258);
      g.fillStyle = '#7fa8ff'; g.fillText(nameB, W * 0.81, 258);

      // clock
      g.fillStyle = '#101d33'; g.fillRect(W * 0.34, 396, W * 0.32, 84);
      g.fillStyle = '#eaf4ff';
      g.font = '900 66px "Trebuchet MS", monospace';
      g.fillText(clock, W / 2, 440);

      // scanlines + vignette
      g.globalAlpha = 0.13; g.fillStyle = '#000';
      for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
      g.globalAlpha = 1;
      t.needsUpdate = true;
    };
    draw(0, 0, '3:00', 'RED', 'BLU');
    return { texture: t, draw };
  });
}

export function disposeStadiumTextures() {
  for (const v of cache.values()) {
    if (v && v.isTexture) v.dispose();
    else if (v && v.texture && v.texture.isTexture) v.texture.dispose();
  }
  cache.clear();
}
