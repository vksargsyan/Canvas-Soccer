// Goal frame + net.
//
//   createGoal(side) -> { group, side, posts, crossbarY, backX, contains(),
//                         impulse(p, v, s), update(dt, ballPos, ballVel),
//                         sheetDepthAt(y), reset(), dispose() }
//
// `side` is +1 (goal at x = +HALF_W) or -1.
//
// Everything below is authored in GOAL-LOCAL space: the goal line is x = 0 and
// +x runs away from the pitch, into the net. A single inner group carries the
// translation to the goal line and a 180 deg yaw for the far goal, so the whole
// build (and the cloth solver) is written once and mirrors for free.
//
// The net is not a quad standing behind the line. It is a closed box skin —
// back sheet, two side panels and a roof panel — stitched into ONE welded
// particle lattice so a shot that bulges the back sheet drags the seams and the
// side panels with it. The rest pose is not authored: the lattice is hung from
// its tie points and relaxed under gravity at build time, so the sag between
// the ties (and the bag in the back sheet) is what a slack cord net actually
// does, not a sine wave. That settle runs once and both goals share it.
//
// Depth profile: the sheet hangs almost straight down off the top rail and only
// swings back to the ground bar near the foot (a power curve, not a ramp). That
// is what puts the mesh right where a struck ball sits, so the ball wraps INTO
// the net instead of hovering in front of a distant plane.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HALF_W, GOAL_HALF_W, GOAL_H, GOAL_DEPTH, POST_R, BALL_R } from '../core/constants.js';

const HW = GOAL_HALF_W;
const D_TOP = 0.85;                 // depth of the net's top rail
const D_BOT = GOAL_DEPTH - 0.06;    // depth where the net meets the ground
// >1 : hangs plumb off the rail and only kicks back at the foot. Tuned so the
// sheet at chest height sits IN FRONT of where a scored ball comes to rest, so
// the ball is through the cord and wearing a pocket rather than floating clear
// of a sheet parked at the back of the goal.
const BACK_P = 2.6;

const NX = 45;                      // back sheet columns (across Z)
const NY = 21;                      // rows, crossbar height -> ground
const ND = 17;                      // side / roof resolution along depth
const TIE = 4;                      // one lashing every TIE-th node on a frame edge

const NET_CELL = 0.18;              // world size of one net cell
const TILE_CELLS = 8;               // cells per texture tile
const TILE = NET_CELL * TILE_CELLS; // world size of one texture tile (1.0 m)

const SLACK = 1.022;                // cord length over the taut layout
const SLACK_D = 1.035;              // ... on the shear diagonals

const clampNum = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Depth of the back sheet at row parameter v (0 = crossbar, 1 = ground). */
const depAt = (v) => D_TOP + (D_BOT - D_TOP) * Math.pow(v, BACK_P);
const hgtAt = (v) => GOAL_H * (1 - v);

// ---------------------------------------------------------------------------
// net cord texture
// ---------------------------------------------------------------------------
// Pure white cord on straight alpha — no dark "shadow" pass, because a dark
// strand pair mips down into a grey-blue wash and that is exactly what reads as
// a "blue-tinted plane" from ten metres out. Cells are small (12.5 cm) so the
// texture is always minified well past 1:1, which keeps the mip chain doing the
// filtering instead of letting the strand frequency beat against the pixel grid
// and moire. Anisotropy keeps it from smearing at grazing angles.

