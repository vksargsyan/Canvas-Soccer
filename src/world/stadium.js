// Everything around the pitch: apron, perimeter ad boards, stands, instanced crowd,
// roof, floodlights, jumbotron and set dressing.
//
//   createStadium(opts) -> { group, setScore(a, b, clock), update(dt), dispose() }
//
// Crowd budget: the front tiers are real instanced chibi geometry (two
// InstancedMeshes per stand: bodies + heads), the deep tier is a tiled crowd-wall
// texture. That keeps a "full house" look inside a handful of draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/rng.js';
import {
  boardTexture, concreteTexture, crowdWallTexture, jumbotronTexture,
} from '../core/assets.js';
import {
  HALF_W, HALF_D, APRON_X, APRON_Z, BOARD_X, BOARD_Z,
  STAND_X, STAND_Z, STAND_DEPTH, STAND_H, TEAMS,
} from '../core/constants.js';

const srng = makeRng(0xb0a7);

const CROWD_SHIRTS = [
  0xd8262c, 0x2450c8, 0xffffff, 0xf5d020, 0x22a05a, 0xeb6d1f,
  0x7c3ec9, 0x1b2a4a, 0x28b8c8, 0xe8e8e8, 0xb21f2a, 0x17357f,
];
const CROWD_SKINS = [0xffd9b3, 0xf2c39a, 0xe0a878, 0xc98a52, 0xa66b39, 0x7a4a26, 0x53301a];

// Roof geometry. ROOF_Y must clear the broadcast camera (y 27) and ROOF_IN keeps
// the roof's inner edge far enough back that a steep wide camera looks over it.
const ROOF_Y = 31;
const ROOF_IN = 2.5;

// Local stand frame: +X runs along the stand, +Z points away from the pitch.
const SIDES = [
  { key: 'N', yaw: Math.PI, near: STAND_Z, len: STAND_X * 2 + 14 },
  { key: 'S', yaw: 0, near: STAND_Z, len: STAND_X * 2 + 14 },
  { key: 'E', yaw: Math.PI / 2, near: STAND_X, len: STAND_Z * 2 + 14 },
  { key: 'W', yaw: -Math.PI / 2, near: STAND_X, len: STAND_Z * 2 + 14 },
];

