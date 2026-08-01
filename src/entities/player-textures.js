// Procedural surfacing for the chibi players — faces, eyes, hair, kits, shorts,
// socks, sleeves, gloves, boots and the shared fabric normal map.
//
// Owned by the CHARS domain together with entities/player.js. Everything here is
// canvas-2D generated at runtime; no binary assets, no Math.random.
//
// ---------------------------------------------------------------------------
// HEAD UV CONVENTION
// ---------------------------------------------------------------------------
// The head mesh (skull + nose + ears + neck) is UV'd by spherical projection
// from the head centre:
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
//
// Every face feature is anchored by a (azimuth, polar) pair in FACE_ANCHORS,
// and player.js sculpts the matching geometry from the SAME numbers — the eye
// sockets, brow ridge, nose and ears are real form, and the paint lands on it.

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
  t.anisotropy = opts.aniso ?? 16;
  t.wrapS = t.wrapT = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
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
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// rosters
// ---------------------------------------------------------------------------

/** Broad, evenly spaced skin range — the reference roster is diverse. */
export const SKIN_TONES = [
  0xf6cba8, 0xecb992, 0xdda478, 0xc98d5f, 0xb1774c,
  0x97613b, 0x7d4e2d, 0x633b21, 0x4a2a18,
];

export const HAIR_COLORS = [
  0x14100c, 0x241a12, 0x3a2415, 0x5a3418, 0x7d4c1e,
  0xa8722e, 0xd0a85e, 0xe4c98c, 0x9a9aa2, 0xd9d9dd, 0xa8391a, 0x3d2b3a,
];

export const HAIR_STYLES = [
  'buzz', 'fade', 'crop', 'quiff', 'curls', 'afro', 'bun', 'long', 'mohawk', 'dreads', 'bald',
];

export const EYE_COLORS = [0x4a3018, 0x2c1c10, 0x6b5124, 0x3d6b3a, 0x2f5f86, 0x6a7c8c];

export const BOOT_COLORS = [
  0xf3f5f8, 0x14161b, 0xf2c318, 0xff4d8d, 0x2fd06a, 0x2a6cf5, 0xff6a1f, 0xc0143c,
];

// ---------------------------------------------------------------------------
// KIT RECIPES — the two clubs must not share a template.
// ---------------------------------------------------------------------------
// Every field below changes something a viewer can name at a glance: the body
// graphic, the shoulder construction, the collar, whether the sleeve is a
// contrasting colour, and the crest silhouette. Read side by side, team 0 is a
// white-sashed club with a polo collar and contrast sleeves; team 1 is a
// pinstriped club with a raglan yoke, a v-neck and panelled sleeves.
export const KIT_RECIPES = {
  0: {
    body: 'sash', shoulder: 'chevron', collar: 'polo', sleeve: 'contrast',
    crest: 'shield', cuffHoops: 2, sidePanel: true, sockBands: 'hoops',
  },
  1: {
    body: 'pinstripe', shoulder: 'raglan', collar: 'v', sleeve: 'panel',
    crest: 'round', cuffHoops: 1, sidePanel: false, sockBands: 'band',
  },
  keeper: {
    body: 'keeper', shoulder: 'yoke', collar: 'crew', sleeve: 'long',
    crest: 'shield', cuffHoops: 1, sidePanel: true, sockBands: 'band',
  },
};

export const kitRecipe = (o) => (o && KIT_RECIPES[o]) || KIT_RECIPES[0];

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
// FACE ANCHORS — the single source of truth for face geometry *and* paint.
// az: radians about Y from +Z toward +X (player's right).  th: polar from the
// crown (0 = top of the skull, PI/2 = equator, PI = under the chin).
// ---------------------------------------------------------------------------

export const FACE_ANCHORS = {
  eyeAz: 0.312, eyeTh: 1.412,
  // eye socket: half-angles of the carved dish, and its depth in skull radii
  socketH: 0.360, socketUp: 0.105, socketDn: 0.155, socketD: 0.070,
  // eyeball, in head radii (tuned so the rim ellipse lands on the ball)
  eyeR: 0.17400, eyeC: 0.81429,
  // Rim of the eye opening, in radians off the eye axis. An adult eye is a
  // narrow almond — roughly 2 : 1 — not the near-circle a cartoon default gives.
  // The upper lid sits low enough to clip the top of the iris, which is what
  // stops the eye reading as a startled googly ball.
  rimH: 0.130, rimUp: 0.0505, rimDn: 0.0755,
  browTh: 1.236,
  noseTh: 1.596,
  mouthTh: 1.830,
  earAz: 1.520, earTh: 1.505,
};

// painted rim of the eye opening — the same ellipse the eyelid geometry uses,
// so the lash line and crease land exactly on the lid edge.
const RIM_H = FACE_ANCHORS.rimH, RIM_UP = FACE_ANCHORS.rimUp, RIM_DN = FACE_ANCHORS.rimDn;

/**
 * Per-variant brow: half-width and thickness in radians of skull arc, plus the
 * outward tilt and the height of the arch. Shared with player.js, which grows a
 * matching geometric ridge from the same numbers so the painted hair sits on
 * real form instead of floating on a sphere.
 *   w    half-width, radians          (eye opening half-width is rimH = 0.130)
 *   th   thickness, radians
 *   arch how much the peak rises above the ends
 *   ang  outer-end lift
 */
export const BROW_SHAPES = [
  { w: 0.176, th: 0.0490, arch: 0.34, ang: 0.10 },
  { w: 0.190, th: 0.0600, arch: 0.16, ang: 0.17 },
  { w: 0.166, th: 0.0420, arch: 0.48, ang: 0.03 },
  { w: 0.198, th: 0.0670, arch: 0.10, ang: 0.22 },
  { w: 0.180, th: 0.0530, arch: 0.36, ang: 0.13 },
  { w: 0.170, th: 0.0450, arch: 0.24, ang: 0.01 },
];

// ---------------------------------------------------------------------------
// EXPRESSIONS
// ---------------------------------------------------------------------------
// Every player has a face on every beat. `set` is the resting game-face,
// `focus` is the running/dribbling squint, `joy` is the goal celebration and
// `strain` is the tackle / knocked-down grimace. player.js swaps the map.

export const EXPRESSIONS = {
  set:    { tilt: 0.06, raise: 0.00, curve: 0.16, open: 0.00, squint: 0.06, teeth: 0, cheek: 0.10 },
  focus:  { tilt: 0.34, raise: -0.04, curve: -0.10, open: 0.06, squint: 0.24, teeth: 0, cheek: 0.14 },
  joy:    { tilt: -0.30, raise: 0.16, curve: 1.00, open: 0.70, squint: 0.62, teeth: 1, cheek: 0.55 },
  strain: { tilt: 0.90, raise: -0.10, curve: -0.60, open: 0.42, squint: 0.58, teeth: 1, cheek: 0.30 },
};

// ---------------------------------------------------------------------------
// FACE TEXTURE
// ---------------------------------------------------------------------------

const FACE_W = 1024, FACE_H = 640;
// pixels per radian of arc at the face
const AX = (FACE_W * (1 + WARP_U)) / TAU;
const AY = (FACE_H * (1 + WARP_V)) / Math.PI;

/** unwrapped x for an azimuth in [-PI, PI]; monotonic, may be < 0 or > FACE_W */
function rawX(az) {
  const d = az / TAU;                      // in [-0.5, 0.5]
  return (0.25 + d + (WARP_U * Math.sin(TAU * d)) / TAU) * FACE_W;
}
const PX = (az) => { let x = rawX(az) / FACE_W; x -= Math.floor(x); return x * FACE_W; };
const PY = (th) => (1 - warpV(1 - th / Math.PI)) * FACE_H;

/**
 * headTexture — the whole head is painted, so it survives a tight closeup while
 * the geometry stays cheap. Geometry (brow ridge, eye sockets, nose, ears, jaw)
 * is sculpted to the same anchors, so the paint sits on real form.
 */