let NET_TEX = null;
function netTex() {
  if (NET_TEX) return NET_TEX;
  const S = 512, step = S / TILE_CELLS;

  // Written straight into a DataTexture rather than stroked onto a canvas,
  // because RGB has to stay 255 in EVERY texel including the holes. A canvas is
  // stored premultiplied, so a transparent texel comes back as BLACK — and the
  // mip chain then averages white cord against black gaps, turning the net grey
  // the moment it is minified. That is most of how the old net ended up reading
  // as a dull tinted plane at any distance. With the cord living purely in the
  // alpha channel of raw data, every mip level stays pure white.
  const data = new Uint8Array(S * S * 4);
  // Cord width is set by MEASURING the reference: its netting whitens the
  // hoarding behind it by about 19%, so the cord has to cover roughly a fifth
  // of the sheet. Physically a 3 mm twine on a 120 mm mesh covers 5%; the
  // reference is exaggerated, and matching the exaggeration is what makes the
  // net read as fabric at gameplay distance instead of vanishing.
  const HALF = 2.9;       // cord half width, px (of a 64 px cell)
  const THIN = 0.75;      // secondary thread through the middle of each cell
  const KNOT = 3.8;
  const band = (q, h, a) => a * Math.min(1, Math.max(0, h + 0.5 - q));
  for (let y = 0; y < S; y++) {
    const my = y % step, dy = Math.min(my, step - my);
    const cy = Math.abs(my - step * 0.5);
    for (let x = 0; x < S; x++) {
      const mx = x % step, dx = Math.min(mx, step - mx);
      const cx = Math.abs(mx - step * 0.5);
      const ax = band(dx, HALF, 0.94), ay = band(dy, HALF, 0.94);
      const bx = band(cx, THIN, 0.28), by = band(cy, THIN, 0.28);
      let a = 1 - (1 - ax) * (1 - ay) * (1 - bx) * (1 - by);
      const knot = Math.hypot(dx, dy);
      if (knot < KNOT) a = Math.max(a, Math.min(1, KNOT + 0.5 - knot));
      const k = (y * S + x) * 4;
      data[k] = 255; data[k + 1] = 255; data[k + 2] = 255;
      data[k + 3] = Math.round(Math.min(1, a) * 255);
    }
  }

  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  NET_TEX = t;
  return t;
}

