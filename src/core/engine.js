// Renderer + scene + post-processing chain + resize + quality tiers.
//
//   createEngine(canvas) -> { renderer, scene, camera, composer, render(dt),
//                             resize(), setQuality(tier), stats }
//
// Chain: RenderPass -> UnrealBloomPass -> OutputPass (ACES + sRGB) -> FXAA -> screen.
// Note that three only applies tone mapping when rendering to the default
// framebuffer, so with a composer OutputPass owns tone mapping and colour space.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { envMap, skyTexture } from './assets.js';

export const QUALITY_TIERS = {
  low: { pixelRatio: 1.0, shadow: 1024, bloom: 0.24, msaa: 0, fxaa: true, shadowRadius: 2 },
  medium: { pixelRatio: 1.0, shadow: 2048, bloom: 0.32, msaa: 4, fxaa: true, shadowRadius: 3 },
  high: { pixelRatio: 1.5, shadow: 2048, bloom: 0.38, msaa: 4, fxaa: true, shadowRadius: 4 },
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
  renderer.toneMappingExposure = 1.20;
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
  const hemi = new THREE.HemisphereLight(0xcfeaff, 0x4c6f34, 1.35);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4dd, 2.9);
  sun.position.set(34, 62, 24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -46;
  sun.shadow.camera.right = 46;
  sun.shadow.camera.top = 34;
  sun.shadow.camera.bottom = -34;
  sun.shadow.camera.near = 12;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.045;
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(0, 0, 0);

  const rim = new THREE.DirectionalLight(0x9fc8ff, 0.55);
  rim.position.set(-34, 26, -30);
  scene.add(rim);

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

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * 0.5, size.y * 0.5), 0.34, 0.62, 0.86);
  composer.addPass(bloom);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

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
    sun.shadow.radius = q.shadowRadius;
    bloom.strength = q.bloom;
    fxaa.enabled = q.fxaa;
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

  function render(dt) {
    tickFps(dt || 1 / 60);
    sky.position.copy(camera.position);
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
    renderer, scene, camera, composer, sun, hemi, rim, sky,
    render, resize, setQuality, stats,
    get quality() { return tier; },
  };
}
