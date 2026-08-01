// Match rules: phases, kickoff, goals, out of play, set pieces, clock and score.
//
//   createMatch(ctx) -> { state, update(dt), kickoff(team), restart(kind, pos),
//                         scoreGoal(side), reset(), clockText(), formationReset(team),
//                         setPhase(p, hold) }
//
// ctx: { agents, body, goals, ai, events }
//
// Phases
//   'kickoff'  ball on the spot, both teams in the kickoff picture, hold, then the
//              striker rolls it to a supporting midfielder and play begins
//   'play'     live
//   'goal'     celebration hold, then kickoff to the conceding side
//   'restart'  a dead ball is being staged and taken (throw-in / corner / goal kick)
//   'halftime' break, then kickoff to the other side
//   'fulltime' terminal
//
// Every non-play phase owns a countdown AND a hard watchdog, so a phase can never
// wedge the match even if a delivery is interrupted.

import {
  HALF_W, HALF_D, MATCH_SECONDS, KICKOFF_HOLD, GOAL_HOLD, TEAMS, BALL_R,
  BOX_W, RUN_SPEED,
} from '../core/constants.js';
import { KICKOFF_ATTACK, KICKOFF_DEFEND } from './ai.js';
import { placeMotion } from './locomotion.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const HALF_SECONDS = MATCH_SECONDS / 2;
const HALFTIME_HOLD = 3.0;
const PHASE_WATCHDOG = 14.0;         // no dead-ball phase may outlive this