export function headTexture(o = {}) {
  const skin = o.skin ?? SKIN_TONES[2];
  const variant = o.variant ?? 0;
  const brow = o.browColor ?? 0x241a12;
  const stubble = o.stubble ?? 0;
  const expr = o.expr ?? 'set';
  const scalp = o.scalp ?? null;     // { color, front, back, fringe } in radians
  const key = `head:${skin}:${variant}:${brow}:${stubble}:${expr}:`
    + (scalp ? `${scalp.color}:${scalp.front.toFixed(3)}:${scalp.back.toFixed(3)}:${scalp.fringe}` : 'x');

  return memo(key, () => {
    const E = EXPRESSIONS[expr] || EXPRESSIONS.set;
    const { c, g } = canvas2d(FACE_W, FACE_H);
    const W = FACE_W, H = FACE_H;
    const A = FACE_ANCHORS;

    const base = skin;
    const shadow = mixHex(base, 0x7a3a22, 0.30);
    const deep = mixHex(base, 0x4a1e10, 0.50);
    const hi = lighten(base, 0.24);

    // ---- base skin -------------------------------------------------------
    g.fillStyle = css(base); g.fillRect(0, 0, W, H);
    // top-lit gradient: crown bright, under-chin dark
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.00, rgba(lighten(base, 0.26), 0.55));
    grd.addColorStop(0.22, rgba(hi, 0.20));
    grd.addColorStop(0.62, 'rgba(0,0,0,0)');
    grd.addColorStop(1.00, rgba(deep, 0.30));
    g.fillStyle = grd; g.fillRect(0, 0, W, H);

    // faint skin grain
    g.save();
    g.globalAlpha = 0.030;
    for (let y = 0; y < H; y += 4) {
      for (let x = 0; x < W; x += 4) {
        const n = vnoise(x / 6.5, y / 6.5);
        if (n > 0.58) { g.fillStyle = '#ffffff'; g.fillRect(x, y, 3, 3); }
        else if (n < 0.40) { g.fillStyle = '#000000'; g.fillRect(x, y, 3, 3); }
      }
    }
    g.restore();

    const cx = PX(0);                     // face centre line
    const eyeX = (s) => cx + s * (rawX(A.eyeAz) - rawX(0));
    const eyeY = PY(A.eyeTh);
    const browY = PY(A.browTh);
    const noseY = PY(A.noseTh);
    const mY = PY(A.mouthTh + E.open * 0.055);

    // ---- cranial shaping -------------------------------------------------
    // temple / side-of-skull falloff either side of the face
    for (const s of [-1, 1]) {
      const tx = cx + s * 0.78 * AX;
      const tg = g.createRadialGradient(tx, eyeY - 0.16 * AY, 8, tx, eyeY - 0.16 * AY, 0.60 * AX);
      tg.addColorStop(0, rgba(shadow, 0.34));
      tg.addColorStop(1, rgba(shadow, 0));
      g.fillStyle = tg;
      g.fillRect(cx + (s < 0 ? -1.45 : 0.2) * AX, eyeY - 0.9 * AY, 1.25 * AX, 1.9 * AY);
    }
    // jaw / under-chin occlusion
    const jg = g.createLinearGradient(0, PY(2.10), 0, PY(2.62));
    jg.addColorStop(0, rgba(shadow, 0));
    jg.addColorStop(0.55, rgba(deep, 0.52));
    jg.addColorStop(1, rgba(deep, 0.92));
    g.fillStyle = jg; g.fillRect(0, PY(2.10), W, PY(2.62) - PY(2.10));
    // neck sits in the head's shadow
    g.fillStyle = rgba(deep, 0.55); g.fillRect(0, PY(2.62), W, H - PY(2.62));

    // cheekbone highlight + warmth
    for (const s of [-1, 1]) {
      const bx = cx + s * 0.46 * AX, by = eyeY + 0.30 * AY;
      g.save();
      g.globalAlpha = 0.20 + E.cheek * 0.16;
      const bg = g.createRadialGradient(bx, by, 4, bx, by, 0.34 * AX);
      bg.addColorStop(0, 'rgba(211,96,74,1)');
      bg.addColorStop(1, 'rgba(211,96,74,0)');
      g.fillStyle = bg;
      g.fillRect(bx - 0.36 * AX, by - 0.36 * AX, 0.72 * AX, 0.72 * AX);
      g.restore();
      // specular pop on the cheekbone so the head is not a matte egg
      g.save();
      g.globalAlpha = 0.20;
      const hg = g.createRadialGradient(bx - s * 0.03 * AX, by - 0.15 * AY, 3,
        bx - s * 0.03 * AX, by - 0.15 * AY, 0.26 * AX);
      hg.addColorStop(0, rgba(hi, 1)); hg.addColorStop(1, rgba(hi, 0));
      g.fillStyle = hg;
      g.fillRect(bx - 0.3 * AX, by - 0.4 * AY, 0.6 * AX, 0.7 * AY);
      g.restore();
    }

    // ---- stubble / beard shadow ------------------------------------------
    if (stubble > 0) {
      const dens = stubble >= 2 ? 1.0 : 0.5;
      const beardCol = mixHex(base, darken(brow, 0.10), 0.50 + dens * 0.36);
      const beardPath = () => {
        g.beginPath();
        g.moveTo(cx - 0.74 * AX, PY(1.62));
        g.bezierCurveTo(cx - 0.66 * AX, PY(1.94), cx - 0.36 * AX, PY(2.02), cx, PY(2.03));
        g.bezierCurveTo(cx + 0.36 * AX, PY(2.02), cx + 0.66 * AX, PY(1.94), cx + 0.74 * AX, PY(1.62));
        g.lineTo(cx + 0.74 * AX, PY(2.72));
        g.lineTo(cx - 0.74 * AX, PY(2.72));
        g.closePath();
      };
      g.save();
      g.filter = 'blur(10px)';
      g.globalAlpha = 0.40 + dens * 0.42;
      g.fillStyle = css(beardCol);
      beardPath(); g.fill();
      g.filter = 'none';
      beardPath(); g.clip();
      g.globalAlpha = 0.26 + dens * 0.16;
      const y0 = PY(1.55), y1 = PY(2.80);
      for (let y = y0; y < y1; y += 3) {
        for (let x = cx - 0.78 * AX; x < cx + 0.78 * AX; x += 3) {
          const n = vnoise(x / 3.1, y / 3.1);
          if (n > 0.60) { g.fillStyle = css(darken(beardCol, 0.45)); g.fillRect(x, y, 2, 2); }
          else if (n < 0.30) { g.fillStyle = css(lighten(beardCol, 0.24)); g.fillRect(x, y, 2, 2); }
        }
      }
      g.restore();
    }

    // ---- eye sockets ------------------------------------------------------
    // The eyeball is real geometry sitting in a real dish. What is painted here
    // is the soft occlusion of the dish, the lid crease and the lash edge —
    // never a sclera or an iris, so nothing can read as a pasted-on decal.
    const rh = RIM_H * AX;
    const ru = (RIM_UP - E.squint * 0.026) * AY;
    const rd = (RIM_DN - E.squint * 0.016) * AY;

    for (const s of [-1, 1]) {
      const ex = eyeX(s);
      g.save();
      g.translate(ex, eyeY);

      // orbital shadow — broad and soft, the dish itself
      const og = g.createRadialGradient(0, -0.02 * AY, 2, 0, -0.02 * AY, rh * 1.75);
      og.addColorStop(0.00, rgba(shadow, 0.42));
      og.addColorStop(0.45, rgba(shadow, 0.26));
      og.addColorStop(1.00, rgba(shadow, 0));
      g.fillStyle = og;
      g.fillRect(-rh * 1.9, -rh * 1.9, rh * 3.8, rh * 3.8);

      // deepest right at the opening, so the eyeball sits in shade at the rim
      g.save();
      g.filter = 'blur(6px)';
      g.fillStyle = rgba(deep, 0.55);
      g.beginPath(); g.ellipse(0, -0.10 * ru, rh * 1.02, (ru + rd) * 0.62, 0, 0, TAU); g.fill();
      g.filter = 'none';
      g.restore();

      // upper lid: a lit skin wedge over the top of the opening
      g.save();
      g.globalAlpha = 0.42;
      const lg = g.createLinearGradient(0, -ru * 3.4, 0, -ru * 0.2);
      lg.addColorStop(0, rgba(hi, 0.0));
      lg.addColorStop(0.55, rgba(hi, 0.9));
      lg.addColorStop(1, rgba(hi, 0.1));
      g.fillStyle = lg;
      g.beginPath(); g.ellipse(0, -ru * 1.55, rh * 1.10, ru * 1.7, 0, 0, TAU); g.fill();
      g.restore();

      // lid crease
      g.strokeStyle = rgba(shadow, 0.50);
      g.lineWidth = Math.max(2, ru * 0.20);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-rh * 0.92, -ru * 1.30);
      g.quadraticCurveTo(0, -ru * 2.42, rh * 0.94, -ru * 1.16);
      g.stroke();

      // lash edge — thin, warm-dark, and only along the top rim where the lid
      // actually meets the eyeball. No closed outline anywhere.
      g.strokeStyle = rgba(mixHex(brow, 0x1b1109, 0.4), 0.86);
      g.lineWidth = Math.max(2.4, ru * 0.30);
      g.beginPath();
      g.moveTo(-rh * 1.00, ru * 0.10);
      g.quadraticCurveTo(-rh * 0.42, -ru * 1.02, rh * 0.16, -ru * 0.94);
      g.quadraticCurveTo(rh * 0.74, -ru * 0.82, rh * 1.02, ru * 0.04);
      g.stroke();
      // outer corner tick
      g.lineWidth = Math.max(1.6, ru * 0.18);
      g.beginPath();
      g.moveTo(s * rh * 1.00, s * 0 + ru * 0.02);
      g.lineTo(s * rh * 1.22, ru * 0.34);
      g.stroke();

      // lower lid: a soft lit ledge with shadow beneath
      g.strokeStyle = rgba(hi, 0.42);
      g.lineWidth = Math.max(2, rd * 0.16);
      g.beginPath();
      g.moveTo(-rh * 0.86, rd * 0.94);
      g.quadraticCurveTo(0, rd * 1.34, rh * 0.88, rd * 0.86);
      g.stroke();
      g.strokeStyle = rgba(shadow, 0.34);
      g.lineWidth = Math.max(2, rd * 0.22);
      g.beginPath();
      g.moveTo(-rh * 0.80, rd * 1.36);
      g.quadraticCurveTo(0, rd * 1.84, rh * 0.84, rd * 1.26);
      g.stroke();

      // inner corner (caruncle) — a warm dot that anchors the eye to the nose
      g.fillStyle = rgba(mixHex(base, 0xb0503c, 0.5), 0.55);
      g.beginPath();
      g.ellipse(-s * rh * 0.98, rd * 0.28, rh * 0.11, rd * 0.24, 0, 0, TAU);
      g.fill();
      g.restore();
    }

    // ---- brows ------------------------------------------------------------
    // Brows are hair on a ridge, not decals: narrow, close above the eye, only
    // a little wider than the eye opening. The huge floating caterpillar is the
    // single loudest "this is a Mii" signal, so these numbers are deliberately
    // small — real brow presence comes from BROW_SHAPES geometry in player.js.
    const bs = BROW_SHAPES[variant % BROW_SHAPES.length];
    const browCol = darken(brow, 0.10);
    for (const s of [-1, 1]) {
      g.save();
      g.translate(eyeX(s), browY - E.raise * 0.055 * AY);
      g.rotate(s * (bs.ang + E.tilt * 0.30));
      const bw = bs.w * AX, bt = bs.th * AY;
      // soft shadow under the brow so it sits on the ridge instead of floating
      g.save();
      g.filter = 'blur(7px)';
      g.globalAlpha = 0.5;
      g.fillStyle = rgba(shadow, 1);
      g.beginPath();
      g.ellipse(0, bt * 0.75, bw * 0.98, bt * 0.85, 0, 0, TAU); g.fill();
      g.filter = 'none';
      g.restore();
      // The brow is hair growing on a ridge that already exists in geometry, so
      // it is painted as a bed of strokes rather than a filled slab: the body
      // is laid down at partial alpha, then individual hairs are drawn over it
      // and — critically — past its edge, so the outline is feathered.
      g.save();
      const body = () => {
        g.beginPath();
        g.moveTo(-bw, bt * 0.34);
        g.quadraticCurveTo(-bw * 0.30, -bt * (0.55 + bs.arch), bw * 0.50, -bt * 0.28);
        g.quadraticCurveTo(bw * 0.88, -bt * 0.04, bw * 0.98, bt * 0.26);
        g.quadraticCurveTo(bw * 0.46, bt * 0.34, -bw * 0.12, bt * 0.78);
        g.quadraticCurveTo(-bw * 0.62, bt * 0.88, -bw, bt * 0.34);
        g.closePath();
      };
      g.globalAlpha = 0.80;
      body();
      g.fillStyle = css(browCol); g.fill();
      g.globalAlpha = 1;
      // hairs, sweeping up and outward, drawn beyond the body outline
      g.lineCap = 'round';
      for (let i = 0; i < 40; i++) {
        const t = i / 39;
        const n = vnoise(i * 3.7, 1.3);
        const px = -bw * 1.02 + t * bw * 2.06;
        const up = bt * (0.30 + bs.arch * 1.10 * Math.sin(Math.pow(t, 0.8) * Math.PI) ** 0.6);
        const fade = Math.sin(Math.pow(t, 0.75) * Math.PI) ** 0.5;
        g.strokeStyle = rgba(
          n > 0.66 ? lighten(brow, 0.40) : n < 0.30 ? darken(brow, 0.55) : browCol,
          (0.30 + 0.55 * n) * (0.35 + 0.65 * fade));
        g.lineWidth = Math.max(1.3, bt * (0.13 + 0.10 * n));
        g.beginPath();
        g.moveTo(px, bt * (0.60 + 0.25 * n));
        g.quadraticCurveTo(px + bw * 0.06, bt * 0.05, px + bw * 0.13, -up * (0.72 + 0.42 * n));
        g.stroke();
      }
      // a hairline of light along the crest so the ridge reads as raised
      g.globalAlpha = 0.30;
      g.strokeStyle = rgba(lighten(brow, 0.55), 1);
      g.lineWidth = Math.max(1.6, bt * 0.14);
      g.beginPath();
      g.moveTo(-bw * 0.84, -bt * 0.10);
      g.quadraticCurveTo(-bw * 0.20, -bt * (0.60 + bs.arch), bw * 0.62, -bt * 0.24);
      g.stroke();
      g.restore();
      g.restore();
    }
    // glabella crease between the brows when the face is working
    if (E.tilt > 0.3) {
      g.save();
      g.globalAlpha = Math.min(0.5, (E.tilt - 0.3) * 0.9);
      g.strokeStyle = rgba(shadow, 1);
      g.lineWidth = Math.max(2.4, 0.014 * AY);
      g.lineCap = 'round';
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx + s * 0.045 * AX, browY + 0.03 * AY);
        g.lineTo(cx + s * 0.062 * AX, browY - 0.085 * AY);
        g.stroke();
      }
      g.restore();
    }

    // ---- nose -------------------------------------------------------------
    const noseW = (0.126 + (variant % 3) * 0.014) * AX;
    // side shadow down both sides of the bridge
    g.save();
    g.globalAlpha = 0.60;
    g.filter = 'blur(5px)';
    for (const s of [-1, 1]) {
      const ng = g.createLinearGradient(cx + s * noseW * 1.7, 0, cx + s * noseW * 0.30, 0);
      ng.addColorStop(0, rgba(shadow, 0));
      ng.addColorStop(1, rgba(shadow, 1));
      g.fillStyle = ng;
      g.beginPath();
      g.moveTo(cx + s * noseW * 0.34, browY - 0.02 * AY);
      g.lineTo(cx + s * noseW * 1.70, noseY + 0.05 * AY);
      g.lineTo(cx + s * noseW * 0.22, noseY + 0.10 * AY);
      g.closePath(); g.fill();
    }
    g.filter = 'none';
    g.restore();
    // bridge highlight running from between the brows to the tip
    g.save();
    g.globalAlpha = 0.42;
    const bhg = g.createLinearGradient(cx - noseW * 0.55, 0, cx + noseW * 0.55, 0);
    bhg.addColorStop(0, rgba(hi, 0)); bhg.addColorStop(0.45, rgba(hi, 1)); bhg.addColorStop(1, rgba(hi, 0));
    g.fillStyle = bhg;
    g.fillRect(cx - noseW * 0.55, browY - 0.06 * AY, noseW * 1.1, noseY - browY + 0.10 * AY);
    g.restore();
    // Shadow UNDER the ball, not around it: the tip is real geometry now, so
    // the paint's only job is to sit a dark line beneath it and put one small
    // specular on the crest. A big pale ellipse on the front of the ball is
    // what turned the nose into a snout.
    g.save();
    g.globalAlpha = 0.50;
    g.filter = 'blur(6px)';
    g.fillStyle = rgba(deep, 1);
    g.beginPath(); g.ellipse(cx, noseY + 0.128 * AY, noseW * 1.30, 0.052 * AY, 0, 0, TAU); g.fill();
    g.filter = 'none';
    g.restore();
    // specular on the crest of the tip — small, high, offset toward the key
    g.save();
    g.globalAlpha = 0.34;
    const tg2 = g.createRadialGradient(cx - noseW * 0.20, noseY - 0.048 * AY, 1,
      cx - noseW * 0.20, noseY - 0.048 * AY, noseW * 0.62);
    tg2.addColorStop(0, rgba(lighten(base, 0.62), 1));
    tg2.addColorStop(1, rgba(lighten(base, 0.62), 0));
    g.fillStyle = tg2;
    g.fillRect(cx - noseW * 1.0, noseY - 0.14 * AY, noseW * 2.0, 0.20 * AY);
    g.restore();
    // nostrils: small, dark, tucked UNDER the tip and angled outward
    g.fillStyle = rgba(deep, 0.80);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * noseW * 0.72, noseY + 0.108 * AY,
        noseW * 0.21, 0.017 * AY, s * 0.52, 0, TAU);
      g.fill();
    }
    // nostril wing crease
    g.strokeStyle = rgba(shadow, 0.42);
    g.lineWidth = Math.max(2, 0.010 * AY);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + s * noseW * 1.24, noseY + 0.052 * AY);
      g.quadraticCurveTo(cx + s * noseW * 1.42, noseY + 0.118 * AY, cx + s * noseW * 1.02, noseY + 0.152 * AY);
      g.stroke();
    }

    // ---- mouth ------------------------------------------------------------
    const mW = (0.215 + (variant % 4) * 0.012) * AX * (1 + E.open * 0.18);
    const open = E.open * 0.115 * AY;
    const curve = E.curve;
    const lip = mixHex(base, 0x9b3a34, 0.44);
    // philtrum
    g.strokeStyle = rgba(shadow, 0.32);
    g.lineWidth = Math.max(2, 0.013 * AY);
    g.beginPath();
    g.moveTo(cx, noseY + 0.095 * AY); g.lineTo(cx, mY - 0.070 * AY); g.stroke();

    // nasolabial folds deepen with a big smile
    if (curve > 0.4) {
      g.save();
      g.globalAlpha = 0.28 * curve;
      g.strokeStyle = rgba(shadow, 1);
      g.lineWidth = Math.max(3, 0.020 * AY);
      g.lineCap = 'round';
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx + s * noseW * 1.35, noseY + 0.05 * AY);
        g.quadraticCurveTo(cx + s * mW * 1.20, mY - 0.03 * AY, cx + s * mW * 1.02, mY + 0.06 * AY);
        g.stroke();
      }
      g.restore();
    }

    // mouth cavity when open
    if (open > 1) {
      g.fillStyle = css(mixHex(0x4a1418, base, 0.10));
      g.beginPath();
      g.moveTo(cx - mW, mY);
      g.quadraticCurveTo(cx, mY - 0.030 * AY, cx + mW, mY);
      g.quadraticCurveTo(cx + mW * 0.55, mY + open + curve * 0.03 * AY, cx, mY + open * 1.10);
      g.quadraticCurveTo(cx - mW * 0.55, mY + open + curve * 0.03 * AY, cx - mW, mY);
      g.closePath(); g.fill();
      if (E.teeth) {
        g.save();
        g.beginPath();
        g.moveTo(cx - mW, mY);
        g.quadraticCurveTo(cx, mY - 0.030 * AY, cx + mW, mY);
        g.quadraticCurveTo(cx + mW * 0.55, mY + open, cx, mY + open * 1.05);
        g.quadraticCurveTo(cx - mW * 0.55, mY + open, cx - mW, mY);
        g.closePath(); g.clip();
        // upper teeth
        g.fillStyle = '#f4f0e8';
        g.beginPath();
        g.moveTo(cx - mW, mY - 0.006 * AY);
        g.quadraticCurveTo(cx, mY - 0.036 * AY, cx + mW, mY - 0.006 * AY);
        g.lineTo(cx + mW, mY + open * 0.42);
        g.quadraticCurveTo(cx, mY + open * 0.52, cx - mW, mY + open * 0.42);
        g.closePath(); g.fill();
        // gaps between teeth
        g.strokeStyle = 'rgba(120,105,95,0.45)';
        g.lineWidth = Math.max(1.6, 0.006 * AY);
        for (let i = -2; i <= 2; i++) {
          const tx = cx + i * mW * 0.34;
          g.beginPath(); g.moveTo(tx, mY - 0.02 * AY); g.lineTo(tx, mY + open * 0.44); g.stroke();
        }
        // lower teeth on a grimace
        if (curve < 0) {
          g.fillStyle = '#e9e3d8';
          g.beginPath();
          g.moveTo(cx - mW * 0.9, mY + open * 1.02);
          g.quadraticCurveTo(cx, mY + open * 1.10, cx + mW * 0.9, mY + open * 1.02);
          g.lineTo(cx + mW * 0.9, mY + open * 0.68);
          g.quadraticCurveTo(cx, mY + open * 0.60, cx - mW * 0.9, mY + open * 0.68);
          g.closePath(); g.fill();
        }
        // shadow inside the top of the cavity
        const cg = g.createLinearGradient(0, mY - 0.03 * AY, 0, mY + open);
        cg.addColorStop(0, 'rgba(0,0,0,0.45)');
        cg.addColorStop(0.5, 'rgba(0,0,0,0)');
        g.fillStyle = cg;
        g.fillRect(cx - mW, mY - 0.04 * AY, mW * 2, open * 1.4);
        g.restore();
      }
    }

    // lips
    g.fillStyle = css(lip);
    g.beginPath();
    g.moveTo(cx - mW, mY - curve * 0.028 * AY);
    g.quadraticCurveTo(cx - mW * 0.46, mY - 0.066 * AY, cx - mW * 0.10, mY - 0.022 * AY);
    g.quadraticCurveTo(cx, mY - 0.048 * AY, cx + mW * 0.10, mY - 0.022 * AY);
    g.quadraticCurveTo(cx + mW * 0.46, mY - 0.066 * AY, cx + mW, mY - curve * 0.028 * AY);
    g.lineTo(cx + mW, mY - 0.004 * AY);
    g.quadraticCurveTo(cx, mY - 0.030 * AY, cx - mW, mY - 0.004 * AY);
    g.closePath(); g.fill();
    // lower lip
    g.fillStyle = css(lighten(lip, 0.10));
    g.beginPath();
    g.moveTo(cx - mW * 0.96, mY + open * 1.02);
    g.quadraticCurveTo(cx, mY + open * 1.06 + (0.052 + curve * 0.026) * AY, cx + mW * 0.96, mY + open * 1.02);
    g.quadraticCurveTo(cx, mY + open * 1.02 - 0.012 * AY, cx - mW * 0.96, mY + open * 1.02);
    g.closePath(); g.fill();
    // mouth line (closed mouths only)
    if (open <= 1) {
      g.strokeStyle = rgba(darken(lip, 0.70), 0.92);
      g.lineWidth = Math.max(3, 0.024 * AY);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx - mW * 0.97, mY - curve * 0.020 * AY);
      g.quadraticCurveTo(cx, mY + curve * 0.060 * AY, cx + mW * 0.97, mY - curve * 0.020 * AY);
      g.stroke();
    }
    // corner dimples
    g.fillStyle = rgba(shadow, 0.55);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * mW * 1.03, mY - curve * 0.024 * AY, 0.020 * AX, 0.024 * AY, 0, 0, TAU);
      g.fill();
    }
    // lower-lip highlight
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.beginPath();
    g.ellipse(cx, mY + open * 1.02 + 0.024 * AY, mW * 0.42, 0.013 * AY, 0, 0, TAU); g.fill();
    // chin crease + shadow
    g.save();
    g.filter = 'blur(6px)';
    g.fillStyle = rgba(shadow, 0.30);
    g.beginPath();
    g.ellipse(cx, mY + open * 1.05 + 0.150 * AY, mW * 1.15, 0.072 * AY, 0, 0, TAU); g.fill();
    g.filter = 'none';
    g.restore();
    g.fillStyle = rgba(hi, 0.20);
    g.beginPath();
    g.ellipse(cx, mY + open * 1.05 + 0.112 * AY, mW * 0.62, 0.038 * AY, 0, 0, TAU); g.fill();

    // ---- ears --------------------------------------------------------------
    // painted where the ear geometry projects, so paint and form agree
    const earXc = rawX(A.earAz) - rawX(0);
    const earY = PY(A.earTh);
    for (const s of [-1, 1]) {
      const base0 = cx + s * earXc;
      for (const off of [-W, 0, W]) {
        const ex = base0 + off;
        if (ex < -0.2 * W || ex > 1.2 * W) continue;
        const ew = 0.150 * AX, eh = 0.300 * AY;
        g.save();
        g.translate(ex, earY);
        // ear plate shading
        g.fillStyle = rgba(shadow, 0.26);
        g.beginPath(); g.ellipse(0, 0, ew * 1.18, eh * 1.02, 0, 0, TAU); g.fill();
        // helix rim, bright
        g.strokeStyle = rgba(lighten(base, 0.34), 0.75);
        g.lineWidth = Math.max(3, ew * 0.22);
        g.beginPath();
        g.ellipse(0, -eh * 0.05, ew * 0.82, eh * 0.80, 0, Math.PI * 0.10, Math.PI * 1.80);
        g.stroke();
        // antihelix
        g.strokeStyle = rgba(shadow, 0.45);
        g.lineWidth = Math.max(2, ew * 0.14);
        g.beginPath();
        g.moveTo(s * ew * 0.10, -eh * 0.48);
        g.quadraticCurveTo(-s * ew * 0.36, -eh * 0.05, s * ew * 0.04, eh * 0.34);
        g.stroke();
        // concha bowl
        g.save();
        g.filter = 'blur(4px)';
        g.fillStyle = rgba(deep, 0.62);
        g.beginPath(); g.ellipse(-s * ew * 0.16, eh * 0.05, ew * 0.42, eh * 0.42, 0, 0, TAU); g.fill();
        g.filter = 'none';
        g.restore();
        // tragus + lobe
        g.fillStyle = rgba(lighten(base, 0.16), 0.7);
        g.beginPath(); g.ellipse(-s * ew * 0.46, eh * 0.14, ew * 0.20, eh * 0.16, 0, 0, TAU); g.fill();
        g.fillStyle = rgba(lighten(base, 0.10), 0.55);
        g.beginPath(); g.ellipse(0, eh * 0.74, ew * 0.44, eh * 0.22, 0, 0, TAU); g.fill();
        g.fillStyle = rgba(shadow, 0.30);
        g.beginPath(); g.ellipse(0, eh * 0.94, ew * 0.50, eh * 0.14, 0, 0, TAU); g.fill();
        g.restore();
      }
    }

    // ---- scalp / painted hairline ------------------------------------------
    // Under the geometric hair shell we paint the scalp in the hair colour with
    // a feathered, wispy edge. That is what kills the "helmet shell with a
    // visible seam" — there is no hard boundary left to see.
    if (scalp) {
      const hc = scalp.color;
      const lineTh = (az) => scalp.front + (scalp.back - scalp.front) * (1 - Math.cos(az)) / 2;
      const N = 96;
      for (const off of [-FACE_W, 0, FACE_W]) {
        g.save();
        g.beginPath();
        g.moveTo(rawX(-Math.PI) + off, -20);
        for (let i = 0; i <= N; i++) {
          const az = -Math.PI + (i / N) * TAU;
          const jitter = (vnoise(i * 0.6, 3.1) - 0.5) * 0.055;
          g.lineTo(rawX(az) + off, PY(lineTh(az) + jitter));
        }
        g.lineTo(rawX(Math.PI) + off, -20);
        g.closePath();
        g.fillStyle = css(hc);
        g.fill();
        // shade the scalp so it is not a flat fill under the shell
        g.clip();
        const sgr = g.createLinearGradient(0, 0, 0, PY(scalp.back));
        sgr.addColorStop(0, rgba(lighten(hc, 0.22), 0.55));
        sgr.addColorStop(0.55, 'rgba(0,0,0,0)');
        sgr.addColorStop(1, rgba(darken(hc, 0.45), 0.6));
        g.fillStyle = sgr;
        g.fillRect(off - 10, -20, FACE_W + 20, PY(scalp.back) + 20);
        g.restore();
      }
      // feathered fringe wisps hanging below the hairline
      g.save();
      g.lineCap = 'round';
      const wisps = 130;
      for (let i = 0; i < wisps; i++) {
        const az = -Math.PI + (i / wisps) * TAU + (vnoise(i * 1.7, 0.4) - 0.5) * 0.06;
        const t0 = lineTh(az);
        const len = (0.035 + 0.085 * vnoise(i * 2.3, 7.7)) * (0.35 + 0.65 * scalp.fringe)
          * (0.45 + 0.55 * Math.max(0, Math.cos(az)));
        const x0 = rawX(az), x1 = rawX(az + (vnoise(i * 0.9, 2.2) - 0.5) * 0.12);
        for (const off of [-FACE_W, 0, FACE_W]) {
          if (x0 + off < -60 || x0 + off > FACE_W + 60) continue;
          g.strokeStyle = rgba(i % 4 === 0 ? lighten(hc, 0.25) : darken(hc, 0.25), 0.55);
          g.lineWidth = 2 + 4 * vnoise(i * 3.1, 1.1);
          g.beginPath();
          g.moveTo(x0 + off, PY(t0 - 0.02));
          g.quadraticCurveTo((x0 + x1) * 0.5 + off, PY(t0 + len * 0.5), x1 + off, PY(t0 + len));
          g.stroke();
        }
      }
      g.restore();
    } else {
      // bald: a desaturated, slightly shinier crown
      const sg2 = g.createLinearGradient(0, 0, 0, PY(1.10));
      sg2.addColorStop(0, rgba(mixHex(base, 0x6b4a35, 0.18), 0.30));
      sg2.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sg2; g.fillRect(0, 0, W, PY(1.10));
      g.save();
      g.globalAlpha = 0.16;
      const cg2 = g.createRadialGradient(cx, PY(0.55), 8, cx, PY(0.55), 0.55 * AX);
      cg2.addColorStop(0, '#ffffff'); cg2.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = cg2; g.fillRect(cx - 0.6 * AX, 0, 1.2 * AX, PY(0.10));
      g.restore();
    }

    return tex(c, { aniso: 16 });
  });
}

