// The playing surface.
//
//   createPitch({ surface }) -> { group, setSurface(k), inPlay(x,z), update(dt), dispose() }
//
// ONE mesh, ONE draw call, ONE material. Three things are combined per-fragment:
//
//   1. a tileable detail texture (albedo + normal + roughness) carrying blade
//      grain — high frequency, repeats every ~2.6 m;
//   2. a non-tiling macro map covering the whole ground plane, holding the mow
//      stripes, broad discolouration, goalmouth wear and the off-pitch verge;
//   3. the painted markings, evaluated analytically as a 2-D signed distance
//      field in world space.
//
// The markings being an SDF matters: they are resolution-independent (crisp from
// a 2 m closeup and correctly filtered from the wide shot), they cost no texture
// memory, and — because they are part of the ground shader rather than a decal
// plane hovering above it — there is nothing to z-fight and nothing to pop.

import * as THREE from 'three';
import { turfTextures, pitchMacroTexture } from '../core/assets.js';
import {
  FIELD_W, FIELD_D, HALF_W, HALF_D,
  CENTER_R, BOX_W, BOX_D, SIX_W, SIX_D, PEN_SPOT, CORNER_R,
  APRON_X, APRON_Z,
} from '../core/constants.js';

// Mow bands. Measured off the reference: roughly 3.5–4 m of pitch per band, so
// a broadcast-height camera sees six or seven of them across the frame.
const MOW_BANDS = 16;
const MOW_W = FIELD_W / MOW_BANDS;

// Paint thickness in metres. Slightly fatter than a real 12 cm line — the
// reference reads chunky and it survives minification better.
const PAINT_T = 0.20;
const SPOT_R = 0.17;
const PEN_ARC_R = 6.2;

// Ground extents. The surface deliberately runs past the touchline all the way
// to the perimeter boards, so the verge between the pitch and the hoardings is
// the same grained, shaded material as the pitch rather than a flat green ring.
// The outline is an offset rounded rectangle so it follows the stadium bowl's
// radiused corners instead of poking out past them.
const MARGIN = Math.max(APRON_X - HALF_W, APRON_Z - HALF_D, 6.3);
const EX = HALF_W + MARGIN;
const EZ = HALF_D + MARGIN;

const f = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const PITCH_HEAD = /* glsl */`
uniform sampler2D uMacro;
uniform vec2  uExt;
uniform vec3  uPaintCol;
uniform float uLineT;
uniform float uPaintWear;
uniform float uMow;      // 0 = no mow stripes (dirt / concrete)
uniform float uMowW;     // band width in metres
uniform vec3  uMowLo;
uniform vec3  uMowHi;
varying vec3 vPitchWPos;

float sdSeg2(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float sdRectEdge(vec2 p, vec2 c, vec2 hs) {
  vec2 d = abs(p - c) - hs;
  return abs(min(max(d.x, d.y), 0.0) + length(max(d, vec2(0.0))));
}
`;

