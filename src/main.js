// Wiring + fixed-timestep loop + the window.__debug harness API.
//
// Everything deterministic runs inside step(FIXED). render() only interpolates
// nothing — the sim rate and the display rate are decoupled by an accumulator.

import * as THREE from 'three';
import { rng, makeRng, SEED } from './core/rng.js';
import { createEngine } from './core/engine.js';
import { createPitch } from './world/pitch.js';
import { createStadium } from './world/stadium.js';
import { createGoal } from './world/goal.js';
import { createPlayer, createSquad } from './entities/player.js';
import { createAnimator } from './entities/animation.js';
import { createBall } from './entities/ball.js';
import { createBallBody, separatePlayers, ballPlayerContact } from './sim/physics.js';
import { createAI, FORMATION } from './sim/ai.js';
import { createMatch } from './sim/match.js';
import { createVfx } from './fx/vfx.js';
import { createDirector } from './fx/camera.js';
import { createAudio } from './audio/audio.js';
import { createHud } from './ui/hud.js';
import {
  HALF_W, HALF_D, BALL_R, PLAYER_R, TEAMS, RUN_SPEED, SPRINT_SPEED, ACCEL,
  GOAL_HALF_W,
} from './core/constants.js';

const FIXED = 1 / 60;
const MAX_FRAME = 0.25;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function boot({ canvas, hudRoot, splash } = {}) {
  canvas = canvas || document.querySelector('canvas');
  hudRoot = hudRoot || document.body;

  const engine = createEngine(canvas);
  const { scene, camera } = engine;

  // ---------------------------------------------------------------- world
  const pitch = createPitch();
  scene.add(pitch.group);

  const stadium = createStadium();
  scene.add(stadium.group);

  const goals = [createGoal(1), createGoal(-1)];
  for (const g of goals) scene.add(g.group);

  const vfx = createVfx(scene);
  vfx.setCamera(camera);

  const ballView = createBall({ style: 'classic' });
  scene.add(ballView.group);
  scene.add(ballView.shadow);
  scene.add(ballView.trail);

  const body = createBallBody({ x: 0, y: BALL_R, z: 0 });

  // ---------------------------------------------------------------- players
  const agents = [];
  const squadRng = makeRng(SEED + 77);
  const teamGroups = [new THREE.Group(), new THREE.Group()];
  scene.add(teamGroups[0], teamGroups[1]);

  for (let team = 0; team < 2; team++) {
    const squad = createSquad(team, squadRng);
    squad.forEach((view, slot) => {
      teamGroups[team].add(view.group);
      const f = FORMATION[slot];
      const dir = TEAMS[team].dir;
      const a = {
        id: agents.length,
        team, slot,
        role: f.role,
        isKeeper: slot === 0,
        pos: new THREE.Vector3(f.x * dir, 0, f.z),
        vel: new THREE.Vector3(),
        yaw: dir > 0 ? Math.PI / 2 : -Math.PI / 2,
        faceX: dir, faceZ: 0,
        down: false,
        control: 'ai',
        cool: 0,
        view,
        anim: createAnimator(view.rig),
      };
      a.anim.play(a.isKeeper ? 'keeperIdle' : 'idle', { force: true });
      agents.push(a);
    });
  }

  // ---------------------------------------------------------------- systems
  const hud = createHud(hudRoot);
  const audio = createAudio();
  const director = createDirector(camera);

  const events = {
    onBounce(speed, p) {
      if (speed > 4) vfx.dust({ x: p.x, y: 0.06, z: p.z }, { count: Math.min(10, Math.round(speed)) });
      if (speed > 6) audio.kick(0.4);
    },
    onPost(p, s) {
      vfx.burst({ x: p.x, y: p.y, z: p.z }, { count: 12, speed: 4, color: 0xffffff, flashSize: 2.0 });
      director.shake(0.35);
      audio.post();
    },
    onGoal(side) { match.scoreGoal(side); },
    onOut(kind, p) { match.restart(kind, p); },
    onShot(a, power) {
      vfx.swoosh({ x: a.pos.x, y: 0.6, z: a.pos.z },
        TEAMS[a.team].dir, (body.vel.z || 0) * 0.05, clamp(power / 24, 0.7, 1.4));
      vfx.scuff({ x: a.pos.x, y: 0, z: a.pos.z }, TEAMS[a.team].dir, 0, { count: 10 });
      director.shake(0.12);
      audio.kick(power / 22);
    },
    onPass(a) {
      vfx.scuff({ x: a.pos.x, y: 0, z: a.pos.z }, TEAMS[a.team].dir, 0, { count: 6 });
      audio.kick(0.6);
    },
    onTackle(a) {
      vfx.scuff({ x: a.pos.x, y: 0, z: a.pos.z }, a.vel.x, a.vel.z, { count: 18 });
      vfx.burst({ x: a.pos.x, y: 0.5, z: a.pos.z }, { count: 10, speed: 3.5, color: 0xffffff, flashSize: 2.6 });
      director.shake(0.3);
      audio.tackle();
      // knock over anyone very close
      for (const o of agents) {
        if (o.team === a.team || o.down) continue;
        if (Math.hypot(o.pos.x - a.pos.x, o.pos.z - a.pos.z) < 1.5) {
          o.down = true; o.downTimer = 1.5;
          o.anim.play('knocked', { force: true });
        }
      }
    },
    onKeeperDive() { audio.tackle(); },
    onPhase(p) {
      if (p === 'kickoff') { hud.banner('KICK OFF', '', 1.4); audio.whistle(1); }
      if (p === 'fulltime') {
        const s = match.state.score;
        hud.showMenu('end', 'FULL TIME', `${TEAMS[0].name} ${s[0]} — ${s[1]} ${TEAMS[1].name}`);
      }
    },
  };

  const ai = createAI({ agents, body, goals, rng, events });
  const match = createMatch({ agents, body, goals, ai, events: { ...events, onGoal: onGoalScored } });
  ai.match = match;

  function onGoalScored(scorer) {
    hud.banner('GOAL!', `${TEAMS[scorer].name} SCORES`, 3.0);
    vfx.goalBlast({ x: TEAMS[scorer].dir * (HALF_W - 2), y: 1.2, z: 0 });
    stadium.celebrate();
    director.cut('goal', { yaw: TEAMS[scorer].dir > 0 ? 2.5 : -2.5 });
    director.shake(0.7);
    audio.goal();
    hud.setScore(match.state.score[0], match.state.score[1]);
    stadium.setScore(match.state.score[0], match.state.score[1], match.clockText());
  }

  // Staged scenarios freeze the rules: a scripted shot must not actually score,
  // or the match phase flips to 'goal' and hijacks the banner and the camera.
  const world = {
    bounds: { halfW: HALF_W, halfD: HALF_D },
    goals,
    events: {
      ...events,
      onGoal: (side) => { if (scen.flags.rules) match.scoreGoal(side); },
      onOut: (kind, p) => { if (scen.flags.rules) match.restart(kind, p); },
    },
  };

  // ---------------------------------------------------------------- control
  let userAgent = null;
  function selectUser(a) {
    for (const x of agents) { x.control = 'ai'; x.view.setSelected(false); }
    if (a) { a.control = 'user'; a.view.setSelected(true); }
    userAgent = a;
  }
  function autoSelect() {
    let best = null, bd = 1e9;
    for (const a of agents) {
      if (a.team !== 0 || a.isKeeper || a.down) continue;
      const d = Math.hypot(body.pos.x - a.pos.x, body.pos.z - a.pos.z);
      if (d < bd) { bd = d; best = a; }
    }
    if (best && best !== userAgent) selectUser(best);
  }

  function driveUser(dt) {
    const a = userAgent;
    if (!a || a.down) return;
    const inp = hud.input;

    // screen space -> world space using the camera's yaw
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-5) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

    const mx = inp.move.x, my = inp.move.y;
    const mag = Math.hypot(mx, my);
    const speed = inp.sprint ? SPRINT_SPEED : RUN_SPEED;

    if (mag > 0.08) {
      const wx = right.x * mx + fwd.x * -my;
      const wz = right.z * mx + fwd.z * -my;
      const l = Math.hypot(wx, wz) || 1;
      const want = speed * Math.min(1, mag);
      a.vel.x += ((wx / l) * want - a.vel.x) * Math.min(1, ACCEL * dt / Math.max(1, want));
      a.vel.z += ((wz / l) * want - a.vel.z) * Math.min(1, ACCEL * dt / Math.max(1, want));
      if (!a.anim.busy) a.anim.play(inp.sprint ? 'sprint' : 'run');
    } else {
      a.vel.multiplyScalar(Math.max(0, 1 - 8 * dt));
      if (!a.anim.busy) a.anim.play('idle');
    }

    const pressed = inp.consume();
    const near = Math.hypot(body.pos.x - a.pos.x, body.pos.z - a.pos.z);

    if (pressed.switchPressed) { autoSelectNext(); }
    if (pressed.slide && a.cool <= 0) {
      a.cool = 1.2;
      a.anim.play('tackle', { force: true });
      events.onTackle(a);
    }

    // shoot on release of the charge
    if (!inp.shootHeld && a.shootWasHeld && near < PLAYER_R + BALL_R + 0.5) {
      const dir = new THREE.Vector3(TEAMS[a.team].dir, 0, 0);
      const gx = TEAMS[a.team].dir * HALF_W;
      dir.set(gx - a.pos.x, 0, clamp(-a.pos.z * 0.4, -3, 3));
      const power = 16 + a.shootCharge * 18;
      body.kick(dir, power, 2.4 + a.shootCharge * 3.6, 0);
      a.anim.play('kick', { force: true });
      events.onShot(a, power);
    }
    a.shootWasHeld = inp.shootHeld;
    a.shootCharge = inp.shootCharge;
    a.cool = Math.max(0, a.cool - dt);
  }

  function autoSelectNext() {
    const mates = agents.filter((x) => x.team === 0 && !x.isKeeper && !x.down);
    if (!mates.length) return;
    const i = mates.indexOf(userAgent);
    selectUser(mates[(i + 1) % mates.length]);
  }

  // ---------------------------------------------------------------- scenario
  const scen = {
    name: '',
    t: 0,
    flags: { ai: true, match: true, physics: true, autoSelect: true },
    beats: [],
    step: null,
  };

  function beat(t, fn) { scen.beats.push({ t, fn, done: false }); }

  function runBeats() {
    for (const b of scen.beats) {
      if (!b.done && scen.t >= b.t) { b.done = true; b.fn(); }
    }
  }

  function agentAt(team, slot) { return agents[team * 6 + slot]; }

  function place(a, x, z, fx = 0, fz = 1, state = 'idle') {
    a.pos.set(x, 0, z);
    a.vel.set(0, 0, 0);
    a.down = false;
    a.cool = 0;
    a.diving = false;
    a.faceX = fx; a.faceZ = fz;
    a.yaw = Math.atan2(fx, fz);
    a.view.group.rotation.y = a.yaw;
    a.anim.play(state, { force: true });
  }

  function baseReset() {
    rng.reseed(SEED);
    vfx.reset();
    for (const g of goals) g.reset();
    match.state.score[0] = 0; match.state.score[1] = 0;
    match.state.clock = 180;
    match.state.phase = 'play';
    match.formationReset(0);
    body.place(0, BALL_R, 0);
    ballView.reset(body.pos);
    hud.banner(null);
    hud.showMenu(null);
    hud.setScore(0, 0);
    hud.setClock(180);
    hud.setPossession(0);
    stadium.setScore(0, 0, '3:00');
    selectUser(null);
    scen.beats.length = 0;
    scen.step = null;
    scen.t = 0;
    scen.flags = { ai: false, match: false, physics: false, autoSelect: false, rules: false };
    for (const a of agents) {
      a.anim.play(a.isKeeper ? 'keeperIdle' : 'idle', { force: true });
      a.down = false;
    }
  }

  const SCENARIOS = {
    kickoff() {
      match.formationReset(0);
      // tighten the kickoff picture
      place(agentAt(0, 5), -1.4, 0.0, 1, 0, 'idle');
      place(agentAt(1, 5), 3.2, -1.6, -1, 0, 'idle');
      place(agentAt(0, 3), -9.0, -8.5, 1, 0, 'idle');
      place(agentAt(0, 4), -9.0, 8.5, 1, 0, 'idle');
      place(agentAt(1, 3), 9.0, -8.0, -1, 0, 'idle');
      place(agentAt(1, 4), 9.0, 8.0, -1, 0, 'idle');
      place(agentAt(0, 1), -18.0, -7.5, 1, 0, 'idle');
      place(agentAt(0, 2), -18.0, 7.5, 1, 0, 'idle');
      place(agentAt(1, 1), 18.0, -7.5, -1, 0, 'idle');
      place(agentAt(1, 2), 18.0, 7.5, -1, 0, 'idle');
      place(agentAt(0, 0), -27.5, 0, 1, 0, 'keeperIdle');
      place(agentAt(1, 0), 27.5, 0, -1, 0, 'keeperIdle');
      body.place(0, BALL_R, 0);
      ballView.reset(body.pos);
      selectUser(agentAt(0, 5));
      hud.banner('KICK OFF', 'RED TO START', 6);
      director.cut('broadcast', { side: 1 });
      director.place(0, 28, 38, 0, 1.0, 0);
    },

    attack() {
      const hero = agentAt(0, 5);
      place(hero, 11.0, -2.0, 1, 0.1, 'run');
      hero.vel.set(RUN_SPEED, 0, 0.6);
      place(agentAt(0, 4), 13.5, 8.4, 1, -0.2, 'run');
      agentAt(0, 4).vel.set(RUN_SPEED * 0.9, 0, -1.2);
      place(agentAt(0, 3), 4.0, -9.5, 1, 0, 'run');
      agentAt(0, 3).vel.set(RUN_SPEED * 0.8, 0, 0);
      place(agentAt(0, 1), -4.0, -6.0, 1, 0, 'run');
      place(agentAt(0, 2), -6.0, 6.5, 1, 0, 'idle');
      place(agentAt(0, 0), -26.0, 0, 1, 0, 'keeperIdle');

      place(agentAt(1, 1), 15.5, -4.6, -1, -0.35, 'sprint');
      agentAt(1, 1).vel.set(-SPRINT_SPEED * 0.8, 0, -2.0);
      place(agentAt(1, 2), 16.5, 2.2, -1, 0.4, 'sprint');
      agentAt(1, 2).vel.set(-SPRINT_SPEED * 0.75, 0, 2.4);
      place(agentAt(1, 3), 20.0, -8.0, -1, 0, 'run');
      place(agentAt(1, 4), 21.0, 7.0, -1, 0, 'run');
      place(agentAt(1, 5), 6.0, 3.0, -1, 0, 'run');
      place(agentAt(1, 0), 28.2, -0.6, -1, 0, 'keeperIdle');

      body.place(12.9, BALL_R, -1.6);
      body.vel.set(6.5, 0, 0.4);
      ballView.reset(body.pos);
      selectUser(hero);
      hud.setPossession(0);
      director.cut('follow', { side: 1 });
      director.place(9, 15.5, 20.5, 12, 1.2, -1.5);

      scen.step = (dt) => {
        hero.pos.x = 11.0; hero.pos.z = -2.0;
        body.place(12.9, BALL_R, -1.6);
      };
      const kick = (dx, dz, n) => vfx.scuff(
        { x: hero.pos.x + dx, y: 0, z: hero.pos.z + dz }, 1, 0.15, { count: n },
      );
      beat(0.60, () => kick(-0.5, 0.2, 12));
      beat(1.10, () => kick(-0.6, -0.15, 12));
      beat(1.55, () => kick(-0.5, 0.25, 14));
      beat(1.86, () => { kick(-0.55, -0.1, 16); vfx.dust({ x: hero.pos.x - 0.7, z: hero.pos.z }, { count: 9 }); });
    },

    shot() {
      const hero = agentAt(0, 5);
      place(hero, 13.5, -2.4, 1, 0, 'idle');
      place(agentAt(0, 4), 16.0, 7.0, 1, 0, 'run');
      place(agentAt(0, 3), 7.0, -8.0, 1, 0, 'run');
      place(agentAt(0, 1), -2.0, -6.0, 1, 0, 'run');
      place(agentAt(0, 2), -4.0, 6.0, 1, 0, 'idle');
      place(agentAt(0, 0), -26.0, 0, 1, 0, 'keeperIdle');
      place(agentAt(1, 1), 17.8, -0.5, -1, -0.4, 'run');
      place(agentAt(1, 2), 19.5, 5.0, -1, 0, 'run');
      place(agentAt(1, 3), 22.0, -7.0, -1, 0, 'run');
      place(agentAt(1, 4), 12.0, 9.0, -1, 0, 'run');
      place(agentAt(1, 5), 4.0, 1.0, -1, 0, 'run');
      place(agentAt(1, 0), 28.4, -0.8, -1, 0, 'keeperIdle');
      selectUser(hero);
      director.cut('follow', { side: 1, heightMul: 0.85, distMul: 0.9 });
      director.place(13, 12.5, 17.0, 18, 1.4, -2.0);

      const fire = () => {
        body.place(14.4, 0.5, -2.2);
        body.kick(new THREE.Vector3(HALF_W - 14.4, 0, -1.4), 30, 5.2, -7);
        ballView.reset(body.pos);
        hero.anim.play('kick', { foot: 1, force: true });
        vfx.swoosh({ x: 14.0, y: 0.55, z: -2.2 }, 1, -0.1, 1.35);
        vfx.scuff({ x: 13.9, y: 0, z: -2.3 }, 1, 0, { count: 14 });
        director.shake(0.25);
      };
      scen.flags.physics = true;
      beat(0.7, fire);
      beat(1.3, fire);
      beat(1.86, fire);
    },

    goal() {
      const side = 1;
      const gx = HALF_W;
      place(agentAt(0, 5), 23.2, -4.6, -0.35, -0.94, 'celebrate');
      place(agentAt(0, 4), 20.6, -1.2, 0.2, -1, 'celebrate');
      place(agentAt(0, 3), 17.0, 6.0, -0.2, -1, 'run');
      agentAt(0, 3).vel.set(-1.2, 0, -5.0);
      place(agentAt(0, 1), 8.0, -7.0, 1, 0, 'celebrate');
      place(agentAt(0, 2), 6.0, 7.5, 1, 0, 'run');
      place(agentAt(0, 0), -26.0, 0, 1, 0, 'celebrate');
      place(agentAt(1, 0), 28.6, 2.6, -1, 0.2, 'knocked');
      place(agentAt(1, 1), 25.0, -5.0, -1, 0, 'idle');
      place(agentAt(1, 2), 23.0, 5.6, -1, 0, 'idle');
      place(agentAt(1, 3), 15.0, -9.0, -1, 0, 'idle');
      place(agentAt(1, 4), 13.0, 9.0, -1, 0, 'idle');
      place(agentAt(1, 5), 2.0, 0.0, -1, 0, 'idle');

      match.state.score[0] = 2; match.state.score[1] = 1;
      hud.setScore(2, 1);
      stadium.setScore(2, 1, '1:42');
      hud.banner('GOAL!', 'RED SCORES', 10);
      hud.setPossession(0);
      stadium.celebrate();

      body.place(gx + 1.55, 1.15, -0.55);
      ballView.reset(body.pos);
      // yaw must put the camera back INSIDE the bowl, not out in the stand
      director.cut('goal', { yaw: -2.18, distMul: 1.15, heightMul: 1.05 });
      director.place(19.4, 5.8, -9.2, 26.8, 1.5, -0.4);

      const nv = new THREE.Vector3(9, 1.2, -1.5);
      scen.step = () => {
        body.place(gx + 1.55, 1.15, -0.55);
        goals[0].impulse(body.pos, nv, 0.55);
      };
      // Confetti has to fall inside the goal-cam frustum, so it is seeded low and
      // near the goal mouth rather than raining from the roof.
      const drop = (t, x, z, n) => beat(t, () => vfx.confetti(
        { x, y: 0, z }, { count: n, spread: 7, y: 1.4 },
      ));
      beat(0.05, () => vfx.goalBlast({ x: gx - 2, y: 1.4, z: 0 }));
      drop(0.55, gx - 4, -1.5, 170);
      drop(1.05, gx - 8, 2.0, 170);
      drop(1.45, gx - 5, 3.5, 160);
      drop(1.80, gx - 10, -3.0, 170);
      beat(1.90, () => {
        vfx.burst({ x: gx + 1.4, y: 1.2, z: -0.5 }, { count: 16, speed: 4.5, color: 0xfff0c0, flashSize: 3.4 });
        vfx.confetti({ x: gx - 6, y: 0, z: 0 }, { count: 220, spread: 9, y: 2.6 });
      });
    },

    tackle() {
      const tackler = agentAt(1, 1);
      const carrier = agentAt(0, 5);
      place(carrier, 1.6, 1.2, 1, 0.15, 'run');
      carrier.vel.set(RUN_SPEED * 0.8, 0, 0.5);
      place(tackler, 3.4, 2.0, -1, -0.35, 'idle');
      place(agentAt(0, 4), -3.5, 7.0, 1, 0, 'run');
      place(agentAt(0, 3), -5.0, -6.5, 1, 0, 'run');
      place(agentAt(0, 1), -14.0, -5.0, 1, 0, 'idle');
      place(agentAt(0, 2), -15.0, 6.0, 1, 0, 'idle');
      place(agentAt(0, 0), -27.0, 0, 1, 0, 'keeperIdle');
      place(agentAt(1, 2), 9.0, -6.0, -1, 0, 'run');
      place(agentAt(1, 3), 12.0, 8.0, -1, 0, 'run');
      place(agentAt(1, 4), 16.0, -9.0, -1, 0, 'idle');
      place(agentAt(1, 5), -6.0, 2.0, -1, 0, 'run');
      place(agentAt(1, 0), 27.5, 0, -1, 0, 'keeperIdle');

      body.place(2.5, BALL_R, 1.7);
      ballView.reset(body.pos);
      selectUser(carrier);
      director.cut('tackle', { yaw: 2.62, distMul: 1.0 });
      director.place(6.7, 3.2, -5.3, 2.4, 1.1, 1.5);

      scen.step = () => {
        carrier.pos.set(1.6, 0, 1.2);
        tackler.pos.set(3.05, 0, 1.85);
        body.place(2.45, BALL_R, 1.5);
      };
      // The tackle pose peaks ~0.25 s in, so it has to start late enough that the
      // settled frame lands on the slide, not on the recovery.
      beat(1.70, () => {
        tackler.anim.play('tackle', { force: true });
      });
      beat(1.84, () => {
        carrier.anim.play('knocked', { force: true });
        vfx.burst({ x: 2.5, y: 0.75, z: 1.6 }, { count: 24, speed: 6, color: 0xffffff, flashSize: 4.6, flashColor: 0xffe8f6 });
        vfx.scuff({ x: 2.9, y: 0, z: 1.85 }, -1, -0.3, { count: 28 });
        director.shake(0.55);
      });
      beat(1.94, () => {
        vfx.burst({ x: 2.6, y: 0.95, z: 1.45 }, { count: 10, speed: 3.4, color: 0xffd9f0, flashSize: 3.2, flashColor: 0xffffff });
      });
    },

    closeup() {
      const hero = agentAt(0, 5);
      place(hero, 0, 0, 0.35, 1, 'idle');
      for (const a of agents) {
        if (a === hero) continue;
        place(a, a.team === 0 ? -34 - a.slot * 2 : 34 + a.slot * 2, -30 - a.slot * 2, 0, 1, 'idle');
      }
      place(agentAt(0, 4), 4.2, 3.6, -0.7, -1, 'idle');
      body.place(-1.15, BALL_R, 0.75);
      ballView.reset(body.pos);
      selectUser(hero);
      hud.setPossession(0);
      director.cut('closeup', { yaw: 0.62 });
      director.place(2.90, 1.55, 4.05, 0, 1.02, 0);
      scen.step = () => { hero.pos.set(0, 0, 0); };
    },

    keeper() {
      const shooter = agentAt(0, 5);
      const keeper = agentAt(1, 0);
      place(shooter, 19.6, 1.4, 1, -0.12, 'idle');
      place(keeper, 28.4, 0.2, -1, 0, 'keeperIdle');
      place(agentAt(1, 1), 23.0, -4.0, -1, 0, 'run');
      place(agentAt(1, 2), 24.0, 5.2, -1, 0, 'run');
      place(agentAt(1, 3), 25.0, -8.0, -1, 0, 'idle');
      place(agentAt(1, 4), 14.0, 8.0, -1, 0, 'run');
      place(agentAt(1, 5), 7.0, -2.0, -1, 0, 'run');
      place(agentAt(0, 4), 20.5, 8.0, 1, 0, 'run');
      place(agentAt(0, 3), 12.0, -8.0, 1, 0, 'run');
      place(agentAt(0, 1), 0.0, -5.0, 1, 0, 'run');
      place(agentAt(0, 2), -2.0, 5.0, 1, 0, 'idle');
      place(agentAt(0, 0), -26.0, 0, 1, 0, 'keeperIdle');

      selectUser(shooter);
      director.cut('keeper', { heightMul: 1.0 });
      director.place(11.5, 4.2, 2.3, 25.5, 1.5, 0.6);

      scen.flags.physics = true;
      const fire = () => {
        body.place(20.7, 0.55, 1.1);
        body.kick(new THREE.Vector3(HALF_W - 20.7, 0, -3.6), 25, 3.2, 6);
        ballView.reset(body.pos);
        shooter.anim.play('kick', { foot: 1, force: true });
        vfx.swoosh({ x: 20.3, y: 0.6, z: 1.2 }, 1, -0.3, 1.2);
        vfx.scuff({ x: 20.1, y: 0, z: 1.3 }, 1, 0, { count: 12 });
      };
      const dive = () => {
        keeper.anim.play('keeperDive', { dir: -1, force: true });
        keeper.pos.set(28.4, 0, 0.2);
      };
      beat(0.60, fire);
      beat(0.74, dive);
      beat(1.52, fire);
      beat(1.66, dive);
      scen.step = (dt, t) => {
        // slide the keeper along his dive so he travels toward the corner
        if (keeper.anim.current === 'keeperDive') {
          keeper.pos.z -= dt * 4.6;
          keeper.pos.x = 28.4;
        }
      };
    },

    wide() {
      match.formationReset(0);
      for (let t = 0; t < 2; t++) {
        for (let s = 0; s < 6; s++) {
          const a = agentAt(t, s);
          const f = FORMATION[s];
          const dir = TEAMS[t].dir;
          place(a, f.x * dir * 0.92, f.z * 1.05, dir, 0, s === 0 ? 'keeperIdle' : 'idle');
        }
      }
      body.place(0, BALL_R, 0);
      ballView.reset(body.pos);
      selectUser(null);
      hud.banner(null);
      hud.setPossession(-1);
      stadium.setScore(1, 1, '2:08');
      hud.setScore(1, 1);
      hud.setClock(128);
      director.cut('wide', { yaw: 0.34 });
      director.place(
        Math.sin(0.34) * 54, 66, Math.cos(0.34) * 54,
        0, 3, 0,
      );
    },
  };

  function scenario(name) {
    baseReset();
    scen.name = name;
    const fn = SCENARIOS[name];
    if (!fn) throw new Error('unknown scenario: ' + name);
    fn();
    // one immediate sync so the very first settle step starts from the pose
    syncViews(0);
    return name;
  }

  function freePlay() {
    paused = false;
    acc = 0;
    baseReset();
    scen.name = 'play';
    scen.flags = { ai: true, match: true, physics: true, autoSelect: true, rules: true };
    match.reset();
    director.cut('broadcast', { side: 1 });
    autoSelect();
  }

  // ---------------------------------------------------------------- stepping
  const _focus = { ball: body.pos, hero: new THREE.Vector3(), action: new THREE.Vector3(), leadX: 0 };

  function syncViews(dt) {
    for (const a of agents) {
      const v = a.view;
      v.group.position.set(a.pos.x, 0, a.pos.z);
      const sp = Math.hypot(a.vel.x, a.vel.z);
      let fx = a.faceX, fz = a.faceZ;
      if (sp > 0.5) { fx = a.vel.x / sp; fz = a.vel.z / sp; }
      if (fx !== 0 || fz !== 0) {
        const want = Math.atan2(fx, fz);
        a.yaw = dt > 0 ? angleLerp(a.yaw, want, 1 - Math.exp(-dt * 11)) : want;
      }
      v.group.rotation.y = a.yaw;
      a.anim.update(dt, {
        speed: sp, moving: sp > 0.5, sprinting: sp > 9.4, isKeeper: a.isKeeper,
      });
      v.syncShadow();
    }
  }

  function step(dt) {
    scen.t += dt;
    runBeats();
    if (scen.step) scen.step(dt, scen.t);

    if (scen.flags.ai) ai.update(dt);
    if (scen.flags.ai || scen.flags.match) driveUser(dt);

    // integrate agents
    for (const a of agents) {
      if (a.down) {
        a.downTimer = (a.downTimer ?? 1.2) - dt;
        a.vel.multiplyScalar(Math.max(0, 1 - 5 * dt));
        if (a.downTimer <= 0) { a.down = false; }
      }
      a.pos.x += a.vel.x * dt;
      a.pos.z += a.vel.z * dt;
      a.pos.x = clamp(a.pos.x, -HALF_W - 2.5, HALF_W + 2.5);
      a.pos.z = clamp(a.pos.z, -HALF_D - 2.0, HALF_D + 2.0);
    }
    if (scen.flags.ai) separatePlayers(agents, dt);

    if (scen.flags.physics) {
      body.step(dt, world);
      if (scen.flags.ai) ballPlayerContact(body, agents, dt, events);
    }

    if (scen.flags.match) {
      match.update(dt);
      hud.setClock(match.state.clock);
      hud.setPossession(match.state.possession);
      if (scen.flags.autoSelect && match.state.phase === 'play') autoSelect();
      if (match.state.phase === 'play' && director.mode !== 'follow' && director.mode !== 'broadcast') {
        director.cut('broadcast', { side: 1 });
      }
    }

    for (const g of goals) g.update(dt, body.pos, body.vel);
    syncViews(dt);
    ballView.sync(body, dt);
    vfx.update(dt);
    stadium.update(dt);

    // camera
    _focus.ball = body.pos;
    if (userAgent) _focus.hero.set(userAgent.pos.x, 0, userAgent.pos.z);
    _focus.action.copy(body.pos);
    _focus.leadX = body.vel.x;
    _focus.goalX = TEAMS[0].dir * HALF_W;
    _focus.goalZ = 0;
    director.update(dt, _focus);

    hud.update(dt);
  }

  // ---------------------------------------------------------------- loop
  let last = performance.now() / 1000;
  let acc = 0;
  let frames = 0;
  let ready = false;
  let paused = false;

  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now() / 1000;
    let dt = now - last;
    last = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    if (!paused) {
      acc += dt;
      let guard = 0;
      while (acc >= FIXED && guard < 8) { step(FIXED); acc -= FIXED; guard++; }
      if (guard >= 8) acc = 0;
    }
    engine.render(dt);
    frames++;
    if (!ready && frames >= 2) {
      ready = true;
      window.__debug.ready = true;
      if (splash) splash.classList.add('gone');
    }
  }

  // Start in a staged kickoff so the very first frame is already a good picture,
  // then hand over to live play on the first user gesture.
  scenario('kickoff');
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    audio.unlock();
    audio.crowd(0.16);
    freePlay();
  };
  window.addEventListener('pointerdown', start, { once: true });
  window.addEventListener('keydown', start, { once: true });

  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- __debug
  const dbg = {
    ready: false,
    scenario(name) {
      started = true;          // never auto-start free play during a capture
      paused = false;
      acc = 0;
      return scenario(name);
    },
    settle(steps = 120) {
      paused = false;
      for (let i = 0; i < steps; i++) step(FIXED);
      engine.render(FIXED);
      // Freeze afterwards: the harness waits ~250 ms before screenshotting and the
      // rAF loop would otherwise keep simulating past the frame we just settled.
      paused = true;
      acc = 0;
      return true;
    },
    perf() {
      return {
        fps: Math.round(engine.stats.fps * 10) / 10,
        drawCalls: engine.stats.drawCalls,
        triangles: engine.stats.triangles,
        programs: engine.stats.programs,
        renderer: engine.stats.rendererName,
        quality: engine.stats.quality,
      };
    },
    state() {
      return {
        score: [match.state.score[0], match.state.score[1]],
        phase: match.state.phase,
        clock: Math.round(match.state.clock * 10) / 10,
        ballPos: [
          Math.round(body.pos.x * 1000) / 1000,
          Math.round(body.pos.y * 1000) / 1000,
          Math.round(body.pos.z * 1000) / 1000,
        ],
        players: agents.length,
        scenario: scen.name,
        camera: director.mode,
      };
    },
    // extras (not part of the contract, handy for tuning)
    engine, scene, camera, agents, body, match, director, vfx, hud, pitch, stadium, goals,
    play: freePlay,
    setQuality: (q) => engine.setQuality(q),
    pause(v) { paused = v === undefined ? !paused : !!v; return paused; },
  };
  window.__debug = dbg;

  return dbg;
}
