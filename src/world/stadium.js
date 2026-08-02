// Everything that frames the pitch: the seating bowl, the instanced crowd,
// perimeter advertising, roof, floodlights, jumbotrons and set dressing.
//
//   createStadium() -> { group, setScore(a,b,clock), celebrate(), update(dt), dispose() }
//
// Shape
// -----
// The bowl is a single continuous rounded rectangle (Minkowski sum of a
// 2a x 2b rectangle with a disc). Offsetting that shape outwards only changes
// the corner radius, so every ring around the bowl — barrier, tread, riser,
// fascia, roof — is generated from the SAME point list at a different radius.
// Rings therefore correspond 1:1 and can be stitched into bands trivially, and
// the whole structure merges down to a handful of draw calls.
//
// Crowd
// -----
// Every spectator is one instanced quad, y-billboarded in the vertex shader and
// sampled from a 32-cell procedural sprite sheet via a per-instance UV offset.
// They sway from a shared time uniform, so ~9k of them animate for free in a
// single draw call.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/rng.js';
import { HALF_W, HALF_D, TEAMS } from '../core/constants.js';
import * as TX from './stadium-tex.js';

// ---------------------------------------------------------------- bowl layout
const A = 28;            // core rect half-length along X
const B = 18;            // core rect half-length along Z
// -> a ring of radius r has half-extents (28+r, 18+r)

const R_BOARD = 6.0;     // ad boards          -> 34.0 x 24.0
const R_TRACK = 8.5;     // barrier / bowl lip -> 36.5 x 26.5

const L1_ROWS = 14, L1_RUN = 0.92, L1_RISE = 0.55;
const L1_R0 = R_TRACK + 1.25, L1_Y0 = 1.55;

const FASCIA_R = L1_R0 + L1_ROWS * L1_RUN;              // 22.4
const FASCIA_Y0 = L1_Y0 + L1_ROWS * L1_RISE;            // 9.11
const FASCIA_Y1 = FASCIA_Y0 + 5.2;                      // 14.31

const L2_ROWS = 17, L2_RUN = 0.96, L2_RISE = 0.63;
const L2_R0 = FASCIA_R + 1.6, L2_Y0 = FASCIA_Y1;
const L2_R1 = L2_R0 + L2_ROWS * L2_RUN;                 // 39.34
const L2_Y1 = L2_Y0 + L2_ROWS * L2_RISE;                // 24.45

const BACK_R = L2_R1 + 1.2;
const BACK_Y = 30.0;

const ROOF_IN = 34.0, ROOF_OUT = 47.0;
const ROOF_Y_IN = 30.4, ROOF_Y_OUT = 33.6;

const SEAT_SP = 0.80;    // seat pitch along a row
const AISLES_1 = 16, AISLES_2 = 20;
const CORNER_SEGS = 20, STRAIGHT_STEP = 6.2;

const srng = makeRng(0xb0a7);

// --------------------------------------------------------------- ring helpers

/** Closed polyline of the rounded rect at radius r. All radii share indices. */
function ringPoints(r) {
  const pts = [];
  const centers = [[A, B], [-A, B], [-A, -B], [A, -B]];
  const a0 = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
  for (let ci = 0; ci < 4; ci++) {
    const [cx, cz] = centers[ci];
    for (let s = 0; s <= CORNER_SEGS; s++) {
      const th = a0[ci] + (s / CORNER_SEGS) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(th) * r, z: cz + Math.sin(th) * r });
    }
    const [nx, nz] = centers[(ci + 1) % 4];
    const th1 = a0[(ci + 1) % 4];
    const sx = cx + Math.cos(th1) * r, sz = cz + Math.sin(th1) * r;
    const ex = nx + Math.cos(th1) * r, ez = nz + Math.sin(th1) * r;
    const len = Math.hypot(ex - sx, ez - sz);
    const n = Math.max(1, Math.round(len / STRAIGHT_STEP));
    for (let s = 1; s < n; s++) {
      pts.push({ x: sx + (ex - sx) * (s / n), z: sz + (ez - sz) * (s / n) });
    }
  }
  // cumulative arc length + outward normal
  let u = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    p.u = u;
    const q = pts[(i + 1) % pts.length];
    u += Math.hypot(q.x - p.x, q.z - p.z);
    const cx = Math.max(-A, Math.min(A, p.x));
    const cz = Math.max(-B, Math.min(B, p.z));
    const dx = p.x - cx, dz = p.z - cz;
    const d = Math.hypot(dx, dz) || 1;
    p.nx = dx / d; p.nz = dz / d;
  }
  pts.total = u;
  return pts;
}

function lift(pts, y) {
  return pts.map((p) => ({ x: p.x, y, z: p.z, u: p.u, nx: p.nx, nz: p.nz }));
}

/**
 * Stitch two matching loops into a quad band.
 * Winding gives +Y for horizontal bands and inward-facing normals for vertical
 * ones, which is what every surface in the bowl wants.
 */