export function createMatch(ctx) {
  const { agents, body, goals } = ctx;
  const events = ctx.events || {};

  const state = {
    score: [0, 0],
    phase: 'kickoff',
    clock: MATCH_SECONDS,
    possession: 0,
    lastScorer: -1,
    half: 1,
    /** live description of the dead ball being taken, read by sim/ai.js */
    setPiece: { kind: null, team: 0, taker: null, x: 0, z: 0, aimX: 0, aimZ: 0 },
  };

  let hold = KICKOFF_HOLD;
  let phaseAge = 0;
  let kickoffTeam = 0;
  let firstKickoffTeam = 0;
  let delivered = true;

  const sp = state.setPiece;

  function clockText(t = state.clock) {
    const s = Math.max(0, Math.ceil(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function ai() { return ctx.ai; }
  function ownGoalX(team) { return -TEAMS[team].dir * HALF_W; }
  /** the team that defends the goal on side s (+1 = the +X goal) */
  function defenderOf(s) { return TEAMS[0].dir === -s ? 0 : 1; }

  function setPhase(p, h = 0) {
    state.phase = p;
    hold = h;
    phaseAge = 0;
  }

  // -------------------------------------------------------------------------
  /**
   * Put every agent on its kickoff slot. The two pictures are authored (see
   * ai.js) rather than derived by clamping the open-play formation into a half —
   * clamping stacks three defenders on the centre spot and gifts them the ball.
   */
  function formationReset(team) {
    for (const a of agents) {
      const k = (a.team === team ? KICKOFF_ATTACK : KICKOFF_DEFEND)[a.slot] || KICKOFF_DEFEND[0];
      const dir = TEAMS[a.team].dir;
      const x = k.x * dir;
      const z = k.z;
      const fromX = a.pos.x, fromZ = a.pos.z;
      a.pos.set(clamp(x, -HALF_W + 2, HALF_W - 2), 0, clamp(z, -HALF_D + 2, HALF_D - 2));
      // Was he CARRIED here, or was he already standing on the spot? A player
      // teleported across the pitch has no motion left to model, so the body is
      // zeroed outright (see locomotion.placeMotion) — the position jumped, and
      // the velocity going with it is what stops a restart inheriting the pace
      // of whatever was happening before the whistle. A player who barely moves
      // is a different case: he is on his mark and pulling up, so he brakes
      // through the envelope like anyone else and stops over a stride.
      if (Math.hypot(a.pos.x - fromX, a.pos.z - fromZ) > 1.0) placeMotion(a);
      else a.vel.set(0, 0, 0);
      a.down = false;
      a.cool = 0;
      a.kickLock = 0;
      a.hold = 0;
      a.diving = false;
      a.hasBall = false;
      if (a.anim) a.anim.play(a.isKeeper ? 'keeperIdle' : 'idle', { force: true });
      a.faceX = TEAMS[a.team].dir;
      a.faceZ = 0;
    }
  }

  function clearSetPiece() {
    sp.kind = null;
    sp.taker = null;
  }

  /**
   * Nearest eligible player of `team` to (x,z). A human-controlled player is
   * never volunteered as the taker — nothing would walk him onto the ball.
   */
  function nearestTo(team, x, z, { keeper = false } = {}) {
    let best = null, bd = 1e9;
    for (const a of agents) {
      if (a.team !== team || a.down || a.control === 'user') continue;
      if (a.isKeeper && !keeper) continue;
      const d = Math.hypot(a.pos.x - x, a.pos.z - z);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) return best;
    for (const a of agents) {
      if (a.team !== team || a.down) continue;
      if (a.isKeeper && !keeper) continue;
      const d = Math.hypot(a.pos.x - x, a.pos.z - z);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  function kickoff(team = 0) {
    kickoffTeam = team;
    delivered = false;
    setPhase('kickoff', KICKOFF_HOLD);
    body.place(0, BALL_R, 0);
    body.lastTouch = null;
    body.lastTouchTeam = -1;
    formationReset(team);
    for (const g of goals) g.reset();
    sp.kind = 'kickoff';
    sp.team = team;
    sp.x = 0; sp.z = 0;
    sp.aimX = TEAMS[team].dir * 6; sp.aimZ = 0;
    sp.taker = agents.find((a) => a.team === team && a.slot === 5) || null;
    if (ai()) ai().reset();
    if (events.onPhase) events.onPhase('kickoff', team);
  }

  function scoreGoal(side) {
    if (state.phase !== 'play') return;
    // `side` is the goal that was scored into (+1 = the goal at +X)
    const conceded = defenderOf(side);
    const scorer = conceded === 0 ? 1 : 0;
    state.score[scorer]++;
    state.lastScorer = scorer;
    setPhase('goal', GOAL_HOLD);
    clearSetPiece();
    for (const a of agents) {
      if (a.down) continue;
      if (a.team === scorer && !a.isKeeper) a.anim && a.anim.play('celebrate', { force: true });
      else if (a.team !== scorer && !a.isKeeper && a.anim) a.anim.play('idle', { force: true });
    }
    if (events.onGoal) events.onGoal(scorer, side);
  }

  // -------------------------------------------------------------------------
  // out of play
  // -------------------------------------------------------------------------
  /**
   * `kind` arrives from sim/physics.js as 'throw' | 'goalkickL' | 'goalkickR'.
   * Physics only knows WHERE the ball left; who touched it last decides whether
   * a ball over the byline is a corner or a goal kick.
   */
  function restart(kind, pos) {
    if (state.phase !== 'play') return;
    const last = body.lastTouchTeam;

    if (kind === 'throw') {
      const zSide = Math.sign(pos.z) || 1;
      const team = last >= 0 ? (last === 0 ? 1 : 0) : 0;
      stage('throw', team,
        clamp(pos.x, -HALF_W + 3.5, HALF_W - 3.5), zSide * (HALF_D - 0.35));
      return;
    }

    const s = kind === 'goalkickR' ? 1 : -1;      // which byline the ball crossed
    const defending = defenderOf(s);
    if (last === defending) {
      // a defender put it behind: corner to the attackers
      const attacking = defending === 0 ? 1 : 0;
      const zSide = Math.sign(pos.z) || 1;
      stage('corner', attacking, s * (HALF_W - 0.45), zSide * (HALF_D - 0.45));
    } else {
      stage('goalkick', defending,
        ownGoalX(defending) + TEAMS[defending].dir * (BOX_W * 0.42),
        clamp(pos.z * 0.35, -5.0, 5.0));
    }
  }

  function stage(kind, team, x, z) {
    sp.kind = kind;
    sp.team = team;
    sp.x = x;
    sp.z = z;
    delivered = false;

    const dir = TEAMS[team].dir;
    if (kind === 'goalkick') {
      sp.taker = agents.find((a) => a.team === team && a.isKeeper) || nearestTo(team, x, z);
      sp.aimX = x + dir * 24; sp.aimZ = 0;
    } else {
      sp.taker = nearestTo(team, x, z);
      sp.aimX = kind === 'corner' ? x - dir * 6 : x + dir * 6;
      sp.aimZ = kind === 'corner' ? 0 : z * 0.4;
    }

    body.place(x, kind === 'throw' ? BALL_R + 0.9 : BALL_R, z);
    body.lastTouch = null;
    body.lastTouchTeam = -1;

    // hold long enough for the taker to actually walk onto the ball
    const walk = sp.taker ? Math.hypot(sp.taker.pos.x - x, sp.taker.pos.z - z) / (RUN_SPEED * 0.95) : 0.6;
    setPhase('restart', clamp(walk + 0.5, 0.9, 2.6));
    if (events.onPhase) events.onPhase(kind, team);
  }

  /** the taker actually plays the ball; the impulse lands on the animation's contact frame */
  function deliver() {
    delivered = true;
    const kind = sp.kind;
    const taker = sp.taker;
    const team = sp.team;
    const dir = TEAMS[team].dir;

    if (!taker || !ai()) { clearSetPiece(); goLive(); return; }

    // Pick a real target rather than hoofing it into space, and tell the pass
    // assist which way this restart is supposed to go. A throw-in taken from
    // outside the line and aimed along it is a throw-in straight back to them:
    // the cone bias points it INFIELD, which is what a thrower is looking for.
    const inward = -(Math.sign(sp.z) || 1);
    const opts = kind === 'goalkick'
      ? { minDist: 7, maxDist: 34, floor: -1e9, dirX: dir, dirZ: 0, cone: 0.16 }
      : kind === 'corner'
        ? { minDist: 4, maxDist: 22, floor: -1e9, dirX: -dir, dirZ: 0, cone: 0.20 }
        : { minDist: 4, maxDist: 17, floor: -1e9, dirX: dir * 0.6, dirZ: inward, cone: 0.34 };
    const p = ai().bestPass(taker, opts);
    let tx = p ? p.x : sp.aimX;
    let tz = p ? p.z : sp.aimZ;

    if (kind === 'corner') {
      // whip it toward the penalty spot area if nobody better is free
      if (!p) { tx = sp.x - dir * 7.5; tz = 0; }
    }

    const state2 = kind === 'throw' ? 'throwIn' : (kind === 'goalkick' ? 'kick' : 'kick');
    ai().strike(taker, state2, tz > taker.pos.z ? 1 : -1, () => {
      const ex = tx - taker.pos.x, ez = tz - taker.pos.z;
      const d = Math.hypot(ex, ez) || 1;
      // Release from the touchline itself, not from the thrower's feet — he
      // stands OUTSIDE the line, and a ball spawned there is instantly out again.
      if (kind === 'throw') body.place(sp.x, 1.75, sp.z);
      else body.place(sp.x, BALL_R, sp.z);
      const power = kind === 'throw' ? clamp(d * 1.05, 8, 17)
        : kind === 'goalkick' ? 30
          : clamp(d * 1.30, 14, 26);
      const lift = kind === 'throw' ? clamp(d * 0.16, 1.4, 3.6)
        : kind === 'goalkick' ? 7.2
          : clamp(d * 0.30, 3.0, 6.0);
      body.vel.set(0, 0, 0);
      body.kick({ x: ex / d, y: 0, z: ez / d }, power, lift, 0);
      body.lastTouch = taker;
      body.lastTouchTeam = team;
      if (events.onPass) events.onPass(taker, p ? p.mate : taker);
    });
    goLive();
  }

  /** kickoff delivery: a short square pass, exactly like the real thing */
  function kickoffDeliver() {
    delivered = true;
    const team = kickoffTeam;
    const taker = sp.taker || nearestTo(team, 0, 0);
    if (!taker || !ai()) { clearSetPiece(); goLive(); return; }
    const p = ai().bestPass(taker, { minDist: 3, maxDist: 16, floor: -1e9 });
    const tx = p ? p.x : -TEAMS[team].dir * 6;
    const tz = p ? p.z : 5.5;
    ai().strike(taker, 'pass', tz > taker.pos.z ? 1 : -1, () => {
      const ex = tx - taker.pos.x, ez = tz - taker.pos.z;
      const d = Math.hypot(ex, ez) || 1;
      body.place(0, BALL_R, 0);
      body.kick({ x: ex / d, y: 0, z: ez / d }, clamp(d * 1.25, 9, 18), 0.3, 0);
      body.lastTouch = taker;
      body.lastTouchTeam = team;
      if (events.onPass) events.onPass(taker, p ? p.mate : taker);
    });
    goLive();
  }

  function goLive() {
    clearSetPiece();
    setPhase('play');
    if (events.onPhase) events.onPhase('play');
  }

  // -------------------------------------------------------------------------
  function update(dt) {
    phaseAge += dt;

    switch (state.phase) {
      case 'kickoff':
        hold -= dt;
        if (!delivered) { body.place(0, BALL_R, 0); }
        if (hold <= 0) kickoffDeliver();
        break;

      case 'restart':
        hold -= dt;
        if (!delivered && sp.kind) {
          // pin the ball on the spot so it cannot trickle away while it is staged
          body.place(sp.x, sp.kind === 'throw' ? BALL_R + 0.9 : BALL_R, sp.z);
        }
        if (hold <= 0) deliver();
        break;

      case 'goal':
        hold -= dt;
        if (hold <= 0) kickoff(state.lastScorer === 0 ? 1 : 0);
        break;

      case 'halftime':
        hold -= dt;
        if (hold <= 0) {
          state.half = 2;
          kickoff(firstKickoffTeam === 0 ? 1 : 0);
        }
        break;

      case 'play':
        if (sp.kind) clearSetPiece();
        state.clock -= dt;
        if (state.half === 1 && state.clock <= HALF_SECONDS) {
          state.clock = HALF_SECONDS;
          setPhase('halftime', HALFTIME_HOLD);
          for (const a of agents) { if (a.anim) a.anim.play(a.isKeeper ? 'keeperIdle' : 'idle', { force: true }); }
          if (events.onPhase) events.onPhase('halftime', state.half);
        } else if (state.clock <= 0) {
          state.clock = 0;
          setPhase('fulltime');
          if (events.onPhase) events.onPhase('fulltime');
        }
        break;

      default:
        break;
    }

    // Watchdog: nothing except full time is allowed to sit in a dead phase.
    // A delivery that somehow never fired cannot wedge the match.
    if (state.phase !== 'play' && state.phase !== 'fulltime' && phaseAge > PHASE_WATCHDOG) {
      kickoff(state.possession === 0 ? 1 : 0);
    }

    // While a dead ball is staged nobody has touched it, so possession would go
    // stale on the HUD; the side awarded the restart owns it.
    if (sp.kind) state.possession = sp.team;
    else if (body.lastTouchTeam >= 0) state.possession = body.lastTouchTeam;
  }

  function reset() {
    state.score[0] = 0; state.score[1] = 0;
    state.clock = MATCH_SECONDS;
    state.half = 1;
    state.lastScorer = -1;
    state.possession = 0;
    firstKickoffTeam = 0;
    clearSetPiece();
    kickoff(0);
  }

  return {
    state, update, kickoff, restart, scoreGoal, reset, clockText,
    formationReset,
    get phase() { return state.phase; },
    get setPiece() { return sp; },
    get ai() { return ctx.ai; },
    /** force a phase without running the transition (scenario staging) */
    setPhase(p, h = 0) { setPhase(p, h); delivered = true; if (p === 'play') clearSetPiece(); },
  };
}
