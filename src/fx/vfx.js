// Particles, impact flashes, dust, grass scuff, confetti and goal explosions.
//
//   createVfx(scene) -> { burst, dust, scuff, confetti, swoosh, goalBlast,
//                         update(dt), reset() }
//
// One pooled Points cloud handles every particle (single draw call). Flashes are a
// small pool of camera-facing quads that stay hidden until used.

import * as THREE from 'three';
import { particleTexture, starTexture, ringTexture } from '../core/assets.js';
import { makeRng } from '../core/rng.js';

const MAX = 900;
const FLASHES = 10;

const frng = makeRng(0xfeed);

export function createVfx(scene) {
  const group = new THREE.Group();
  group.name = 'vfx';
  scene.add(group);

  // ---- pooled particle cloud ---------------------------------------------
  const pos = new Float32Array(MAX * 3);
  const col = new Float32Array(MAX * 3);
  const siz = new Float32Array(MAX);
  const alp = new Float32Array(MAX);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: particleTexture() },
      uScale: { value: 700 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aAlpha;
      uniform float uScale;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.0, aSize * uScale / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.002) discard;
        vec4 t = texture2D(uMap, gl_PointCoord);
        gl_FragColor = vec4(vColor, t.a * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 20;
  group.add(points);

  const P = [];
  for (let i = 0; i < MAX; i++) {
    P.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, drag: 1, grav: -9, r: 1, g: 1, b: 1, fade: 1, spinY: 0 });
  }
  let cursor = 0;

  function spawn() {
    for (let i = 0; i < MAX; i++) {
      const p = P[cursor];
      cursor = (cursor + 1) % MAX;
      if (!p.live) return p;
    }
    return P[cursor];
  }

  const c3 = new THREE.Color();
  function emit(o) {
    const p = spawn();
    p.live = true;
    p.x = o.x; p.y = o.y; p.z = o.z;
    p.vx = o.vx; p.vy = o.vy; p.vz = o.vz;
    p.life = 0; p.max = o.life;
    p.size = o.size; p.drag = o.drag ?? 1.6; p.grav = o.grav ?? -9;
    c3.set(o.color).convertSRGBToLinear();
    p.r = c3.r; p.g = c3.g; p.b = c3.b;
    p.fade = o.fade ?? 1;
    return p;
  }

  // ---- flash quads --------------------------------------------------------
  const starMat = new THREE.MeshBasicMaterial({
    map: starTexture(4), transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
  });
  const ringMat = new THREE.MeshBasicMaterial({
    map: ringTexture(), transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
  });
  const quad = new THREE.PlaneGeometry(1, 1);

  const flashes = [];
  for (let i = 0; i < FLASHES; i++) {
    const m = new THREE.Mesh(quad, i % 2 ? ringMat.clone() : starMat.clone());
    m.visible = false;
    m.renderOrder = 30;
    m.frustumCulled = false;
    group.add(m);
    flashes.push({ mesh: m, life: 0, max: 1, s0: 1, s1: 2, spin: 0, kind: i % 2 });
  }

  function takeFlash(kind) {
    let best = null;
    for (const f of flashes) {
      if (f.kind !== kind) continue;
      if (f.life <= 0) return f;
      if (!best || f.life / f.max > best.life / best.max) best = f;
    }
    return best;
  }

  function flash(kind, x, y, z, size, life, color, spin = 0) {
    const f = takeFlash(kind);
    if (!f) return;
    f.life = life; f.max = life;
    f.s0 = size * 0.55; f.s1 = size;
    f.spin = spin;
    f.mesh.position.set(x, y, z);
    f.mesh.material.color.set(color);
    f.mesh.visible = true;
    f.mesh.scale.setScalar(f.s0);
  }

  // ---- public emitters ----------------------------------------------------

  function burst(p, opts = {}) {
    const n = opts.count ?? 16;
    const spd = opts.speed ?? 5;
    const color = opts.color ?? 0xffffff;
    for (let i = 0; i < n; i++) {
      const a = frng.float() * Math.PI * 2;
      const e = frng.range(0.15, 1.0);
      emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * spd * e, vy: frng.range(0.4, 1.4) * spd * 0.6, vz: Math.sin(a) * spd * e,
        life: frng.range(0.28, 0.6), size: frng.range(0.10, 0.24), color,
        drag: 2.4, grav: -11,
      });
    }
    if (opts.flash !== false) {
      flash(0, p.x, p.y + 0.15, p.z, opts.flashSize ?? 2.4, 0.28, opts.flashColor ?? 0xffffff, frng.range(-1, 1));
    }
  }

  function dust(p, opts = {}) {
    const n = opts.count ?? 10;
    for (let i = 0; i < n; i++) {
      const a = frng.float() * Math.PI * 2;
      emit({
        x: p.x + frng.range(-0.2, 0.2), y: 0.06, z: p.z + frng.range(-0.2, 0.2),
        vx: Math.cos(a) * frng.range(0.4, 2.0), vy: frng.range(0.5, 1.8), vz: Math.sin(a) * frng.range(0.4, 2.0),
        life: frng.range(0.5, 0.95), size: frng.range(0.2, 0.44), color: opts.color ?? 0xcfd6c8,
        drag: 2.8, grav: -2.2, fade: 0.55,
      });
    }
  }

  function scuff(p, dirX, dirZ, opts = {}) {
    const n = opts.count ?? 14;
    const len = Math.hypot(dirX, dirZ) || 1;
    for (let i = 0; i < n; i++) {
      emit({
        x: p.x + frng.range(-0.25, 0.25), y: 0.07, z: p.z + frng.range(-0.25, 0.25),
        vx: (-dirX / len) * frng.range(1.5, 5.5) + frng.range(-1, 1),
        vy: frng.range(1.2, 4.0),
        vz: (-dirZ / len) * frng.range(1.5, 5.5) + frng.range(-1, 1),
        life: frng.range(0.4, 0.85), size: frng.range(0.08, 0.17),
        color: frng.chance(0.7) ? 0x5fae36 : 0x8fd45c,
        drag: 1.6, grav: -13,
      });
    }
    dust(p, { count: 6 });
  }

  function swoosh(p, dirX, dirZ, power = 1) {
    const len = Math.hypot(dirX, dirZ) || 1;
    flash(1, p.x, p.y + 0.1, p.z, 3.2 * power, 0.34, 0xffc8e6, 0);
    flash(0, p.x + (dirX / len) * 0.4, p.y + 0.3, p.z + (dirZ / len) * 0.4,
      3.6 * power, 0.30, 0xffffff, frng.range(-0.6, 0.6));
    for (let i = 0; i < 12; i++) {
      emit({
        x: p.x, y: p.y + frng.range(-0.15, 0.25), z: p.z,
        vx: (dirX / len) * frng.range(2, 9) + frng.range(-1.5, 1.5),
        vy: frng.range(-0.3, 1.6),
        vz: (dirZ / len) * frng.range(2, 9) + frng.range(-1.5, 1.5),
        life: frng.range(0.18, 0.4), size: frng.range(0.1, 0.22), color: 0xffd9f0,
        drag: 3.2, grav: -3,
      });
    }
  }

  const CONFETTI = [0xff3b6b, 0xffd93b, 0x3bd6ff, 0x6bff8c, 0xc06bff, 0xffffff];
  function confetti(p, opts = {}) {
    const n = opts.count ?? 220;
    const spread = opts.spread ?? 9;
    for (let i = 0; i < n; i++) {
      const a = frng.float() * Math.PI * 2;
      const r = frng.float() * spread;
      emit({
        x: p.x + Math.cos(a) * r * 0.4,
        y: (opts.y ?? 7) + frng.range(0, 4),
        z: p.z + Math.sin(a) * r,
        vx: frng.range(-2.4, 2.4), vy: frng.range(-0.4, 3.2), vz: frng.range(-2.4, 2.4),
        life: frng.range(1.6, 3.4), size: frng.range(0.13, 0.26),
        color: CONFETTI[frng.int(CONFETTI.length)],
        drag: 1.3, grav: -3.4, fade: 0.8,
      });
    }
  }

  function goalBlast(p) {
    confetti(p, { count: 260, spread: 11, y: 8 });
    for (let i = 0; i < 60; i++) {
      const a = frng.float() * Math.PI * 2;
      emit({
        x: p.x, y: p.y + 1.0, z: p.z,
        vx: Math.cos(a) * frng.range(3, 13), vy: frng.range(2, 9), vz: Math.sin(a) * frng.range(3, 13),
        life: frng.range(0.5, 1.1), size: frng.range(0.14, 0.3), color: 0xfff2b0,
        drag: 1.8, grav: -7,
      });
    }
    flash(0, p.x, p.y + 1.2, p.z, 9, 0.5, 0xfff0c0, 0.4);
    flash(1, p.x, p.y + 1.2, p.z, 8, 0.55, 0xffd0ea, 0);
  }

  // ---- update -------------------------------------------------------------
  let camera = null;
  function setCamera(c) { camera = c; }

  function update(dt) {
    let n = 0;
    for (let i = 0; i < MAX; i++) {
      const p = P[i];
      if (!p.live) continue;
      p.life += dt;
      if (p.life >= p.max) { p.live = false; continue; }
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d; p.vz *= d;
      p.vy += p.grav * dt;
      p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.03) { p.y = 0.03; p.vy *= -0.28; p.vx *= 0.6; p.vz *= 0.6; }
      const t = p.life / p.max;
      const o = n * 3;
      pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
      col[o] = p.r; col[o + 1] = p.g; col[o + 2] = p.b;
      siz[n] = p.size;
      alp[n] = (1 - t) * (1 - t) * p.fade;
      n++;
    }
    geo.setDrawRange(0, n);
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('aColor').needsUpdate = true;
    geo.getAttribute('aSize').needsUpdate = true;
    geo.getAttribute('aAlpha').needsUpdate = true;

    for (const f of flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.mesh.visible = false; f.life = 0; continue; }
      const t = 1 - f.life / f.max;
      const s = f.s0 + (f.s1 - f.s0) * (1 - Math.pow(1 - t, 3));
      f.mesh.scale.setScalar(s);
      f.mesh.material.opacity = Math.pow(1 - t, 1.6);
      f.mesh.material.transparent = true;
      f.mesh.rotation.z += f.spin * dt;
      if (camera) f.mesh.quaternion.copy(camera.quaternion);
    }
  }

  function reset() {
    for (const p of P) p.live = false;
    for (const f of flashes) { f.life = 0; f.mesh.visible = false; }
    geo.setDrawRange(0, 0);
    frng.reseed(0xfeed);
  }

  return {
    group, points, setCamera,
    burst, dust, scuff, swoosh, confetti, goalBlast, flash, emit,
    update, reset,
    get liveCount() { return geo.drawRange.count; },
    dispose() {
      geo.dispose(); mat.dispose(); quad.dispose();
      starMat.dispose(); ringMat.dispose();
      for (const f of flashes) f.mesh.material.dispose();
    },
  };
}
