// Procedural asset factory. Everything the game draws with is baked here at runtime
// from canvas 2D — the repo contains no binary assets.
//
// Every exported function is memoised: calling it twice returns the identical
// THREE.Texture instance, so materials share GPU resources.

import * as THREE from 'three';
import { makeRng } from './rng.js';
import { instrumentMemo } from './profile.js';

// Texture bakes use their own streams so they never perturb gameplay randomness.
const trng = makeRng(0x51ed);

const cache = new Map();
const memo = instrumentMemo((key, make) => {
  if (cache.has(key)) return cache.get(key);
  const v = make();
  cache.set(key, v);
  return v;
}, 'assets');

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  // Drawn once, then read back whole by texImage2D — see the raster-backend note
  // in entities/player-textures.js. Keeps Chromium on Skia's CPU rasteriser
  // instead of pushing every draw through a software GL driver.
  const g = c.getContext('2d', { willReadFrequently: true });
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
// GROUND SURFACES — tileable albedo + normal + roughness for grass / dirt /
// concrete, plus the non-tiling "macro" map that carries mow stripes, broad
// discolouration and wear across the whole pitch.
//
// The detail tile holds ONLY high-frequency blade/aggregate grain. Everything
// that varies across the pitch (stripes, goalmouth scuffing, sun sheen) lives
// in the macro map, and world/pitch.js multiplies the two in one material.
// ---------------------------------------------------------------------------

const ss = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const frac = (v) => v - Math.floor(v);
const mixc = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];

/**
 * Surface recipes. Colours are sRGB bytes: `lo` is the deepest shadowed fibre,
 * `hi` the brightest sun-caught tip, `tint` a third colour blended into random
 * clumps so the field never resolves to a two-colour ramp.
 */
export const SURFACES = {
  grass: {
    tile: 2.6,
    // Sampled off the reference at gameplay distance: dark band (71,132,35),
    // light band (110,170,73). Both are markedly LESS saturated than a "grass
    // green" instinct produces — the blue channel in particular runs around 40%
    // of green, not 25%. Undershooting it is what made our pitch read as a
    // poster-paint field next to theirs.
    lo: [34, 64, 16], hi: [136, 186, 78], tint: [132, 152, 62], tintAmt: 0.22,
    // streaks per tile across U — the mow direction runs along world Z, so the
    // blades are lines of constant U.
    //
    // TWO frequencies, and the coarse one is the one that matters. A 1.7 cm
    // blade (bladeFreq 150) is 0.35 of a screen pixel from the gameplay camera:
    // it mips into a uniform mush and the pitch reads as felt. What survives at
    // that distance is the CLUMP — the 15 cm tuft the roller leaves — which is
    // still four texels wide at mip 5 and four pixels wide on screen. The fine
    // blade is kept anyway because it is what you see in a goal replay closeup.
    bladeFreq: 132, bladeAmp: 0.20, bladeWander: 7.0,
    clumpFreq: 17, clumpAmp: 0.195,
    speckle: 0, speckleCol: [0, 0, 0],
    // Less of the 32 cm octave, more of the 1.4 cm one: the coarse field is
    // better spent steering the streaks than adding its own soft blobs, which
    // is the other half of what made the surface look woven.
    weights: [0.24, 0.30, 0.14],
    sharpen: 1,
    normalStrength: 4.6, rough: [0.55, 0.95],
    stripes: true,
    wearCol: [1.60, 1.12, 0.74], wearDark: 0.13, blotchAmt: 0.050,
    macroBase: [1, 1, 1],
    vergeMul: [0.58, 0.65, 0.52],
  },
  dirt: {
    tile: 3.4,
    lo: [104, 78, 54], hi: [196, 168, 132], tint: [150, 128, 88], tintAmt: 0.45,
    bladeFreq: 0, bladeAmp: 0.0, bladeWander: 0,
    speckle: 0.055, speckleCol: [88, 68, 48],
    weights: [0.44, 0.30, 0.26],
    normalStrength: 2.2, rough: [0.82, 0.99],
    stripes: false,
    wearCol: [1.10, 1.02, 0.92], wearDark: 0.14, blotchAmt: 0.200,
    macroBase: [1, 1, 1],
    vergeMul: [0.86, 0.84, 0.80],
  },
  concrete: {
    tile: 4.0,
    lo: [92, 92, 92], hi: [172, 172, 166], tint: [150, 146, 136], tintAmt: 0.26,
    bladeFreq: 0, bladeAmp: 0.0, bladeWander: 0,
    speckle: 0.09, speckleCol: [96, 96, 98],
    weights: [0.40, 0.32, 0.28],
    normalStrength: 1.5, rough: [0.55, 0.86],
    stripes: false,
    wearCol: [0.94, 0.94, 0.96], wearDark: 0.16, blotchAmt: 0.150,
    macroBase: [1, 1, 1],
    vergeMul: [0.80, 0.80, 0.80],
  },
};