export function createStadium() {
  const group = new THREE.Group();
  group.name = 'stadium';
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  const repeated = (t, rx, ry) => {
    const c = t.clone(); c.needsUpdate = true;
    c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(rx, ry);
    return track(c);
  };

  const concrete = concreteTexture();
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  // ------------------------------------------------------------------ apron
  {
    // Deliberately much larger than the stadium footprint: the `wide` camera looks
    // past the stands, and without ground out there the frame fills with bare sky.
    const apron = new THREE.Mesh(
      track(new THREE.PlaneGeometry(300, 280)),
      track(new THREE.MeshLambertMaterial({
        map: repeated(concrete, 30, 28), color: 0x7c8582,
      })),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.06;
    // No shadow receive: it is a full-screen-fill surface outside the shadow
    // frustum, and the per-pixel lookup costs more than it shows.
    apron.receiveShadow = false;
    group.add(apron);
  }

  // Grass verge ring between the pitch and the boards.
  {
    const shape = new THREE.Shape();
    shape.moveTo(-APRON_X, -APRON_Z);
    shape.lineTo(APRON_X, -APRON_Z);
    shape.lineTo(APRON_X, APRON_Z);
    shape.lineTo(-APRON_X, APRON_Z);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-HALF_W, -HALF_D);
    hole.lineTo(-HALF_W, HALF_D);
    hole.lineTo(HALF_W, HALF_D);
    hole.lineTo(HALF_W, -HALF_D);
    hole.closePath();
    shape.holes.push(hole);
    const geo = track(new THREE.ShapeGeometry(shape));
    geo.rotateX(-Math.PI / 2);
    const verge = new THREE.Mesh(geo, track(new THREE.MeshStandardMaterial({
      color: 0x4d9130, roughness: 0.99,
    })));
    verge.position.y = -0.02;
    verge.receiveShadow = true;
    group.add(verge);
  }

  // ------------------------------------------------------------- ad boards
  const adTex = boardTexture('MINI SOCCER');
  const boardBodyMat = track(new THREE.MeshStandardMaterial({ color: 0x0a3f8a, roughness: 0.62 }));

  function adBoard(len, x, z, yaw, rep) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    group.add(g);

    const body = new THREE.Mesh(track(new THREE.BoxGeometry(len, 1.45, 0.36)), boardBodyMat);
    body.position.y = 0.72;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);

    const face = new THREE.Mesh(
      track(new THREE.PlaneGeometry(len, 1.45)),
      track(new THREE.MeshStandardMaterial({
        map: repeated(adTex, rep, 1), roughness: 0.5, metalness: 0.06,
      })),
    );
    face.position.set(0, 0.72, 0.19);
    g.add(face);
    return g;
  }
  // +Z of each board group must point at the pitch.
  adBoard(BOARD_X * 2 + 2, 0, -BOARD_Z, 0, 12);
  adBoard(BOARD_X * 2 + 2, 0, BOARD_Z, Math.PI, 12);
  adBoard(BOARD_Z * 2 + 2, -BOARD_X, 0, Math.PI / 2, 9);
  adBoard(BOARD_Z * 2 + 2, BOARD_X, 0, -Math.PI / 2, 9);

  // ------------------------------------------------------------------ stands
  const concreteMat = track(new THREE.MeshStandardMaterial({
    map: repeated(concrete, 14, 4), color: 0xb7bec1, roughness: 0.95,
  }));
  const deckMat = track(new THREE.MeshStandardMaterial({
    color: 0x2b3542, roughness: 0.96, side: THREE.DoubleSide,
  }));
  const roofMat = track(new THREE.MeshStandardMaterial({
    color: 0x59636e, roughness: 0.66, metalness: 0.24, side: THREE.DoubleSide,
  }));
  const stairMat = track(new THREE.MeshStandardMaterial({
    color: 0xd6dade, roughness: 0.9, side: THREE.DoubleSide,
  }));

  const bodyGeo = track((() => {
    const g = new THREE.CylinderGeometry(0.30, 0.37, 0.64, 6, 1);
    g.translate(0, 0.32, 0);
    return g;
  })());
  const headGeo = track((() => {
    const g = new THREE.IcosahedronGeometry(0.31, 0);
    g.translate(0, 0.97, 0);
    return g;
  })());
  const crowdBodyMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const crowdHeadMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));

  const crowdSets = [];

  for (const S of SIDES) {
    const g = new THREE.Group();
    g.rotation.y = S.yaw;
    group.add(g);

    const len = S.len;
    const near = S.near;
    const deckLen = STAND_DEPTH;
    const rise = STAND_H - 2.0;
    const slopeLen = Math.hypot(deckLen, rise);
    const A = Math.atan2(rise, deckLen);

    // front wall
    const wall = new THREE.Mesh(track(new THREE.BoxGeometry(len, 2.0, 0.7)), concreteMat);
    wall.position.set(0, 1.0, near);
    wall.receiveShadow = true; wall.castShadow = true;
    g.add(wall);

    // sloped seating deck
    const deck = new THREE.Mesh(track(new THREE.PlaneGeometry(len, slopeLen)), deckMat);
    deck.rotation.x = Math.PI / 2 - A;
    deck.position.set(0, 2.0 + rise / 2, near + deckLen / 2);
    g.add(deck);

    // stair strips (merged into a single mesh — one draw per stand)
    {
      const stairs = Math.max(3, Math.round(len / 15));
      const parts = [];
      for (let i = 0; i < stairs; i++) {
        const p = new THREE.PlaneGeometry(1.15, slopeLen);
        p.rotateX(Math.PI / 2 - A);
        p.translate(-len / 2 + (i + 0.5) * (len / stairs), 2.0 + rise / 2 + 0.05, near + deckLen / 2 + 0.03);
        parts.push(p);
      }
      const merged = track(mergeGeometries(parts, false));
      parts.forEach((p) => p.dispose());
      g.add(new THREE.Mesh(merged, stairMat));
    }

    // deep crowd wall (tiled sprite texture)
    const wallH = 8.0;
    const cw = new THREE.Mesh(
      track(new THREE.PlaneGeometry(len, wallH)),
      track(new THREE.MeshBasicMaterial({
        map: repeated(crowdWallTexture(), Math.max(4, Math.round(len / 6.5)), 2.2),
        side: THREE.DoubleSide, fog: true,
      })),
    );
    cw.rotation.x = -0.34;
    cw.position.set(0, STAND_H + wallH * 0.34, near + deckLen + 1.0);
    g.add(cw);

    // back wall behind the deep tier
    const back = new THREE.Mesh(track(new THREE.BoxGeometry(len, ROOF_Y + 2, 1.0)), concreteMat);
    back.position.set(0, (ROOF_Y + 2) / 2, near + deckLen + 6.4);
    g.add(back);

    // Roof. Its inner edge must stay OUTSIDE the sight line of the broadcast and
    // wide cameras, otherwise it silently eats the whole frame — hence ROOF_IN.
    const roofDepth = 18;
    const roof = new THREE.Mesh(track(new THREE.PlaneGeometry(len, roofDepth)), roofMat);
    roof.rotation.x = Math.PI / 2 - 0.14;
    roof.position.set(0, ROOF_Y, near + ROOF_IN + roofDepth / 2);
    roof.castShadow = false;
    g.add(roof);

    // roof trusses (merged — one draw per stand)
    {
      const trusses = Math.max(3, Math.round(len / 18));
      const parts = [];
      for (let i = 0; i < trusses; i++) {
        const p = new THREE.BoxGeometry(0.55, 0.55, roofDepth + 2);
        p.rotateX(-0.14);
        p.translate(-len / 2 + (i + 0.5) * (len / trusses), ROOF_Y - 0.5, near + ROOF_IN + roofDepth / 2);
        parts.push(p);
      }
      const merged = track(mergeGeometries(parts, false));
      parts.forEach((p) => p.dispose());
      g.add(new THREE.Mesh(merged, concreteMat));
    }

    // instanced spectators on the deck
    const rows = 8;
    const perRow = Math.max(10, Math.round(len / 1.25));
    const total = rows * perRow;
    const bodies = new THREE.InstancedMesh(bodyGeo, crowdBodyMat, total);
    const heads = new THREE.InstancedMesh(headGeo, crowdHeadMat, total);
    bodies.frustumCulled = false; heads.frustumCulled = false;

    let n = 0;
    const phases = new Float32Array(total);
    const baseY = new Float32Array(total);
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const dz = near + 1.1 + t * (deckLen - 2.2);
      const dy = 2.05 + t * rise * 0.97;
      for (let i = 0; i < perRow; i++) {
        const x = -len / 2 + (i + 0.5 + (r % 2) * 0.4) * (len / perRow) + srng.range(-0.1, 0.1);
        const s = srng.range(0.85, 1.05);
        dummy.position.set(x, dy, dz);
        dummy.rotation.set(0, srng.range(-0.3, 0.3), 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        bodies.setMatrixAt(n, dummy.matrix);
        heads.setMatrixAt(n, dummy.matrix);
        bodies.setColorAt(n, col.setHex(srng.pick(CROWD_SHIRTS)).convertSRGBToLinear());
        heads.setColorAt(n, col.setHex(srng.pick(CROWD_SKINS)).convertSRGBToLinear());
        phases[n] = srng.range(0, Math.PI * 2);
        baseY[n] = dy;
        n++;
      }
    }
    bodies.count = n; heads.count = n;
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
    g.add(bodies, heads);
    disposables.push(bodies, heads);
    crowdSets.push({ bodies, heads, phases, baseY, count: n });
  }

  // -------------------------------------------------------------- floodlights
  const lampMat = track(new THREE.MeshStandardMaterial({
    color: 0xfffbee, emissive: 0xfff0c8, emissiveIntensity: 3.2, roughness: 0.35, toneMapped: true,
  }));
  const pylonMat = track(new THREE.MeshStandardMaterial({ color: 0x8b9399, roughness: 0.65, metalness: 0.45 }));

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * (STAND_X + STAND_DEPTH + 8);
      const pz = sz * (STAND_Z + STAND_DEPTH + 8);
      const mast = new THREE.Mesh(track(new THREE.CylinderGeometry(0.6, 1.2, 46, 8)), pylonMat);
      mast.position.set(px, 23, pz);
      mast.castShadow = true;
      group.add(mast);

      const rig = new THREE.Group();
      rig.position.set(px, 46.5, pz);
      rig.lookAt(0, 3, 0);
      group.add(rig);

      rig.add(new THREE.Mesh(track(new THREE.BoxGeometry(8.4, 3.8, 0.55)), pylonMat));

      const lamps = new THREE.InstancedMesh(track(new THREE.BoxGeometry(1.24, 0.98, 0.3)), lampMat, 12);
      for (let i = 0; i < 12; i++) {
        dummy.position.set(-3.1 + (i % 6) * 1.24, i < 6 ? 0.8 : -0.8, 0.36);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        lamps.setMatrixAt(i, dummy.matrix);
      }
      lamps.instanceMatrix.needsUpdate = true;
      rig.add(lamps);
      disposables.push(lamps);
    }
  }

  // ---------------------------------------------------------------- jumbotron
  const jumboTex = jumbotronTexture();
  {
    const holder = new THREE.Group();
    holder.position.set(0, 22.5, -(STAND_Z + 9));
    holder.rotation.x = 0.20;
    group.add(holder);
    holder.add(new THREE.Mesh(
      track(new THREE.BoxGeometry(22, 11.5, 1.6)),
      track(new THREE.MeshStandardMaterial({ color: 0x171c23, roughness: 0.8 })),
    ));
    const screen = new THREE.Mesh(
      track(new THREE.PlaneGeometry(20.4, 10.1)),
      track(new THREE.MeshBasicMaterial({ map: jumboTex, toneMapped: false })),
    );
    screen.position.z = 0.82;
    holder.add(screen);
  }

  // -------------------------------------------------------------- set dressing
  const poleMat = track(new THREE.MeshStandardMaterial({ color: 0xf3f3f3, roughness: 0.55 }));
  const flagMat = track(new THREE.MeshStandardMaterial({
    color: 0xf5d020, roughness: 0.85, side: THREE.DoubleSide,
  }));
  const flags = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(track(new THREE.CylinderGeometry(0.05, 0.05, 1.7, 6)), poleMat);
      pole.position.set(sx * HALF_W, 0.85, sz * HALF_D);
      pole.castShadow = true;
      group.add(pole);
      const holder = new THREE.Group();
      holder.position.set(sx * HALF_W, 1.5, sz * HALF_D);
      group.add(holder);
      const flag = new THREE.Mesh(track(new THREE.PlaneGeometry(0.62, 0.4)), flagMat);
      flag.position.x = -sx * 0.31;
      holder.add(flag);
      flags.push(holder);
    }
  }

  const propMat = track(new THREE.MeshStandardMaterial({ color: 0xe6edf0, roughness: 0.45 }));
  const darkProp = track(new THREE.MeshStandardMaterial({ color: 0x20242a, roughness: 0.7 }));
  // bottles: one merged mesh per goal side
  for (const sx of [-1, 1]) {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const b = new THREE.CylinderGeometry(0.1, 0.1, 0.34, 6);
      b.translate(sx * (HALF_W + 1.6), 0.17, 6.2 + i * 0.34);
      parts.push(b);
    }
    const merged = track(mergeGeometries(parts, false));
    parts.forEach((p) => p.dispose());
    const m = new THREE.Mesh(merged, propMat);
    m.castShadow = true;
    group.add(m);
  }

  // broadcast tripods: legs merged, one camera box each
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const parts = [];
      for (let l = 0; l < 3; l++) {
        const leg = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 5);
        const a = (l / 3) * Math.PI * 2;
        leg.rotateZ(-Math.cos(a) * 0.22);
        leg.rotateX(Math.sin(a) * 0.22);
        leg.translate(Math.cos(a) * 0.2, 0.78, Math.sin(a) * 0.2);
        parts.push(leg);
      }
      const cam = new THREE.BoxGeometry(0.54, 0.34, 0.76);
      cam.rotateY(-sx * 0.7);
      cam.translate(0, 1.7, 0);
      parts.push(cam);
      const merged = track(mergeGeometries(parts, false));
      parts.forEach((p) => p.dispose());
      const tri = new THREE.Mesh(merged, darkProp);
      tri.position.set(sx * (HALF_W + 3.4), 0, sz * (HALF_D - 3.5));
      tri.castShadow = true;
      group.add(tri);
    }
  }

  // ------------------------------------------------------------------ update
  let t = 0;
  let excite = 0;
  const m4 = new THREE.Matrix4();
  const v3 = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();

  function update(dt) {
    t += dt;
    excite = Math.max(0, excite - dt * 0.55);
    for (const f of flags) f.rotation.z = Math.sin(t * 2.3 + f.position.x) * 0.16;

    // Crowd bob. Cheap enough at this instance count and only when excited.
    if (excite > 0.02) {
      for (const set of crowdSets) {
        for (let i = 0; i < set.count; i++) {
          set.bodies.getMatrixAt(i, m4);
          m4.decompose(v3, q, sc);
          v3.y = set.baseY[i] + Math.max(0, Math.sin(t * 7 + set.phases[i])) * 0.42 * excite;
          m4.compose(v3, q, sc);
          set.bodies.setMatrixAt(i, m4);
          set.heads.setMatrixAt(i, m4);
        }
        set.bodies.instanceMatrix.needsUpdate = true;
        set.heads.instanceMatrix.needsUpdate = true;
      }
    }
  }

  function setScore(a, b, clock) {
    if (jumboTex.userData.draw) {
      jumboTex.userData.draw(a, b, clock || '0:00', TEAMS[0].short, TEAMS[1].short);
    }
  }

  setScore(0, 0, '3:00');

  return {
    group, update, setScore,
    celebrate() { excite = 1; },
    dispose() { for (const d of disposables) if (d && d.dispose) d.dispose(); },
  };
}
