// Renderer + scene + lighting + post-processing chain + resize + quality tiers.
//
//   createEngine(canvas) -> { renderer, scene, camera, composer, render(dt),
//                             resize(), setQuality(tier), stats }
//
// Chain:
//
//   RenderPass  -> HDR linear scene (MSAA 4x where the driver supports it) with
//                  a depth texture attached to the first composer target
//   DofPass     -> depth-of-field + aerial haze, still in HDR so a defocused
//                  highlight keeps its energy and blooms afterwards
//   BloomPass   -> floodlights, the ball's specular and every additive VFX bloom
//   OutputPass  -> ACES filmic tone map + sRGB transfer
//   GradePass   -> print-film grade (lift/gain/saturation), radial chromatic
//                  aberration, smooth vignette and a fine grain floor
//   FXAAPass    -> edge clean-up after the grade, so CA fringes get smoothed too
//
// three only tone maps when rendering to the default framebuffer, so with a
// composer OutputPass owns tone mapping and colour space; the grade therefore
// runs in display space where lift/gain behave like a colour-grading LUT.
//
// Shadowing is PCSS (percentage-closer soft shadows): the stock three PCF branch
// is replaced at import time with a blocker search + variable-radius filter, so
// the penumbra grows with the distance between blocker and receiver. That is the
// difference between "a shadow is drawn" and "the boot is planted" — contact is
// razor sharp under the studs and the cast shadow a metre out is already soft,
// from one shadow map.
//
// On top of that every character carries a contact-occlusion decal, MULTIPLIED
// into the frame rather than alpha-blended, so the grass keeps its own grain
// through the shadow. Cast shadow says where the light is; the decal says the
// sole is touching. You need both or the players hover.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { envMap, skyTexture } from './assets.js';

// ---------------------------------------------------------------------------
// Sun + shadow rig constants
// ---------------------------------------------------------------------------
// The key sits at ≈51.5° elevation, swung to +X/+Z — up, to the right, and on
// the camera's side of the pitch. Three things fall out of that choice and all
// three are visible in the reference frames:
//
//   1. Faces are FRONT-lit. The camera lives at +Z, so a key from +Z puts the
//      light on the side of every head the player actually sees. A key from -Z
//      would rim the hair beautifully and leave every face in its own shade.
//   2. Shadows are SHORT. A 1.6 m chibi throws ≈1.3 m, so the shadow stays
//      welded to the boots instead of streaking half a metre of pitch away —
//      which is the difference between "grounded" and "sticker on grass".
//   3. The bowl stops shading the pitch. The roof inner edge is at 34 m out,
//      y = 30.4, so its shadow now lands 15 m PAST the touchline. The previous
//      37° key parked that edge at z ≈ +12 and put the near third of the field
//      — and every player standing on it — into flat ambient, which is most of
//      why the frame read washed out. The broad sun-sheen gradient the
//      reference has across the turf is painted into the macro map instead
//      (core/assets.js), where it can be shaped instead of being whatever the
//      architecture happens to throw.
const SUN_POS = new THREE.Vector3(34, 66, 40);

// Square ortho box for the shadow camera. With the bowl no longer shading the
// pitch there is nothing to fit but the playing surface, its verge and the
// goals, so the box shrinks from 64 to 44 — 88 m over 3072 texels is 29 mm per
// texel instead of 42 mm, and contact hardening gets a third more resolution to
// work with for free.
const SHADOW_EXTENT = 44;                 // half-width, world units
const SHADOW_CENTER = new THREE.Vector3(0, 1.5, 0);
const SHADOW_DIST = 150;                  // light distance along -sunDir
// Tight depth range around that box: the span divides into the PCSS blocker
// gap, so halving it halves the quantisation of every penumbra estimate.
const SHADOW_NEAR = 88;
const SHADOW_FAR = 218;

// PCSS tuning, in metres of world space.
const SUN_SOFTNESS = 0.055;   // tan(apparent sun radius); 1 m of gap -> 5.5 cm
const PEN_MIN = 0.022;        // never below this or contact aliases
const PEN_MAX = 1.10;         // penumbra cap — nothing tall casts on the pitch now