// ---------------------------------------------------------------------------
// EYEBALL
// ---------------------------------------------------------------------------
// Planar patch mapped down the eye's look axis. player.js projects the sphere
// with the same S, so the iris lands dead centre in the opening.

export const EYE_PROJ_S = 0.70;

export function eyeTexture(o = {}) {
  const iris = o.color ?? EYE_COLORS[0];
  return memo(`eye:${iris}`, () => {
    const S = 256;
    const { c, g } = canvas2d(S, S);
    const R = S / 2;

    // sclera — never paper white; a real eye reads warm grey in its socket
    g.fillStyle = '#e6dfd6'; g.fillRect(0, 0, S, S);
    // veins / warmth toward the corners
    g.save();
    g.globalAlpha = 0.30;
    const wg = g.createRadialGradient(R, R, R * 0.18, R, R, R);
    wg.addColorStop(0, 'rgba(255,255,255,0)');
    wg.addColorStop(1, 'rgba(178,128,116,1)');
    g.fillStyle = wg; g.fillRect(0, 0, S, S);
    g.restore();
    // lid shadow across the top of the ball — heavy, so the eye sits in a socket
    const lg = g.createLinearGradient(0, 0, 0, S * 0.66);
    lg.addColorStop(0, 'rgba(58,42,34,0.86)');
    lg.addColorStop(0.45, 'rgba(104,84,72,0.36)');
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lg; g.fillRect(0, 0, S, S * 0.66);
    // faint bounce from below
    const bg = g.createLinearGradient(0, S, 0, S * 0.72);
    bg.addColorStop(0, 'rgba(150,126,112,0.22)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg; g.fillRect(0, S * 0.72, S, S * 0.28);

    // Iris. The visible opening is ~45 deg of the eyeball, so a 20 deg iris
    // leaves a huge field of sclera and the eye reads as a cartoon googly.
    // 30 deg (dx = sin 30 = 0.5, patch fraction = dx / EYE_PROJ_S) fills the
    // opening the way the reference does, with the lid clipping its top.
    const IR = R * (0.5 / EYE_PROJ_S);
    const cxp = R, cyp = R + R * 0.055;

    // limbal ring
    g.fillStyle = css(darken(iris, 0.72));
    g.beginPath(); g.arc(cxp, cyp, IR * 1.06, 0, TAU); g.fill();
    // iris body
    const ig = g.createRadialGradient(cxp - IR * 0.24, cyp - IR * 0.28, IR * 0.10, cxp, cyp, IR);
    ig.addColorStop(0, css(lighten(iris, 0.52)));
    ig.addColorStop(0.55, css(iris));
    ig.addColorStop(1, css(darken(iris, 0.52)));
    g.fillStyle = ig;
    g.beginPath(); g.arc(cxp, cyp, IR, 0, TAU); g.fill();
    // radial fibres
    g.save();
    g.beginPath(); g.arc(cxp, cyp, IR * 0.98, 0, TAU); g.clip();
    g.lineCap = 'round';
    for (let i = 0; i < 42; i++) {
      const a = (i / 42) * TAU + 0.11;
      const n = vnoise(i * 2.3, 5.1);
      g.strokeStyle = rgba(n > 0.5 ? lighten(iris, 0.45) : darken(iris, 0.5), 0.30 + n * 0.25);
      g.lineWidth = IR * 0.07;
      g.beginPath();
      g.moveTo(cxp + Math.cos(a) * IR * 0.30, cyp + Math.sin(a) * IR * 0.30);
      g.lineTo(cxp + Math.cos(a) * IR * (0.86 + n * 0.14), cyp + Math.sin(a) * IR * (0.86 + n * 0.14));
      g.stroke();
    }
    // shadow from the upper lid falling onto the iris
    const sg = g.createLinearGradient(0, cyp - IR, 0, cyp + IR * 0.3);
    sg.addColorStop(0, 'rgba(0,0,0,0.42)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg; g.fillRect(cxp - IR, cyp - IR, IR * 2, IR * 1.4);
    g.restore();
    // pupil
    g.fillStyle = '#08090c';
    g.beginPath(); g.arc(cxp, cyp, IR * 0.38, 0, TAU); g.fill();
    // catchlight: one crisp specular, one dim bounce from the turf below
    g.fillStyle = 'rgba(255,255,255,0.97)';
    g.beginPath(); g.arc(cxp - IR * 0.34, cyp - IR * 0.40, IR * 0.175, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.34)';
    g.beginPath(); g.arc(cxp + IR * 0.30, cyp + IR * 0.36, IR * 0.095, 0, TAU); g.fill();

    // everything outside the visible cap is buried in the skull; keep it dark so
    // no bright sliver can ever leak at a grazing angle
    g.save();
    g.globalCompositeOperation = 'multiply';
    const eg = g.createRadialGradient(R, R, R * 0.80, R, R, R * 1.02);
    eg.addColorStop(0, '#ffffff');
    eg.addColorStop(1, '#2a2018');
    g.fillStyle = eg; g.fillRect(0, 0, S, S);
    g.restore();

    return tex(c, { aniso: 8, clamp: true });
  });
}

// ---------------------------------------------------------------------------
// HAIR ATLAS — one texture, two zones:
//   u < 0.5   opaque, with strand streaks   (shells, buns, crests, beards)
//   u > 0.5   alpha strand card             (fringe, nape, flyaways, afro fuzz)
// One material for all hair, so alpha cards cost no extra draw call.
// ---------------------------------------------------------------------------

export function hairAtlas() {
  return memo('hairAtlas', () => {
    const W = 512, H = 256;
    const { c, g } = canvas2d(W, H);
    g.clearRect(0, 0, W, H);

    // -- opaque half: white with soft strand streaks (multiplied by vertex colour)
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W / 2, H);
    g.save();
    g.globalAlpha = 0.5;
    g.lineCap = 'round';
    for (let i = 0; i < 130; i++) {
      const x = (i / 130) * (W / 2) + (vnoise(i * 1.7, 0.3) - 0.5) * 3;
      const n = vnoise(i * 3.1, 2.2);
      g.strokeStyle = n > 0.5 ? `rgba(255,255,255,${0.35 + n * 0.4})` : `rgba(96,84,72,${0.16 + n * 0.30})`;
      g.lineWidth = 1 + n * 2.6;
      g.beginPath();
      g.moveTo(x, -4);
      g.bezierCurveTo(x + 6, H * 0.35, x - 5, H * 0.7, x + 2, H + 4);
      g.stroke();
    }
    g.restore();

    // -- alpha half: a fan of tapered strands, fully transparent between them
    g.save();
    g.translate(W / 2, 0);
    g.lineCap = 'round';
    for (let i = 0; i < 30; i++) {
      const t = i / 29;
      const x0 = 10 + t * (W / 2 - 20) + (vnoise(i * 2.7, 4.4) - 0.5) * 8;
      const sway = (vnoise(i * 1.3, 9.1) - 0.5) * 34;
      const len = H * (0.62 + 0.38 * vnoise(i * 5.5, 3.3));
      const wid = 3 + 7 * vnoise(i * 0.9, 6.6);
      const grad = g.createLinearGradient(0, 0, 0, len);
      const lum = 150 + Math.floor(105 * vnoise(i * 4.1, 1.9));
      grad.addColorStop(0, `rgba(${lum},${lum},${lum},1)`);
      grad.addColorStop(0.62, `rgba(${lum},${lum},${lum},0.95)`);
      grad.addColorStop(1, `rgba(${lum},${lum},${lum},0)`);
      g.strokeStyle = grad;
      g.lineWidth = wid;
      g.beginPath();
      g.moveTo(x0, -6);
      g.quadraticCurveTo(x0 + sway * 0.4, len * 0.55, x0 + sway, len);
      g.stroke();
    }
    // a solid band at the very top so cards never show a gap at their root
    const rg = g.createLinearGradient(0, 0, 0, H * 0.14);
    rg.addColorStop(0, 'rgba(225,225,225,1)');
    rg.addColorStop(1, 'rgba(225,225,225,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W / 2, H * 0.14);
    g.restore();

    return tex(c, { aniso: 8 });
  });
}

// ---------------------------------------------------------------------------
// FABRIC — shared weave normal
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
        const wu = Math.sin((x / S) * TAU * 28);
        const wv = Math.sin((y / S) * TAU * 28);
        const weave = (Math.abs(wu) > Math.abs(wv) ? wu : wv) * 0.5;
        h[y * S + x] = weave * 0.5 + (vnoise(x / 2.2, y / 2.2) - 0.5) * 0.45
          + (vnoise(x / 9, y / 9) - 0.5) * 0.30;
      }
    }
    const at = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * 1.5;
        const dy = (at(x, y + 1) - at(x, y - 1)) * 1.5;
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

