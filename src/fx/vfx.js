// Particles, impact flashes, swoosh streaks, dust, grass scuff, confetti, goal
// pyro and fading ground decals.
//
//   createVfx(scene) -> {
//     burst, dust, scuff, swoosh, confetti, goalBlast, pyro, slideMark,
//     selection, flash, emit, setCamera, update(dt), reset()
//   }
//
// Everything is pooled and batched. There are exactly eight VFX draw calls no
// matter how much is on screen:
//
//   1  matter particles  (Points, atlas, normal blend)   dust / grass / confetti
//   2  energy particles  (Points, atlas, additive)       sparks / embers
//   3  star flashes      (instanced billboards, add)     tackle + kick bursts
//   4  glows             (instanced billboards, add)     soft light under a flash
//   5  smoke             (instanced billboards, normal)  goal pyro
//   6  swoosh ribbons    (instanced ribbons, add)        shot streaks
//   7  ground decals     (instanced ground quads)        slide marks, scuff
//   8  selection ring    (instanced ground quads)        controlled player
//
// No allocation happens in update() or in any emitter.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import {
  impactStar, swooshStrip, softGlow, particleAtlas, SPRITE,
  selectRingTexture, slideMarkTexture, smokeTexture, scuffDecalTexture,
} from './fx-textures.js';

const MAX_MATTER = 900;
const MAX_ENERGY = 400;

const frng = makeRng(0xfeed);