export const QUALITY_TIERS = {
  low: { pixelRatio: 1.0, shadow: 2048, bloom: 0.19, msaa: 0, fxaa: true, grade: true, dof: false },
  medium: { pixelRatio: 1.0, shadow: 3072, bloom: 0.25, msaa: 4, fxaa: true, grade: true, dof: true },
  high: { pixelRatio: 1.5, shadow: 4096, bloom: 0.28, msaa: 4, fxaa: true, grade: true, dof: true },
};

// ---------------------------------------------------------------------------
// PCSS — patched into three's shadow chunk at import time
// ---------------------------------------------------------------------------
// three's SHADOWMAP_TYPE_PCF branch is a fixed 3x3 tap pattern: one penumbra
// width for the whole scene. Replacing it costs 20 texture reads and buys real
// contact hardening. The helpers are spliced in ahead of getShadow() so they
// still see texture2DCompare / unpackRGBAToDepth from the stock chunk.
let PCSS_INSTALLED = false;

function installSoftShadows() {
  if (PCSS_INSTALLED) return;
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (!src || src.indexOf('csPCSS') >= 0) { PCSS_INSTALLED = true; return; }

  const anchor = 'float getShadow(';
  const a = src.indexOf(anchor);
  const bStart = src.indexOf('#if defined( SHADOWMAP_TYPE_PCF )', a);
  const bEnd = src.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )', bStart);
  if (a < 0 || bStart < 0 || bEnd < 0) { PCSS_INSTALLED = true; return; }  // vendored three moved; keep stock

  // Depth in an orthographic shadow map is linear, so a depth difference maps
  // straight back to metres along the light.
  const depthSpan = (SHADOW_FAR - SHADOW_NEAR).toFixed(2);
  const uvPerM = (1.0 / (SHADOW_EXTENT * 2.0)).toFixed(8);

  const helpers = `
	// --- PCSS -------------------------------------------------------------
	// Vogel disc: even coverage from any tap count, no lookup table, and a
	// per-pixel rotation so the penumbra dithers instead of ringing.
	vec2 csDisc( float i, float n, float rot ) {
		float ang = i * 2.39996323 + rot;
		float r = sqrt( ( i + 0.5 ) / n );
		return vec2( cos( ang ), sin( ang ) ) * r;
	}
	float csPCSS( sampler2D map, vec2 mapSize, vec2 uv, float zRecv, float radius ) {
		float rot = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
		float searchUV = ${(PEN_MAX * (1.0 / (SHADOW_EXTENT * 2.0))).toFixed(8)} * radius;
		float sum = 0.0;
		float cnt = 0.0;
		for ( int i = 0; i < 8; i ++ ) {
			vec2 o = csDisc( float( i ), 8.0, rot ) * searchUV;
			float d = unpackRGBAToDepth( texture2D( map, uv + o ) );
			if ( d < zRecv ) { sum += d; cnt += 1.0; }
		}
		if ( cnt < 0.5 ) return 1.0;
		float gap = ( zRecv - sum / cnt ) * ${depthSpan};
		float pen = clamp( gap * ${SUN_SOFTNESS.toFixed(4)}, ${PEN_MIN.toFixed(4)}, ${PEN_MAX.toFixed(4)} );
		float penUV = pen * ${uvPerM} * radius;
		// one texel floor, otherwise a contact shadow shimmers on its own aliasing
		penUV = max( penUV, 0.75 / mapSize.x );
		float s = 0.0;
		for ( int i = 0; i < 12; i ++ ) {
			vec2 o = csDisc( float( i ), 12.0, rot + 1.7 ) * penUV;
			s += texture2DCompare( map, uv + o, zRecv );
		}
		return s / 12.0;
	}
`;

  const branch = `#if defined( SHADOWMAP_TYPE_PCF )
			shadow = csPCSS( shadowMap, shadowMapSize, shadowCoord.xy, shadowCoord.z, shadowRadius );
		`;

  let out = src.slice(0, a) + helpers + '\t' + src.slice(a);
  const shift = helpers.length + 1;
  out = out.slice(0, bStart + shift) + branch + out.slice(bEnd + shift);
  THREE.ShaderChunk.shadowmap_pars_fragment = out;
  PCSS_INSTALLED = true;
}