/** very faint woven tone laid over a kit panel so it is not flat plastic */
function weaveOverlay(g, W, H, alpha = 0.05) {
  g.save();
  g.globalAlpha = alpha;
  for (let y = 0; y < H; y += 4) {
    g.fillStyle = '#ffffff'; g.fillRect(0, y, W, 1);
    g.fillStyle = '#000000'; g.fillRect(0, y + 2, W, 1);
  }
  g.globalAlpha = alpha * 0.55;
  for (let x = 0; x < W; x += 4) {
    g.fillStyle = '#ffffff'; g.fillRect(x, 0, 1, H);
    g.fillStyle = '#000000'; g.fillRect(x + 2, 0, 1, H);
  }
  g.globalAlpha = alpha * 1.5;
  for (let y = 0; y < H; y += 5) {
    for (let x = 0; x < W; x += 5) {
      const n = vnoise(x / 5, y / 5);
      if (n > 0.64) { g.fillStyle = '#ffffff'; g.fillRect(x, y, 2, 2); }
      else if (n < 0.34) { g.fillStyle = '#000000'; g.fillRect(x, y, 2, 2); }
    }
  }
  g.restore();
}

/** cylindrical AO: darker at the sides so a lathe body reads round */
function roundShade(g, W, H, front = 0.25, strength = 1) {
  const sh = g.createLinearGradient(0, 0, W, 0);
  for (let i = 0; i <= 32; i++) {
    const u = i / 32;
    const a = Math.cos((u - front) * TAU);        // 1 facing camera-front
    const v = a * 0.5 + 0.5;
    const c = v > 0.5
      ? `rgba(255,255,255,${(v - 0.5) * 0.24 * strength})`
      : `rgba(0,0,0,${(0.5 - v) * 0.46 * strength})`;
    sh.addColorStop(u, c);
  }
  g.fillStyle = sh; g.fillRect(0, 0, W, H);
}