// ---------------------------------------------------------------------------
// Instanced billboard / ribbon / ground-quad batch — one draw call each.
// ---------------------------------------------------------------------------
// mode 0: camera-facing billboard, rotated about the view axis
// mode 1: ribbon — long axis pinned to a world direction, width faces the camera
// mode 2: ground quad — lies in XZ, yaw about Y
function createBatch({ map, blending, capacity, mode, depthTest = true, boost = 1, zBias = 0 }) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;
  geo.instanceCount = 0;

  const iPos = new Float32Array(capacity * 3);
  const iAxis = new Float32Array(capacity * 3);
  const iScale = new Float32Array(capacity * 2);
  const iRot = new Float32Array(capacity);
  const iColor = new Float32Array(capacity * 3);
  const iAlpha = new Float32Array(capacity);

  const aPos = new THREE.InstancedBufferAttribute(iPos, 3);
  const aAxis = new THREE.InstancedBufferAttribute(iAxis, 3);
  const aScale = new THREE.InstancedBufferAttribute(iScale, 2);
  const aRot = new THREE.InstancedBufferAttribute(iRot, 1);
  const aColor = new THREE.InstancedBufferAttribute(iColor, 3);
  const aAlpha = new THREE.InstancedBufferAttribute(iAlpha, 1);
  geo.setAttribute('iPos', aPos);
  geo.setAttribute('iAxis', aAxis);
  geo.setAttribute('iScale', aScale);
  geo.setAttribute('iRot', aRot);
  geo.setAttribute('iColor', aColor);
  geo.setAttribute('iAlpha', aAlpha);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uBoost: { value: boost }, uZBias: { value: zBias } },
    defines: { MODE: mode },
    vertexShader: /* glsl */`
      attribute vec3 iPos;
      attribute vec3 iAxis;
      attribute vec2 iScale;
      attribute float iRot;
      attribute vec3 iColor;
      attribute float iAlpha;
      uniform float uZBias;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vColor = iColor;
        vAlpha = iAlpha;
        vec3 world;
      #if MODE == 2
        // ground quad: local +x runs along the yaw heading, +y across it
        float s = sin(iRot), c = cos(iRot);
        vec3 ax = vec3(s, 0.0, c);
        vec3 az = vec3(c, 0.0, -s);
        world = iPos + ax * (position.x * iScale.x) + az * (position.y * iScale.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      #else
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        #if MODE == 1
          // ribbon: long axis follows iAxis in view space, width is screen-vertical
          vec3 dirV = normalize((viewMatrix * vec4(iAxis, 0.0)).xyz);
          vec3 side = normalize(cross(dirV, vec3(0.0, 0.0, 1.0)) + vec3(1e-5));
          mv.xyz += dirV * (position.x * iScale.x) + side * (position.y * iScale.y);
        #else
          float s = sin(iRot), c = cos(iRot);
          vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
          mv.xy += q * iScale;
        #endif
        // uZBias pulls the quad toward the camera in view space. The ball's own
        // motion trail (entities/ball.js) occupies almost exactly the same volume
        // as a shot streak, and without a bias the two z-fight and the streak
        // loses. World placement is unchanged, so players still occlude it.
        mv.z += uZBias;
        gl_Position = projectionMatrix * mv;
      #endif
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform float uBoost;
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        float a = t.a * vAlpha;
        if (a <= 0.003) discard;
        gl_FragColor = vec4(t.rgb * vColor * uBoost, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest,
    blending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  const slots = [];
  for (let i = 0; i < capacity; i++) {
    slots.push({ live: false, life: 0, max: 1, s0x: 1, s1x: 1, s0y: 1, s1y: 1, spin: 0, ease: 1, hold: 0, a0: 1, vx: 0, vy: 0, vz: 0, drag: 0 });
  }

  const col = new THREE.Color();
  let cursor = 0;

  function take() {
    for (let i = 0; i < capacity; i++) {
      const s = slots[cursor];
      const idx = cursor;
      cursor = (cursor + 1) % capacity;
      if (!s.live) return idx;
    }
    const idx = cursor;
    cursor = (cursor + 1) % capacity;
    return idx;
  }

  /** o: { x,y,z, ax,ay,az, w0,w1,h0,h1, life, color, alpha, rot, spin, ease } */
  function add(o) {
    const i = take();
    const s = slots[i];
    s.live = true; s.life = 0; s.max = o.life;
    s.s0x = o.w0; s.s1x = o.w1 ?? o.w0;
    s.s0y = o.h0; s.s1y = o.h1 ?? o.h0;
    s.spin = o.spin ?? 0;
    s.ease = o.ease ?? 1.6;
    s.hold = o.hold ?? 0;
    s.a0 = o.alpha ?? 1;
    s.vx = o.vx ?? 0; s.vy = o.vy ?? 0; s.vz = o.vz ?? 0;
    s.drag = o.drag ?? 0;
    iPos[i * 3] = o.x; iPos[i * 3 + 1] = o.y; iPos[i * 3 + 2] = o.z;
    iAxis[i * 3] = o.ax ?? 1; iAxis[i * 3 + 1] = o.ay ?? 0; iAxis[i * 3 + 2] = o.az ?? 0;
    iRot[i] = o.rot ?? 0;
    col.set(o.color ?? 0xffffff).convertSRGBToLinear();
    iColor[i * 3] = col.r; iColor[i * 3 + 1] = col.g; iColor[i * 3 + 2] = col.b;
    iAlpha[i] = o.alpha ?? 1;
    return i;
  }

  const tmp = { i: -1 };
  function update(dt) {
    let hi = -1;
    for (let i = 0; i < capacity; i++) {
      const s = slots[i];
      if (!s.live) { iAlpha[i] = 0; continue; }
      s.life += dt;
      if (s.life >= s.max) { s.live = false; iAlpha[i] = 0; continue; }
      const t = s.life / s.max;
      const g = 1 - Math.pow(1 - t, 3);           // fast-out growth
      const w = s.s0x + (s.s1x - s.s0x) * g;
      const h = s.s0y + (s.s1y - s.s0y) * g;
      iScale[i * 2] = w; iScale[i * 2 + 1] = h;
      if (s.vx || s.vy || s.vz) {
        const k = s.drag ? Math.max(0, 1 - s.drag * dt) : 1;
        s.vx *= k; s.vy *= k; s.vz *= k;
        iPos[i * 3] += s.vx * dt;
        iPos[i * 3 + 1] += s.vy * dt;
        iPos[i * 3 + 2] += s.vz * dt;
      }
      const fadeT = s.hold > 0 ? Math.max(0, (t - s.hold) / (1 - s.hold)) : t;
      iAlpha[i] = s.a0 * (s.ease <= 0 ? 1 : Math.pow(1 - fadeT, s.ease));
      iRot[i] += s.spin * dt;
      hi = i;
    }
    geo.instanceCount = hi + 1;
    if (hi >= 0) {
      aPos.needsUpdate = true; aAxis.needsUpdate = true; aScale.needsUpdate = true;
      aRot.needsUpdate = true; aColor.needsUpdate = true; aAlpha.needsUpdate = true;
    }
    return tmp;
  }

  function moveTo(i, x, y, z) {
    iPos[i * 3] = x; iPos[i * 3 + 1] = y; iPos[i * 3 + 2] = z;
  }
  function axisTo(i, x, y, z) {
    iAxis[i * 3] = x; iAxis[i * 3 + 1] = y; iAxis[i * 3 + 2] = z;
  }
  function alive(i) { return i >= 0 && slots[i].live; }
  function reset() {
    for (const s of slots) { s.live = false; }
    iAlpha.fill(0);
    geo.instanceCount = 0;
    cursor = 0;
  }

  return {
    mesh, add, update, reset, moveTo, axisTo, alive, slots,
    setScale(i, w, h) { slots[i].s0x = slots[i].s1x = w; slots[i].s0y = slots[i].s1y = h; },
    dispose() { geo.dispose(); mat.dispose(); base.dispose(); },
  };
}

// ---------------------------------------------------------------------------
// Point-sprite particle cloud (atlas)
// ---------------------------------------------------------------------------
function createCloud({ capacity, blending, boost }) {
  const pos = new Float32Array(capacity * 3);
  const col = new Float32Array(capacity * 3);
  const siz = new Float32Array(capacity);
  const alp = new Float32Array(capacity);
  const til = new Float32Array(capacity);
  const rot = new Float32Array(capacity);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1));
  geo.setAttribute('aTile', new THREE.BufferAttribute(til, 1));
  geo.setAttribute('aRot', new THREE.BufferAttribute(rot, 1));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: particleAtlas() },
      uScale: { value: 620 },
      uBoost: { value: boost },
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aAlpha;
      attribute float aTile;
      attribute float aRot;
      uniform float uScale;
      varying vec3 vColor;
      varying float vAlpha;
      varying vec2 vTile;
      varying float vRot;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vRot = aRot;
        float ti = floor(aTile + 0.5);
        vTile = vec2(mod(ti, 2.0), floor(ti * 0.5));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * uScale / max(0.001, -mv.z), 1.0, 220.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform float uBoost;
      varying vec3 vColor;
      varying float vAlpha;
      varying vec2 vTile;
      varying float vRot;
      void main() {
        if (vAlpha <= 0.003) discard;
        vec2 p = gl_PointCoord - 0.5;
        float s = sin(vRot), c = cos(vRot);
        p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + 0.5;
        if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) discard;
        // 2x2 atlas. The atlas texture is uploaded with flipY off, so both
        // gl_PointCoord and the sampler run top-left origin and agree.
        vec2 uv = (vTile + p) * 0.5;
        vec4 t = texture2D(uMap, uv);
        float a = t.a * vAlpha;
        if (a <= 0.003) discard;
        gl_FragColor = vec4(t.rgb * vColor * uBoost, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;

  const P = [];
  for (let i = 0; i < capacity; i++) {
    P.push({
      live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1,
      size: 1, size1: 1, drag: 1, grav: -9, r: 1, g: 1, b: 1, fade: 1,
      tile: 0, rot: 0, spin: 0, bounce: 0.28, ease: 2,
    });
  }
  let cursor = 0;
  function spawn() {
    for (let i = 0; i < capacity; i++) {
      const p = P[cursor];
      cursor = (cursor + 1) % capacity;
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
    p.size = o.size; p.size1 = o.size1 ?? o.size;
    p.drag = o.drag ?? 1.6; p.grav = o.grav ?? -9;
    c3.set(o.color).convertSRGBToLinear();
    p.r = c3.r; p.g = c3.g; p.b = c3.b;
    p.fade = o.fade ?? 1;
    p.tile = o.tile ?? SPRITE.PUFF;
    p.rot = o.rot ?? 0; p.spin = o.spin ?? 0;
    p.bounce = o.bounce ?? 0.28;
    p.ease = o.ease ?? 2;
    return p;
  }

  function update(dt) {
    let n = 0;
    for (let i = 0; i < capacity; i++) {
      const p = P[i];
      if (!p.live) continue;
      p.life += dt;
      if (p.life >= p.max) { p.live = false; continue; }
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d; p.vz *= d;
      p.vy += p.grav * dt;
      p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.spin * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy *= -p.bounce; p.vx *= 0.62; p.vz *= 0.62; p.spin *= 0.5; }
      const t = p.life / p.max;
      const o = n * 3;
      pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
      col[o] = p.r; col[o + 1] = p.g; col[o + 2] = p.b;
      siz[n] = p.size + (p.size1 - p.size) * t;
      alp[n] = Math.pow(1 - t, p.ease) * p.fade;
      til[n] = p.tile;
      rot[n] = p.rot;
      n++;
    }
    geo.setDrawRange(0, n);
    if (n > 0) {
      geo.getAttribute('position').needsUpdate = true;
      geo.getAttribute('aColor').needsUpdate = true;
      geo.getAttribute('aSize').needsUpdate = true;
      geo.getAttribute('aAlpha').needsUpdate = true;
      geo.getAttribute('aTile').needsUpdate = true;
      geo.getAttribute('aRot').needsUpdate = true;
    }
    return n;
  }

  function reset() {
    for (const p of P) p.live = false;
    geo.setDrawRange(0, 0);
    cursor = 0;
  }

  return {
    points, emit, update, reset,
    get count() { return geo.drawRange.count; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ---------------------------------------------------------------------------

export function createVfx(scene) {
  const group = new THREE.Group();
  group.name = 'vfx';
  scene.add(group);

  const matter = createCloud({ capacity: MAX_MATTER, blending: THREE.NormalBlending, boost: 1 });
  const energy = createCloud({ capacity: MAX_ENERGY, blending: THREE.AdditiveBlending, boost: 1.5 });
  matter.points.renderOrder = 20;
  energy.points.renderOrder = 21;
  group.add(matter.points, energy.points);

  // ---- decals sit on the turf, everything else floats above it ------------
  const decals = createBatch({
    map: slideMarkTexture(), blending: THREE.NormalBlending, capacity: 24, mode: 2,
  });
  decals.mesh.renderOrder = 4;
  const scuffs = createBatch({
    map: scuffDecalTexture(), blending: THREE.NormalBlending, capacity: 28, mode: 2,
  });
  scuffs.mesh.renderOrder = 5;
  const rings = createBatch({
    map: selectRingTexture(), blending: THREE.NormalBlending, capacity: 4, mode: 2,
  });
  rings.mesh.renderOrder = 6;
  const smoke = createBatch({
    map: smokeTexture(), blending: THREE.NormalBlending, capacity: 40, mode: 0,
  });
  smoke.mesh.renderOrder = 18;
  // Alpha-blended, not additive: the streak in the reference is an opaque salmon
  // band. Added on top of bright turf, a pink additive layer just resolves to
  // white and the shot loses its signature colour.
  const ribbons = createBatch({
    map: swooshStrip(), blending: THREE.NormalBlending, capacity: 8, mode: 1, boost: 1.0, zBias: 0.35,
  });
  ribbons.mesh.renderOrder = 24;
  ribbons.mesh.material.depthWrite = false;
  const glows = createBatch({
    map: softGlow(), blending: THREE.AdditiveBlending, capacity: 12, mode: 0, boost: 1.1,
  });
  glows.mesh.renderOrder = 25;
  const stars = createBatch({
    map: impactStar('pink'), blending: THREE.AdditiveBlending, capacity: 10, mode: 0, boost: 1.35,
  });
  stars.mesh.renderOrder = 26;
  group.add(decals.mesh, scuffs.mesh, rings.mesh, smoke.mesh, ribbons.mesh, glows.mesh, stars.mesh);

  const batches = [decals, scuffs, rings, smoke, ribbons, glows, stars];

  // ---- ball reference -----------------------------------------------------
  // The shot streak has to end ON the ball or it reads as a stray white slash
  // across the pitch (an actual defect in the first build). The ball view is a
  // top-level scene node named 'ball'; look it up lazily and read its position.
  // Nothing is written, so this stays a one-way observation of shared state.
  let ballNode = null;
  const ballPos = new THREE.Vector3();
  function ball() {
    if (!ballNode) ballNode = scene.getObjectByName('ball');
    return ballNode;
  }

  // ---- live streaks -------------------------------------------------------
  const STREAKS = 6;
  const streaks = [];
  for (let i = 0; i < STREAKS; i++) {
    streaks.push({ live: false, idx: -1, ox: 0, oy: 0, oz: 0, dx: 1, dy: 0, dz: 0, t: 0, max: 0.5, speed: 26, width: 0.34, track: false });
  }

  // ---- selection ring -----------------------------------------------------
  let ringIdx = -1;
  let ringT = 0;
  const ringState = { on: false, x: 0, z: 0, yaw: 0, color: 0x66ff88 };

  // =========================================================================
  // emitters
  // =========================================================================

  function emit(o) { return matter.emit(o); }

  /** short-lived star flash + its glow */
  function flash(kind, x, y, z, size, life, color, spin = 0) {
    // kind 0 = star, 1 = glow ring (kept for API compatibility)
    if (kind === 1) {
      glows.add({
        x, y, z, w0: size * 0.5, w1: size * 1.35, h0: size * 0.5, h1: size * 1.35,
        life, color, alpha: 0.75, ease: 1.7,
      });
      return;
    }
    // Callers ask for a "size" in metres; the sprite's needles reach the very
    // edge of the tile, so it is scaled down here to keep the burst reading as a
    // sharp star rather than a soft flare that swallows the players.
    const s = size * 0.66;
    stars.add({
      x, y, z,
      w0: s * 0.30, w1: s, h0: s * 0.30, h1: s,
      life, color, alpha: 1, rot: spin * 0.7, spin: spin * 1.4, ease: 2.3,
    });
    glows.add({
      x, y, z, w0: s * 0.26, w1: s * 0.58, h0: s * 0.26, h1: s * 0.58,
      life: life * 1.15, color, alpha: 0.30, ease: 1.8,
    });
  }

  /** generic impact — sparks fly out, a star pops, dust lifts */
  function burst(p, opts = {}) {
    const n = opts.count ?? 16;
    const spd = opts.speed ?? 5;
    const color = opts.color ?? 0xffffff;
    for (let i = 0; i < n; i++) {
      const a = frng.float() * Math.PI * 2;
      const e = frng.range(0.15, 1.0);
      energy.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * spd * e, vy: frng.range(0.4, 1.4) * spd * 0.6, vz: Math.sin(a) * spd * e,
        life: frng.range(0.20, 0.42), size: frng.range(0.09, 0.20), size1: 0.02,
        color, drag: 3.0, grav: -9, tile: SPRITE.SPARK, ease: 1.6,
      });
    }
    // a few solid white flecks like the reference's paper-chip debris
    for (let i = 0; i < Math.max(3, n * 0.3) | 0; i++) {
      const a = frng.float() * Math.PI * 2;
      matter.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * spd * frng.range(0.3, 0.9),
        vy: frng.range(1.2, 3.4),
        vz: Math.sin(a) * spd * frng.range(0.3, 0.9),
        life: frng.range(0.35, 0.7), size: frng.range(0.07, 0.13),
        color: 0xffffff, drag: 1.9, grav: -11, tile: SPRITE.CHIP,
        rot: frng.float() * 6.28, spin: frng.range(-14, 14), ease: 1.2,
      });
    }
    if (opts.flash !== false) {
      flash(0, p.x, p.y + 0.08, p.z, opts.flashSize ?? 2.2, opts.flashLife ?? 0.26,
        opts.flashColor ?? 0xffffff, frng.range(-1.2, 1.2));
    }
  }

  function dust(p, opts = {}) {
    const n = opts.count ?? 10;
    for (let i = 0; i < n; i++) {
      const a = frng.float() * Math.PI * 2;
      matter.emit({
        x: p.x + frng.range(-0.2, 0.2), y: 0.05, z: p.z + frng.range(-0.2, 0.2),
        vx: Math.cos(a) * frng.range(0.4, 2.0), vy: frng.range(0.4, 1.5), vz: Math.sin(a) * frng.range(0.4, 2.0),
        life: frng.range(0.55, 1.05), size: frng.range(0.28, 0.50), size1: frng.range(0.85, 1.5),
        color: opts.color ?? 0xe6ead8,
        drag: 2.6, grav: -1.4, fade: 0.8, tile: SPRITE.PUFF,
        rot: frng.float() * 6.28, spin: frng.range(-1.2, 1.2), ease: 1.5, bounce: 0,
      });
    }
  }

  /** turf torn up by a boot: blades fly back along -dir, dust lifts, a decal stays */
  function scuff(p, dirX, dirZ, opts = {}) {
    const n = opts.count ?? 14;
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len, uz = dirZ / len;
    // Perpendicular to the run, so roughly half the spray fans out to the sides
    // instead of piling up directly behind the boot where the player's own body
    // hides it from the camera.
    const px = -uz, pz = ux;
    for (let i = 0; i < n; i++) {
      const side = frng.range(-1, 1);
      matter.emit({
        x: p.x + px * side * 0.28 + frng.range(-0.16, 0.16), y: 0.09,
        z: p.z + pz * side * 0.28 + frng.range(-0.16, 0.16),
        vx: -ux * frng.range(1.0, 4.4) + px * side * frng.range(1.4, 4.0),
        vy: frng.range(1.8, 4.6),
        vz: -uz * frng.range(1.0, 4.4) + pz * side * frng.range(1.4, 4.0),
        life: frng.range(0.45, 0.9), size: frng.range(0.10, 0.21),
        color: frng.chance(0.55) ? 0x8fe05a : (frng.chance(0.55) ? 0xc8f08a : 0x8a6d3c),
        drag: 1.5, grav: -14, tile: SPRITE.BLADE,
        rot: frng.float() * 6.28, spin: frng.range(-18, 18), ease: 1.3,
      });
    }
    dust(p, { count: Math.max(5, (n * 0.6) | 0) });
    if (opts.decal !== false && frng.chance(0.9)) {
      scuffs.add({
        x: p.x - ux * 0.35 + frng.range(-0.12, 0.12), y: 0.017,
        z: p.z - uz * 0.35 + frng.range(-0.12, 0.12),
        w0: frng.range(1.5, 2.3), h0: frng.range(0.9, 1.4),
        rot: Math.atan2(ux, uz) + frng.range(-0.25, 0.25),
        life: opts.decalLife ?? 6.0, color: 0xffffff, alpha: 0.6, ease: 0.9, hold: 0.5,
      });
    }
  }

  /**
   * The pink-white streak a struck ball drags behind it (minifootball_07 / _12).
   * A tapered ribbon anchored at the strike point whose head chases the ball; if
   * no ball node is available it extends along `dir` at the shot speed instead.
   */
  function swoosh(p, dirX, dirZ, power = 1) {
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len, uz = dirZ / len;

    let s = null;
    for (const st of streaks) if (!st.live) { s = st; break; }
    if (!s) s = streaks[0];
    s.live = true;
    s.ox = p.x; s.oy = (p.y ?? 0.45) + 0.08; s.oz = p.z;
    s.dx = ux; s.dy = 0; s.dz = uz;
    s.t = 0;
    s.max = 0.55 + 0.25 * power;
    s.speed = 20 * power + 8;
    s.width = 0.30 + 0.26 * power;
    s.track = !!ball();
    s.idx = ribbons.add({
      x: p.x, y: s.oy, z: p.z, ax: ux, ay: 0, az: uz,
      w0: 0.01, h0: s.width, life: s.max, color: 0xffc4de, alpha: 1.0, ease: 1.4, hold: 0.30,
    });
    // strike star at the boot, sized off the power
    flash(0, p.x + ux * 0.18, (p.y ?? 0.45) + 0.12, p.z + uz * 0.18,
      2.0 + 1.5 * power, 0.30, 0xffffff, frng.range(-1.0, 1.0));
    for (let i = 0; i < 10; i++) {
      energy.emit({
        x: p.x, y: (p.y ?? 0.45) + frng.range(-0.12, 0.2), z: p.z,
        vx: ux * frng.range(2, 8) + frng.range(-1.4, 1.4),
        vy: frng.range(-0.2, 1.4),
        vz: uz * frng.range(2, 8) + frng.range(-1.4, 1.4),
        life: frng.range(0.14, 0.30), size: frng.range(0.08, 0.18), size1: 0.02,
        color: 0xffbfe4, drag: 3.4, grav: -3, tile: SPRITE.SPARK, ease: 1.5,
      });
    }
  }

  const CONFETTI = [0xff3b6b, 0xffd93b, 0x3bd6ff, 0x6bff8c, 0xc06bff, 0xffffff, 0xff8a3b];
  function confetti(p, opts = {}) {
    const n = opts.count ?? 220;
    const spread = opts.spread ?? 9;
    for (let i = 0; i < n; i++) {
      const a = frng.float() * Math.PI * 2;
      const r = Math.sqrt(frng.float()) * spread;
      matter.emit({
        x: p.x + Math.cos(a) * r * 0.5,
        y: (opts.y ?? 7) + frng.range(0, 4),
        z: p.z + Math.sin(a) * r,
        vx: frng.range(-2.2, 2.2), vy: frng.range(-0.6, 2.8), vz: frng.range(-2.2, 2.2),
        life: frng.range(1.8, 3.6),
        size: frng.chance(0.14) ? frng.range(0.30, 0.46) : frng.range(0.15, 0.27),
        color: CONFETTI[frng.int(CONFETTI.length)],
        drag: 1.5, grav: -3.1, fade: 1, tile: SPRITE.CHIP,
        rot: frng.float() * 6.28, spin: frng.range(-9, 9), ease: 0.7, bounce: 0.1,
      });
    }
  }

  /** stadium pyro: a jet of embers with a lazy smoke column */
  function pyro(x, y, z, opts = {}) {
    const n = opts.count ?? 26;
    for (let i = 0; i < n; i++) {
      const a = frng.float() * Math.PI * 2;
      energy.emit({
        x: x + frng.range(-0.2, 0.2), y, z: z + frng.range(-0.2, 0.2),
        vx: Math.cos(a) * frng.range(0.2, 1.6),
        vy: frng.range(6, 13),
        vz: Math.sin(a) * frng.range(0.2, 1.6),
        life: frng.range(0.5, 1.1), size: frng.range(0.10, 0.22), size1: 0.03,
        color: opts.color ?? 0xffd58a, drag: 1.2, grav: -8, tile: SPRITE.SPARK, ease: 1.4,
      });
    }
    // Flare smoke is the part that survives: it keeps rising and spreading for
    // several seconds after the embers are gone, which is what actually reads in
    // a celebration frame.
    for (let i = 0; i < 5; i++) {
      const sz = 1.0 + i * 0.45;
      smoke.add({
        x: x + frng.range(-0.45, 0.45), y: y + 0.5 + i * 0.7, z: z + frng.range(-0.45, 0.45),
        w0: sz, w1: sz + 2.8, h0: sz, h1: sz + 2.8,
        life: frng.range(3.0, 4.6), color: opts.smoke ?? 0xdfeaf6, alpha: 0.5,
        rot: frng.float() * 6.28, spin: frng.range(-0.35, 0.35), ease: 1.5, hold: 0.25,
        vx: frng.range(-0.3, 0.3), vy: frng.range(1.4, 2.6) - i * 0.1,
        vz: frng.range(-0.3, 0.3), drag: 0.35,
      });
    }
  }

  function goalBlast(p) {
    confetti(p, { count: 240, spread: 11, y: 8 });
    for (let i = 0; i < 54; i++) {
      const a = frng.float() * Math.PI * 2;
      energy.emit({
        x: p.x, y: p.y + 1.0, z: p.z,
        vx: Math.cos(a) * frng.range(3, 13), vy: frng.range(2, 9), vz: Math.sin(a) * frng.range(3, 13),
        life: frng.range(0.4, 0.95), size: frng.range(0.12, 0.26), size1: 0.03,
        color: 0xfff0b4, drag: 1.9, grav: -7, tile: SPRITE.SPARK, ease: 1.5,
      });
    }
    flash(0, p.x, p.y + 1.2, p.z, 8.5, 0.46, 0xfff0c8, 0.5);
    flash(1, p.x, p.y + 1.2, p.z, 7.5, 0.6, 0xffd6ee);
    // The goal cam sits inside the bowl looking back at the mouth, so the pyro
    // goes BEHIND the goal line where the column reads against the stand. Keep
    // it off the camera's own position or the smoke just fogs the whole frame.
    pyro(p.x + 3.4, p.y, p.z - 7.8, { count: 22 });
    pyro(p.x + 3.4, p.y, p.z + 7.8, { count: 22 });
    pyro(p.x - 5.0, p.y, p.z + 12.0, { count: 18 });
  }

  /** leave a long scrape where a player slid */
  function slideMark(x, z, yaw, opts = {}) {
    decals.add({
      x, y: 0.016, z,
      w0: opts.length ?? 2.6, h0: opts.width ?? 0.9,
      rot: yaw, life: opts.life ?? 7.0, color: 0xffffff,
      alpha: opts.alpha ?? 0.7, ease: 0.9, hold: 0.5,
    });
  }

  /**
   * Ground ellipse under the controlled player. Call every frame with the
   * player's position; call with `on:false` (or no args) to clear it.
   */
  function selection(x, z, yaw = 0, color = 0x66ff88) {
    ringState.on = true;
    ringState.x = x; ringState.z = z; ringState.yaw = yaw; ringState.color = color;
  }
  function clearSelection() { ringState.on = false; }

  // =========================================================================
  // update
  // =========================================================================
  let camera = null;
  function setCamera(c) { camera = c; }

  function update(dt) {
    matter.update(dt);
    energy.update(dt);

    // --- streaks: head chases the ball, tail stays at the strike point ------
    const bn = ball();
    if (bn) ballPos.setFromMatrixPosition(bn.matrixWorld);
    for (const s of streaks) {
      if (!s.live) continue;
      s.t += dt;
      if (s.t >= s.max || !ribbons.alive(s.idx)) { s.live = false; continue; }
      let hx, hy, hz;
      if (s.track && bn) {
        hx = ballPos.x; hy = ballPos.y; hz = ballPos.z;
      } else {
        const d = s.speed * s.t;
        hx = s.ox + s.dx * d; hy = s.oy; hz = s.oz + s.dz * d;
      }
      let vx = hx - s.ox, vy = hy - s.oy, vz = hz - s.oz;
      let L = Math.hypot(vx, vy, vz);
      if (L < 0.05) { vx = s.dx; vy = 0; vz = s.dz; L = 1; }
      // Cap the streak so a stray ball position can never draw a slash across
      // the whole pitch, and shorten the tail as the shot ages.
      const cap = Math.min(L, 11);
      const shrink = 1 - Math.min(1, Math.max(0, (s.t / s.max - 0.35) / 0.65)) * 0.55;
      const half = cap * 0.5 * shrink;
      const ux = vx / L, uy = vy / L, uz = vz / L;
      ribbons.moveTo(s.idx, hx - ux * half, hy - uy * half + 0.02, hz - uz * half);
      ribbons.axisTo(s.idx, ux, uy, uz);
      ribbons.setScale(s.idx, cap * shrink, s.width);
    }

    // --- selection ring ----------------------------------------------------
    ringT += dt;
    if (ringState.on) {
      const pulse = 1 + 0.055 * Math.sin(ringT * 4.4);
      if (!rings.alive(ringIdx)) {
        ringIdx = rings.add({
          x: ringState.x, y: 0.021, z: ringState.z, w0: 1.16, h0: 1.62,
          rot: ringState.yaw, life: 1e6, color: ringState.color, alpha: 0.92, ease: 0,
        });
      }
      rings.moveTo(ringIdx, ringState.x, 0.021, ringState.z);
      rings.setScale(ringIdx, 1.16 * pulse, 1.62 * pulse);
    } else if (ringIdx >= 0 && rings.alive(ringIdx)) {
      rings.slots[ringIdx].live = false;
      ringIdx = -1;
    }

    for (const b of batches) b.update(dt);

    // billboards that are not camera-facing need no per-frame work; the two
    // camera-facing batches are oriented in the vertex shader, so nothing here.
  }

  function reset() {
    matter.reset(); energy.reset();
    for (const b of batches) b.reset();
    for (const s of streaks) { s.live = false; s.idx = -1; }
    ringIdx = -1; ringT = 0; ringState.on = false;
    frng.reseed(0xfeed);
  }

  return {
    group,
    points: matter.points,
    setCamera,
    burst, dust, scuff, swoosh, confetti, goalBlast, pyro, flash, emit,
    slideMark, selection, clearSelection,
    update, reset,
    get liveCount() { return matter.count + energy.count; },
    dispose() {
      matter.dispose(); energy.dispose();
      for (const b of batches) b.dispose();
    },
  };
}