installSoftShadows();

// ---------------------------------------------------------------------------
// Contact-occlusion decal
// ---------------------------------------------------------------------------
// A cast shadow tells you where the light is; it does not tell you that the sole
// of the boot is touching grass. That is ambient occlusion, and at chibi scale a
// tight dark core right under the body sells it. Characters ship a generic soft
// ellipse for this; it is re-pointed at this much tighter falloff during shadow
// enrolment so it reads as contact rather than as a sticker the player sits on.
let _contactTex = null;
function contactTexture() {
  if (_contactTex) return _contactTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x + 0.5) / S * 2 - 1;
      const ny = (y + 0.5) / S * 2 - 1;
      const r = Math.hypot(nx, ny);
      // Two lobes, not one. A single falloff has to choose between "tight and
      // dark" and "soft and wide" and always looks like a decal; occlusion in
      // life is a small very dark core where the sole actually meets grass plus
      // a much wider, much fainter skirt from the bulk of the body.
      const core = Math.pow(Math.max(0, 1 - r / 0.50), 1.35);
      const skirt = Math.pow(Math.max(0, 1 - r / 1.00), 3.0);
      const a = Math.min(1, 0.72 * core + 0.40 * skirt);
      const i = (y * S + x) * 4;
      // RGB is ignored by the multiply blend below; alpha is the occlusion.
      d[i] = d[i + 1] = d[i + 2] = 0;
      d[i + 3] = Math.round(255 * a);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;   // an occlusion mask, not a picture
  t.needsUpdate = true;
  _contactTex = t;
  return t;
}

