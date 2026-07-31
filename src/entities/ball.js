// Ball visual: textured sphere with real spin, a fading trail ribbon and a
// contact shadow. Physics lives in sim/physics.js; this module only renders.
//
//   createBall(opts) -> { group, mesh, sync(body, dt), reset(), setTrail(b), dispose() }

import * as THREE from 'three';
import { ballTexture, softCircle, particleTexture } from '../core/assets.js';
import { BALL_R } from '../core/constants.js';

const TRAIL = 22;

export function createBall(opts = {}) {
  const group = new THREE.Group();
  group.name = 'ball';

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 26, 18),
    new THREE.MeshStandardMaterial({
      map: ballTexture(opts.style || 'classic'),
      roughness: 0.44,
      metalness: 0.02,
      envMapIntensity: 0.8,
    }),
  );
  mesh.castShadow = true;
  group.add(mesh);

  // contact shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({
      map: softCircle('rgba(0,0,0,0.55)'), transparent: true, depthWrite: false, opacity: 0.6,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 3;

  // ---- trail ribbon -------------------------------------------------------
  const trailGeo = new THREE.BufferGeometry();
  const tPos = new Float32Array(TRAIL * 2 * 3);
  const tAlpha = new Float32Array(TRAIL * 2);
  const tIdx = [];
  for (let i = 0; i < TRAIL - 1; i++) {
    const a = i * 2;
    tIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  trailGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  trailGeo.setAttribute('aAlpha', new THREE.BufferAttribute(tAlpha, 1));
  trailGeo.setIndex(tIdx);
  trailGeo.frustumCulled = false;

  const trailMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xffffff) } },
    vertexShader: /* glsl */`
      attribute float aAlpha;
      varying float vA;
      void main() {
        vA = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vA;
      void main() {
        if (vA <= 0.001) discard;
        gl_FragColor = vec4(uColor, vA);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.frustumCulled = false;
  trail.renderOrder = 5;

  const history = [];
  for (let i = 0; i < TRAIL; i++) history.push(new THREE.Vector3(0, BALL_R, 0));
  let trailOn = true;

  const spinQ = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function sync(body, dt) {
    group.position.copy(body.pos);
    mesh.position.set(0, 0, 0);

    // spin
    const w = body.spin;
    const mag = Math.hypot(w.x, w.y, w.z);
    if (mag > 1e-4) {
      axis.set(w.x / mag, w.y / mag, w.z / mag);
      spinQ.setFromAxisAngle(axis, mag * dt);
      mesh.quaternion.premultiply(spinQ);
    }

    // shadow
    shadow.position.set(body.pos.x, 0.014, body.pos.z);
    const h = Math.max(0, body.pos.y - BALL_R);
    const k = 1 / (1 + h * 0.55);
    shadow.scale.setScalar(0.62 + 0.5 * k);
    shadow.material.opacity = 0.55 * k;

    // trail
    for (let i = history.length - 1; i > 0; i--) history[i].copy(history[i - 1]);
    history[0].copy(body.pos);

    const speed = Math.hypot(body.vel.x, body.vel.y, body.vel.z);
    const strength = trailOn ? Math.min(1, Math.max(0, (speed - 11) / 22)) : 0;

    for (let i = 0; i < TRAIL; i++) {
      const p = history[i];
      const n = Math.min(TRAIL - 1, i + 1);
      dir.copy(history[n]).sub(p);
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
      side.crossVectors(dir, up).normalize().multiplyScalar(BALL_R * 0.82 * (1 - i / TRAIL));
      const o = i * 6;
      tPos[o] = p.x - side.x; tPos[o + 1] = p.y - side.y; tPos[o + 2] = p.z - side.z;
      tPos[o + 3] = p.x + side.x; tPos[o + 4] = p.y + side.y; tPos[o + 5] = p.z + side.z;
      const a = strength * Math.pow(1 - i / TRAIL, 2.0) * 0.55;
      tAlpha[i * 2] = a; tAlpha[i * 2 + 1] = a;
    }
    trailGeo.getAttribute('position').needsUpdate = true;
    trailGeo.getAttribute('aAlpha').needsUpdate = true;
  }

  function reset(pos) {
    for (const h of history) h.copy(pos);
    tAlpha.fill(0);
    trailGeo.getAttribute('aAlpha').needsUpdate = true;
    mesh.quaternion.identity();
    group.position.copy(pos);
  }

  return {
    group, mesh, shadow, trail,
    sync, reset,
    setTrail(v) { trailOn = !!v; },
    dispose() {
      mesh.geometry.dispose(); mesh.material.dispose();
      shadow.geometry.dispose(); shadow.material.dispose();
      trailGeo.dispose(); trailMat.dispose();
    },
  };
}