function pitchBody() {
  const HW = f(HALF_W), HD = f(HALF_D);
  const CR = f(CENTER_R);
  const BCX = f(HALF_W - BOX_W / 2), BHX = f(BOX_W / 2), BHZ = f(BOX_D / 2);
  const SCX = f(HALF_W - SIX_W / 2), SHX = f(SIX_W / 2), SHZ = f(SIX_D / 2);
  const PSX = f(HALF_W - PEN_SPOT);
  const BEX = f(HALF_W - BOX_W);
  const CORR = f(CORNER_R);
  const PAR = f(PEN_ARC_R);

  return /* glsl */`
  vec2 P = vPitchWPos.xz;
  vec2 mUv = (P + uExt) / (2.0 * uExt);
  vec4 macro = texture2D(uMacro, clamp(mUv, 0.0005, 0.9995));

  // macro rgb is a linear albedo multiplier encoded as value * 0.5
  diffuseColor.rgb *= macro.rgb * 2.0;

  // ---- mow stripes -------------------------------------------------------
  // Evaluated here rather than baked, so the band edge is exact at any distance.
  // The roller never runs perfectly straight: three low-frequency sines wander
  // the phase, and a blade-scale nudge from the detail map frays the edge so it
  // never resolves into a ruled line.
  if (uMow > 0.5) {
    float grain = texture2D(map, vMapUv).g - 0.5;
    float ph = (P.x + ${HW}) / uMowW
             + 0.052 * sin(P.y * 0.191 + 1.7)
             + 0.030 * sin(P.y * 0.523 + 4.2)
             + 0.018 * sin(P.x * 0.37 + P.y * 0.13)
             + grain * 0.075;
    float e = 0.058;
    float mf = fract(ph * 0.5 + e * 0.5);
    float band = smoothstep(0.0, e, mf) - smoothstep(0.5, 0.5 + e, mf);
    float inP = smoothstep(0.0, 0.7, ${HW} + 0.35 - abs(P.x))
              * smoothstep(0.0, 0.7, ${HD} + 0.35 - abs(P.y));
    diffuseColor.rgb *= mix(vec3(1.0), mix(uMowLo, uMowHi, band), inP);
  }

  float d = 1e5;
  d = min(d, sdRectEdge(P, vec2(0.0, 0.0), vec2(${HW}, ${HD})));          // touch + goal lines
  d = min(d, sdSeg2(P, vec2(0.0, -${HD}), vec2(0.0, ${HD})));             // halfway
  d = min(d, abs(length(P) - ${CR}));                                     // centre circle
  d = min(d, sdRectEdge(P, vec2( ${BCX}, 0.0), vec2(${BHX}, ${BHZ})));    // penalty areas
  d = min(d, sdRectEdge(P, vec2(-${BCX}, 0.0), vec2(${BHX}, ${BHZ})));
  d = min(d, sdRectEdge(P, vec2( ${SCX}, 0.0), vec2(${SHX}, ${SHZ})));    // six-yard boxes
  d = min(d, sdRectEdge(P, vec2(-${SCX}, 0.0), vec2(${SHX}, ${SHZ})));

  // penalty arcs — the part of the D that sits outside the penalty area
  float arcR = abs(length(P - vec2(${PSX}, 0.0)) - ${PAR});
  d = min(d, P.x > ${BEX} ? 1e5 : arcR);
  float arcL = abs(length(P + vec2(${PSX}, 0.0)) - ${PAR});
  d = min(d, P.x < -${BEX} ? 1e5 : arcL);

  // corner quadrants
  vec2 corner = vec2(${HW}, ${HD}) * vec2(P.x < 0.0 ? -1.0 : 1.0, P.y < 0.0 ? -1.0 : 1.0);
  float cArc = abs(length(P - corner) - ${CORR});
  float inField = step(abs(P.x), ${HW}) * step(abs(P.y), ${HD});
  d = min(d, mix(1e5, cArc, inField));

  float ht = uLineT * 0.5;
  float aa = max(fwidth(d) * 0.8, 0.013);
  float lineMask = 1.0 - smoothstep(ht - aa, ht + aa, d);

  // centre + penalty spots
  float sd = min(length(P), min(length(P - vec2(${PSX}, 0.0)), length(P + vec2(${PSX}, 0.0))));
  float saa = max(fwidth(sd) * 0.8, 0.010);
  lineMask = max(lineMask, 1.0 - smoothstep(${f(SPOT_R)} - saa, ${f(SPOT_R)} + saa, sd));

  // faint wear: paint scrubs off where traffic is heaviest, and flakes finely
  lineMask *= mix(1.0, macro.a, uPaintWear);

  diffuseColor.rgb = mix(diffuseColor.rgb, uPaintCol, lineMask * 0.95);
  roughnessFactor = mix(roughnessFactor, 0.55, lineMask);
`;
}

// ---------------------------------------------------------------------------

