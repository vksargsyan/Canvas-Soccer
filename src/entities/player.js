// Chibi player rig.
//
//   createPlayer(cfg) -> { group, rig, config, setSelected(b), dispose() }
//     cfg: { team, number, skin, hair, hairColor, kit, isKeeper, faceVariant }
//
// Proportions (total height 2.0 world units):
//   feet 0.00 → knee 0.34 → hip 0.64 → shoulder 1.16 → head bone 1.20
//   head sphere r 0.42 centred at 1.61 → crown 2.03.  Head ≈ 42 % of total height.
//
// The rig exposes named bones (plain Object3D): root, hips, torso, head,
// armL/R, forearmL/R, thighL/R, shinL/R, footL/R. animation.js drives only these.
//
// Draw-call discipline: head + hair are one mesh (vertex colours pick hair colour,
// hair UVs point at a solid white strip of the face texture), hand is merged into
// the forearm, sock into the shin. 13 meshes per player.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  faceTexture, kitTexture, softCircle, SKIN_TONES, HAIR_COLORS, HAIR_STYLES,
} from '../core/assets.js';
import { TEAMS } from '../core/constants.js';

export const HEAD_R = 0.42;
const HIP_Y = 0.64;
const THIGH_L = 0.30;
const SHIN_L = 0.28;
const TORSO_H = 0.52;
const HEAD_BONE_Y = 0.56;      // relative to torso bone
const HEAD_CENTER = 0.41;      // relative to head bone

const matCache = new Map();
function sharedMat(key, make) {
  if (!matCache.has(key)) matCache.set(key, make());
  return matCache.get(key);
}

function skinMaterial(skin) {
  return sharedMat('skin:' + skin, () => new THREE.MeshStandardMaterial({
    color: skin, roughness: 0.78, metalness: 0.0,
  }));
}
function flatMaterial(color, rough = 0.72) {
  return sharedMat(`flat:${color}:${rough}`, () => new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: 0.0,
  }));
}
function headMaterial(skin, variant) {
  return sharedMat(`head:${skin}:${variant}`, () => new THREE.MeshStandardMaterial({
    map: faceTexture(skin, variant), vertexColors: true, roughness: 0.74, metalness: 0.0,
  }));
}
function torsoMaterial(kit, trim, number, style) {
  return sharedMat(`torso:${kit}:${trim}:${number}:${style}`, () => new THREE.MeshStandardMaterial({
    map: kitTexture(kit, trim, number, style), roughness: 0.72, metalness: 0.0,
  }));
}

// --------------------------------------------------------------------------
// geometry helpers
// --------------------------------------------------------------------------

/** paint a constant colour into a geometry's colour attribute */
function tint(geo, hexColor) {
  const c = new THREE.Color(hexColor).convertSRGBToLinear();
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

/** push every UV into the reserved solid-white strip at the top of the face texture */
function blankUv(geo) {
  const uv = geo.getAttribute('uv');
  if (!uv) {
    const n = geo.getAttribute('position').count;
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2).fill(0.5), 2));
  }
  const u2 = geo.getAttribute('uv');
  for (let i = 0; i < u2.count; i++) u2.setXY(i, 0.5, 0.985);
  u2.needsUpdate = true;
  return geo;
}

function capsule(r, len, seg = 8) {
  const g = new THREE.CapsuleGeometry(r, len, 2, seg);
  return g;
}

// --------------------------------------------------------------------------
// hair styles — returned already positioned relative to the head bone
// --------------------------------------------------------------------------

