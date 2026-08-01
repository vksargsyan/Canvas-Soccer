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
  // Eyes set wider: at 0.31 the pair occupied only ~30 % of the head width and
  // left two blank cheeks either side. The reference sits them nearer 36 %.
  eyeAz: 0.352, eyeTh: 1.382,
  // eye socket: half-angles of the carved dish, and its depth in skull radii
  socketH: 0.360, socketUp: 0.105, socketDn: 0.155, socketD: 0.070,
  // eyeball, in head radii (tuned so the rim ellipse lands on the ball)
  eyeR: 0.17400, eyeC: 0.79600,
  // Rim of the eye opening, in radians off the eye axis. An adult eye is a
  // narrow almond — roughly 2 : 1 — not the near-circle a cartoon default gives.
  // The upper lid sits low enough to clip the top of the iris, which is what
  // stops the eye reading as a startled googly ball.
  rimH: 0.128, rimUp: 0.0490, rimDn: 0.0680,
  browTh: 1.204,
  noseTh: 1.566,
  mouthTh: 1.778,
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
// `ang` is deliberately small and signed the other way from the first cut: a
// brow whose outer end drops hard reads as permanently worried, and every
// player on the pitch wearing the same worried face is worse than no variation.
export const BROW_SHAPES = [
  { w: 0.180, th: 0.0500, arch: 0.30, ang: -0.05 },
  { w: 0.194, th: 0.0610, arch: 0.14, ang: -0.09 },
  { w: 0.170, th: 0.0430, arch: 0.42, ang: 0.02 },
  { w: 0.202, th: 0.0680, arch: 0.09, ang: -0.12 },
  { w: 0.184, th: 0.0540, arch: 0.32, ang: -0.07 },
  { w: 0.174, th: 0.0460, arch: 0.22, ang: 0.04 },
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

// The head is the one part of a chibi that the camera ever gets close to, and
// at 1024 x 640 the face carried roughly one texel per screen pixel in a
// closeup — enough for a shape to exist, not enough for it to have an edge,
// which is the "textured at low resolution, reads mushy against a sharp
// background" note. Every anatomical constant in here is in RADIANS of skull
// arc and scales with AX / AY automatically; the only resolution-bound numbers
// are the hand-tuned blur radii, which go through blurPx().
// BACKED OUT to 1024 x 640. At 1280 x 800 a cold boot stopped reaching
// __debug.ready inside 23 minutes under headless SwiftShader, against about
// four minutes at 1024 on the same box — and heads are memoised per
// (skin, variant, brow, stubble, scalp, EXPRESSION), so a squad of 22 can hold
// several dozen of these maps and every one of them costs an upload and a
// mipmap chain. The sharpening was the least valuable item on the list and it
// was the only change with an open-ended cost, so it goes. The RS / blurPx
// machinery below stays: at 1024 RS is exactly 1 and every blur radius is
// byte-identical to the hand-tuned original, so raising this later is a
// one-line change that keeps the paint looking the same, just resolved finer.
const FACE_W = 1024, FACE_H = 640;
const RS = FACE_W / 1024;
const blurPx = (p) => `blur(${(p * RS).toFixed(2)}px)`;
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
    const gc = 4 * RS;
    for (let y = 0; y < H; y += gc) {
      for (let x = 0; x < W; x += gc) {
        const n = vnoise(x / (6.5 * RS), y / (6.5 * RS));
        if (n > 0.58) { g.fillStyle = '#ffffff'; g.fillRect(x, y, gc * 0.75, gc * 0.75); }
        else if (n < 0.40) { g.fillStyle = '#000000'; g.fillRect(x, y, gc * 0.75, gc * 0.75); }
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
    // Jaw / under-chin occlusion. This used to run 0 -> 0.92 of `deep` and then
    // step straight down to 0.55 at the neck, which put a hard tonal seam right
    // on the jawline. It is also the wrong place to spend darkness: the lighting
    // rig already turns every downward-facing normal to the ground colour, so
    // painting a second occlusion on top is what made the whole lower face
    // collapse into one value. Half the depth, and no step.
    const jg = g.createLinearGradient(0, PY(2.16), 0, PY(2.70));
    jg.addColorStop(0, rgba(shadow, 0));
    jg.addColorStop(0.55, rgba(deep, 0.26));
    jg.addColorStop(1, rgba(deep, 0.48));
    g.fillStyle = jg; g.fillRect(0, PY(2.16), W, PY(2.70) - PY(2.16));
    // neck sits in the head's shadow — matched to the jaw value so there is no
    // seam where the two meet
    const ng2 = g.createLinearGradient(0, PY(2.70), 0, PY(2.86));
    ng2.addColorStop(0, rgba(deep, 0.48));
    ng2.addColorStop(1, rgba(deep, 0.56));
    g.fillStyle = ng2; g.fillRect(0, PY(2.70), W, H - PY(2.70));

    // Warm bounce on the chin and jaw. Light coming off the pitch is green and
    // dim; without a warm albedo bias underneath it, every chin in the game
    // rendered as a slab of moss. This is the counterweight, and it is painted
    // where the reference heads carry their strongest warmth anyway.
    g.save();
    g.globalAlpha = 0.26;
    g.filter = blurPx(20);
    const wb = g.createRadialGradient(cx, PY(2.02), 6, cx, PY(2.02), 0.62 * AX);
    wb.addColorStop(0.00, 'rgba(236,150,104,1)');
    wb.addColorStop(0.60, 'rgba(230,140,96,0.55)');
    wb.addColorStop(1.00, 'rgba(230,140,96,0)');
    g.fillStyle = wb;
    g.fillRect(cx - 0.70 * AX, PY(1.66), 1.40 * AX, PY(2.42) - PY(1.66));
    g.filter = 'none';
    g.restore();

    // Buccal hollow: a soft shadow UNDER and inboard of the cheekbone. Without
    // it the skin reads as one flat tone across the whole lower face, which was
    // the "skin is flat with no shading variation" note.
    for (const s of [-1, 1]) {
      const hx = cx + s * 0.36 * AX, hy = eyeY + 0.62 * AY;
      g.save();
      g.globalAlpha = 0.32;
      g.filter = blurPx(14);
      const hh = g.createRadialGradient(hx, hy, 3, hx, hy, 0.30 * AX);
      hh.addColorStop(0, rgba(shadow, 1));
      hh.addColorStop(1, rgba(shadow, 0));
      g.fillStyle = hh;
      g.fillRect(hx - 0.34 * AX, hy - 0.34 * AY, 0.68 * AX, 0.68 * AY);
      g.filter = 'none';
      g.restore();
    }
    // Shadow the outer third of the face so it turns away from the key. The
    // previous version ended its gradient AT the edge of a fillRect while the
    // alpha there was still 0.34, which stamped a hard vertical seam down each
    // side of the head and a hard horizontal one at the crown and the jaw —
    // visible as a literal rectangle drawn on the skin. This runs the full
    // half-turn from the face centre to the nape, returns to zero at both ends,
    // and is drawn with its wrapped copies so nothing lands on a rect boundary.
    for (const s of [-1, 1]) {
      for (const off of [-W, 0, W]) {
        const x0 = cx + off, x1 = cx + s * 0.5 * W + off;
        const og2 = g.createLinearGradient(x0, 0, x1, 0);
        og2.addColorStop(0.00, rgba(shadow, 0));
        og2.addColorStop(0.40, rgba(shadow, 0.05));
        og2.addColorStop(0.74, rgba(shadow, 0.30));
        og2.addColorStop(1.00, rgba(shadow, 0));
        g.fillStyle = og2;
        g.fillRect(Math.min(x0, x1), 0, 0.5 * W, H);
      }
    }
    // RIM. "Flat matte plastic" is what a head looks like when nothing separates
    // it from what is behind it. A stadium is lit from every side, so the last
    // few degrees before the silhouette catch a cool bounce off the stands. In
    // this unwrap the silhouette sits at t = 0.739 of the way from the face
    // centre to the nape, so the rim peaks just past it and dies before the ear
    // paint on one side and the nape hair on the other. Baked rather than
    // shaded: the play camera is nearly always looking at the front of a
    // player, so the silhouette is where this puts it.
    for (const s of [-1, 1]) {
      for (const off of [-W, 0, W]) {
        const x0 = cx + off, x1 = cx + s * 0.5 * W + off;
        const rg2 = g.createLinearGradient(x0, 0, x1, 0);
        const rim = mixHex(lighten(base, 0.72), 0xcfe0f2, 0.34);
        rg2.addColorStop(0.000, rgba(rim, 0));
        rg2.addColorStop(0.672, rgba(rim, 0));
        rg2.addColorStop(0.770, rgba(rim, 0.30));
        rg2.addColorStop(0.868, rgba(rim, 0));
        rg2.addColorStop(1.000, rgba(rim, 0));
        g.fillStyle = rg2;
        g.fillRect(Math.min(x0, x1), 0, 0.5 * W, H);
      }
    }

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
      // Warmed and lightened to match the beard shell. At 0.86 toward a near
      // black brow this was a solid dark bib painted on the skin, and the shell
      // sitting over it could not do anything but read as one flat black mass.
      const beardCol = mixHex(base, mixHex(brow, 0x7a5334, 0.46), 0.46 + dens * 0.30);
      // The bib was a bezier jaw curve closed off with THREE STRAIGHT LINES —
      // two vertical sides at +/-0.74 AX and a flat bottom — so the painted
      // beard was, literally, a rectangle with a scalloped top. That is the
      // "flat bib decal with hard cutout edges" the panel called out. A beard
      // has no straight edges anywhere: the sideburn tapers to a point at the
      // ear, the band follows the mandible, and it wraps UNDER the chin rather
      // than being chopped off by the bottom of a box.
      const beardPath = () => {
        g.beginPath();
        // right sideburn, tapering up toward the ear
        g.moveTo(cx + 0.80 * AX, PY(1.46));
        g.bezierCurveTo(cx + 0.78 * AX, PY(1.72), cx + 0.66 * AX, PY(1.92), cx + 0.40 * AX, PY(2.00));
        g.bezierCurveTo(cx + 0.22 * AX, PY(2.04), cx + 0.10 * AX, PY(2.05), cx, PY(2.05));
        g.bezierCurveTo(cx - 0.10 * AX, PY(2.05), cx - 0.22 * AX, PY(2.04), cx - 0.40 * AX, PY(2.00));
        g.bezierCurveTo(cx - 0.66 * AX, PY(1.92), cx - 0.78 * AX, PY(1.72), cx - 0.80 * AX, PY(1.46));
        // down the far side and back under the chin — no straight run anywhere
        g.bezierCurveTo(cx - 0.90 * AX, PY(2.00), cx - 0.72 * AX, PY(2.62), cx - 0.34 * AX, PY(2.76));
        g.bezierCurveTo(cx - 0.14 * AX, PY(2.82), cx + 0.14 * AX, PY(2.82), cx + 0.34 * AX, PY(2.76));
        g.bezierCurveTo(cx + 0.72 * AX, PY(2.62), cx + 0.90 * AX, PY(2.00), cx + 0.80 * AX, PY(1.46));
        g.closePath();
      };
      // Two passes at different blurs: a wide soft one that has no findable
      // edge at all, then a tighter denser one for the body. A single hard-ish
      // silhouette is what reads as a decal.
      g.save();
      g.filter = blurPx(26);
      g.globalAlpha = 0.30 + dens * 0.26;
      g.fillStyle = css(beardCol);
      beardPath(); g.fill();
      g.filter = blurPx(11);
      g.globalAlpha = 0.30 + dens * 0.34;
      beardPath(); g.fill();
      g.filter = 'none';
      g.restore();
      // Stubble grain. The old loop stamped 2 px squares off a 3 px noise grid
      // at up to 0.42 alpha, which at this texel density is salt-and-pepper —
      // the "reads as dirt" note. Coarser cells, far lower contrast, and blurred
      // afterwards so it is a texture rather than a rash.
      g.save();
      beardPath(); g.clip();
      g.filter = blurPx(2.2);
      g.globalAlpha = 0.10 + dens * 0.10;
      const y0 = PY(1.55), y1 = PY(2.84);
      const cell = 5 * RS;
      for (let y = y0; y < y1; y += cell) {
        for (let x = cx - 0.92 * AX; x < cx + 0.92 * AX; x += cell) {
          const n = vnoise(x / (6.4 * RS), y / (6.4 * RS));
          if (n > 0.62) { g.fillStyle = css(darken(beardCol, 0.34)); g.fillRect(x, y, cell, cell); }
          else if (n < 0.32) { g.fillStyle = css(lighten(beardCol, 0.30)); g.fillRect(x, y, cell, cell); }
        }
      }
      g.filter = 'none';
      g.restore();
      // Direction: a beard grows DOWN and the light comes from above, so the
      // top of the band is lighter than the bottom. Without this ramp the whole
      // band is one value and no amount of grain will make it read as hair.
      g.save();
      beardPath(); g.clip();
      const bgd = g.createLinearGradient(0, PY(1.86), 0, PY(2.72));
      bgd.addColorStop(0.00, rgba(lighten(beardCol, 0.34), 0.34));
      bgd.addColorStop(0.42, rgba(beardCol, 0));
      bgd.addColorStop(1.00, rgba(darken(beardCol, 0.40), 0.42));
      g.fillStyle = bgd;
      g.fillRect(cx - 1.0 * AX, PY(1.40), 2.0 * AX, PY(2.90) - PY(1.40));
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

      // Baked AO, tight to the opening, so the eyeball sits in shade at the rim.
      // This is the contact occlusion between lid and ball — it has to be
      // narrow. Spread wide it stops being a socket and becomes half of the dark
      // horizontal band across the face that the panel read as a welding visor,
      // so the broad falloff above stays gentle and the depth is spent here.
      g.save();
      g.filter = blurPx(6);
      g.fillStyle = rgba(deep, 0.34);
      g.beginPath(); g.ellipse(0, -0.10 * ru, rh * 1.02, (ru + rd) * 0.62, 0, 0, TAU); g.fill();
      g.filter = 'none';
      g.restore();
      // the deepest point of the dish is the inner corner, next to the nose root
      g.save();
      g.filter = blurPx(5);
      g.fillStyle = rgba(deep, 0.40);
      g.beginPath();
      g.ellipse(-s * rh * 0.70, ru * 0.10, rh * 0.44, (ru + rd) * 0.52, 0, 0, TAU);
      g.fill();
      g.filter = 'none';
      g.restore();
      // and a second, shallower one directly under the brow ridge, which is
      // what makes a brow read as a shelf rather than as paint
      g.save();
      g.filter = blurPx(7);
      g.fillStyle = rgba(shadow, 0.34);
      g.beginPath();
      g.ellipse(0, -ru * 2.30, rh * 1.14, ru * 0.80, 0, 0, TAU);
      g.fill();
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
    // Warmed and lifted off the hair colour. With the common dark-brown hairs
    // darken(brow, 0.10) lands at about 0x201710, i.e. two black bars, and two
    // black bars sitting above two shadowed sockets are most of what fuses into
    // the dark horizontal band the panel read as a welding visor at gameplay
    // distance. Real brows are lighter and browner than the hair above them.
    const browCol = mixHex(brow, 0x6b4a30, 0.30);
    for (const s of [-1, 1]) {
      g.save();
      g.translate(eyeX(s), browY - E.raise * 0.055 * AY);
      g.rotate(s * (bs.ang + E.tilt * 0.30));
      const bw = bs.w * AX, bt = bs.th * AY;
      // soft shadow under the brow so it sits on the ridge instead of floating
      g.save();
      g.filter = blurPx(7);
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
          n > 0.66 ? lighten(browCol, 0.40) : n < 0.30 ? darken(browCol, 0.34) : browCol,
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
    g.filter = blurPx(5);
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
    // Kept TIGHT. At 0.052 AY blurred 6 px and 0.50 alpha this shadow reached
    // down to the vermilion border and fused with the mouth into one dark bar
    // across the middle of the face — which is why the mouth "was missing":
    // there was nothing left to distinguish it from the nose's own shadow.
    g.save();
    g.globalAlpha = 0.38;
    g.filter = blurPx(5);
    g.fillStyle = rgba(deep, 1);
    g.beginPath(); g.ellipse(cx, noseY + 0.116 * AY, noseW * 1.16, 0.030 * AY, 0, 0, TAU); g.fill();
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
    // Nostrils: narrow slits, low, angled outward. Round dots on the front of
    // the tip is exactly the geometry of a pig snout — from a level camera a
    // real nostril is barely more than a dark comma under the wing.
    // They were drawn at blur(2) and 0.72 alpha of a mid brown, which at
    // gameplay distance is nothing at all and even at 3x reads as a scuff. A
    // nostril is a HOLE: the darkest value anywhere on the face bar the pupil.
    g.save();
    g.filter = blurPx(3);
    g.fillStyle = rgba(mixHex(deep, 0x000000, 0.45), 0.40);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * noseW * 0.70, noseY + 0.130 * AY,
        noseW * 0.30, 0.026 * AY, s * 0.46, 0, TAU);
      g.fill();
    }
    g.filter = 'none';
    g.restore();
    g.save();
    g.filter = blurPx(1.6);
    g.fillStyle = rgba(mixHex(deep, 0x000000, 0.62), 0.95);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * noseW * 0.70, noseY + 0.130 * AY,
        noseW * 0.185, 0.0155 * AY, s * 0.52, 0, TAU);
      g.fill();
    }
    g.filter = 'none';
    g.restore();
    // a thin lit ridge on the near wall of each nostril, so it reads as an
    // opening with a rim rather than an ink dot
    g.save();
    g.globalAlpha = 0.34;
    g.strokeStyle = rgba(lighten(base, 0.44), 1);
    g.lineWidth = Math.max(1.6, 0.008 * AY);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + s * noseW * 0.40, noseY + 0.126 * AY);
      g.quadraticCurveTo(cx + s * noseW * 0.62, noseY + 0.106 * AY,
        cx + s * noseW * 0.92, noseY + 0.118 * AY);
      g.stroke();
    }
    g.restore();
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
    const mW = (0.258 + (variant % 4) * 0.013) * AX * (1 + E.open * 0.18);
    const open = E.open * 0.115 * AY;
    const curve = E.curve;
    const lip = mixHex(base, 0x8e2c28, 0.60);
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

    // LIPS.
    // The blind panel's first note was "the mouth is missing ENTIRELY". It was
    // not missing — it was painted at the tonal contrast of a blush, in the one
    // band of the face that catches the most green bounce off the turf, and
    // with the moustache shell parked on top of the upper lip. Three fixes:
    //  1. a lit muzzle pad, so the mouth sits on a field brighter than the jaw
    //     rather than inside the shadow that runs under the nose;
    //  2. lips with a real value spread — dark upper, light lower, and a
    //     near-black oral line between them that survives an 8x minification;
    //  3. a cast shadow under the lower lip so the whole thing has depth.
    const lipHi = lighten(mixHex(lip, 0xd98a72, 0.34), 0.06);
    const lipDk = mixHex(lip, 0x3a1010, 0.55);

    // muzzle pad: the upper lip / chin plane faces the sky more than the jaw
    g.save();
    g.globalAlpha = 0.34;
    g.filter = blurPx(16);
    const mug = g.createRadialGradient(cx, mY - 0.02 * AY, 4, cx, mY - 0.02 * AY, mW * 1.65);
    mug.addColorStop(0, rgba(lighten(base, 0.34), 1));
    mug.addColorStop(1, rgba(lighten(base, 0.34), 0));
    g.fillStyle = mug;
    g.fillRect(cx - mW * 1.8, mY - 0.30 * AY, mW * 3.6, 0.52 * AY);
    g.filter = 'none';
    g.restore();

    // soft occlusion hugging the whole mouth, so it is set into the face
    g.save();
    g.globalAlpha = 0.30;
    g.filter = blurPx(9);
    g.fillStyle = rgba(deep, 1);
    g.beginPath();
    g.ellipse(cx, mY + open * 0.5 + 0.012 * AY, mW * 1.22, (0.088 + open / AY * 0.5) * AY, 0, 0, TAU);
    g.fill();
    g.filter = 'none';
    g.restore();

    // upper lip — the darker of the two, with a defined cupid's bow
    const upTop = (x) => mY - 0.070 * AY - curve * 0.026 * AY * (1 - Math.abs(x));
    g.fillStyle = css(lip);
    g.beginPath();
    g.moveTo(cx - mW, mY - curve * 0.030 * AY);
    g.quadraticCurveTo(cx - mW * 0.52, upTop(0.5), cx - mW * 0.13, mY - 0.030 * AY);
    g.quadraticCurveTo(cx, mY - 0.058 * AY, cx + mW * 0.13, mY - 0.030 * AY);
    g.quadraticCurveTo(cx + mW * 0.52, upTop(0.5), cx + mW, mY - curve * 0.030 * AY);
    g.lineTo(cx + mW, mY - 0.002 * AY);
    g.quadraticCurveTo(cx, mY - 0.034 * AY, cx - mW, mY - 0.002 * AY);
    g.closePath(); g.fill();
    // the upper lip turns under toward the line: shade its lower half
    g.save();
    g.globalAlpha = 0.55;
    const ulg = g.createLinearGradient(0, mY - 0.062 * AY, 0, mY);
    ulg.addColorStop(0, rgba(lipDk, 0));
    ulg.addColorStop(1, rgba(lipDk, 1));
    g.fillStyle = ulg;
    g.fillRect(cx - mW, mY - 0.062 * AY, mW * 2, 0.062 * AY);
    g.restore();

    // lower lip — fuller, lighter, catching the key
    g.fillStyle = css(lipHi);
    g.beginPath();
    g.moveTo(cx - mW * 0.94, mY + open * 1.02);
    g.quadraticCurveTo(cx, mY + open * 1.06 + (0.070 + curve * 0.028) * AY, cx + mW * 0.94, mY + open * 1.02);
    g.quadraticCurveTo(cx, mY + open * 1.02 - 0.014 * AY, cx - mW * 0.94, mY + open * 1.02);
    g.closePath(); g.fill();
    // its own shading: dark where it tucks under, light on the crest
    g.save();
    g.globalAlpha = 0.42;
    const llg = g.createLinearGradient(0, mY + open * 1.02, 0, mY + open * 1.02 + 0.072 * AY);
    llg.addColorStop(0, rgba(lipDk, 0.9));
    llg.addColorStop(0.42, rgba(lipDk, 0));
    llg.addColorStop(1, rgba(darken(lip, 0.42), 0.8));
    g.fillStyle = llg;
    g.fillRect(cx - mW, mY + open * 1.02, mW * 2, 0.076 * AY);
    g.restore();

    // ORAL LINE. This is the mark that has to survive minification, so it is
    // near-black, thick, and sits on a blurred darker bed rather than being a
    // hairline that mip-maps away into the lip colour.
    if (open <= 1) {
      const lineY = (x) => mY + curve * 0.062 * AY * (1 - x * x);
      g.save();
      g.filter = blurPx(4);
      g.strokeStyle = rgba(mixHex(lipDk, 0x000000, 0.5), 0.55);
      g.lineWidth = 0.052 * AY;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx - mW * 0.99, lineY(1) - curve * 0.020 * AY);
      g.quadraticCurveTo(cx, lineY(0) + 0.006 * AY, cx + mW * 0.99, lineY(1) - curve * 0.020 * AY);
      g.stroke();
      g.filter = 'none';
      g.restore();
      g.strokeStyle = rgba(mixHex(lipDk, 0x000000, 0.55), 0.97);
      g.lineWidth = Math.max(4.5, 0.036 * AY);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx - mW * 0.99, lineY(1) - curve * 0.020 * AY);
      g.quadraticCurveTo(cx, lineY(0), cx + mW * 0.99, lineY(1) - curve * 0.020 * AY);
      g.stroke();
    }
    // corner dimples — press the ends of the line into the cheek
    g.save();
    g.filter = blurPx(3);
    g.fillStyle = rgba(deep, 0.62);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * mW * 1.02, mY - curve * 0.026 * AY, 0.024 * AX, 0.030 * AY, 0, 0, TAU);
      g.fill();
    }
    g.filter = 'none';
    g.restore();
    // lower-lip specular — a short, bright, hard band on the crest
    g.fillStyle = 'rgba(255,246,238,0.42)';
    g.beginPath();
    g.ellipse(cx - mW * 0.06, mY + open * 1.02 + 0.028 * AY, mW * 0.40, 0.011 * AY, 0, 0, TAU); g.fill();
    // cast shadow under the lower lip: the mentolabial sulcus
    g.save();
    g.globalAlpha = 0.42;
    g.filter = blurPx(7);
    g.fillStyle = rgba(deep, 1);
    g.beginPath();
    g.ellipse(cx, mY + open * 1.05 + 0.086 * AY, mW * 0.86, 0.030 * AY, 0, 0, TAU); g.fill();
    g.filter = 'none';
    g.restore();
    // chin crease + shadow
    g.save();
    g.filter = blurPx(6);
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
        const ew = 0.128 * AX, eh = 0.252 * AY;
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
        g.filter = blurPx(4);
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

    // Sclera. The previous pass painted it warm grey AND then multiplied a dark
    // burial ring in from 0.80 R — but the eye opening reaches 0.97 R, so every
    // pixel of white the lids actually expose was inside the ring. The result
    // was an eye with no white at all: a dark oval decal, which is exactly what
    // the review called it. The white has to be white where it is seen.
    g.fillStyle = '#f4efe6'; g.fillRect(0, 0, S, S);
    // warmth only in the far corners, where the lid folds meet
    g.save();
    g.globalAlpha = 0.34;
    const wg = g.createRadialGradient(R, R, R * 0.62, R, R, R * 1.15);
    wg.addColorStop(0, 'rgba(255,255,255,0)');
    wg.addColorStop(1, 'rgba(186,140,124,1)');
    g.fillStyle = wg; g.fillRect(0, 0, S, S);
    g.restore();
    // lid shadow across the top of the ball, so the eye sits in a socket. Kept
    // shallow: the eyelid is real geometry and casts its own shadow, and doing
    // it twice is what buried the sclera.
    const lg = g.createLinearGradient(0, 0, 0, S * 0.56);
    lg.addColorStop(0, 'rgba(74,54,44,0.62)');
    lg.addColorStop(0.42, 'rgba(126,104,90,0.24)');
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lg; g.fillRect(0, 0, S, S * 0.56);
    // faint bounce from below
    const bg = g.createLinearGradient(0, S, 0, S * 0.72);
    bg.addColorStop(0, 'rgba(150,126,112,0.22)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg; g.fillRect(0, S * 0.72, S, S * 0.28);

    // Iris. The lids expose an almond running from x = 0.03 R to 1.97 R and
    // from y = 0.61 R to 1.53 R, i.e. 1.94 R wide by 0.92 R tall. At the old
    // 1.60 R the iris filled 82 % of that width and the two sclera wedges left
    // over were three pixels each. The reference sits nearer 62 %, which leaves
    // a real white triangle at each corner — that white is what makes an eye
    // read as an eye rather than as a painted dot.
    const IR = R * 0.605;
    // Vertically the opening centres on 1.07 R. Sitting the iris a little above
    // that lets the upper lid clip its top (alert, not startled) while its
    // bottom rests on the lower lid instead of floating with white underneath.
    const cxp = R, cyp = R * 1.015;

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
    g.beginPath(); g.arc(cxp, cyp, IR * 0.40, 0, TAU); g.fill();
    // Catchlight. Hard-edged and straddling the pupil rim, the way every
    // reference eye does it — a soft blurred dot reads as a smudge once the
    // head is 60 px tall, and the specular is the single cue that says "wet".
    g.fillStyle = 'rgba(255,255,255,0.98)';
    g.beginPath(); g.arc(cxp - IR * 0.30, cyp - IR * 0.34, IR * 0.235, 0, TAU); g.fill();
    // a small second lobe so the highlight is not a perfect circle
    g.fillStyle = 'rgba(255,255,255,0.80)';
    g.beginPath(); g.arc(cxp - IR * 0.06, cyp - IR * 0.50, IR * 0.105, 0, TAU); g.fill();
    // dim bounce from the turf under the chin
    g.fillStyle = 'rgba(214,226,214,0.30)';
    g.beginPath(); g.arc(cxp + IR * 0.34, cyp + IR * 0.40, IR * 0.110, 0, TAU); g.fill();

    // Contact shadow where the upper lid physically rests on the ball. This is
    // a thin dark band ON the eyeball, not on the skin, so the lash line reads
    // as a crease between two surfaces instead of a drawn outline.
    g.save();
    g.filter = 'blur(4px)';
    const cg2 = g.createLinearGradient(0, R * 0.40, 0, R * 0.86);
    cg2.addColorStop(0, 'rgba(40,26,18,0.55)');
    cg2.addColorStop(1, 'rgba(40,26,18,0)');
    g.fillStyle = cg2; g.fillRect(0, R * 0.40, S, R * 0.50);
    g.filter = 'none';
    g.restore();

    // everything outside the visible cap is buried in the skull; keep it dark so
    // no bright sliver can ever leak at a grazing angle. The ring now starts at
    // 0.99 R — outside the eye opening — instead of 0.80 R, which was inside it.
    g.save();
    g.globalCompositeOperation = 'multiply';
    // The opening's horizontal extreme lands at 0.971 R, so the ring starts a
    // hair outside it and ramps hard: all the sclera the lids expose keeps its
    // value, and everything past the rim — which lives under the lid shell and
    // inside the skull — is dark within another tenth of a radius, so no bright
    // sliver can leak at a grazing angle.
    const eg = g.createRadialGradient(R, R, R * 1.00, R, R, R * 1.10);
    eg.addColorStop(0, '#ffffff');
    eg.addColorStop(1, '#3a2e26');
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
    squadNumber(g, number, FRONT, H * 0.665, H * 0.255, numFill, numEdge);

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
    // Fraction of the strip that is bare skin. A short sleeve reaches most of
    // the way to the elbow — at 0.46 the shirt stopped at the deltoid and the
    // whole arm read as bare.
    const cuff = long ? 0.14 : 0.34;
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
  const bands = o.bands ?? 'band';
  return memo(`sock:${base}:${trim}:${bands}`, () => {
    const W = 256, H = 256;
    const { c, g } = canvas2d(W, H);
    g.fillStyle = css(base); g.fillRect(0, 0, W, H);

    // turnover band at the knee
    g.fillStyle = css(trim); g.fillRect(0, 0, W, H * 0.185);
    g.fillStyle = rgba(darken(base, 0.40), 0.6); g.fillRect(0, H * 0.185, W, H * 0.030);
    if (bands === 'hoops') {
      // three narrow hoops down the calf — reads as a different club's socks
      for (const y of [0.290, 0.400, 0.510]) {
        g.fillStyle = rgba(trim, 0.92); g.fillRect(0, H * y, W, H * 0.040);
        g.fillStyle = rgba(darken(base, 0.45), 0.35); g.fillRect(0, H * (y + 0.040), W, H * 0.010);
      }
    } else {
      g.fillStyle = rgba(trim, 0.8); g.fillRect(0, H * 0.285, W, H * 0.045);
    }

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