function bandGeometry(LA, LB, uScale, v0, v1, mask) {
  const n = LA.length;
  const pos = new Float32Array(n * 6);
  const uv = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pos[i * 6 + 0] = LA[i].x; pos[i * 6 + 1] = LA[i].y; pos[i * 6 + 2] = LA[i].z;
    pos[i * 6 + 3] = LB[i].x; pos[i * 6 + 4] = LB[i].y; pos[i * 6 + 5] = LB[i].z;
    uv[i * 4 + 0] = LA[i].u * uScale; uv[i * 4 + 1] = v0;
    uv[i * 4 + 2] = LB[i].u * uScale; uv[i * 4 + 3] = v1;
  }
  const idx = [];
  for (let i = 0; i < n; i++) {
    if (mask && !mask(i)) continue;
    const j = (i + 1) % n;
    const a0 = i * 2, b0 = i * 2 + 1, a1 = j * 2, b1 = j * 2 + 1;
    idx.push(a0, b1, b0, a0, a1, b1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Even arc-length samples around a loop. */
function sampleLoop(pts, spacing, offset = 0) {
  const L = pts.total;
  const count = Math.max(8, Math.round(L / spacing));
  const step = L / count;
  const out = [];
  let i = 0;
  for (let k = 0; k < count; k++) {
    const target = (((k + offset) * step) % L + L) % L;
    while (i > 0 && pts[i].u > target) i--;
    while (i + 1 < pts.length && pts[i + 1].u <= target) i++;
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const qu = (i + 1 >= pts.length) ? L : q.u;
    const t = (qu - p.u) > 1e-6 ? (target - p.u) / (qu - p.u) : 0;
    const nx = p.nx + (q.nx - p.nx) * t;
    const nz = p.nz + (q.nz - p.nz) * t;
    const nl = Math.hypot(nx, nz) || 1;
    out.push({
      x: p.x + (q.x - p.x) * t,
      z: p.z + (q.z - p.z) * t,
      nx: nx / nl, nz: nz / nl,
      u: target, frac: target / L,
    });
  }
  return out;
}

// ------------------------------------------------------------- crowd shaders

/**
 * Turns a material into an instanced, y-billboarded, swaying spectator.
 *
 * The quads face the camera (cylindrical billboard built in view space) — with
 * fixed pitch-facing quads the side stands vanish edge-on as soon as the camera
 * looks along a touchline, which is exactly what the `goal` and `keeper` shots
 * do. Shading is baked into the instance colour so the flat billboard normal
 * never fights the sun.
 */
function crowdAnim(mat, uniforms, cell) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uTime = uniforms.uTime;
    s.uniforms.uExcite = uniforms.uExcite;
    s.vertexShader = 'attribute float aPhase;\nattribute float aFlip;\nattribute vec2 aCell;\n'
      + 'uniform float uTime;\nuniform float uExcite;\n' + s.vertexShader;
    s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float _b = max(0.0, sin(uTime * 6.2 + aPhase)) * 0.40 * uExcite;
      float _i = sin(uTime * 1.10 + aPhase) * 0.028
               + sin(uTime * 0.43 + aPhase * 1.7) * 0.020;
      transformed.y += _b + _i;
      transformed.x += sin(uTime * 2.7 + aPhase) * (0.012 + 0.05 * uExcite);
    `);
    s.vertexShader = s.vertexShader.replace('#include <project_vertex>', `
      vec4 _ctr = modelViewMatrix * ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) );
      vec3 _up = normalize( ( modelViewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
      vec3 _to = normalize( -_ctr.xyz );
      vec3 _rt = normalize( cross( _up, _to ) ) * aFlip;
      float _sx = length( instanceMatrix[0].xyz );
      float _sy = length( instanceMatrix[1].xyz );
      vec4 mvPosition = vec4(
        _ctr.xyz + _rt * ( transformed.x * _sx ) + _up * ( transformed.y * _sy ), 1.0 );
      gl_Position = projectionMatrix * mvPosition;
    `);
    s.vertexShader = s.vertexShader.replace('#include <uv_vertex>', `
      #include <uv_vertex>
      vMapUv = vMapUv * vec2(${cell[0].toFixed(6)}, ${cell[1].toFixed(6)}) + aCell;
    `);
  };
  // The cell scale is baked into the shader, so it MUST be part of the cache
  // key or a second material silently reuses the first one's program.
  mat.customProgramCacheKey = () => `cs-crowd-${cell[0].toFixed(5)}-${cell[1].toFixed(5)}`;
  return mat;
}

// ---------------------------------------------------------------------------

export function createStadium() {
  const group = new THREE.Group();
  group.name = 'stadium';
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  const uniforms = { uTime: { value: 0 }, uExcite: { value: 0 } };
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  const rings = new Map();
  const ring = (r) => {
    const k = r.toFixed(3);
    if (!rings.has(k)) rings.set(k, ringPoints(r));
    return rings.get(k);
  };

  // snap a repeat count so the tiling closes cleanly around the loop
  const snapU = (pts, unit) => Math.max(1, Math.round(pts.total / unit)) / pts.total;

  const jumbo = TX.jumbotron();
  const jumboTex = jumbo.texture;
  const concreteTex = TX.concreteTexture();
  const seatTex = TX.seatTexture();
  const stairTex = TX.stairTexture();
  const roofTex = TX.roofTexture();

  const matConcrete = track(new THREE.MeshStandardMaterial({
    map: concreteTex, roughness: 0.97, metalness: 0.0, color: 0xa8a39a,
  }));
  const matSeat = track(new THREE.MeshStandardMaterial({
    map: seatTex, roughness: 0.92, metalness: 0.0, color: 0x6e7175,
  }));
  const matStair = track(new THREE.MeshStandardMaterial({
    map: stairTex, roughness: 0.94, color: 0x9ba09d,
  }));
  const matBarrier = track(new THREE.MeshStandardMaterial({
    map: concreteTex, roughness: 0.85, metalness: 0.0, color: 0x2b3a52,
  }));
  const matRoof = track(new THREE.MeshStandardMaterial({
    map: roofTex, roughness: 0.55, metalness: 0.55, color: 0xbfc7cc,
    side: THREE.DoubleSide,
  }));
  const matDark = track(new THREE.MeshStandardMaterial({ color: 0x0b0f16, roughness: 1.0 }));

  const geoConcrete = [];
  const geoSeat = [];
  const geoStair = [];
  const geoDark = [];

  const addTo = (arr, g) => { arr.push(g); };

  // -------------------------------------------------------- outside + apron
  {
    const gt = TX.groundsTexture();
    gt.repeat.set(6, 6);
    const grounds = new THREE.Mesh(
      track(new THREE.PlaneGeometry(620, 620)),
      track(new THREE.MeshLambertMaterial({ map: gt, color: 0x9aa39c })),
    );
    grounds.rotation.x = -Math.PI / 2;
    grounds.position.y = -0.10;
    group.add(grounds);
  }

  // Grass verge: a ring band from just inside the pitch edge out to the bowl lip,
  // so the pitch never ends against bare ground.
  {
    const verge = new THREE.Mesh(
      track(bandGeometry(
        lift(ring(R_BOARD - 6.4), -0.03), lift(ring(R_TRACK + 0.1), -0.03), 0.25, 0, 1)),
      track(new THREE.MeshStandardMaterial({ color: 0x3d7a2b, roughness: 0.99 })),
    );
    verge.receiveShadow = true;
    group.add(verge);
  }

  // ------------------------------------------------------------- ad boards
  {
    const bTex = TX.adBoardTexture();
    const base = ring(R_BOARD);
    const lo = lift(base, 0.02);
    const hi = lift(ring(R_BOARD + 0.42), 1.42);   // leans back away from the pitch
    const us = snapU(base, 12.6);
    const face = new THREE.Mesh(
      track(bandGeometry(lo, hi, us, 0, 1)),
      track(new THREE.MeshStandardMaterial({
        map: bTex, roughness: 0.78, metalness: 0.0, color: 0xf2f5f8,
      })),
    );
    face.receiveShadow = true;
    group.add(face);

    // dark back / top cap so the boards read as solid volumes
    const capA = lift(ring(R_BOARD + 0.42), 1.42);
    const capB = lift(ring(R_BOARD + 0.95), 1.30);
    const capC = lift(ring(R_BOARD + 1.05), 0.02);
    const cap = track(mergeGeometries([
      bandGeometry(capA, capB, 0.2, 0, 1),
      bandGeometry(capB, capC, 0.2, 0, 1),
    ], false));
    const capMesh = new THREE.Mesh(cap, track(new THREE.MeshStandardMaterial({
      color: 0x0a3f8a, roughness: 0.7,
    })));
    capMesh.castShadow = true;
    group.add(capMesh);
  }

  // ------------------------------------------------------------ bowl shell
  // Front barrier wall (pitch side of the lower tier). Kept low and dark so the
  // ad boards read as the brightest band at pitch level, as in the reference.
  const geoBarrier = [];
  {
    const p = ring(R_TRACK);
    const us = snapU(p, 5.0);
    addTo(geoBarrier, bandGeometry(lift(p, 0.0), lift(p, 1.30), us, 0, 0.55));
    // pale capping rail
    addTo(geoConcrete, bandGeometry(lift(p, 1.30), lift(ring(R_TRACK + 0.5), 1.30), us, 0, 0.10));
    addTo(geoConcrete, bandGeometry(lift(ring(R_TRACK + 0.5), 1.30), lift(ring(R_TRACK + 0.5), 1.12), us, 0, 0.06));
  }

  // ---- terraces -----------------------------------------------------------
  const crowd = [];  // { x, y, z, yaw, tier, row, rowT, frac }

  function buildTier(rows, r0, y0, run, rise, aisles, tierIdx) {
    const pTop = ring(r0 + rows * run);
    const aisleFrac = tierIdx === 0 ? 0.055 : 0.045;
    const isAisleU = (frac) => ((frac * aisles) % 1) < aisleFrac;

    for (let i = 0; i < rows; i++) {
      const rA = r0 + i * run;
      const rB = rA + run;
      const y = y0 + i * rise;
      const pa = ring(rA), pb = ring(rB);
      const usSeat = snapU(pa, SEAT_SP);
      const treadA = lift(pa, y), treadB = lift(pb, y);
      const maskSeat = (k) => !isAisleU(pa[k].u / pa.total);
      const maskAisle = (k) => isAisleU(pa[k].u / pa.total);
      addTo(geoSeat, bandGeometry(treadA, treadB, usSeat, 0, 1, maskSeat));
      addTo(geoStair, bandGeometry(
        lift(pa, y + 0.015), lift(pb, y + 0.015), snapU(pa, 1.6), 0, 0.5, maskAisle));
      // riser up to the next row
      const riserA = lift(pb, y), riserB = lift(pb, y + rise);
      addTo(geoConcrete, bandGeometry(riserA, riserB, snapU(pb, 4.0), 0.5, 0.62, maskSeat));
      addTo(geoStair, bandGeometry(
        lift(pb, y + 0.015), lift(pb, y + rise + 0.015), snapU(pb, 1.6), 0.5, 1.0, maskAisle));

      // spectators sit on the tread
      const seats = sampleLoop(pa, SEAT_SP, (i % 2) * 0.5 + i * 0.13);
      for (const s of seats) {
        if (isAisleU(s.frac)) continue;
        if (srng.float() < (tierIdx === 0 ? 0.028 : 0.06)) continue;
        crowd.push({
          x: s.x + s.nx * run * 0.45, z: s.z + s.nz * run * 0.45,
          y, yaw: Math.atan2(-s.nx, -s.nz),
          tier: tierIdx, row: i, rowT: i / rows, frac: s.frac,
        });
      }
    }
    return pTop;
  }

  buildTier(L1_ROWS, L1_R0, L1_Y0, L1_RUN, L1_RISE, AISLES_1, 0);
  buildTier(L2_ROWS, L2_R0, L2_Y0, L2_RUN, L2_RISE, AISLES_2, 1);

  // ---- fascia between the tiers (structure + LED ring + vomitories) --------
  {
    const p = ring(FASCIA_R);
    const us = snapU(p, 6.0);
    // structural wall
    addTo(geoConcrete, bandGeometry(lift(p, FASCIA_Y0), lift(p, FASCIA_Y0 + 1.6), us, 0, 0.2));
    // vomitory openings punched into the wall, aligned with every 2nd aisle
    const isVom = (k) => {
      const f = p[k].u / p.total;
      return ((f * (AISLES_1 / 2)) % 1) < 0.10;
    };
    addTo(geoDark, bandGeometry(lift(p, FASCIA_Y0), lift(p, FASCIA_Y0 + 1.6), us, 0, 1, isVom));

    // LED ring
    const ledA = lift(p, FASCIA_Y0 + 1.6), ledB = lift(p, FASCIA_Y0 + 3.0);
    const led = new THREE.Mesh(
      track(bandGeometry(ledA, ledB, snapU(p, 11.0), 0, 1)),
      track(new THREE.MeshBasicMaterial({ map: TX.fasciaTexture(), toneMapped: true })),
    );
    group.add(led);

    // big end screens set into the fascia behind each goal
    const scrMat = track(new THREE.MeshBasicMaterial({ map: jumboTex, toneMapped: false }));
    for (const sx of [-1, 1]) {
      const scr = new THREE.Mesh(track(new THREE.PlaneGeometry(15.4, 7.7)), scrMat);
      scr.position.set(sx * (A + FASCIA_R - 0.1), FASCIA_Y0 + 3.5, 0);
      scr.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
      group.add(scr);
      const bez = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.5, 8.7, 16.4)),
        track(new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 0.8 })),
      );
      bez.position.set(sx * (A + FASCIA_R + 0.2), FASCIA_Y0 + 3.5, 0);
      group.add(bez);
    }

    // walkway + the deck the upper tier springs from
    addTo(geoConcrete, bandGeometry(lift(p, FASCIA_Y1), lift(ring(L2_R0), FASCIA_Y1), snapU(p, 5), 0, 0.2));
    addTo(geoConcrete, bandGeometry(lift(p, FASCIA_Y0 + 3.0), lift(p, FASCIA_Y1), us, 0, 0.3));
  }

  // ---- back wall + roof ---------------------------------------------------
  {
    const pBack = ring(BACK_R);
    addTo(geoConcrete, bandGeometry(
      lift(ring(L2_R1), L2_Y1), lift(pBack, L2_Y1), snapU(pBack, 5), 0, 0.1));
    addTo(geoConcrete, bandGeometry(lift(pBack, L2_Y1), lift(pBack, BACK_Y), snapU(pBack, 6), 0, 0.9));

    const rin = ring(ROOF_IN), rout = ring(ROOF_OUT);
    const roof = new THREE.Mesh(
      track(bandGeometry(lift(rin, ROOF_Y_IN), lift(rout, ROOF_Y_OUT), snapU(rin, 8), 0, 1.6)),
      matRoof,
    );
    group.add(roof);

    // inner roof fascia band (bright, catches the eye in wide shots)
    const fA = lift(rin, ROOF_Y_IN - 1.5), fB = lift(rin, ROOF_Y_IN);
    const fascia = new THREE.Mesh(
      track(bandGeometry(fA, fB, snapU(rin, 13.0), 0, 1)),
      track(new THREE.MeshStandardMaterial({
        map: TX.adBoardTexture(), roughness: 0.5, color: 0xffffff, side: THREE.DoubleSide,
      })),
    );
    group.add(fascia);

    // trusses under the roof
    const trussPts = sampleLoop(rin, 7.4);
    const tparts = [];
    for (const t of trussPts) {
      const len = ROOF_OUT - ROOF_IN;
      const g1 = new THREE.BoxGeometry(0.42, 0.42, len);
      const g2 = new THREE.BoxGeometry(0.30, 0.30, len);
      const yaw = Math.atan2(t.nx, t.nz);
      const m = new THREE.Matrix4();
      const cx = t.x + t.nx * len * 0.5, cz = t.z + t.nz * len * 0.5;
      const cy = (ROOF_Y_IN + ROOF_Y_OUT) / 2;
      m.makeRotationY(yaw); m.setPosition(cx, cy - 0.45, cz);
      g1.applyMatrix4(m);
      m.makeRotationY(yaw); m.setPosition(cx, cy - 1.55, cz);
      g2.applyMatrix4(m);
      tparts.push(g1, g2);
      // vertical hangers
      for (let k = -1; k <= 1; k += 2) {
        const h = new THREE.BoxGeometry(0.16, 1.5, 0.16);
        const hx = t.x + t.nx * (len * (0.5 + k * 0.26));
        const hz = t.z + t.nz * (len * (0.5 + k * 0.26));
        h.translate(hx, cy - 1.0, hz);
        tparts.push(h);
      }
    }
    const trussGeo = track(mergeGeometries(tparts, false));
    tparts.forEach((g) => g.dispose());
    group.add(new THREE.Mesh(trussGeo, track(new THREE.MeshStandardMaterial({
      color: 0x8d969c, roughness: 0.5, metalness: 0.6,
    }))));
  }

  // ---- deep "standing room" crowd wall behind the top row -----------------
  {
    const p = ring(L2_R1);
    const cw = new THREE.Mesh(
      track(bandGeometry(lift(p, L2_Y1), lift(ring(L2_R1 + 1.1), L2_Y1 + 3.4), snapU(p, 7.5), 0, 1)),
      track(new THREE.MeshLambertMaterial({
        map: TX.crowdWallTexture(), color: 0xbfc6cc, side: THREE.DoubleSide,
      })),
    );
    group.add(cw);
  }

  // ---- merge the shell ----------------------------------------------------
  const shell = [
    [geoConcrete, matConcrete], [geoSeat, matSeat],
    [geoStair, matStair], [geoDark, matDark], [geoBarrier, matBarrier],
  ];
  for (const [arr, mat] of shell) {
    if (!arr.length) continue;
    const merged = track(mergeGeometries(arr, false));
    arr.forEach((g) => g.dispose());
    const m = new THREE.Mesh(merged, mat);
    m.receiveShadow = false;
    group.add(m);
  }

  // ------------------------------------------------------------------ crowd
  // Real crowds are blocks of colour, not confetti. The sprite sheet is grouped
  // into home / away / neutral shirt rows, so allegiance comes from WHICH cell
  // an instance samples; the per-instance tint then only carries shading.
  function groupFor(c) {
    const block = Math.floor(c.frac * 34);
    if (c.x > A * 0.60) return 'home';
    if (c.x < -A * 0.60) return 'away';
    const k = (block * 5 + 1) % 7;
    return k < 2 ? 'home' : (k < 4 ? 'away' : 'neutral');
  }

  {
    const sheet = TX.crowdSheet();
    const n = crowd.length;
    const geo = new THREE.PlaneGeometry(1.12, 1.28);
    geo.translate(0, 0.58, 0);
    const phase = new Float32Array(n);
    const flip = new Float32Array(n);
    const cells = new Float32Array(n * 2);
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.setAttribute('aFlip', new THREE.InstancedBufferAttribute(flip, 1));
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    track(geo);

    // alphaTest (not blending) keeps them in the opaque pass, so they occlude
    // and are occluded correctly with no sorting artefacts.
    const mat = crowdAnim(track(new THREE.MeshBasicMaterial({
      map: sheet.texture, transparent: false, alphaTest: 0.45,
      side: THREE.DoubleSide, color: 0xffffff, fog: true,
    })), uniforms, [1 / sheet.cols, 1 / sheet.rows]);

    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    for (let i = 0; i < n; i++) {
      const c = crowd[i];
      phase[i] = srng.range(0, Math.PI * 2);
      flip[i] = srng.float() < 0.5 ? -1 : 1;
      const rows = sheet.groups[groupFor(c)];
      cells[i * 2] = srng.int(sheet.cols) / sheet.cols;
      cells[i * 2 + 1] = rows[srng.int(rows.length)] / sheet.rows;

      const s = srng.range(0.93, 1.08);
      dummy.position.set(c.x, c.y, c.z);
      dummy.rotation.set(0, c.yaw, 0);
      dummy.scale.set(s, s * srng.range(0.96, 1.04), s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Lighting is baked: deeper rows sit further back into the roof's shade.
      const k = (c.tier === 0 ? 1.04 - c.rowT * 0.20 : 1.06 - c.rowT * 0.30)
        * srng.range(0.93, 1.04);
      col.setRGB(k * 1.02, k, k * 0.97);
      mesh.setColorAt(i, col.convertSRGBToLinear());
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    disposables.push(mesh);
  }

  // --- flags waved in the stands -------------------------------------------
  // Reuses the crowd billboard shader (a 1x1 "sheet"), so they sway with the
  // crowd and cost one extra draw call.
  {
    const picks = [];
    for (let i = 0; i < crowd.length; i += 233) {
      const c = crowd[i];
      if (c.row < 2) continue;
      picks.push(c);
    }
    const n = picks.length;
    if (n) {
      const geo = new THREE.PlaneGeometry(2.15, 1.42);
      geo.translate(0, 1.48, 0);
      const phase = new Float32Array(n);
      const flip = new Float32Array(n);
      const cells = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        phase[i] = srng.range(0, Math.PI * 2);
        flip[i] = srng.float() < 0.5 ? -1 : 1;
      }
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
      geo.setAttribute('aFlip', new THREE.InstancedBufferAttribute(flip, 1));
      geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
      track(geo);
      const mat = crowdAnim(track(new THREE.MeshBasicMaterial({
        map: TX.bannerTexture('#ffffff', '#2450c8'), transparent: false,
        alphaTest: 0.4, side: THREE.DoubleSide, fog: true,
      })), uniforms, [1, 1]);
      const flags = new THREE.InstancedMesh(geo, mat, n);
      flags.frustumCulled = false;
      for (let i = 0; i < n; i++) {
        const c = picks[i];
        const sc = srng.range(0.85, 1.25);
        dummy.position.set(c.x, c.y, c.z);
        dummy.rotation.set(0, c.yaw, 0);
        dummy.scale.set(sc, sc, sc);
        dummy.updateMatrix();
        flags.setMatrixAt(i, dummy.matrix);
        const k = srng.range(0.9, 1.05);
        col.setRGB(k, k, k);
        flags.setColorAt(i, col);
      }
      flags.instanceMatrix.needsUpdate = true;
      if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
      group.add(flags);
      disposables.push(flags);
    }
  }

  // --- supporter banners tied to the front barrier --------------------------
  {
    const pts = sampleLoop(ring(R_TRACK - 0.05), 11.0, 0.35);
    const sets = [[], []];
    pts.forEach((p, i) => {
      if (i % 3 === 2) return;
      const g = new THREE.PlaneGeometry(4.4, 1.05);
      const m = new THREE.Matrix4();
      m.makeRotationY(Math.atan2(-p.nx, -p.nz));
      m.setPosition(p.x - p.nx * 0.08, 0.70, p.z - p.nz * 0.08);
      g.applyMatrix4(m);
      sets[i % 2].push(g);
    });
    const skins = [
      TX.bannerTexture('#e0353b', '#ffffff'),
      TX.bannerTexture('#2450c8', '#f5d020'),
    ];
    sets.forEach((parts, k) => {
      if (!parts.length) return;
      const merged = track(mergeGeometries(parts, false));
      parts.forEach((g) => g.dispose());
      group.add(new THREE.Mesh(merged, track(new THREE.MeshLambertMaterial({
        map: skins[k], side: THREE.DoubleSide,
      }))));
    });
  }

  // ------------------------------------------------------------- floodlights
  {
    const glowTex = TX.glowTexture();
    const pylonMat = track(new THREE.MeshStandardMaterial({
      color: 0x9aa2a8, roughness: 0.55, metalness: 0.55,
    }));
    const lampMat = track(new THREE.MeshBasicMaterial({ color: 0xfffbe8, toneMapped: false }));

    const mastParts = [];
    const lampXf = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const dir = new THREE.Vector3(sx, 0, sz).normalize();
        const px = A * sx + dir.x * (ROOF_OUT - 2), pz = B * sz + dir.z * (ROOF_OUT - 2);
        const yaw = Math.atan2(-dir.x, -dir.z);
        const H = 50;
        const mast = new THREE.CylinderGeometry(0.55, 1.35, H, 8, 1);
        mast.translate(px, H / 2, pz);
        mastParts.push(mast);
        // lattice bracing
        for (let k = 0; k < 6; k++) {
          const y = 8 + k * 6.2;
          const rr = 1.25 - (y / H) * 0.75;
          const br = new THREE.TorusGeometry(rr, 0.10, 4, 8);
          br.rotateX(Math.PI / 2);
          br.translate(px, y, pz);
          mastParts.push(br);
        }
        // head frame
        const frame = new THREE.BoxGeometry(11.5, 4.6, 0.7);
        const m = new THREE.Matrix4();
        m.makeRotationY(yaw); m.setPosition(px, H + 2.2, pz);
        frame.applyMatrix4(m);
        mastParts.push(frame);
        for (let r = 0; r < 2; r++) {
          for (let c = 0; c < 7; c++) {
            const lx = -4.5 + c * 1.5, ly = r === 0 ? 1.0 : -1.0;
            const v = new THREE.Vector3(lx, ly, 0.55).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
            lampXf.push({ x: px + v.x, y: H + 2.2 + v.y, z: pz + v.z, yaw });
          }
        }
      }
    }
    const mastGeo = track(mergeGeometries(mastParts, false));
    mastParts.forEach((g) => g.dispose());
    const masts = new THREE.Mesh(mastGeo, pylonMat);
    group.add(masts);

    const lampGeo = track(new THREE.BoxGeometry(1.30, 1.05, 0.34));
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, lampXf.length);
    lampXf.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, t.yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      lamps.setMatrixAt(i, dummy.matrix);
    });
    lamps.instanceMatrix.needsUpdate = true;
    group.add(lamps);
    disposables.push(lamps);

    // additive glow so bloom has something to grab
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const dir = new THREE.Vector3(sx, 0, sz).normalize();
        const px = A * sx + dir.x * (ROOF_OUT - 2), pz = B * sz + dir.z * (ROOF_OUT - 2);
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
          depthWrite: false, toneMapped: false, opacity: 0.8, color: 0xfff2cf,
        }));
        s.position.set(px, 52.2, pz);
        s.scale.set(22, 14, 1);
        group.add(s);
        disposables.push(s.material);
      }
    }
  }

  // --------------------------------------------------------------- jumbotron
  // Big screens ride ON TOP of the roof at both ends, tilted down at the pitch:
  // anywhere lower and they would be buried in the upper tier crowd.
  {
    const bodyMat = track(new THREE.MeshStandardMaterial({ color: 0x151a22, roughness: 0.8 }));
    const screenMat = track(new THREE.MeshBasicMaterial({ map: jumboTex, toneMapped: false }));
    for (const sz of [-1, 1]) {
      const holder = new THREE.Group();
      holder.position.set(0, 40.0, sz * (B + ROOF_IN + 4.5));
      holder.rotation.y = sz > 0 ? Math.PI : 0;
      holder.rotation.x = sz > 0 ? -0.34 : 0.34;
      group.add(holder);
      holder.add(new THREE.Mesh(track(new THREE.BoxGeometry(27, 14, 1.8)), bodyMat));
      const screen = new THREE.Mesh(track(new THREE.PlaneGeometry(25.2, 12.4)), screenMat);
      screen.position.z = 0.95;
      holder.add(screen);
      // support legs down onto the roof
      const legs = [];
      for (const ax of [-10, 10]) {
        const g = new THREE.BoxGeometry(0.7, 9.0, 0.7);
        g.translate(ax, -10.5, 1.2);
        legs.push(g);
        const br = new THREE.BoxGeometry(0.5, 0.5, 6.5);
        br.translate(ax, -8.0, 3.4);
        legs.push(br);
      }
      const lg = track(mergeGeometries(legs, false));
      legs.forEach((g) => g.dispose());
      holder.add(new THREE.Mesh(lg, bodyMat));
    }
  }

  // ------------------------------------------------------------ set dressing
  const flags = [];
  {
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.5 }));
    const poles = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const g = new THREE.CylinderGeometry(0.055, 0.055, 1.8, 6);
        g.translate(sx * HALF_W, 0.9, sz * HALF_D);
        poles.push(g);
        const holder = new THREE.Group();
        holder.position.set(sx * HALF_W, 1.58, sz * HALF_D);
        group.add(holder);
        const flag = new THREE.Mesh(
          track(new THREE.PlaneGeometry(0.66, 0.44, 3, 1)),
          track(new THREE.MeshLambertMaterial({
            map: TX.bannerTexture('#f5d020', '#e0353b'), side: THREE.DoubleSide,
          })),
        );
        flag.position.x = -sx * 0.33;
        holder.add(flag);
        flags.push(holder);
      }
    }
    const pg = track(mergeGeometries(poles, false));
    poles.forEach((g) => g.dispose());
    const pm = new THREE.Mesh(pg, poleMat);
    pm.castShadow = true;
    group.add(pm);
  }

  // Dugouts / subs benches, tucked behind the ad boards so their roofs never
  // float over the boards at pitch level but still read from above.
  {
    const shellMat = track(new THREE.MeshStandardMaterial({
      color: 0x2f3a4e, roughness: 0.55, metalness: 0.15,
    }));
    const benchMat = track(new THREE.MeshStandardMaterial({ color: 0xc4cad0, roughness: 0.6 }));
    const zLine = HALF_D + 2.9;
    for (const sx of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(sx * 11.5, 0, zLine);
      group.add(g);
      const roof = new THREE.Mesh(track(new THREE.BoxGeometry(6.8, 0.16, 1.9)), shellMat);
      roof.position.set(0, 1.30, 0);
      roof.castShadow = true;
      g.add(roof);
      const back = new THREE.Mesh(track(new THREE.BoxGeometry(6.8, 1.30, 0.14)), shellMat);
      back.position.set(0, 0.65, 0.90);
      g.add(back);
      for (const ex of [-3.4, 3.4]) {
        const post = new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 1.30, 1.9)), shellMat);
        post.position.set(ex, 0.65, 0);
        g.add(post);
      }
      const bench = new THREE.Mesh(track(new THREE.BoxGeometry(6.2, 0.14, 0.44)), benchMat);
      bench.position.set(0, 0.50, 0.30);
      g.add(bench);
    }
  }

  // bottles, tripods, camera platforms
  {
    const propMat = track(new THREE.MeshStandardMaterial({ color: 0xeaf2f6, roughness: 0.35 }));
    const darkProp = track(new THREE.MeshStandardMaterial({ color: 0x1b1f25, roughness: 0.7 }));
    const bottles = [];
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const b = new THREE.CylinderGeometry(0.085, 0.085, 0.30, 6);
        b.translate(sx * (HALF_W + 1.5), 0.15, 5.2 + i * 0.30);
        bottles.push(b);
        const b2 = new THREE.CylinderGeometry(0.085, 0.085, 0.30, 6);
        b2.translate(sx * (HALF_W + 1.5), 0.15, -5.2 - i * 0.30);
        bottles.push(b2);
      }
    }
    const bg = track(mergeGeometries(bottles, false));
    bottles.forEach((g) => g.dispose());
    const bm = new THREE.Mesh(bg, propMat);
    bm.castShadow = true;
    group.add(bm);

    const tri = [];
    const spots = [
      [-HALF_W - 2.6, -HALF_D - 2.2], [HALF_W + 2.6, -HALF_D - 2.2],
      [-HALF_W - 2.6, HALF_D + 2.2], [HALF_W + 2.6, HALF_D + 2.2],
      [0, -HALF_D - 3.0],
    ];
    for (const [px, pz] of spots) {
      for (let l = 0; l < 3; l++) {
        const leg = new THREE.CylinderGeometry(0.045, 0.045, 1.7, 5);
        const a = (l / 3) * Math.PI * 2;
        leg.rotateZ(-Math.cos(a) * 0.22);
        leg.rotateX(Math.sin(a) * 0.22);
        leg.translate(px + Math.cos(a) * 0.22, 0.83, pz + Math.sin(a) * 0.22);
        tri.push(leg);
      }
      const cam = new THREE.BoxGeometry(0.55, 0.36, 0.85);
      cam.rotateY(Math.atan2(-px, -pz));
      cam.translate(px, 1.78, pz);
      tri.push(cam);
      const hood = new THREE.CylinderGeometry(0.18, 0.24, 0.3, 8);
      hood.rotateX(Math.PI / 2);
      hood.translate(px, 1.85, pz - Math.sign(pz || 1) * 0.5);
      tri.push(hood);
    }
    const tg = track(mergeGeometries(tri, false));
    tri.forEach((g) => g.dispose());
    const tm = new THREE.Mesh(tg, darkProp);
    tm.castShadow = true;
    group.add(tm);
  }

  // ------------------------------------------------------------------ update
  let t = 0;
  let excite = 0.14;

  function update(dt) {
    t += dt;
    excite = Math.max(0.14, excite - dt * 0.42);
    uniforms.uTime.value = t;
    uniforms.uExcite.value = excite;
    for (const f of flags) f.rotation.z = Math.sin(t * 2.4 + f.position.x) * 0.17;
  }

  function setScore(a, b, clock) {
    jumbo.draw(a, b, clock || '0:00', TEAMS[0].short, TEAMS[1].short);
  }
  setScore(0, 0, '3:00');

  return {
    group, update, setScore,
    celebrate() { excite = 1; },
    dispose() { for (const d of disposables) if (d && d.dispose) d.dispose(); },
  };
}