/**
 * Tileable detail for one surface.
 * @returns {{map,normalMap,roughnessMap,tile:number}}
 */
export function turfTextures(opts = {}) {
  const kind = opts.surface || 'grass';
  const S = opts.size || 2048;
  const D = SURFACES[kind] || SURFACES.grass;
  return memo(`turf:${kind}:${S}`, () => {
    // Coarse clumping is baked at low resolution and bilinearly upsampled — it
    // is smooth by definition, so full-res fbm there would only cost time.
    const CS = 256;
    const Tc = tables(4, 1201 + S, 8);
    const coarse = new Float32Array(CS * CS);
    for (let y = 0; y < CS; y++)
      for (let x = 0; x < CS; x++) coarse[y * CS + x] = fbm(x / CS, y / CS, 4, 8, Tc);
    const upC = (u, v) => {
      const fx = u * CS, fy = v * CS;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const i0 = ((x0 % CS) + CS) % CS, j0 = ((y0 % CS) + CS) % CS;
      const i1 = (i0 + 1) % CS, j1 = (j0 + 1) % CS;
      return (coarse[j0 * CS + i0] * (1 - tx) + coarse[j0 * CS + i1] * tx) * (1 - ty)
        + (coarse[j1 * CS + i0] * (1 - tx) + coarse[j1 * CS + i1] * tx) * ty;
    };
    const midT = lattice(192, 5501 + S);
    const fineT = lattice(512, 9203 + S);
    const specT = lattice(256, 3313 + S);
    const jitT = lattice(256, 7717 + S);

    const height = new Float32Array(S * S);
    const { c, g } = canvas2d(S, S);
    const img = g.createImageData(S, S);
    const [w0, w1, w2] = D.weights;
    const wsum = w0 + w1 + w2 + D.bladeAmp + (D.clumpAmp || 0);

    for (let y = 0; y < S; y++) {
      const v = y / S;
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const cl = upC(u, v);
        const md = noise2(midT, 192, u * 192, v * 192);
        const fn = noise2(fineT, 512, u * 512, v * 512);

        let h = (w0 * cl + w1 * md + w2 * fn);
        if (D.bladeAmp > 0) {
          // blades run along +V (world Z), so the stripe pattern varies in U,
          // wandering with the coarse field so no two rows line up.
          const wob = cl * D.bladeWander + md * 3.1;
          const b1 = Math.sin(u * D.bladeFreq * 6.2831853 + wob) * 0.5 + 0.5;
          const b2 = Math.sin(u * D.bladeFreq * 2.61 * 6.2831853 + md * 9.0) * 0.5 + 0.5;
          h += D.bladeAmp * (b1 * 0.62 + b2 * 0.38);
        }
        if (D.clumpAmp > 0) {
          // The clump layer. BOTH harmonics are functions of U only, so the
          // tufts run unbroken along the mow direction the way real fibre does;
          // an earlier version skewed the second harmonic into V to break up
          // the corduroy and the pitch came out looking knitted. What actually
          // breaks the lines is the phase, and it has to wander SLOWLY: driving
          // it from the 0.5 cm octave scrambled the second harmonic into noise,
          // and noise crossed with a clean first harmonic reads as basket weave.
          // Only the 32 cm field steers, with a whisker of 1.4 cm jitter on the
          // harmonic, so the tufts stay legible as fibre at every distance.
          const cw = cl * 2.2;
          const k1 = Math.sin(u * D.clumpFreq * 6.2831853 + cw) * 0.5 + 0.5;
          const k2 = Math.sin(u * D.clumpFreq * 2.37 * 6.2831853 + cw * 1.7 + md * 0.5) * 0.5 + 0.5;
          h += D.clumpAmp * (k1 * 0.60 + k2 * 0.40);
        }
        h = clamp01(h / wsum);
        for (let k = 0; k < (D.sharpen || 1); k++) h = h * h * (3 - 2 * h);
        height[y * S + x] = h;

        let col = mixc(D.lo, D.hi, h);
        if (D.tintAmt > 0) {
          const t = ss((cl - 0.52) * 2.6) * D.tintAmt;
          col = mixc(col, D.tint, t);
        }
        if (D.speckle > 0) {
          const sp = noise2(specT, 256, u * 256, v * 256);
          if (sp > 1 - D.speckle * 3.2) {
            const k = (sp - (1 - D.speckle * 3.2)) / (D.speckle * 3.2);
            col = mixc(col, D.speckleCol, k * 0.8);
          }
        }
        // tiny per-texel hue break-up so flat colour is unreachable
        const j = noise2(jitT, 256, u * 256 * 1.7 + 11, v * 256 * 1.7 + 3) - 0.5;
        const i = (y * S + x) * 4;
        img.data[i] = clamp01((col[0] + j * 16) / 255) * 255;
        img.data[i + 1] = clamp01((col[1] + j * 20) / 255) * 255;
        img.data[i + 2] = clamp01((col[2] + j * 12) / 255) * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // roughness at half res — it is a broad property, full res buys nothing
    const RS = S >> 1;
    const { c: rc, g: rg } = canvas2d(RS, RS);
    const rimg = rg.createImageData(RS, RS);
    for (let y = 0; y < RS; y++) {
      for (let x = 0; x < RS; x++) {
        const h = height[(y * 2) * S + x * 2];
        const cl = upC(x / RS, y / RS);
        // worn / flattened patches are shinier than upright fibre
        const r = clamp01(D.rough[0] + (1 - h) * (D.rough[1] - D.rough[0]) - (cl - 0.5) * 0.10);
        const i = (y * RS + x) * 4;
        rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = r * 255;
        rimg.data[i + 3] = 255;
      }
    }
    rg.putImageData(rimg, 0, 0);

    const map = tex(c, { srgb: true, aniso: 16 });
    const normalMap = tex(normalFromHeight(height, S, D.normalStrength), { srgb: false, aniso: 16 });
    const roughnessMap = tex(rc, { srgb: false, aniso: 8 });
    return { map, normalMap, roughnessMap, tile: D.tile };
  });
}

/**
 * Whole-pitch macro map. Not tiled — it maps 1:1 onto the ground plane.
 *
 *   rgb = linear albedo multiplier, encoded as value/2 (so 0..2 is expressible)
 *   a   = paint integrity (1 = fresh white line, 0 = scrubbed away)
 *
 * Carries the mow stripes, broad discolouration, goalmouth / centre-circle
 * scuffing, the off-pitch verge, and a very soft sun sheen band.
 */
export function pitchMacroTexture(o = {}) {
  const kind = o.surface || 'grass';
  const hw = o.halfW ?? 30, hd = o.halfD ?? 20;
  const mx = o.marginX ?? 5, mz = o.marginZ ?? 5;
  const stripeW = o.stripeW ?? 5;
  const D = SURFACES[kind] || SURFACES.grass;
  const key = `macro:${kind}:${hw}:${hd}:${mx}:${mz}:${stripeW}`;
  return memo(key, () => {
    const EX = hw + mx, EZ = hd + mz;
    const W = 1024, H = Math.round((W * EZ) / EX / 4) * 4;
    // No canvas here on purpose — see the DataTexture note at the end of this function.
    const img = new ImageData(W, H);

    const Tb = tables(4, 2207, 4);      // broad blotches
    const Tw = tables(3, 8821, 10);     // wear break-up
    const Tp = tables(3, 4409, 40);     // paint break-up
    // Clump mottle at ~0.8 m. The detail tile carries structure down to 15 cm
    // but repeats every 2.6 m; this layer does not tile at all, so it is what
    // stops five metres of pitch from resolving into the same stamp five times.
    const Tk = tables(2, 3733, 96);
    const jitT = lattice(128, 6151);

    // wear ellipses in world space: [cx, cz, rx, rz, strength]
    const zones = [];
    if (kind === 'grass' || kind === 'dirt') {
      for (const s of [-1, 1]) {
        zones.push([s * (hw - 2.4), 0, 6.2, 8.0, 0.85]);       // goalmouth
        zones.push([s * (hw - 7.5), 0, 5.0, 10.0, 0.30]);      // six-yard apron
        zones.push([s * (hw - 8.0), 0, 1.9, 1.9, 0.55]);       // penalty spot scuff
        zones.push([s * (hw - 15.5), 0, 4.0, 6.0, 0.16]);      // edge of the box
      }
      zones.push([0, 0, 3.2, 3.2, 0.34]);                      // kickoff spot
      zones.push([0, 0, 9.5, 8.0, 0.11]);                      // centre circle traffic
      zones.push([0, hd - 1.2, 30, 2.4, 0.13]);                // touchline wear
      zones.push([0, -(hd - 1.2), 30, 2.4, 0.13]);
    }

    const wearAt = (x, z, n) => {
      let w = 0;
      for (let i = 0; i < zones.length; i++) {
        const [cx, cz, rx, rz, k] = zones[i];
        const dx = (x - cx) / rx, dz = (z - cz) / rz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 1.35) w = Math.max(w, k * (1 - ss((d - 0.15) / 1.2)));
      }
      // ragged edges — never a clean airbrushed ellipse
      return clamp01(w * (0.60 + 0.80 * n));
    };

    for (let py = 0; py < H; py++) {
      const v = py / H;
      const z = -EZ + v * 2 * EZ;
      for (let px = 0; px < W; px++) {
        const u = px / W;
        const x = -EX + u * 2 * EX;

        const bl = fbm(u, v, 4, 4, Tb);
        const wn = fbm(u, v, 3, 10, Tw);
        const pn = fbm(u, v, 3, 40, Tp);
        const kn = fbm(u, v, 2, 96, Tk);
        const jt = noise2(jitT, 128, u * 128 * 3.1, v * 128 * 3.1) - 0.5;

        // soft inside-the-lines mask (touchline sits on the boundary)
        const inside = ss((hw + 0.25 - Math.abs(x)) / 0.5) * ss((hd + 0.25 - Math.abs(z)) / 0.5);

        // Mow stripes are NOT baked here — world/pitch.js evaluates them
        // analytically in the ground shader so their edges stay crisp at any
        // camera distance instead of being capped by this map's texel size.
        let m0 = 1, m1 = 1, m2 = 1;

        // broad discolouration + faint darker patches
        const ba = D.blotchAmt ?? 0.05;
        const b = (1 - ba * 0.48) + ba * bl + (wn - 0.5) * (0.045 + ba * 0.9) + jt * 0.022;
        m0 *= b; m1 *= b; m2 *= b;

        // clump mottle (grass only — dirt and concrete have their own blotching)
        if (D.stripes) {
          // Kept deliberately quiet. At 0.19 this layer stopped reading as turf
          // variation and started reading as splotches painted on top of it —
          // the structure the eye wants at this scale comes from the streaks in
          // the detail tile, not from isotropic noise.
          const km = 1 + (kn - 0.5) * 0.085;
          m0 *= km; m1 *= km; m2 *= km;
        }

        // --- sun sheen ------------------------------------------------------
        // A broad diagonal band of brighter turf with the rest of the field
        // falling away from it, plus a slow radial droop into the corners. This
        // is not decoration: it is the single largest low-frequency feature of
        // the reference pitch and the reason theirs never reads as one flat
        // sheet of green. The old version swung 4% over a band so wide the whole
        // pitch sat inside its peak — invisible after tone mapping. This swings
        // 20% end to end, about a third of a stop.
        const sh = Math.exp(-Math.pow((x * 0.42 + z * 0.56 - 4.0) / 18.0, 2));
        const rr = Math.min(1, Math.hypot(x / (EX * 1.12), z / (EZ * 1.12)));
        const shk = (0.905 + 0.175 * sh) * (1 - 0.085 * rr * rr);
        m0 *= shk; m1 *= shk; m2 *= shk;

        // wear
        const w = wearAt(x, z, wn) * inside;
        if (w > 0.001) {
          const k = w * 0.9;
          m0 *= 1 + (D.wearCol[0] - 1) * k;
          m1 *= 1 + (D.wearCol[1] - 1) * k;
          m2 *= 1 + (D.wearCol[2] - 1) * k;
          const dk = 1 - w * D.wearDark;
          m0 *= dk; m1 *= dk; m2 *= dk;
        }

        // off-pitch verge: unstriped, darker, slightly bluer in shade
        if (inside < 1) {
          const t = 1 - inside;
          m0 = m0 * (1 - t) + D.vergeMul[0] * (0.94 + 0.14 * bl) * t;
          m1 = m1 * (1 - t) + D.vergeMul[1] * (0.94 + 0.14 * bl) * t;
          m2 = m2 * (1 - t) + D.vergeMul[2] * (0.94 + 0.14 * bl) * t;
        }

        // paint integrity: worn where traffic is heaviest, plus fine flaking
        const paint = clamp01(0.52 + 0.62 * pn + 0.18 * bl - w * 0.95);

        const i = (py * W + px) * 4;
        img.data[i] = clamp01(m0 * 0.5) * 255;
        img.data[i + 1] = clamp01(m1 * 0.5) * 255;
        img.data[i + 2] = clamp01(m2 * 0.5) * 255;
        img.data[i + 3] = paint * 255;
      }
    }

    // Upload the bytes directly as a DataTexture rather than round-tripping through
    // the canvas.
    //
    // This map is a data map, not a picture: RGB is an albedo multiplier and ALPHA is
    // an unrelated paint-integrity mask. A canvas backing store holds RGBA
    // PREMULTIPLIED, so drawing this through one scales RGB by that alpha — and alpha
    // goes to ~0 exactly where wear is highest. The goalmouths came back as near-black
    // (8,11,20) instead of worn brown, painting a large dark blob at each goal.
    // DataTexture takes the bytes verbatim, so the two channels stay independent.
    const t = new THREE.DataTexture(img.data, W, H, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
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

/**
 * Contact shadow under a standing figure.
 *
 * `softCircle` is a glow ramp — it spends most of its radius in a wide, pale
 * haze, which is right for a light bloom and wrong for an occlusion term. A
 * figure standing on turf occludes the sky almost totally in the few
 * centimetres around the soles and then recovers quickly, so what grounds it is
 * a small, genuinely dark core with a short shoulder, not a big grey cloud.
 * Hence the plateau out to 0.30 and the steep tail: at the core this reads as
 * shade, and by 80% of the radius it is gone, so the ellipse never announces
 * its own edge against the grass.
 */
export function contactBlob(peak = 0.72) {
  return memo('contact:' + peak, () => {
    const S = 128;
    const { c, g } = canvas2d(S, S);
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0.00, `rgba(0,0,0,${peak})`);
    gr.addColorStop(0.30, `rgba(0,0,0,${(peak * 0.88).toFixed(3)})`);
    gr.addColorStop(0.52, `rgba(0,0,0,${(peak * 0.50).toFixed(3)})`);
    gr.addColorStop(0.72, `rgba(0,0,0,${(peak * 0.15).toFixed(3)})`);
    gr.addColorStop(0.88, 'rgba(0,0,0,0.02)');
    gr.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    const t = tex(c, { aniso: 4 });
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