/** soft elliptical AO blob */
function aoBlob(g, x, y, rx, ry, a, col = '#000000') {
  const gr = g.createRadialGradient(x, y, 1, x, y, 1);
  // radial gradients cannot be elliptical: scale the space instead
  g.save();
  g.translate(x, y); g.scale(rx / ry, 1);
  const r = g.createRadialGradient(0, 0, ry * 0.15, 0, 0, ry);
  r.addColorStop(0, col === '#000000' ? `rgba(0,0,0,${a})` : col);
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(-ry * 1.05, -ry * 1.05, ry * 2.1, ry * 2.1);
  g.restore();
  void gr;
}

// ---------------------------------------------------------------------------
// kit graphics
// ---------------------------------------------------------------------------

const NUM_FONT = '900 %spx "Arial Black", "Arial Bold", Impact, "Trebuchet MS", sans-serif';

/**
 * Squad number. One crisp contrast edge, one tight drop shadow — no soft
 * double-stroke, which is what made the old numbers read as a blurry decal.
 */
function squadNumber(g, n, x, y, size, fill, edge) {
  const s = String(n);
  g.save();
  g.translate(x, y);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = NUM_FONT.replace('%s', String(Math.round(size)));
  g.lineJoin = 'round'; g.miterLimit = 2;
  // contact shadow, offset not blurred, so the edge stays razor sharp
  g.fillStyle = 'rgba(0,0,0,0.34)';
  g.fillText(s, size * 0.035, size * 0.055);
  // contrast edge
  g.lineWidth = size * 0.115;
  g.strokeStyle = css(edge);
  g.strokeText(s, 0, 0);
  g.fillStyle = css(fill);
  g.fillText(s, 0, 0);
  // top-lit sheen across the upper half of the glyph
  g.save();
  g.beginPath();
  g.rect(-size, -size, size * 2, size * 0.52);
  g.clip();
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillText(s, 0, 0);
  g.restore();
  g.restore();
}