/** Soft ambient-occlusion patch laid on the grass inside the goal mouth. */
let AO_TEX = null;
function goalAoTex() {
  if (AO_TEX) return AO_TEX;
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const u = i / (S - 1);          // 0 = goal line, 1 = back of the net
      const v = j / (S - 1);          // across the mouth
      const edge = Math.min(1, Math.min(v, 1 - v) / 0.14);
      const deep = Math.pow(u, 0.55);
      const mouth = Math.min(1, u / 0.10);
      const rear = Math.min(1, (1 - u) / 0.07);   // no hard rectangle at the back
      const a = 0.44 * deep * edge * mouth * rear;
      const k = (j * S + i) * 4;
      data[k] = 12; data[k + 1] = 22; data[k + 2] = 14;
      data[k + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  AO_TEX = t;
  return t;
}

// ---------------------------------------------------------------------------
// the lattice: built once, shared
// ---------------------------------------------------------------------------

let LATTICE = null;

function buildLattice() {
  if (LATTICE) return LATTICE;

  // --- row profile + arc length so the cord texture keeps a constant scale
  const rowDep = new Float32Array(NY);
  const rowY = new Float32Array(NY);
  const rowArc = new Float32Array(NY);
  for (let j = 0; j < NY; j++) {
    const v = j / (NY - 1);
    rowDep[j] = depAt(v); rowY[j] = hgtAt(v);
    if (j > 0) {
      rowArc[j] = rowArc[j - 1] + Math.hypot(rowDep[j] - rowDep[j - 1], rowY[j] - rowY[j - 1]);
    }
  }

  // --- nodes (welded by position) -----------------------------------------
  const nx = [], ny = [], nz = [];
  const pin = [];
  const pdir = [];                    // frame-bar direction at a lashing
  const press = [];                   // outward panel normal, for the settle
  const nmap = new Map();
  const kOf = (x, y, z) =>
    `${Math.round(x * 1e4)}|${Math.round(y * 1e4)}|${Math.round(z * 1e4)}`;

  function node(x, y, z) {
    const k = kOf(x, y, z);
    let i = nmap.get(k);
    if (i === undefined) {
      i = nx.length;
      nx.push(x); ny.push(y); nz.push(z);
      pin.push(0); pdir.push(0, 0, 0); press.push(0, 0, 0);
      nmap.set(k, i);
    }
    return i;
  }
  function lash(i, dx, dy, dz) {
    pin[i] = 1;
    pdir[i * 3] = dx; pdir[i * 3 + 1] = dy; pdir[i * 3 + 2] = dz;
  }
  function pushOut(i, dx, dy, dz) {
    press[i * 3] += dx; press[i * 3 + 1] += dy; press[i * 3 + 2] += dz;
  }

  // --- vertices + triangles ------------------------------------------------
  const vNode = [];
  const vUV = [];
  const vAO = [];
  const index = [];

  // Baked occlusion: the net is lit through the open mouth, so it darkens with
  // depth, near the floor and into the corners. This is what stops a white
  // sheet reading as a flat cut-out and gives the box its volume.
  function ao(x, y, z) {
    const dep = clampNum(x / D_BOT, 0, 1);
    const low = 1 - clampNum(y / 1.7, 0, 1);
    const zEdge = 1 - clampNum((HW - Math.abs(z)) / 1.1, 0, 1);
    return clampNum(1 - 0.30 * dep - 0.17 * low * dep - 0.13 * zEdge * dep - 0.05 * low, 0.46, 1);
  }

  const conA = [], conB = [], conR = [];
  const conSeen = new Set();
  function link(a, b, slack) {
    if (a === b) return;
    const k = a < b ? a * 1e6 + b : b * 1e6 + a;
    if (conSeen.has(k)) return;
    conSeen.add(k);
    const d = Math.hypot(nx[a] - nx[b], ny[a] - ny[b], nz[a] - nz[b]);
    conA.push(a); conB.push(b); conR.push(d * slack);
  }

  /** grid[j][i] of node ids -> vertices, triangles and cord constraints. */
  function panel(cols, rows, fn) {
    const base = vNode.length;
    const ids = new Int32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = fn(i, j);
        const id = node(p.x, p.y, p.z);
        ids[j * cols + i] = id;
        vNode.push(id);
        vUV.push(p.u, p.v);
        vAO.push(ao(p.x, p.y, p.z));
        if (p.n) pushOut(id, p.n[0], p.n[1], p.n[2]);
        if (p.lash) lash(id, p.lash[0], p.lash[1], p.lash[2]);
      }
    }
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = base + j * cols + i, b = a + 1, c = a + cols, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const id = ids[j * cols + i];
        if (i + 1 < cols) link(id, ids[j * cols + i + 1], SLACK);
        if (j + 1 < rows) link(id, ids[(j + 1) * cols + i], SLACK);
        if (i + 1 < cols && j + 1 < rows) {
          link(id, ids[(j + 1) * cols + i + 1], SLACK_D);
          link(ids[j * cols + i + 1], ids[(j + 1) * cols + i], SLACK_D);
        }
      }
    }
    return ids;
  }

  const tieCol = (i) => (i % TIE === 0 || i === 0 || i === NX - 1);
  const tieRow = (j) => (j % TIE === 0 || j === 0 || j === NY - 1);
  const tieDep = (k) => (k % TIE === 0 || k === 0 || k === ND - 1);

  // ---- back sheet ---------------------------------------------------------
  panel(NX, NY, (i, j) => {
    const z = -HW + (i / (NX - 1)) * HW * 2;
    const x = rowDep[j], y = rowY[j];
    let lashDir = null;
    if (j === 0 && tieCol(i)) lashDir = [0, 0, 1];              // back top rail
    else if (j === NY - 1 && tieCol(i)) lashDir = [0, 0, 1];    // rear ground bar
    else if ((i === 0 || i === NX - 1) && tieRow(j)) {          // rear stanchion
      const j0 = Math.max(0, j - 1), j1 = Math.min(NY - 1, j + 1);
      lashDir = [rowDep[j1] - rowDep[j0], rowY[j1] - rowY[j0], 0];
    }
    return {
      x, y, z,
      u: (z + HW) / TILE, v: rowArc[j] / TILE,
      n: [1, 0, 0],
      lash: lashDir,
    };
  });

  // ---- side panels --------------------------------------------------------
  for (const zs of [-1, 1]) {
    panel(ND, NY, (k, j) => {
      const t = k / (ND - 1);
      const x = rowDep[j] * t, y = rowY[j], z = zs * HW;
      let lashDir = null;
      if (k === 0 && tieRow(j)) lashDir = [0, 1, 0];             // goal post
      else if (j === 0 && tieDep(k)) lashDir = [1, 0, 0];        // top stringer
      else if (j === NY - 1 && tieDep(k)) lashDir = [1, 0, 0];   // side ground bar
      return {
        x, y, z,
        u: x / TILE, v: (GOAL_H - y) / TILE,
        n: [0, 0, zs * 0.5],
        lash: lashDir,
      };
    });
  }

  // ---- roof panel ---------------------------------------------------------
  panel(ND, NX, (k, i) => {
    const x = D_TOP * (k / (ND - 1));
    const z = -HW + (i / (NX - 1)) * HW * 2;
    let lashDir = null;
    if (k === 0 && tieCol(i)) lashDir = [0, 0, 1];               // crossbar
    return { x, y: GOAL_H, z, u: x / TILE, v: (z + HW) / TILE, n: null, lash: lashDir };
  });

  // --- relax under gravity -------------------------------------------------
  const N = nx.length;
  const rest = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { rest[i * 3] = nx[i]; rest[i * 3 + 1] = ny[i]; rest[i * 3 + 2] = nz[i]; }

  const cA = Int32Array.from(conA), cB = Int32Array.from(conB), cR = Float32Array.from(conR);
  const pinA = Uint8Array.from(pin);

  // The cord can sag and bulge, but it cannot pass through the ground, escape
  // past the ground bars or flap out onto the pitch in front of the line.
  const cage = (p) => {
    for (let i = 0; i < N; i++) {
      if (pinA[i]) continue;
      const o = i * 3;
      if (p[o] < -0.04) p[o] = -0.04;
      else if (p[o] > D_BOT + 0.03) p[o] = D_BOT + 0.03;
      if (p[o + 1] < 0.012) p[o + 1] = 0.012;
      else if (p[o + 1] > GOAL_H + 0.02) p[o + 1] = GOAL_H + 0.02;
      const zl = HW + 0.05;
      if (p[o + 2] < -zl) p[o + 2] = -zl;
      else if (p[o + 2] > zl) p[o + 2] = zl;
    }
  };

  const solve = (p, iters) => {
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < cA.length; c++) {
        const ai = cA[c], bi = cB[c];
        const a = ai * 3, b = bi * 3, r = cR[c];
        let dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d <= r || d < 1e-7) continue;     // cord: resists stretch only
        const k = ((d - r) / d) * 0.5;
        dx *= k; dy *= k; dz *= k;
        const pa = pinA[ai], pb = pinA[bi];
        if (pa && pb) continue;
        if (pa) { p[b] -= dx * 2; p[b + 1] -= dy * 2; p[b + 2] -= dz * 2; }
        else if (pb) { p[a] += dx * 2; p[a + 1] += dy * 2; p[a + 2] += dz * 2; }
        else {
          p[a] += dx; p[a + 1] += dy; p[a + 2] += dz;
          p[b] -= dx; p[b + 1] -= dy; p[b + 2] -= dz;
        }
      }
      cage(p);
    }
  };

  {
    const cur = Float32Array.from(rest);
    const prv = Float32Array.from(rest);
    const G = -0.00062, PR = 0.00020, DMP = 0.955;
    for (let s = 0; s < 170; s++) {
      for (let i = 0; i < N; i++) {
        if (pinA[i]) continue;
        const o = i * 3;
        for (let a = 0; a < 3; a++) {
          const c = cur[o + a];
          const v = (c - prv[o + a]) * DMP;
          prv[o + a] = c;
          cur[o + a] = c + v + press[o + a] * PR + (a === 1 ? G : 0);
        }
      }
      solve(cur, 4);
    }
    rest.set(cur);
  }

  // --- geometry template ---------------------------------------------------
  const vc = vNode.length;
  const pos = new Float32Array(vc * 3);
  const uv = Float32Array.from(vUV);
  const col = new Float32Array(vc * 3);
  for (let i = 0; i < vc; i++) {
    const n = vNode[i] * 3;
    pos[i * 3] = rest[n]; pos[i * 3 + 1] = rest[n + 1]; pos[i * 3 + 2] = rest[n + 2];
    const a = vAO[i];
    col[i * 3] = a; col[i * 3 + 1] = a; col[i * 3 + 2] = a * 0.995;
  }

  // lashing points, for the frame builder
  const ties = [];
  for (let i = 0; i < N; i++) {
    if (!pinA[i]) continue;
    const dx = pdir[i * 3], dy = pdir[i * 3 + 1], dz = pdir[i * 3 + 2];
    if (dx === 0 && dy === 0 && dz === 0) continue;
    ties.push({ x: rest[i * 3], y: rest[i * 3 + 1], z: rest[i * 3 + 2], dx, dy, dz });
  }

  LATTICE = {
    N, rest, pin: pinA, cA, cB, cR, solve,
    vNode: Int32Array.from(vNode), index: Uint32Array.from(index),
    pos, uv, col, ties,
  };
  return LATTICE;
}