export function createPitch(opts = {}) {
  const group = new THREE.Group();
  group.name = 'pitch';

  let surface = opts.surface || 'grass';

  const uniforms = {
    uMacro: { value: null },
    uExt: { value: new THREE.Vector2(EX, EZ) },
    uPaintCol: { value: new THREE.Color(0xf4f7f2) },
    uLineT: { value: PAINT_T },
    uPaintWear: { value: 0.34 },
    uMow: { value: 1 },
    uMowW: { value: MOW_W },
    uMowLo: { value: new THREE.Vector3(0.735, 0.712, 0.808) },
    uMowHi: { value: new THREE.Vector3(1.252, 1.292, 1.168) },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.9, 0.9),
    // The sky probe is strongly blue; at full strength it lifts the turf's blue
    // channel far above the reference and the field reads grey-green.
    envMapIntensity: 0.55,
    dithering: true,
  });

  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'varying vec3 vPitchWPos;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vPitchWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
    sh.fragmentShader = PITCH_HEAD + sh.fragmentShader
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n' + pitchBody(),
      )
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n'
        + '  normal = normalize(mix(normal, nonPerturbedNormal, lineMask * 0.85));',
      );
  };
  // distinct cache key so this program is never shared with a plain standard mat
  mat.customProgramCacheKey = () => 'pitch-surface-v1';

  // Offset rounded rectangle. ShapeGeometry emits UVs equal to the shape's local
  // XY, i.e. metres, so the detail tile repeats every `tile` world units with a
  // plain 1/tile repeat and never stretches at the rounded corners.
  const geo = (() => {
    const s = new THREE.Shape();
    const r = MARGIN;
    s.moveTo(-EX + r, -EZ);
    s.lineTo(EX - r, -EZ);
    s.quadraticCurveTo(EX, -EZ, EX, -EZ + r);
    s.lineTo(EX, EZ - r);
    s.quadraticCurveTo(EX, EZ, EX - r, EZ);
    s.lineTo(-EX + r, EZ);
    s.quadraticCurveTo(-EX, EZ, -EX, EZ - r);
    s.lineTo(-EX, -EZ + r);
    s.quadraticCurveTo(-EX, -EZ, -EX + r, -EZ);
    s.closePath();
    const g = new THREE.ShapeGeometry(s, 10);
    g.rotateX(-Math.PI / 2);
    return g;
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'pitchSurface';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // keep it behind every decal / VFX quad that also sits near y = 0
  mesh.renderOrder = -1;
  group.add(mesh);

  function applySurface(kind) {
    surface = kind;
    const turf = turfTextures({ surface: kind });
    const rp = 1 / turf.tile;   // UVs are in metres — see the geometry above
    for (const t of [turf.map, turf.normalMap, turf.roughnessMap]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rp, rp);
      t.needsUpdate = true;
    }
    mat.map = turf.map;
    mat.normalMap = turf.normalMap;
    mat.roughnessMap = turf.roughnessMap;
    const ns = kind === 'grass' ? 1.35 : 0.7;
    mat.normalScale.set(ns, ns);
    uniforms.uMacro.value = pitchMacroTexture({
      surface: kind, halfW: HALF_W, halfD: HALF_D,
      marginX: EX - HALF_W, marginZ: EZ - HALF_D, stripeW: MOW_W,
    });
    uniforms.uPaintWear.value = kind === 'grass' ? 0.34 : 0.46;
    uniforms.uPaintCol.value.set(kind === 'concrete' ? 0xfafcfa : 0xf4f7f2);
    uniforms.uMow.value = kind === 'grass' ? 1 : 0;
    mat.needsUpdate = true;
  }

  applySurface(surface);

  return {
    group,
    mesh,
    get surface() { return surface; },
    setSurface: applySurface,
    materials: { turf: mat, paint: mat },
    /** world-space bounds test helper */
    inPlay(x, z) { return Math.abs(x) <= HALF_W && Math.abs(z) <= HALF_D; },
    size: { w: FIELD_W, d: FIELD_D },
    update() { /* static — wear decals accumulate in fx/vfx.js */ },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