/** readable club crest. `shape` picks the silhouette so the two clubs differ. */
function crest(g, x, y, s, shell, field, ink, letter, shape = 'shield') {
  g.save();
  g.translate(x, y); g.scale(s, s);
  const path = shape === 'round'
    ? () => {
      // roundel with a flat top bar — a visibly different club identity
      g.beginPath();
      g.moveTo(-28, -26);
      g.lineTo(28, -26);
      g.lineTo(28, -6);
      g.arc(0, -6, 28, 0, Math.PI);
      g.closePath();
    }
    : () => {
      g.beginPath();
      g.moveTo(-26, -30); g.lineTo(26, -30); g.lineTo(26, 6);
      g.bezierCurveTo(26, 26, 14, 36, 0, 42);
      g.bezierCurveTo(-14, 36, -26, 26, -26, 6);
      g.closePath();
    };
  path();
  g.fillStyle = css(shell); g.fill();
  g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.stroke();
  g.save();
  path(); g.clip();
  g.fillStyle = css(field);
  g.fillRect(-30, -34, 60, 30);
  g.fillStyle = css(darken(field, 0.28));
  g.fillRect(-30, -8, 60, 8);
  // initial
  g.fillStyle = css(ink);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '900 30px "Arial Black", Impact, sans-serif';
  g.fillText(letter, 0, 14);
  // star
  g.fillStyle = css(ink);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 3.6 : 8;
    const px = Math.cos(a) * r, py = -18 + Math.sin(a) * r;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath(); g.fill();
  // gloss
  const gg = g.createLinearGradient(0, -34, 0, 12);
  gg.addColorStop(0, 'rgba(255,255,255,0.30)');
  gg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gg; g.fillRect(-30, -34, 60, 46);
  g.restore();
  g.restore();
}

/** small angular maker mark */
function makerMark(g, x, y, s, col) {
  g.save();
  g.translate(x, y); g.scale(s, s);
  g.fillStyle = css(col);
  g.globalAlpha = 0.92;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.moveTo(-16 + i * 11, 8);
    g.lineTo(-8 + i * 11, -8 + i * 2);
    g.lineTo(-3 + i * 11, -8 + i * 2);
    g.lineTo(-11 + i * 11, 8);
    g.closePath(); g.fill();
  }
  g.restore();
}

