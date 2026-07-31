// Renderer + scene + post-processing chain + resize + quality tiers.
//
//   createEngine(canvas) -> { renderer, scene, camera, composer, render(dt),
//                             resize(), setQuality(tier), stats }
//
// Chain:
//
//   RenderPass  -> HDR linear scene (MSAA 4x where the driver supports it)
//   BloomPass   -> floodlights, the ball's specular and every additive VFX bloom
//   OutputPass  -> ACES filmic tone map + sRGB transfer
//   GradePass   -> print-film grade (lift/gain/saturation), radial chromatic
//                  aberration, vignette and a fine grain floor
//   FXAAPass    -> edge clean-up after the grade, so CA fringes get smoothed too
//
// three only tone maps when rendering to the default framebuffer, so with a
// composer OutputPass owns tone mapping and colour space; the grade therefore
// runs in display space where lift/gain behave like a colour-grading LUT.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { envMap, skyTexture } from './assets.js';

export const QUALITY_TIERS = {
  low: { pixelRatio: 1.0, shadow: 1024, bloom: 0.19, msaa: 0, fxaa: true, grade: true },
  medium: { pixelRatio: 1.0, shadow: 2048, bloom: 0.25, msaa: 4, fxaa: true, grade: true },
  high: { pixelRatio: 1.5, shadow: 2048, bloom: 0.28, msaa: 4, fxaa: true, grade: true },
};

// ---------------------------------------------------------------------------
// Grade / vignette / chromatic aberration
// ---------------------------------------------------------------------------
// The reference has a very specific look: deeply saturated grass, warm skin and
// kit, cool shadow, and a soft dark corner falloff that keeps the eye on the
// ball. This is a lift/gamma/gain grade plus a per-channel radial resample, i.e.
// exactly what a 3D LUT would bake — done analytically so there is no texture to
// ship and it stays tweakable.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAberration: { value: 0.0016 },
    uVignette: { value: new THREE.Vector2(0.72, 1.34) }, // (inner, power)
    uVigStrength: { value: 0.36 },
    uSaturation: { value: 1.24 },
    uContrast: { value: 1.10 },
    uLift: { value: new THREE.Vector3(0.004, 0.008, 0.016) },
    uGain: { value: new THREE.Vector3(1.020, 1.006, 0.992) },
    uGrain: { value: 0.016 },
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
    uniform vec2  uVignette;
    uniform float uVigStrength;
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
      col = col - 0.055 * col * col * col;

      // --- vignette ---------------------------------------------------------
      float d = length(c * vec2(1.0, 1.08)) * 1.4142;
      float v = 1.0 - uVigStrength * pow(smoothstep(uVignette.x, 1.0, d), uVignette.y);
      col *= v;

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
  renderer.toneMappingExposure = 1.07;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x8ec6ee, 1);
  // The composer issues several renderer.render() calls per frame; without this
  // renderer.info would only ever report the last pass.
  renderer.info.autoReset = false;

  // --- scene ---------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xc6def0, 210, 520);

  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.35, 600);
  camera.position.set(0, 26, 44);
  camera.lookAt(0, 0, 0);

  // Sky dome (drawn as scene.background would be flat; a dome gives a horizon).
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(320, 32, 20),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.name = 'sky';
  sky.renderOrder = -1000;
  scene.add(sky);

  // --- lighting ------------------------------------------------------------
  // Balance note: a chibi head is a large smooth sphere and catches far more of a
  // hard key than a stubby limb does, which used to blow the faces out to near
  // white. The fix is a softer key with more of the level carried by the sky
  // hemisphere and the environment: same overall brightness, much flatter
  // terminator on spheres. Exposure came down to match and the grade pass puts
  // the contrast back where the reference has it.
  const hemi = new THREE.HemisphereLight(0xd4eaff, 0x557f3e, 1.62);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d6, 2.30);
  sun.position.set(34, 62, 24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -44;
  sun.shadow.camera.right = 44;
  sun.shadow.camera.top = 33;
  sun.shadow.camera.bottom = -33;
  sun.shadow.camera.near = 12;
  sun.shadow.camera.far = 170;
  // One shadow texel is 88/2048 = 43 mm here. A constant bias of that order is
  // enough to kill acne on the near-planar turf without lifting contact shadows
  // off the boots (peter-panning); the normal bias does the rest on curved kit.
  sun.shadow.bias = -0.00042;
  sun.shadow.normalBias = 0.024;
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(0, 0, 0);

  // Cool sky-side rim, and a soft warm bounce from the far stand so the shadow
  // side of a player never goes flat black.
  const rim = new THREE.DirectionalLight(0xa8ceff, 0.42);
  rim.position.set(-34, 26, -30);
  scene.add(rim);

  const bounce = new THREE.DirectionalLight(0xffe6c2, 0.26);
  bounce.position.set(-18, 6, 34);
  scene.add(bounce);

  const env = envMap(renderer);
  if (env) { scene.environment = env; }

  // --- post processing -----------------------------------------------------
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);

  const rtOpts = { type: THREE.HalfFloatType };
  if (!software) rtOpts.samples = 4;
  const rt = new THREE.WebGLRenderTarget(Math.max(2, size.x), Math.max(2, size.y), rtOpts);

  const composer = new EffectComposer(renderer, rt);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

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
  }

  // Grain has to be deterministic for the capture harness, so it advances on the
  // fixed step count rather than on the wall clock.
  let gradeTick = 0;

  function render(dt) {
    tickFps(dt || 1 / 60);
    sky.position.copy(camera.position);
    gradeTick = (gradeTick + 1) % 64;
    grade.material.uniforms.uTime.value = gradeTick * 0.137;
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

  return {
    renderer, scene, camera, composer, sun, hemi, rim, bounce, sky,
    bloom, grade,
    render, resize, setQuality, stats,
    get quality() { return tier; },
  };
}
