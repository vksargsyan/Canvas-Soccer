// Ball visual: panelled sphere with real spin, an impact squash, a camera-facing
// motion trail and a contact shadow that tightens as it nears the ground.
// Physics lives in sim/physics.js; this module only renders.
//
//   createBall(opts) -> { group, mesh, shadow, trail, sync(body, dt), reset(pos),
//                         setTrail(b), dispose() }

import * as THREE from 'three';
import { ballSkin } from './ball-texture.js';
import { BALL_R } from '../core/constants.js';

// Direction the key sun travels, mirroring the engine's main DirectionalLight at
// (34, 62, 24) aimed at the origin. The contact shadow is projected along it so
// it sits *beside* the ball the way the reference does, instead of hiding
// directly underneath where the camera can never see it.
const SUN = { x: -34, y: -62, z: -24 };
const SUN_DX = (SUN.x / -SUN.y) * 0.78;
const SUN_DZ = (SUN.z / -SUN.y) * 0.78;
const SUN_AZ = Math.atan2(SUN_DZ, SUN_DX);

const TRAIL = 20;                 // ribbon samples
const TRAIL_ON = 11;              // m/s where the trail starts to appear
const TRAIL_FULL = 28;            // m/s where it is at full strength

export function createBall(opts = {}) {
  const group = new THREE.Group();
  group.name = 'ball';

  // group -> squash (world-axis scale) -> mesh (spin). Scaling the parent means
  // the impact squash always flattens along Y no matter how the ball is rotated.
  const squash = new THREE.Group();
  group.add(squash);

  const skin = ballSkin(opts.style || 'classic');
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 32, 24),
    new THREE.MeshStandardMaterial({
      map: skin.map,
      normalMap: skin.normalMap,
      normalScale: new THREE.Vector2(0.62, 0.62),
      roughnessMap: skin.roughnessMap,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.85,
    }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  squash.add(mesh);

  // ---- contact shadow -----------------------------------------------------
  // The falloff is evaluated in the fragment shader rather than sampled from a
  // texture: it stays perfectly smooth at any on-screen size, costs no texture
  // memory, and there is no mip chain to go soft on a ball this small.
  const shadowMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x0c1a07) },
      uOpacity: { value: 0.8 },
      uCore: { value: 0.5 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uCore;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float d = length(p);
        // solid umbra out to uCore, then a soft penumbra to the rim. On the deck
        // the umbra is wide and dark; the higher the ball, the more it is all
        // penumbra — which is what "tightens as it nears the ground" means.
        float a = (1.0 - smoothstep(uCore, 1.0, d)) * uOpacity;
        if (a <= 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
  shadow.rotation.set(-Math.PI / 2, 0, -SUN_AZ);
  shadow.renderOrder = 3;
  shadow.frustumCulled = false;

  // ---- trail ribbon -------------------------------------------------------
  // Built as a strip of centre points; the vertex shader spreads each pair
  // sideways in VIEW space, so the ribbon always faces the camera whatever the
  // ball's flight direction (a world-space cross product goes edge-on on a
  // dropping ball and disappears).
  const trailGeo = new THREE.BufferGeometry();
  const tPos = new Float32Array(TRAIL * 2 * 3);
  const tDir = new Float32Array(TRAIL * 2 * 3);
  const tSide = new Float32Array(TRAIL * 2);
  const tWidth = new Float32Array(TRAIL * 2);
  const tAlpha = new Float32Array(TRAIL * 2);
  const tUv = new Float32Array(TRAIL * 2 * 2);
  const tIdx = [];
  for (let i = 0; i < TRAIL; i++) {
    tSide[i * 2] = -1; tSide[i * 2 + 1] = 1;
    const u = i / (TRAIL - 1);
    tUv[i * 4] = u; tUv[i * 4 + 1] = 0;
    tUv[i * 4 + 2] = u; tUv[i * 4 + 3] = 1;
  }
  for (let i = 0; i < TRAIL - 1; i++) {
    const a = i * 2;
    tIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  trailGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  trailGeo.setAttribute('aDir', new THREE.BufferAttribute(tDir, 3));
  trailGeo.setAttribute('aSide', new THREE.BufferAttribute(tSide, 1));
  trailGeo.setAttribute('aWidth', new THREE.BufferAttribute(tWidth, 1));
  trailGeo.setAttribute('aAlpha', new THREE.BufferAttribute(tAlpha, 1));
  trailGeo.setAttribute('uv', new THREE.BufferAttribute(tUv, 2));
  trailGeo.setIndex(tIdx);

  const trailMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xdff0ff) },
    },
    vertexShader: /* glsl */`
      attribute vec3 aDir;
      attribute float aSide;
      attribute float aWidth;
      attribute float aAlpha;
      varying float vA;
      varying vec2 vUv;
      void main() {
        vA = aAlpha;
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 dv = (modelViewMatrix * vec4(aDir, 0.0)).xyz;
        if (length(dv) < 1e-5) dv = vec3(0.0, 1.0, 0.0);
        dv = normalize(dv);
        vec3 toEye = normalize(-mv.xyz);
        vec3 sideV = cross(dv, toEye);
        float sl = length(sideV);
        sideV = sl < 1e-4 ? vec3(1.0, 0.0, 0.0) : sideV / sl;
        mv.xyz += sideV * (aSide * aWidth);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vA;
      varying vec2 vUv;
      void main() {
        // soft across the ribbon, fading out along its length — analytic so the
        // taper stays clean however few samples the strip has
        float v = vUv.y * 2.0 - 1.0;
        float across = pow(max(0.0, 1.0 - v * v), 0.8);
        float along = pow(max(0.0, 1.0 - vUv.x), 1.5);
        float a = across * along * vA;
        if (a <= 0.003) discard;
        gl_FragColor = vec4(uColor * (0.65 + 0.7 * a), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.frustumCulled = false;
  trail.renderOrder = 5;
  trail.visible = false;

  // ---- state --------------------------------------------------------------
  const history = [];
  for (let i = 0; i < TRAIL; i++) history.push(new THREE.Vector3(0, BALL_R, 0));
  let trailOn = true;
  let strength = 0;
  let squashAmt = 0;
  let lastImpact = 0;

  const spinQ = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function sync(body, dt) {
    group.position.copy(body.pos);

    // --- spin ---------------------------------------------------------------
    const w = body.spin;
    const mag = Math.hypot(w.x, w.y, w.z);
    if (mag > 1e-4 && dt > 0) {
      axis.set(w.x / mag, w.y / mag, w.z / mag);
      spinQ.setFromAxisAngle(axis, mag * dt);
      mesh.quaternion.premultiply(spinQ);
    }

    // --- impact squash ------------------------------------------------------
    if (body.impactId !== lastImpact) {
      lastImpact = body.impactId;
      squashAmt = Math.min(0.30, (body.impactSpeed || 0) * 0.020);
    }
    if (squashAmt > 0.0005) {
      squashAmt *= Math.max(0, 1 - dt * 13);
      squash.scale.set(1 + squashAmt * 0.55, 1 - squashAmt, 1 + squashAmt * 0.55);
    } else if (squash.scale.y !== 1) {
      squashAmt = 0;
      squash.scale.set(1, 1, 1);
    }

    // --- contact shadow -----------------------------------------------------
    const h = Math.max(0, body.pos.y - BALL_R);
    const k = 1 / (1 + h * 1.25);
    shadow.position.set(
      body.pos.x + body.pos.y * SUN_DX,
      0.013,
      body.pos.z + body.pos.y * SUN_DZ,
    );
    // tight and dark on the deck, wide and faint the higher the ball climbs;
    // stretched slightly along the sun azimuth, as a real low-sun shadow is
    const s = BALL_R * (2.85 + 5.0 * (1 - k));
    shadow.scale.set(s * 1.22, s, 1);
    shadowMat.uniforms.uOpacity.value = 0.80 * k * k + 0.05;
    shadowMat.uniforms.uCore.value = 0.14 + 0.38 * k;

    // --- trail --------------------------------------------------------------
    for (let i = history.length - 1; i > 0; i--) history[i].copy(history[i - 1]);
    history[0].copy(body.pos);

    const speed = Math.hypot(body.vel.x, body.vel.y, body.vel.z);
    const want = trailOn
      ? Math.min(1, Math.max(0, (speed - TRAIL_ON) / (TRAIL_FULL - TRAIL_ON)))
      : 0;
    // ease in fast, fade out slowly so the tail lingers a beat after a save
    strength += (want - strength) * Math.min(1, dt * (want > strength ? 26 : 7));

    trail.visible = strength > 0.02;
    if (trail.visible) {
      for (let i = 0; i < TRAIL; i++) {
        const p = history[i];
        const a = history[Math.max(0, i - 1)];
        const b = history[Math.min(TRAIL - 1, i + 1)];
        dir.copy(b).sub(a);
        if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
        const t = i / (TRAIL - 1);
        const width = BALL_R * (1.20 - 0.86 * t) * (0.5 + 0.5 * strength);
        const alpha = strength * (1 - t) * 1.25;
        for (let s = 0; s < 2; s++) {
          const j = i * 2 + s;
          tPos[j * 3] = p.x; tPos[j * 3 + 1] = p.y; tPos[j * 3 + 2] = p.z;
          tDir[j * 3] = dir.x; tDir[j * 3 + 1] = dir.y; tDir[j * 3 + 2] = dir.z;
          tWidth[j] = width;
          tAlpha[j] = alpha;
        }
      }
      trailGeo.getAttribute('position').needsUpdate = true;
      trailGeo.getAttribute('aDir').needsUpdate = true;
      trailGeo.getAttribute('aWidth').needsUpdate = true;
      trailGeo.getAttribute('aAlpha').needsUpdate = true;
      trailGeo.computeBoundingSphere();
    }
  }

  function reset(pos) {
    const p = pos || group.position;
    for (const h of history) h.copy(p);
    tAlpha.fill(0);
    trailGeo.getAttribute('aAlpha').needsUpdate = true;
    strength = 0;
    squashAmt = 0;
    squash.scale.set(1, 1, 1);
    trail.visible = false;
    mesh.quaternion.identity();
    group.position.copy(p);
    shadow.position.set(p.x, 0.013, p.z);
  }

  return {
    group, mesh, shadow, trail,
    sync, reset,
    setTrail(v) { trailOn = !!v; },
    dispose() {
      mesh.geometry.dispose(); mesh.material.dispose();
      shadow.geometry.dispose(); shadowMat.dispose();
      trailGeo.dispose(); trailMat.dispose();
    },
  };
}