function sponsor(g, x, y, w, text, col) {
  g.save();
  g.translate(x, y);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `800 ${Math.round(w * 0.20)}px "Trebuchet MS", "Arial", sans-serif`;
  const m = g.measureText(text).width || 1;
  g.scale(Math.min(1.6, w / m), 1);
  g.fillStyle = 'rgba(0,0,0,0.30)';
  g.fillText(text, 2, 2);
  g.fillStyle = css(col);
  g.fillText(text, 0, 0);
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
  const letter = o.letter ?? 'C';
  const name = o.name ?? '';
  const R = o.recipe ?? KIT_RECIPES[0];
  const key = `shirt:${kit}:${trim}:${alt}:${number}:${style}:${letter}:${name}`
    + `:${R.body}:${R.shoulder}:${R.collar}:${R.crest}:${R.sidePanel ? 1 : 0}`;

  return memo(key, () => {
    const W = 1280, H = 640;
    const { c, g } = canvas2d(W, H);
    const FRONT = W * 0.25, BACK = W * 0.75;

    g.fillStyle = css(kit); g.fillRect(0, 0, W, H);

    // ---- body graphic ------------------------------------------------------
    const body = style === 'keeper' ? 'keeper' : R.body;
    if (body === 'stripes') {
      g.fillStyle = css(alt);
      for (let i = 0; i < 9; i++) g.fillRect((i * 2 + 0.5) * (W / 18), 0, W / 18, H);
    } else if (body === 'pinstripe') {
      // tonal ground stripes, then one bold contrast pair per quarter so the
      // shirt still reads as striped from the far touchline
      g.save(); g.globalAlpha = 0.16; g.fillStyle = css(darken(kit, 0.62));
      for (let x = 0; x < W; x += 22) g.fillRect(x, 0, 9, H);
      g.restore();
      g.fillStyle = css(alt);
      for (const u of [0.14, 0.36, 0.64, 0.86]) {
        g.fillRect(W * u - W * 0.021, 0, W * 0.042, H);
      }
      g.fillStyle = rgba(trim, 0.72);
      for (const u of [0.14, 0.36, 0.64, 0.86]) {
        g.fillRect(W * u - W * 0.027, 0, W * 0.006, H);
        g.fillRect(W * u + W * 0.021, 0, W * 0.006, H);
      }
    } else if (body === 'hoops') {
      g.fillStyle = css(alt);
      for (let i = 0; i < 4; i++) g.fillRect(0, H * (0.14 + i * 0.20), W, H * 0.095);
    } else if (body === 'sash') {
      // a real sash: bordered, and mirrored on the back so the wrap is coherent
      for (const [x0, dir] of [[0.06, 1], [0.94, -1]]) {
        g.save();
        g.beginPath();
        g.moveTo(W * x0, H);
        g.lineTo(W * (x0 + dir * 0.34), 0);
        g.lineTo(W * (x0 + dir * 0.475), 0);
        g.lineTo(W * (x0 + dir * 0.135), H);
        g.closePath();
        g.fillStyle = css(trim); g.fill();
        g.lineWidth = H * 0.016; g.strokeStyle = rgba(darken(kit, 0.45), 0.85); g.stroke();
        g.restore();
      }
    } else if (body === 'halves') {
      g.fillStyle = css(alt);
      g.fillRect(0, 0, W * 0.25, H); g.fillRect(W * 0.75, 0, W * 0.25, H);
    } else if (body === 'keeper') {
      g.fillStyle = css(darken(kit, 0.34));
      g.fillRect(0, 0, W, H * 0.30);
      g.fillStyle = css(lighten(kit, 0.42));
      g.fillRect(0, H * 0.46, W, H * 0.075);
      g.fillStyle = css(darken(kit, 0.22));
      g.fillRect(0, H * 0.535, W, H * 0.030);
      g.save(); g.globalAlpha = 0.12; g.fillStyle = css(darken(kit, 0.7));
      for (let x = 0; x < W; x += 26) { g.fillRect(x, 0, 13, H); }
      g.restore();
    }

    // ---- shoulder construction --------------------------------------------
    // The reference kits all break at the shoulder somehow — a yoke, a raglan
    // seam, or angled panels. It is the cheapest way to make two clubs in the
    // same palette read as different manufacturers' templates.
    if (R.shoulder === 'yoke') {
      g.fillStyle = css(alt); g.fillRect(0, 0, W, H * 0.185);
      g.fillStyle = rgba(trim, 0.9); g.fillRect(0, H * 0.185, W, H * 0.016);
    } else if (R.shoulder === 'chevron') {
      g.save();
      for (const cxq of [FRONT, BACK]) {
        for (const s of [-1, 1]) {
          g.beginPath();
          g.moveTo(cxq + s * W * 0.030, 0);
          g.lineTo(cxq + s * W * 0.255, 0);
          g.lineTo(cxq + s * W * 0.255, H * 0.135);
          g.lineTo(cxq + s * W * 0.052, H * 0.245);
          g.closePath();
          g.fillStyle = css(alt); g.fill();
          g.lineWidth = H * 0.013; g.strokeStyle = rgba(trim, 0.85); g.stroke();
        }
      }
      g.restore();
    } else if (R.shoulder === 'raglan') {
      g.save();
      for (const cxq of [FRONT, BACK]) {
        for (const s of [-1, 1]) {
          g.beginPath();
          g.moveTo(cxq + s * W * 0.062, 0);
          g.quadraticCurveTo(cxq + s * W * 0.150, H * 0.075, cxq + s * W * 0.255, H * 0.285);
          g.lineTo(cxq + s * W * 0.255, 0);
          g.closePath();
          g.fillStyle = css(alt); g.fill();
          g.lineWidth = H * 0.014; g.strokeStyle = rgba(trim, 0.80); g.stroke();
        }
      }
      g.restore();
    }

    // contrast flank panel
    if (R.sidePanel) {
      for (const u of [0.0, 0.5, 1.0]) {
        g.fillStyle = rgba(alt, 0.95);
        g.fillRect(W * u - W * 0.024, H * 0.16, W * 0.048, H * 0.84);
        g.fillStyle = rgba(trim, 0.85);
        g.fillRect(W * u - W * 0.031, H * 0.16, W * 0.007, H * 0.84);
        g.fillRect(W * u + W * 0.024, H * 0.16, W * 0.007, H * 0.84);
      }
    }

    weaveOverlay(g, W, H, 0.040);
    roundShade(g, W, H, 0.25, 0.95);

    // ---- construction: seams the eye can find -----------------------------
    // shoulder / sleeve seam arcs at the two sides (u = 0 and u = 0.5)
    g.save();
    g.lineCap = 'round';
    for (const u of [0.0, 0.5, 1.0]) {
      const x = W * u;
      g.strokeStyle = 'rgba(0,0,0,0.34)';
      g.lineWidth = H * 0.012;
      g.beginPath();
      g.moveTo(x - W * 0.055, H * 0.05);
      g.quadraticCurveTo(x, H * 0.20, x + W * 0.055, H * 0.05);
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.lineWidth = H * 0.006;
      g.beginPath();
      g.moveTo(x - W * 0.054, H * 0.062);
      g.quadraticCurveTo(x, H * 0.208, x + W * 0.054, H * 0.062);
      g.stroke();
    }
    // side panel seams running the length of the shirt
    for (const u of [0.0, 0.5, 1.0]) {
      const x = W * u;
      g.strokeStyle = 'rgba(0,0,0,0.22)';
      g.lineWidth = H * 0.007;
      g.beginPath(); g.moveTo(x, H * 0.16); g.lineTo(x, H); g.stroke();
      g.strokeStyle = rgba(trim, 0.42);
      g.lineWidth = H * 0.010;
      g.beginPath(); g.moveTo(x + W * 0.008, H * 0.18); g.lineTo(x + W * 0.008, H * 0.96); g.stroke();
    }
    g.restore();

    // ---- ambient occlusion -------------------------------------------------
    // armpits: deep shade where the sleeve meets the body
    for (const u of [0.0, 0.5, 1.0]) {
      aoBlob(g, W * u, H * 0.24, W * 0.075, H * 0.20, 0.55);
    }
    // under the collar, all the way round, strongest front and back
    const cg = g.createLinearGradient(0, 0, 0, H * 0.24);
    cg.addColorStop(0, 'rgba(0,0,0,0.42)');
    cg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = cg; g.fillRect(0, 0, W, H * 0.24);
    aoBlob(g, FRONT, H * 0.045, W * 0.11, H * 0.13, 0.40);
    aoBlob(g, BACK, H * 0.045, W * 0.11, H * 0.13, 0.46);
    // waist: the shirt falls over the shorts, so the hem sits in shade
    const hg = g.createLinearGradient(0, H, 0, H * 0.80);
    hg.addColorStop(0, 'rgba(0,0,0,0.46)');
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = hg; g.fillRect(0, H * 0.80, W, H * 0.20);

    // hem band
    g.fillStyle = rgba(darken(kit, 0.5), 0.85); g.fillRect(0, H * 0.962, W, H * 0.038);
    g.fillStyle = rgba(trim, 0.9); g.fillRect(0, H * 0.944, W, H * 0.014);

    // ---- collar ------------------------------------------------------------
    g.fillStyle = css(trim); g.fillRect(0, 0, W, H * 0.062);
    g.fillStyle = rgba(darken(trim, 0.40), 0.6); g.fillRect(0, H * 0.058, W, H * 0.012);
    if (R.collar === 'v') {
      g.fillStyle = css(darken(kit, 0.34));
      g.beginPath();
      g.moveTo(FRONT - W * 0.046, H * 0.062);
      g.lineTo(FRONT + W * 0.046, H * 0.062);
      g.lineTo(FRONT, H * 0.165);
      g.closePath(); g.fill();
      g.strokeStyle = css(trim); g.lineWidth = H * 0.016; g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(FRONT - W * 0.049, H * 0.060);
      g.lineTo(FRONT, H * 0.172);
      g.lineTo(FRONT + W * 0.049, H * 0.060);
      g.stroke();
    } else if (R.collar === 'polo') {
      // a laid-flat polo: two wings either side of a buttoned placket
      g.fillStyle = css(alt);
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(FRONT + s * W * 0.016, H * 0.052);
        g.lineTo(FRONT + s * W * 0.098, H * 0.052);
        g.lineTo(FRONT + s * W * 0.070, H * 0.135);
        g.lineTo(FRONT + s * W * 0.014, H * 0.118);
        g.closePath(); g.fill();
        g.lineWidth = H * 0.011; g.strokeStyle = rgba(trim, 0.9); g.stroke();
      }
      g.fillStyle = css(darken(kit, 0.30));
      g.fillRect(FRONT - W * 0.017, H * 0.052, W * 0.034, H * 0.130);
      g.strokeStyle = rgba(trim, 0.85); g.lineWidth = H * 0.008;
      g.beginPath();
      g.moveTo(FRONT - W * 0.017, H * 0.052); g.lineTo(FRONT - W * 0.017, H * 0.182);
      g.moveTo(FRONT + W * 0.017, H * 0.052); g.lineTo(FRONT + W * 0.017, H * 0.182);
      g.stroke();
      g.fillStyle = css(trim);
      for (const y of [0.086, 0.140]) {
        g.beginPath(); g.arc(FRONT, H * y, H * 0.012, 0, TAU); g.fill();
      }
    } else {
      // crew: a ribbed band, thicker at the front
      g.fillStyle = css(alt);
      g.fillRect(0, H * 0.052, W, H * 0.048);
      g.save(); g.globalAlpha = 0.28;
      for (let x = 0; x < W; x += 9) {
        g.fillStyle = '#000000'; g.fillRect(x, H * 0.052, 3, H * 0.048);
      }
      g.restore();
      g.fillStyle = rgba(trim, 0.9); g.fillRect(0, H * 0.100, W, H * 0.010);
    }

    // shoulder yoke light
    const yg = g.createLinearGradient(0, 0, 0, H * 0.30);
    yg.addColorStop(0, 'rgba(255,255,255,0.20)');
    yg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = yg; g.fillRect(0, 0, W, H * 0.30);

    // ---- identity ---------------------------------------------------------
    const numFill = contrastOn(kit) === 0xffffff ? 0xffffff : 0x14171c;
    const numEdge = numFill === 0xffffff ? darken(kit, 0.62) : lighten(kit, 0.7);

    crest(g, FRONT + W * 0.090, H * 0.268, 0.78, trim, kit, contrastOn(trim), letter, R.crest);
    makerMark(g, FRONT - W * 0.090, H * 0.258, 0.82, trim);
    sponsor(g, FRONT, H * 0.430, W * 0.150, 'CANVAS', numFill);
    // The number had been scaled so large it wrapped past the side seams and
    // read as a decal smeared round the ribs. Chest numbers are small.
    squadNumber(g, number, FRONT, H * 0.680, H * 0.230, numFill, numEdge);

    // back: name arc over a big number
    g.save();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `800 ${Math.round(H * 0.080)}px "Trebuchet MS", Arial, sans-serif`;
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fillText(name, BACK + 2, H * 0.268);
    g.fillStyle = css(numFill);
    g.fillText(name, BACK, H * 0.266);
    g.restore();
    squadNumber(g, number, BACK, H * 0.600, H * 0.335, numFill, numEdge);

    return tex(c, { aniso: 16 });
  });
}

// ---------------------------------------------------------------------------
// SLEEVE / ARM
// ---------------------------------------------------------------------------
// One texture serves the upper arm and (v-remapped in player.js) the forearm.
// v = 1 shoulder, v = 0 elbow. Sleeve -> trim cuff -> bare skin, so short
// sleeves need no extra mesh.