function buildHair(style, headR) {
  const parts = [];
  const add = (g, x, y, z, sx = 1, sy = 1, sz = 1) => {
    g.scale(sx, sy, sz); g.translate(x, y + HEAD_CENTER, z); parts.push(g);
  };
  // The hairline must stay above the eyes, which the face texture paints at
  // v = 0.515 (theta ~ 87 deg). A cap of 0.40*PI stops at 72 deg — a forehead.
  const CUT = Math.PI * 0.40;
  const cap = (rScale, cut = CUT) => new THREE.SphereGeometry(
    headR * rScale, 16, 12, 0, Math.PI * 2, 0, cut,
  );
  // A back flap so the head isn't bald from behind. On a SphereGeometry the face
  // (+Z) sits at phi = 0.5*PI and the back of the head at phi = 1.5*PI, so the
  // flap is centred on 1.5*PI — not on PI, which is the player's left ear.
  const flap = (rScale) => new THREE.SphereGeometry(
    headR * rScale, 14, 10, Math.PI * 1.12, Math.PI * 0.76, 0, Math.PI * 0.62,
  );

  switch (style) {
    case 'bald':
      break;
    case 'buzz':
      add(cap(1.03), 0, 0, 0);
      add(flap(1.02), 0, 0, 0);
      break;
    case 'bun':
      add(cap(1.04), 0, 0, 0);
      add(flap(1.03), 0, 0, 0);
      add(new THREE.SphereGeometry(headR * 0.34, 10, 8), 0, headR * 0.80, -headR * 0.74);
      break;
    case 'afro':
      add(new THREE.SphereGeometry(headR * 1.20, 14, 11), 0, headR * 0.34, -headR * 0.10, 1, 0.92, 1);
      break;
    case 'curls': {
      add(cap(1.03), 0, 0, 0);
      add(flap(1.04), 0, 0, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add(new THREE.SphereGeometry(headR * 0.29, 8, 6),
          Math.cos(a) * headR * 0.74, headR * 0.56, Math.sin(a) * headR * 0.74 - headR * 0.10);
      }
      break;
    }
    case 'swoop':
      add(cap(1.04), 0, 0, 0);
      add(flap(1.03), 0, 0, 0);
      add(new THREE.SphereGeometry(headR * 0.40, 10, 8), headR * 0.34, headR * 0.62, headR * 0.60, 1.6, 0.55, 0.85);
      break;
    case 'mohawk': {
      // shaved sides read as bald without a thin cap under the crest
      add(new THREE.SphereGeometry(headR * 1.015, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.34), 0, 0, 0);
      add(flap(1.00), 0, 0, 0);
      // a crest running front-to-back over the crown, not across the face
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        const z = (t - 0.5) * headR * 1.5;
        const y = headR * (0.92 - Math.pow(t - 0.5, 2) * 1.3);
        add(new THREE.BoxGeometry(headR * 0.20, headR * 0.42, headR * 0.24), 0, y, z);
      }
      break;
    }
    default:
      add(cap(1.03), 0, 0, 0);
      add(flap(1.02), 0, 0, 0);
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts.map(blankUv), false);
  parts.forEach((p) => p.dispose());
  return merged;
}

function buildBeard(headR) {
  const g = new THREE.SphereGeometry(headR * 0.92, 14, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45);
  g.scale(1, 1.05, 1.06);
  g.translate(0, HEAD_CENTER - headR * 0.06, headR * 0.06);
  return blankUv(g);
}

// --------------------------------------------------------------------------

let uid = 0;