// ---------------------------------------------------------------------------

export function createGoal(side = 1) {
  const L = buildLattice();

  const group = new THREE.Group();
  group.name = 'goal' + (side > 0 ? 'R' : 'L');
  const gx = side * HALF_W;

  // Everything is authored in goal-local space; this node puts it on the line
  // and yaws the far goal 180 deg (a true mirror, with the winding intact).
  const gs = new THREE.Group();
  gs.position.x = gx;
  if (side < 0) gs.rotation.y = Math.PI;
  group.add(gs);

  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  // ---- frame -------------------------------------------------------------
  const parts = [];
  const OVAL = 0.80;                      // posts are flattened along the pitch axis

  // posts
  for (const z of [-HW, HW]) {
    const p = new THREE.CylinderGeometry(POST_R, POST_R, GOAL_H, 16, 1);
    p.scale(OVAL, 1, 1);
    p.translate(0, GOAL_H / 2, z);
    parts.push(p);
  }
  // crossbar
  {
    const bar = new THREE.CylinderGeometry(POST_R, POST_R, HW * 2 + POST_R * 2, 16, 1);
    bar.rotateX(Math.PI / 2);
    bar.scale(OVAL, 1, 1);
    bar.translate(0, GOAL_H, 0);
    parts.push(bar);
  }
  // welded corner blobs so the joint has mass instead of two tubes crossing
  for (const z of [-HW, HW]) {
    const s = new THREE.SphereGeometry(POST_R * 1.06, 12, 8);
    s.scale(OVAL, 1, 1);
    s.translate(0, GOAL_H, z);
    parts.push(s);
  }
  // post feet
  for (const z of [-HW, HW]) {
    const s = new THREE.CylinderGeometry(POST_R * 1.25, POST_R * 1.45, 0.07, 12, 1);
    s.translate(0, 0.035, z);
    parts.push(s);
  }

  // back top rail
  {
    const rail = new THREE.CylinderGeometry(POST_R * 0.52, POST_R * 0.52, HW * 2, 10, 1);
    rail.rotateX(Math.PI / 2);
    rail.translate(D_TOP, GOAL_H - 0.015, 0);
    parts.push(rail);
  }
  // top stringers, crossbar -> back rail
  for (const z of [-HW, HW]) {
    const r = new THREE.CylinderGeometry(POST_R * 0.44, POST_R * 0.44, D_TOP + POST_R, 10, 1);
    r.rotateZ(Math.PI / 2);
    r.translate((D_TOP - POST_R) * 0.5 + POST_R * 0.5, GOAL_H - 0.015, z);
    parts.push(r);
  }
  // rear stanchions: a curved elbow that follows the net's own hang profile
  // from the top rail down to the ground bar. This is the piece the side and
  // back panels are laced to, and it is what gives the goal a rear silhouette.
  for (const z of [-HW, HW]) {
    const pts = [];
    for (let j = 0; j <= 14; j++) {
      const v = j / 14;
      pts.push(new THREE.Vector3(depAt(v), hgtAt(v) + (j === 14 ? POST_R * 0.5 : 0), z));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    parts.push(new THREE.TubeGeometry(curve, 26, POST_R * 0.52, 8, false));
  }
  // ground bar across the back
  {
    const g = new THREE.CylinderGeometry(POST_R * 0.5, POST_R * 0.5, HW * 2, 10, 1);
    g.rotateX(Math.PI / 2);
    g.translate(D_BOT, POST_R * 0.5, 0);
    parts.push(g);
  }
  // ground bars down each side
  for (const z of [-HW, HW]) {
    const g = new THREE.CylinderGeometry(POST_R * 0.44, POST_R * 0.44, D_BOT, 10, 1);
    g.rotateZ(Math.PI / 2);
    g.translate(D_BOT * 0.5, POST_R * 0.44, z);
    parts.push(g);
  }

  // lashings: a ring of cord at every point the net is actually tied on
  {
    const up = new THREE.Vector3(0, 0, 1);
    const dir = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const t of L.ties) {
      dir.set(t.dx, t.dy, t.dz);
      if (dir.lengthSq() < 1e-9) continue;
      dir.normalize();
      const onBar = Math.abs(t.y - GOAL_H) < 1e-3 && t.x < 1e-3;      // crossbar
      const onPost = t.x < 1e-3 && !onBar;
      const r = (onBar || onPost) ? POST_R * 1.22 : POST_R * 0.72;
      const g = new THREE.TorusGeometry(r, POST_R * 0.15, 4, 8);
      q.setFromUnitVectors(up, dir);
      g.applyQuaternion(q);
      if (onBar || onPost) g.scale(1, 1, 1);
      g.translate(t.x, t.y, t.z);
      parts.push(g);
    }
  }

  const frameGeo = track(mergeGeometries(parts, false));
  parts.forEach((g) => g.dispose());
  const frameMat = track(new THREE.MeshStandardMaterial({
    color: 0xf4f6f8, roughness: 0.40, metalness: 0.06,
  }));
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.castShadow = true;
  frame.receiveShadow = true;
  gs.add(frame);

  // ---- occlusion patch on the goal floor ---------------------------------
  {
    // after the -90 deg X spin the plane's own u axis runs along +x (depth)
    const g = track(new THREE.PlaneGeometry(D_BOT + 0.30, HW * 2 + 0.55));
    g.rotateX(-Math.PI / 2);
    g.translate((D_BOT + 0.30) / 2 - 0.15, 0.018, 0);
    const m = track(new THREE.MeshBasicMaterial({
      map: goalAoTex(), transparent: true, depthWrite: false,
      side: THREE.FrontSide, fog: true,
    }));
    const patch = new THREE.Mesh(g, m);
    patch.renderOrder = 1;
    gs.add(patch);
  }

  // ---- net ---------------------------------------------------------------
  const netGeo = track(new THREE.BufferGeometry());
  const posArr = Float32Array.from(L.pos);
  netGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  netGeo.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(L.uv), 2));
  netGeo.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(L.col), 3));
  netGeo.setIndex(new THREE.BufferAttribute(Uint32Array.from(L.index), 1));
  // no normals: the cord is unlit (its shading is baked into the vertex colour),
  // so re-deriving them every frame the cloth moves would be pure waste.

  const netMat = track(new THREE.MeshBasicMaterial({
    map: netTex(),
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  }));
  const net = new THREE.Mesh(netGeo, netMat);
  net.frustumCulled = false;
  net.renderOrder = 3;
  gs.add(net);

  // ---- cloth state -------------------------------------------------------
  const N = L.N;
  const rest = L.rest;
  const cur = Float32Array.from(rest);
  const prev = Float32Array.from(rest);
  const pin = L.pin;
  const vNode = L.vNode;
  const posAttr = netGeo.getAttribute('position');

  function writeOut() {
    for (let i = 0; i < vNode.length; i++) {
      const n = vNode[i] * 3, o = i * 3;
      posArr[o] = cur[n]; posArr[o + 1] = cur[n + 1]; posArr[o + 2] = cur[n + 2];
    }
    posAttr.needsUpdate = true;
  }

  const REST_K = 0.085;       // how hard the cloth is drawn back to its hang
  const DAMP = 0.90;
  let live = 0;               // seconds of solving left

  /** Push every node out of the ball's sphere: this is the bulge. */
  const BR = BALL_R + 0.028;
  function wrapBall(bx, by, bz) {
    let hit = false;
    for (let i = 0; i < N; i++) {
      if (pin[i]) continue;
      const o = i * 3;
      const dx = cur[o] - bx, dy = cur[o + 1] - by, dz = cur[o + 2] - bz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= BR * BR) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-5) { cur[o] += BR; hit = true; continue; }
      const k = BR / d;
      cur[o] = bx + dx * k; cur[o + 1] = by + dy * k; cur[o + 2] = bz + dz * k;
      hit = true;
    }
    return hit;
  }

  /** Local-space impulse: a struck shot throws the cord ahead of the ball. */
  function impulseLocal(px, py, pz, vx, vy, vz, strength = 1) {
    for (let i = 0; i < N; i++) {
      if (pin[i]) continue;
      const o = i * 3;
      const dx = cur[o] - px, dy = cur[o + 1] - py, dz = cur[o + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const falloff = Math.exp(-d2 * 1.25);
      if (falloff < 0.004) continue;
      const k = 0.0052 * strength * falloff;
      cur[o] += vx * k; cur[o + 1] += vy * k; cur[o + 2] += vz * k;
    }
    live = Math.max(live, 1.4);
  }

  // A struck net stretches; it does not turn into a balloon. Anything driving
  // the cloth every frame (the staged goal shot does exactly that) would
  // otherwise walk the pocket steadily deeper with nothing to stop it.
  const MAX_PULL = 0.42;
  function capPull() {
    for (let i = 0; i < N; i++) {
      if (pin[i]) continue;
      const o = i * 3;
      const dx = cur[o] - rest[o], dy = cur[o + 1] - rest[o + 1], dz = cur[o + 2] - rest[o + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= MAX_PULL * MAX_PULL) continue;
      const k = MAX_PULL / Math.sqrt(d2);
      cur[o] = rest[o] + dx * k;
      cur[o + 1] = rest[o + 1] + dy * k;
      cur[o + 2] = rest[o + 2] + dz * k;
    }
  }

  function integrate() {
    for (let i = 0; i < N; i++) {
      if (pin[i]) continue;
      const o = i * 3;
      for (let a = 0; a < 3; a++) {
        const c = cur[o + a];
        const v = (c - prev[o + a]) * DAMP;
        prev[o + a] = c;
        cur[o + a] = c + v + (rest[o + a] - c) * REST_K;
      }
    }
  }

  function snapRest() {
    cur.set(rest); prev.set(rest);
    writeOut();
  }

  // local-space ball scratch
  let bx = 0, by = 0, bz = 0, touching = false;

  function update(dt, ballPos, ballVel) {
    touching = false;
    if (ballPos) {
      const lx = side * (ballPos.x - gx);
      const lz = side * ballPos.z;
      if (lx > -BALL_R * 2.2 && lx < D_BOT + 0.6
        && Math.abs(lz) < HW + 0.5 && ballPos.y < GOAL_H + 0.5) {
        bx = lx; by = ballPos.y; bz = lz;
        touching = true;
        live = Math.max(live, 0.9);
        if (ballVel) {
          const sp = Math.abs(ballVel.x) + Math.abs(ballVel.z);
          if (sp > 6) live = Math.max(live, 1.6);
        }
      }
    }
    if (live <= 0) return;
    live -= dt;

    const steps = 2;
    for (let s = 0; s < steps; s++) {
      integrate();
      capPull();
      L.solve(cur, 3);
      // collide LAST so the cord finishes the step draped on the ball rather
      // than yanked back through it by the constraint pass
      if (touching) { wrapBall(bx, by, bz); L.solve(cur, 1); wrapBall(bx, by, bz); }
    }
    writeOut();
    if (live <= 0) snapRest();
  }

  /** Does a point sit inside the goal mouth (i.e. is it a goal)? */
  function contains(x, y, z) {
    if (Math.abs(z) > HW - BALL_R * 0.4) return false;
    if (y > GOAL_H - BALL_R * 0.4) return false;
    return side > 0 ? x > HALF_W + BALL_R * 0.35 : x < -HALF_W - BALL_R * 0.35;
  }

  return {
    group, side, frame, net, back: net,
    posts: [
      { x: gx, z: -HW, r: POST_R },
      { x: gx, z: HW, r: POST_R },
    ],
    crossbarY: GOAL_H,
    backX: gx + side * D_BOT,
    /**
     * Depth (metres behind the goal line) of the sloping back sheet at height y.
     * The sim must call this instead of approximating the slope, so the net
     * response tracks the real geometry if the profile ever changes.
     */
    sheetDepthAt(y) {
      return depAt(1 - clampNum(y / GOAL_H, 0, 1));
    },
    depthTop: D_TOP,
    depthBottom: D_BOT,
    contains,
    impulse: (p, v, s = 1) => impulseLocal(
      side * (p.x - gx), p.y, side * p.z,
      side * v.x, v.y, side * v.z, s,
    ),
    update,
    reset() { live = 0; snapRest(); },
    dispose() { for (const d of disposables) if (d && d.dispose) d.dispose(); },
  };
}