export function armTexture(o = {}) {
  const kit = o.kit ?? 0xd8262c;
  const trim = o.trim ?? 0xffffff;
  const skin = o.skin ?? SKIN_TONES[2];
  const alt = o.alt ?? darken(kit, 0.4);
  const long = !!o.long;
  const glove = o.glove ?? 0;
  const rc = o.recipe ?? KIT_RECIPES[0];
  const key = `arm:${kit}:${trim}:${skin}:${alt}:${long ? 1 : 0}:${glove}`
    + `:${o.style}:${rc.sleeve}:${rc.cuffHoops}`;

  return memo(key, () => {
    const W = 384, H = 384;
    const { c, g } = canvas2d(W, H);
    const cuff = long ? 0.14 : 0.46;      // fraction of the strip that is bare
    const cy = H * (1 - cuff);

    // bare skin below the cuff
    g.fillStyle = css(skin); g.fillRect(0, 0, W, H);
    // deltoid/biceps shading down the bare arm
    const skg = g.createLinearGradient(0, cy, 0, H);
    skg.addColorStop(0, rgba(darken(skin, 0.30), 0.55));
    skg.addColorStop(0.35, 'rgba(0,0,0,0)');
    skg.addColorStop(1, rgba(darken(skin, 0.24), 0.42));
    g.fillStyle = skg; g.fillRect(0, cy, W, H - cy);

    // glove zone for a keeper (the hand geometry samples the bottom of the strip)
    if (glove) {
      const gy = H * 0.80;
      g.fillStyle = css(glove); g.fillRect(0, gy, W, H - gy);
      g.fillStyle = css(darken(glove, 0.45));
      g.fillRect(0, gy, W, H * 0.022);
      g.save(); g.globalAlpha = 0.5;
      for (let i = 0; i < 6; i++) {
        g.fillStyle = css(darken(glove, 0.35));
        g.fillRect(W * (0.06 + i * 0.16), gy + H * 0.03, W * 0.012, H * 0.17);
      }
      g.restore();
      g.fillStyle = rgba(lighten(glove, 0.5), 0.5);
      g.fillRect(0, H * 0.955, W, H * 0.045);
    }

    // ---- sleeve ------------------------------------------------------------
    // Sleeves are where club templates diverge most visibly in the reference:
    // one club wears a solid contrasting sleeve, the next a panel split down
    // the outer arm, the next the body pattern carried through.
    const R = o.recipe ?? KIT_RECIPES[0];
    const sleeveBase = R.sleeve === 'contrast' ? alt : kit;
    g.fillStyle = css(sleeveBase); g.fillRect(0, 0, W, cy);
    if (R.sleeve === 'panel') {
      // outer half of the sleeve in the contrast colour, split by a trim seam.
      // u = 0.25 is the front of the arm, u = 0.75 the back.
      g.fillStyle = css(alt);
      g.fillRect(0, 0, W * 0.24, cy);
      g.fillRect(W * 0.76, 0, W * 0.24, cy);
      g.fillStyle = rgba(trim, 0.85);
      g.fillRect(W * 0.24 - W * 0.012, 0, W * 0.024, cy);
      g.fillRect(W * 0.76 - W * 0.012, 0, W * 0.024, cy);
    } else if (R.sleeve === 'contrast') {
      // carry one body stripe onto the sleeve so it belongs to the same shirt
      g.fillStyle = rgba(trim, 0.55);
      g.fillRect(W * 0.24, 0, W * 0.014, cy);
      g.fillRect(W * 0.74, 0, W * 0.014, cy);
    } else if (o.style === 'stripes') {
      g.fillStyle = css(alt);
      for (let i = 0; i < 9; i++) g.fillRect((i * 2 + 0.5) * (W / 18), 0, W / 18, cy);
    } else if (o.style === 'keeper') {
      g.fillStyle = css(darken(kit, 0.34));
      g.fillRect(0, 0, W, cy * 0.34);
      g.fillStyle = css(lighten(kit, 0.42));
      g.fillRect(0, cy * 0.60, W, cy * 0.07);
    }
    weaveOverlay(g, W, cy, 0.05);

    // shoulder seam at the very top
    g.fillStyle = 'rgba(0,0,0,0.34)'; g.fillRect(0, 0, W, H * 0.020);
    g.fillStyle = rgba(trim, 0.85); g.fillRect(0, H * 0.026, W, H * 0.028);
    // cuff: one or two trim hoops, per club
    const hoops = R.cuffHoops ?? 1;
    g.fillStyle = css(trim); g.fillRect(0, cy - H * 0.048, W, H * 0.048);
    if (hoops >= 2) {
      g.fillStyle = css(alt); g.fillRect(0, cy - H * 0.036, W, H * 0.014);
      g.fillStyle = css(trim); g.fillRect(0, cy - H * 0.022, W, H * 0.022);
    }
    g.fillStyle = rgba(darken(kit, 0.55), 0.55); g.fillRect(0, cy - H * 0.061, W, H * 0.013);
    g.fillStyle = rgba(darken(trim, 0.45), 0.45); g.fillRect(0, cy - H * 0.006, W, H * 0.006);

    // elbow / wrist AO on the bare arm
    const wg = g.createLinearGradient(0, H, 0, H * 0.90);
    wg.addColorStop(0, 'rgba(0,0,0,0.30)');
    wg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = wg; g.fillRect(0, H * 0.90, W, H * 0.10);

    roundShade(g, W, H, 0.25, 1.05);
    return tex(c, { aniso: 16 });
  });
}

// ---------------------------------------------------------------------------
// SHORTS  (lathe: u 0.25 front, 0.75 back; v 1 waist, v 0 hem)
// ---------------------------------------------------------------------------

export function shortsTexture(o = {}) {
  const base = o.color ?? 0xf2f2f2;
  const trim = o.trim ?? 0xd8262c;
  const kit = o.kit ?? trim;
  const long = !!o.long;
  return memo(`shorts:${base}:${trim}:${kit}:${long ? 1 : 0}`, () => {
    const W = 768, H = 384;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = css(base); g.fillRect(0, 0, W, H);
    weaveOverlay(g, W, H, 0.055);

    // side panels at the hips (u = 0 and u = 0.5)
    for (const u of [0.0, 0.5, 1.0]) {
      const x = W * u;
      g.fillStyle = rgba(trim, 0.92);
      g.fillRect(x - W * 0.016, H * 0.06, W * 0.032, H * 0.82);
      g.fillStyle = rgba(darken(trim, 0.45), 0.35);
      g.fillRect(x + W * 0.016, H * 0.06, W * 0.007, H * 0.82);
      g.strokeStyle = 'rgba(0,0,0,0.20)';
      g.lineWidth = H * 0.008;
      g.beginPath(); g.moveTo(x - W * 0.024, H * 0.06); g.lineTo(x - W * 0.024, H * 0.88); g.stroke();
    }

    // waistband
    g.fillStyle = css(darken(base, 0.20)); g.fillRect(0, 0, W, H * 0.125);
    g.fillStyle = css(trim); g.fillRect(0, H * 0.100, W, H * 0.026);
    g.fillStyle = rgba(lighten(base, 0.4), 0.35); g.fillRect(0, 0, W, H * 0.014);
    // drawstring at the front
    g.strokeStyle = rgba(trim, 0.9); g.lineWidth = H * 0.015; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(W * 0.232, H * 0.038); g.lineTo(W * 0.25, H * 0.096); g.lineTo(W * 0.268, H * 0.038);
    g.stroke();

    // leg-opening hem
    g.fillStyle = rgba(darken(base, 0.34), 0.65); g.fillRect(0, H * 0.935, W, H * 0.065);
    g.fillStyle = rgba(trim, 0.55); g.fillRect(0, H * 0.918, W, H * 0.012);
    if (long) {
      g.fillStyle = rgba(darken(base, 0.18), 0.5);
      g.fillRect(0, H * 0.70, W, H * 0.22);
    }

    // AO: the shirt hem sits over the top of the shorts
    const tg = g.createLinearGradient(0, 0, 0, H * 0.26);
    tg.addColorStop(0, 'rgba(0,0,0,0.42)');
    tg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = tg; g.fillRect(0, 0, W, H * 0.26);
    // AO in the crotch / inner thigh, front and back
    aoBlob(g, W * 0.25, H * 1.02, W * 0.075, H * 0.30, 0.42);
    aoBlob(g, W * 0.75, H * 1.02, W * 0.075, H * 0.30, 0.42);

    roundShade(g, W, H, 0.25, 0.95);
    return tex(c, { aniso: 16 });
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
    g.fillStyle = css(trim); g.fillRect(0, 0, W, H * 0.185);
    g.fillStyle = rgba(darken(base, 0.40), 0.6); g.fillRect(0, H * 0.185, W, H * 0.030);
    g.fillStyle = rgba(trim, 0.8); g.fillRect(0, H * 0.285, W, H * 0.045);

    // rib knit
    g.save(); g.globalAlpha = 0.085;
    for (let x = 0; x < W; x += 7) {
      g.fillStyle = '#000000'; g.fillRect(x, 0, 3, H);
      g.fillStyle = '#ffffff'; g.fillRect(x + 3, 0, 2, H);
    }
    g.restore();
    weaveOverlay(g, W, H, 0.05);

    // shin-pad bulge highlight at the front
    g.save();
    g.globalAlpha = 0.20;
    const bg = g.createLinearGradient(W * 0.17, 0, W * 0.33, 0);
    bg.addColorStop(0, 'rgba(255,255,255,0)');
    bg.addColorStop(0.5, 'rgba(255,255,255,1)');
    bg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = bg; g.fillRect(W * 0.17, H * 0.25, W * 0.16, H * 0.5);
    g.restore();

    // ankle shading
    const ag = g.createLinearGradient(0, H * 0.78, 0, H);
    ag.addColorStop(0, 'rgba(0,0,0,0)');
    ag.addColorStop(1, rgba(darken(base, 0.55), 0.75));
    g.fillStyle = ag; g.fillRect(0, H * 0.78, W, H * 0.22);

    roundShade(g, W, H, 0.25);
    return tex(c, { aniso: 16 });
  });
}

export function gloveTexture(o = {}) {
  const base = o.color ?? 0xf2f4f7;
  const accent = o.accent ?? 0xff3b30;
  return memo(`glove:${base}:${accent}`, () => {
    const W = 256, H = 256;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = css(base); g.fillRect(0, 0, W, H);
    g.fillStyle = css(accent); g.fillRect(0, H * 0.70, W, H * 0.16);
    g.fillStyle = rgba(darken(base, 0.5), 0.5);
    for (let i = 0; i < 5; i++) g.fillRect(W * (0.08 + i * 0.19), 0, W * 0.016, H * 0.64);
    g.fillStyle = rgba(lighten(base, 0.5), 0.5);
    g.fillRect(0, H * 0.90, W, H * 0.10);
    weaveOverlay(g, W, H, 0.08);
    roundShade(g, W, H, 0.25);
    return tex(c, { aniso: 8 });
  });
}

export function skinMaterialColor(skin) { return skin; }