// ---------------------------------------------------------------------------
// Depth of field + aerial haze
// ---------------------------------------------------------------------------
// Runs in HDR straight after the scene pass. The circle of confusion is signed:
// negative in front of the focal plane, positive behind it, so the near field
// can be blurred harder than the far field the way a long lens actually behaves.
// Samples are rejected when they are sharper than the pixel being written, which
// stops a crisp foreground bleeding a halo into a soft background.
const DofShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uCam: { value: new THREE.Vector2(0.35, 600) },   // near, far
    uFocus: { value: 26 },
    uRange: { value: 0.55 },     // fraction of focus distance that stays sharp
    uNearK: { value: 1.5 },      // near-field blur multiplier
    uMaxCoc: { value: 0.012 },   // max blur radius, fraction of frame height
    uHaze: { value: new THREE.Vector3(0.62, 0.74, 0.86) },
    uHazeK: { value: 0.0 },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2  uTexel;
    uniform vec2  uCam;
    uniform float uFocus;
    uniform float uRange;
    uniform float uNearK;
    uniform float uMaxCoc;
    uniform vec3  uHaze;
    uniform float uHazeK;
    uniform float uAspect;
    varying vec2 vUv;

    float viewZ(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      // perspective depth -> positive distance from the eye
      return (2.0 * uCam.x * uCam.y) / (uCam.y + uCam.x - (2.0 * d - 1.0) * (uCam.y - uCam.x));
    }

    // signed circle of confusion, -1 .. 1
    float coc(float z) {
      float f = uFocus;
      float sharp = f * uRange;
      float s = (z - f) / max(0.35, abs(z) * 0.85 + sharp);
      s = clamp(s, -1.0, 1.0);
      return s < 0.0 ? s * uNearK : s;
    }

    vec2 disc(float i, float n, float rot) {
      float a = i * 2.39996323 + rot;
      float r = sqrt((i + 0.5) / n);
      return vec2(cos(a), sin(a)) * r;
    }

    void main() {
      float z = viewZ(vUv);
      float c = coc(z);
      float ac = min(1.0, abs(c));
      vec4 here = texture2D(tDiffuse, vUv);

      vec3 col = here.rgb;
      if (ac > 0.035) {
        float rot = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
        float rad = ac * uMaxCoc;
        vec2 scale = vec2(rad / uAspect, rad);
        vec3 acc = here.rgb;
        float wsum = 1.0;
        for (int i = 0; i < 14; i++) {
          vec2 o = disc(float(i), 14.0, rot) * scale;
          vec2 suv = clamp(vUv + o, vec2(0.001), vec2(0.999));
          float sc = abs(coc(viewZ(suv)));
          // a tap only contributes if its own blur reaches this pixel
          float w = smoothstep(0.0, 0.55, sc / max(0.02, ac));
          vec3 s = texture2D(tDiffuse, suv).rgb;
          acc += s * w;
          wsum += w;
        }
        col = acc / wsum;
      }

      // --- aerial perspective: distance eats contrast and pulls toward sky
      if (uHazeK > 0.0) {
        float h = 1.0 - exp(-max(0.0, z - 46.0) * uHazeK);
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, mix(col, vec3(l), 0.35 * h) + uHaze * h * 0.16, clamp(h, 0.0, 1.0));
      }

      gl_FragColor = vec4(col, 1.0);
    }`,
};

// ---------------------------------------------------------------------------
// Grade / vignette / chromatic aberration
// ---------------------------------------------------------------------------
// The reference has a very specific look: deeply saturated grass, warm skin and
// kit, cool shadow, and a soft dark corner falloff that keeps the eye on the
// ball. This is a lift/gamma/gain grade plus a per-channel radial resample, i.e.
// exactly what a 3D LUT would bake — done analytically so there is no texture to
// ship and it stays tweakable.
//
// The vignette is a pure even-power falloff of radius. The old version ran a
// smoothstep from an inner radius, which is C1-discontinuous where it starts and
// drew a faint ring the panel could see; x^n has no such onset.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAberration: { value: 0.0015 },
    uVigStrength: { value: 0.30 },
    uVigPower: { value: 2.35 },
    uVigCool: { value: 0.055 },
    uSaturation: { value: 1.22 },
    uContrast: { value: 1.13 },
    // Lift is deliberately near zero on R/G now. The old (0.004, 0.009, 0.019)
    // floor was worth ~2 sRGB counts of milk in every shadow on screen; with the
    // key/fill ratio doing the work there is nothing to rescue and the lift only
    // costs black.
    uLift: { value: new THREE.Vector3(0.000, 0.002, 0.010) },
    uGain: { value: new THREE.Vector3(1.026, 1.008, 0.984) },
    uGrain: { value: 0.014 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uAberration;
    uniform float uVigStrength;
    uniform float uVigPower;
    uniform float uVigCool;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3  uLift;
    uniform vec3  uGain;
    uniform float uGrain;
    uniform float uTime;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // --- chromatic aberration: transverse only, quadratic with radius, so the
      // centre of frame (where the ball lives) stays perfectly registered.
      float k = uAberration * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + c * k).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - c * k).b;

      // --- grade -----------------------------------------------------------
      col = max(vec3(0.0), col);
      col = col * uGain + uLift * (1.0 - col);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;

      // gentle highlight roll so bloom + white kit never clip to a flat plate
      col = col - 0.070 * col * col * col;

      // --- vignette: even power of normalised radius, so it is smooth at the
      // centre and has no onset ring anywhere. A touch of cool + desaturation
      // in the corners reads as lens falloff instead of a painted-on disc.
      float d = clamp(length(c * vec2(1.0, 1.10)) * 1.4142, 0.0, 1.0);
      float v = pow(d, uVigPower);
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(lum), v * 0.22);
      col *= 1.0 - uVigStrength * v;
      col.b += v * uVigCool * 0.5 * lum;
      col.r -= v * uVigCool * 0.25 * lum;

      // --- grain: breaks up banding in the sky gradient ---------------------
      float g = hash(vUv * vec2(1024.0, 1024.0) + uTime) - 0.5;
      col += g * uGrain * (1.0 - 0.7 * l);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

export function createEngine(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    stencil: false,
    powerPreference: 'high-performance',
  });

  // --- capability probe -----------------------------------------------------
  let rendererName = '';
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) rendererName = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
  } catch (e) { /* ignore */ }
  const software = /swiftshader|llvmpipe|softwarerasterizer|mesa offscreen/i.test(rendererName);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.00;
  renderer.shadowMap.enabled = true;
  // PCF, not PCFSoft: the PCF branch is the one replaced by csPCSS above.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x8ec6ee, 1);
  // The composer issues several renderer.render() calls per frame; without this
  // renderer.info would only ever report the last pass.
  renderer.info.autoReset = false;

  // --- scene ---------------------------------------------------------------
  const scene = new THREE.Scene();
  // Aerial perspective. The far stand sits 60-100 units out, so the range has to
  // start just past the touchline or the pitch itself goes milky. The DOF pass
  // adds a second, contrast-eating haze term on top of this.
  scene.fog = new THREE.Fog(0xbdd8ee, 58, 300);

  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.35, 600);
  camera.position.set(0, 26, 44);
  camera.lookAt(0, 0, 0);
  // The camera director publishes its focal distance here (see fx/camera.js);
  // the DOF pass reads it, so focus always tracks whatever the shot is about.
  camera.userData.dof = { focus: 26, range: 0.55, near: 1.5, max: 0.010, haze: 0.0035 };

  // Sky dome (drawn as scene.background would be flat; a dome gives a horizon).
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(320, 32, 20),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.name = 'sky';
  sky.renderOrder = -1000;
  scene.add(sky);

  // --- lighting ------------------------------------------------------------
  // Four sources, each with a job:
  //   hemi   sky/ground bounce — carries everything the sun cannot reach
  //   sun    the key, and the only shadow caster
  //   rim    cool back-light roughly opposite the key: puts a cold edge on the
  //          shadow side of every head, which is most of what "3D" reads as
  //   bounce warm low fill off the near stand so the fronts of legs stay warm
  //
  // The ratio between the first and the second IS the contrast of the frame, and
  // it is the whole reason a shadow reads as a shadow rather than as a slightly
  // greyer patch of grass. On flat turf the old rig delivered 1.56 of sun against
  // 1.65 of everything-else — a shadow removed 49% of the light, under an ACES
  // curve about half a stop, and the panel called the result "soft grey patches".
  // This rig delivers 2.6 against 1.35: a shadow now removes two thirds of the
  // light, ~1.5 stops, which is the reference's read. The lit level is held where
  // it was (3.2 -> 4.0 before tone mapping, which ACES pulls most of the way
  // back) so nothing clips; only the floor drops.
  const hemi = new THREE.HemisphereLight(0xd6eaff, 0x4d7a3c, 0.80);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4dc, 3.34);
  sun.position.copy(SUN_POS);
  sun.castShadow = true;
  sun.shadow.mapSize.set(3072, 3072);
  sun.shadow.camera.left = -SHADOW_EXTENT;
  sun.shadow.camera.right = SHADOW_EXTENT;
  sun.shadow.camera.top = SHADOW_EXTENT;
  sun.shadow.camera.bottom = -SHADOW_EXTENT;
  sun.shadow.camera.near = SHADOW_NEAR;
  sun.shadow.camera.far = SHADOW_FAR;
  // 88 m of ortho over 3072 texels is 29 mm per texel, and the depth span is now
  // 130 m, so -0.0003 is 39 mm of push — about one texel. That is enough to kill
  // acne on the near-planar turf and small enough that the shadow stays welded
  // to the sole of the boot instead of peter-panning out from under it; the
  // normal bias does the rest on curved kit.
  sun.shadow.bias = -0.00030;
  sun.shadow.normalBias = 0.016;
  sun.shadow.radius = 1;
  // THIS LINE IS THE WHOLE BALL GAME. LightShadow.updateMatrices() refreshes the
  // shadow camera's world matrix every frame but never its projection matrix, so
  // resizing the ortho frustum has no effect until it is recomputed by hand.
  // Without it the map keeps DirectionalLightShadow's constructor default of
  // (-5, 5, 5, -5) — a ten-metre square at the centre spot — and everything
  // outside that patch silently casts nothing. That is why the build had a fully
  // configured sun, castShadow flags, a 2k shadow map, and no shadows on screen.
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  // Aim the key at SHADOW_CENTER and park the lamp SHADOW_DIST back along the
  // ray, so the ortho box straddles the pitch AND the roofline that shades it.
  const _sunDirV = new THREE.Vector3().copy(SUN_POS).normalize();
  sun.target.position.copy(SHADOW_CENTER);
  sun.position.copy(SHADOW_CENTER).addScaledVector(_sunDirV, SHADOW_DIST);

  // Opposite the new key, so it still lands on the side of every head the sun
  // misses. Pulled back with the ambient — a rim that survives the contrast cut
  // would just put the flatness back in through the side door.
  const rim = new THREE.DirectionalLight(0xa9d2ff, 0.56);
  rim.position.set(-30, 26, -52);
  scene.add(rim);

  const bounce = new THREE.DirectionalLight(0xffe3bd, 0.24);
  bounce.position.set(-16, 5, 34);
  scene.add(bounce);

  const env = envMap(renderer);
  if (env) { scene.environment = env; }

  // --- post processing -----------------------------------------------------
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);

  const rtOpts = { type: THREE.HalfFloatType };
  if (!software) rtOpts.samples = 4;
  const rt = new THREE.WebGLRenderTarget(Math.max(2, size.x), Math.max(2, size.y), rtOpts);

  // Scene depth for DOF.
  //
  // EffectComposer ping-pongs two targets, and RenderPass draws into whichever
  // one is currently the *read* buffer. With an odd number of swapping passes in
  // the chain that role alternates every frame, so BOTH targets need their own
  // depth attachment — and the DOF pass has to sample the one that was just
  // written, not a fixed texture. Everything downstream is a full-screen quad
  // rendered with autoClear on, which wipes the depth of whatever it writes to;
  // that is harmless as long as DOF has already consumed the buffer it wants.
  function makeDepth() {
    const d = new THREE.DepthTexture(Math.max(2, size.x), Math.max(2, size.y));
    d.type = THREE.UnsignedIntType;
    d.minFilter = THREE.NearestFilter;
    d.magFilter = THREE.NearestFilter;
    return d;
  }
  const depthTex = makeDepth();
  rt.depthTexture = depthTex;

  const composer = new EffectComposer(renderer, rt);
  if (composer.renderTarget2) composer.renderTarget2.depthTexture = makeDepth();

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const dof = new ShaderPass(DofShader);
  dof.material.uniforms.tDepth.value = depthTex;
  dof.material.uniforms.uCam.value.set(camera.near, camera.far);
  const _dofRender = dof.render.bind(dof);
  dof.render = function (r, writeBuffer, readBuffer, deltaTime, maskActive) {
    if (readBuffer && readBuffer.depthTexture) {
      dof.material.uniforms.tDepth.value = readBuffer.depthTexture;
    }
    _dofRender(r, writeBuffer, readBuffer, deltaTime, maskActive);
  };
  composer.addPass(dof);

  // Threshold just above 1.0 in linear: only genuinely over-range pixels bloom —
  // floodlight lamp cores, the additive impact stars, the ball's specular hit.
  // A tight radius keeps the glow welded to whatever emits it instead of hazing
  // the turf, which is what separates the reference's crisp look from the
  // "everything is behind frosted glass" failure mode of a lazy bloom.
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * 0.5, size.y * 0.5), 0.30, 0.40, 1.02);
  composer.addPass(bloom);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  const fxaa = new ShaderPass(FXAAShader);
  composer.addPass(fxaa);

  // --- fps meter -----------------------------------------------------------
  let fps = 60, frames = 0, acc = 0;
  function tickFps(dt) {
    frames++; acc += dt;
    if (acc >= 0.4) { fps = frames / acc; frames = 0; acc = 0; }
  }

  let tier = 'high';

  function setQuality(t) {
    const q = QUALITY_TIERS[t] || QUALITY_TIERS.high;
    tier = QUALITY_TIERS[t] ? t : 'high';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    if (sun.shadow.mapSize.width !== q.shadow) {
      sun.shadow.mapSize.set(q.shadow, q.shadow);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    bloom.strength = q.bloom;
    fxaa.enabled = q.fxaa;
    grade.enabled = q.grade;
    dof.enabled = q.dof;
    resize();
  }

  function resize() {
    const w = Math.max(2, canvas.clientWidth || window.innerWidth);
    const h = Math.max(2, canvas.clientHeight || window.innerHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(Math.max(2, w * 0.5), Math.max(2, h * 0.5));
    const pr = renderer.getPixelRatio();
    fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    dof.material.uniforms.uTexel.value.set(1 / (w * pr), 1 / (h * pr));
    dof.material.uniforms.uAspect.value = w / h;
  }

  // -------------------------------------------------------------------------
  // Shadow enrolment
  // -------------------------------------------------------------------------
  // Who casts is a *lighting* decision, not a modelling one, so it is made here
  // rather than scattered across the entity modules — which is exactly how the
  // build ended up with a fully configured sun and not one player in its shadow
  // map. The walk is idempotent and marks what it has touched, so it costs a
  // pointer compare per node after the first pass.
  //
  // Only character rigs, the ball and the goals are enrolled. The stands and the
  // instanced crowd deliberately stay out: they are hundreds of extra shadow
  // draw calls for silhouettes nobody can see against their own structure. The
  // roof is already a caster and is the one piece of stadium that matters.
  let enrolTick = 0;

  function enrolMesh(m) {
    if (m.userData.__csShadow) return;
    m.userData.__csShadow = 1;
    const mat = m.material;
    if (!mat || mat.isMeshBasicMaterial || mat.isShaderMaterial || mat.transparent) {
      // decals, rings, fake shadows: never a caster
      m.castShadow = false;
      return;
    }
    const g = m.geometry;
    if (g && !g.boundingSphere) { try { g.computeBoundingSphere(); } catch (e) { /* ignore */ } }
    const r = g && g.boundingSphere ? g.boundingSphere.radius : 1;
    // Face features (brows, pupils, nostrils) sit inside the head's own
    // silhouette; they would double the shadow draw calls and change nothing.
    m.castShadow = r > 0.085;
    m.receiveShadow = true;
  }

  // The generic soft ellipse a character ships as its "shadow" is retargeted to
  // a tight contact-occlusion falloff. Its owner keeps driving position/opacity;
  // only the profile and the footprint change, so nothing fights over it.
  //
  // The blend is the important half. Alpha-blending a dark colour over grass
  // replaces the grass: inside the blob you see flat charcoal, the blade texture
  // stops, and the eye reads a sticker lying on the pitch. Occlusion is a
  // MULTIPLY — it scales the light already there and everything underneath keeps
  // its own detail. Custom blending gives exactly that from the alpha channel:
  //
  //     src * ZERO + dst * (1 - srcAlpha)   ==   dst * (1 - occlusion)
  //
  // which is why the mask above stores its profile in alpha and leaves RGB at
  // zero. It also means the owner's per-frame `material.opacity` write (the
  // fade-out as a player leaves the ground) still scales the whole effect, since
  // MeshBasicMaterial folds opacity into the alpha it emits.
  function tameContactBlob(m) {
    if (m.userData.__csContact) return;
    m.userData.__csContact = 1;
    const mat = m.material;
    if (!mat || !mat.map) return;
    mat.map = contactTexture();
    mat.color.setRGB(0, 0, 0);
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.ZeroFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    mat.depthWrite = false;
    mat.toneMapped = false;
    mat.needsUpdate = true;
    if (m.geometry && m.geometry.attributes && m.geometry.attributes.position) {
      m.geometry.scale(1.14, 1.14, 1);
      m.geometry.computeBoundingSphere();
    }
  }

  function enrolGroup(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      const isFlatDecal = o.material && o.material.isMeshBasicMaterial
        && o.material.transparent && o.material.map
        && Math.abs(o.rotation.x + Math.PI / 2) < 0.01;
      if (isFlatDecal) { tameContactBlob(o); o.castShadow = false; o.receiveShadow = false; return; }
      enrolMesh(o);
    });
  }

  // The bowl is the reason the reference frames have a shadow at all: the roof
  // and the upper deck are what throw that huge soft band across the near third
  // of the pitch. Only the big high structure is enrolled — anything low is
  // hidden behind the ad boards, and the instanced crowd is never touched (tens
  // of thousands of tiny casters for a silhouette that lands on their own seats).
  const _bb = new THREE.Box3();
  function enrolStadium(root) {
    if (root.userData.__csStadium) return;
    root.userData.__csStadium = 1;
    root.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const g = o.geometry;
      if (!g) return;
      if (!g.boundingBox) { try { g.computeBoundingBox(); } catch (e) { return; } }
      if (!g.boundingSphere) { try { g.computeBoundingSphere(); } catch (e) { return; } }
      if (!g.boundingBox || !g.boundingSphere) return;
      _bb.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
      const tall = _bb.max.y > 13;
      const big = g.boundingSphere.radius > 6;
      const mat = o.material;
      const opaque = mat && !mat.isMeshBasicMaterial && !mat.transparent;
      if (tall && big && opaque) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  function enrolShadows() {
    for (let i = 0; i < scene.children.length; i++) {
      const c = scene.children[i];
      const n = c.name || '';
      if (n === 'stadium') { c.updateMatrixWorld(true); enrolStadium(c); continue; }
      if (n === 'sky' || n === 'vfx' || n === 'pitch') continue;
      if (n === 'ball' || n.indexOf('goal') === 0) { enrolGroup(c); continue; }
      // team groups hold the player rigs
      c.traverse((o) => {
        if (o.isGroup && o.name && o.name.indexOf('player-') === 0) enrolGroup(o);
      });
    }
  }

  // Grain has to be deterministic for the capture harness, so it advances on the
  // fixed step count rather than on the wall clock.
  let gradeTick = 0;

  function render(dt) {
    tickFps(dt || 1 / 60);
    // Rigs and props are added over the first frames and can be swapped later;
    // re-walking occasionally is far cheaper than a mutation observer and means
    // anything that appears mid-match still lands in the shadow map.
    if ((enrolTick++ % 20) === 0) enrolShadows();
    sky.position.copy(camera.position);
    gradeTick = (gradeTick + 1) % 64;
    grade.material.uniforms.uTime.value = gradeTick * 0.137;

    // depth of field follows the director's focal target
    const d = camera.userData.dof;
    if (d && dof.enabled) {
      const u = dof.material.uniforms;
      u.uCam.value.set(camera.near, camera.far);
      u.uFocus.value = d.focus;
      u.uRange.value = d.range;
      u.uNearK.value = d.near;
      u.uMaxCoc.value = d.max;
      u.uHazeK.value = d.haze;
    }

    renderer.info.reset();
    composer.render(dt || 1 / 60);
  }

  const stats = {
    get fps() { return fps; },
    get drawCalls() { return renderer.info.render.calls; },
    get triangles() { return renderer.info.render.triangles; },
    get programs() { return renderer.info.programs ? renderer.info.programs.length : 0; },
    get software() { return software; },
    get rendererName() { return rendererName; },
    get quality() { return tier; },
  };

  setQuality(software ? 'medium' : 'high');
  resize();
  window.addEventListener('resize', resize);

  // Direction the key light TRAVELS (from the lamp toward the pitch), normalised.
  // Anything that fakes a projected shadow — the ball's contact ellipse, decals —
  // must read this instead of hardcoding a copy, so moving the key here moves
  // every faked shadow with it.
  const sunTravel = new THREE.Vector3();
  function sunDir() {
    return sunTravel.copy(sun.target.position).sub(sun.position).normalize();
  }

  return {
    renderer, scene, camera, composer, sun, hemi, rim, bounce, sky,
    bloom, grade, dof,
    render, resize, setQuality, stats,
    sunDir, enrolShadows,
    get quality() { return tier; },
  };
}