export function createPlayer(cfg = {}) {
  const team = TEAMS[cfg.team ?? 0];
  const isKeeper = !!cfg.isKeeper;
  const number = cfg.number ?? 9;
  const skin = cfg.skin ?? SKIN_TONES[2];
  const hairColor = cfg.hairColor ?? HAIR_COLORS[0];
  const hairStyle = cfg.hair ?? HAIR_STYLES[0];
  const faceVariant = cfg.faceVariant ?? 0;
  const beard = !!cfg.beard;
  const kitStyle = cfg.kitStyle ?? 'plain';

  const kitColor = isKeeper ? team.keeper : team.kit;
  const shortsColor = isKeeper ? team.keeperShorts : team.shorts;
  const sockColor = isKeeper ? team.keeper : team.socks;
  const trimColor = team.trim;

  const group = new THREE.Group();
  group.name = `player-${team.name}-${number}`;
  group.userData.id = uid++;

  const root = new THREE.Object3D(); root.name = 'root';
  group.add(root);

  const hips = new THREE.Object3D(); hips.name = 'hips';
  hips.position.y = HIP_Y;
  root.add(hips);

  const torso = new THREE.Object3D(); torso.name = 'torso';
  hips.add(torso);

  const head = new THREE.Object3D(); head.name = 'head';
  head.position.y = HEAD_BONE_Y;
  torso.add(head);

  const meshes = [];
  const addMesh = (parent, geo, mat, cast = false) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = false;
    parent.add(m);
    meshes.push(m);
    return m;
  };

  // ---- shorts (hips) ------------------------------------------------------
  const shortsGeo = new THREE.CylinderGeometry(0.285, 0.345, 0.32, 14, 1);
  shortsGeo.scale(1, 1, 0.84);
  shortsGeo.translate(0, -0.11, 0);
  addMesh(hips, shortsGeo, flatMaterial(shortsColor, 0.78));

  // ---- torso --------------------------------------------------------------
  const torsoGeo = new THREE.CylinderGeometry(0.335, 0.335, TORSO_H, 16, 1, false);
  torsoGeo.scale(1, 1, 0.78);
  torsoGeo.translate(0, TORSO_H / 2 - 0.02, 0);
  const torsoMesh = addMesh(torso, torsoGeo, torsoMaterial(kitColor, trimColor, number, kitStyle), true);

  // ---- head + hair (one mesh, vertex colours) -----------------------------
  const headParts = [];

  // short neck so the head does not float off the collar
  const neck = new THREE.CylinderGeometry(0.135, 0.16, 0.14, 10);
  neck.translate(0, -0.05, 0);
  headParts.push(tint(blankUv(neck), skin));

  const headGeo = new THREE.SphereGeometry(HEAD_R, 22, 16);
  headGeo.scale(1, 1.02, 0.96);
  headGeo.translate(0, HEAD_CENTER, 0);
  headParts.push(tint(headGeo, 0xffffff));

  // little nose bump
  const nose = new THREE.SphereGeometry(HEAD_R * 0.155, 8, 6);
  nose.scale(0.85, 0.9, 1.3);
  nose.translate(0, HEAD_CENTER - HEAD_R * 0.10, HEAD_R * 0.92);
  headParts.push(tint(blankUv(nose), skin));

  // ears
  for (const s of [-1, 1]) {
    const ear = new THREE.SphereGeometry(HEAD_R * 0.19, 8, 6);
    ear.scale(0.55, 1, 0.85);
    ear.translate(s * HEAD_R * 0.96, HEAD_CENTER - HEAD_R * 0.04, 0);
    headParts.push(tint(blankUv(ear), skin));
  }

  const hairGeo = buildHair(hairStyle, HEAD_R);
  if (hairGeo) headParts.push(tint(hairGeo, hairColor));
  if (beard) headParts.push(tint(buildBeard(HEAD_R), hairColor));

  const headMerged = mergeGeometries(headParts, false);
  headParts.forEach((p) => p.dispose());
  addMesh(head, headMerged, headMaterial(skin, faceVariant), true);

  // ---- arms ---------------------------------------------------------------
  const skinMat = skinMaterial(skin);
  const sleeveMat = flatMaterial(kitColor, 0.72);
  const bones = {};

  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const arm = new THREE.Object3D();
    arm.name = 'arm' + side;
    arm.position.set(s * 0.345, TORSO_H - 0.11, 0);
    torso.add(arm);
    bones['arm' + side] = arm;

    const up = capsule(0.098, 0.15, 8);
    up.translate(0, -0.115, 0);
    addMesh(arm, up, sleeveMat);

    const fore = new THREE.Object3D();
    fore.name = 'forearm' + side;
    fore.position.y = -0.23;
    arm.add(fore);
    bones['forearm' + side] = fore;

    const foreGeo = capsule(0.090, 0.14, 8);
    foreGeo.translate(0, -0.11, 0);
    const hand = new THREE.SphereGeometry(isKeeper ? 0.13 : 0.112, 8, 6);
    hand.translate(0, -0.225, 0);
    const foreMerged = mergeGeometries([foreGeo, hand], false);
    foreGeo.dispose(); hand.dispose();
    addMesh(fore, foreMerged, isKeeper ? flatMaterial(team.keeper, 0.6) : skinMat);
  }

  // ---- legs ---------------------------------------------------------------
  const sockMat = flatMaterial(sockColor, 0.8);
  const bootMat = flatMaterial(cfg.bootColor ?? 0xf5f7f9, 0.42);

  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const thigh = new THREE.Object3D();
    thigh.name = 'thigh' + side;
    thigh.position.set(s * 0.155, -0.02, 0);
    hips.add(thigh);
    bones['thigh' + side] = thigh;

    const thighGeo = capsule(0.132, THIGH_L - 0.15, 8);
    thighGeo.translate(0, -THIGH_L / 2, 0);
    addMesh(thigh, thighGeo, skinMat, true);

    const shin = new THREE.Object3D();
    shin.name = 'shin' + side;
    shin.position.y = -THIGH_L;
    thigh.add(shin);
    bones['shin' + side] = shin;

    const shinGeo = capsule(0.118, SHIN_L - 0.12, 8);
    shinGeo.translate(0, -SHIN_L / 2, 0);
    addMesh(shin, shinGeo, sockMat, true);

    const foot = new THREE.Object3D();
    foot.name = 'foot' + side;
    foot.position.y = -SHIN_L;
    shin.add(foot);
    bones['foot' + side] = foot;

    const bootGeo = new THREE.BoxGeometry(0.215, 0.125, 0.36);
    bootGeo.translate(0, -0.05, 0.06);
    const bootTip = new THREE.SphereGeometry(0.108, 8, 6);
    bootTip.scale(1, 0.60, 1);
    bootTip.translate(0, -0.05, 0.18);
    const bootMerged = mergeGeometries([bootGeo, bootTip], false);
    bootGeo.dispose(); bootTip.dispose();
    addMesh(foot, bootMerged, bootMat);
  }

  // ---- selection ring + contact shadow ------------------------------------
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.52, 0.70, 28),
    new THREE.MeshBasicMaterial({
      color: 0x4dff72, transparent: true, opacity: 0.9,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.scale.set(1, 1, 0.62);
  ring.position.y = 0.03;
  ring.visible = false;
  ring.renderOrder = 4;
  group.add(ring);

  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({
      map: softCircle('rgba(0,0,0,0.5)'), transparent: true,
      depthWrite: false, opacity: 0.62,
    }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.012;
  blob.renderOrder = 3;
  group.add(blob);

  const rig = {
    root, hips, torso, head,
    armL: bones.armL, armR: bones.armR,
    forearmL: bones.forearmL, forearmR: bones.forearmR,
    thighL: bones.thighL, thighR: bones.thighR,
    shinL: bones.shinL, shinR: bones.shinR,
    footL: bones.footL, footR: bones.footR,
    group,
    torsoMesh,
  };

  const config = {
    team: team.id, teamData: team, number, skin, hair: hairStyle, hairColor,
    isKeeper, faceVariant, beard, kitStyle,
  };

  return {
    group, rig, config, meshes, ring, blob,
    setSelected(v) { ring.visible = !!v; },
    /** ground blob follows the hip so it stays under a diving keeper */
    syncShadow() {
      blob.position.x = 0;
      blob.position.z = 0;
      const lift = Math.max(0, root.position.y);
      const k = 1 / (1 + lift * 1.4);
      blob.scale.setScalar(0.55 + 0.45 * k);
      blob.material.opacity = 0.62 * k;
    },
    dispose() {
      group.traverse((o) => { if (o.isMesh && !matCache.has(o.material)) o.geometry.dispose(); });
      ring.geometry.dispose(); ring.material.dispose();
      blob.geometry.dispose(); blob.material.dispose();
    },
  };
}

/** Build a full squad deterministically from a seeded rng. */
export function createSquad(teamIndex, rng) {
  const squad = [];
  const numbers = [1, 4, 6, 8, 10, 11];
  const styles = ['plain', 'stripes', 'sash', 'hoops', 'plain', 'plain'];
  for (let i = 0; i < numbers.length; i++) {
    squad.push(createPlayer({
      team: teamIndex,
      number: numbers[i],
      isKeeper: i === 0,
      skin: rng.pick(SKIN_TONES),
      hair: rng.pick(HAIR_STYLES),
      hairColor: rng.pick(HAIR_COLORS),
      faceVariant: rng.int(6),
      beard: rng.chance(0.35),
      kitStyle: styles[teamIndex % 2 === 0 ? 0 : 1],
      bootColor: rng.pick([0xf5f7f9, 0x1b1e24, 0xf5d020, 0xff5aa0, 0x2fd06a]),
    }));
  }
  return squad;
}
