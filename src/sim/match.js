// Match rules: phases, kickoff, goals, out of play, clock and score.
//
//   createMatch(ctx) -> { state, update(dt), kickoff(team), restart(kind, pos),
//                         scoreGoal(side), reset(), clockText() }
//
// ctx: { agents, body, goals, ai, events }
// Phases: 'kickoff' | 'play' | 'goal' | 'restart' | 'halftime' | 'fulltime'

import {
  HALF_W, HALF_D, MATCH_SECONDS, KICKOFF_HOLD, GOAL_HOLD, TEAMS, BALL_R,
} from '../core/constants.js';
import { FORMATION } from './ai.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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
  };

  let hold = KICKOFF_HOLD;
  let kickoffTeam = 0;

  function clockText(t = state.clock) {
    const s = Math.max(0, Math.ceil(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** put every agent on its formation slot for a kickoff */
  function formationReset(team) {
    for (const a of agents) {
      const f = FORMATION[a.slot] || FORMATION[0];
      const dir = TEAMS[a.team].dir;
      let x = f.x * dir;
      let z = f.z;
      if (a.team !== team) {
        // defending side sits back behind the halfway line
        x = clamp(x, dir > 0 ? -HALF_W + 3 : 3.2, dir > 0 ? -3.2 : HALF_W - 3);
      } else if (f.role === 'ST') {
        x = -dir * 1.2; z = 0;
      } else if (f.role === 'LM' || f.role === 'RM') {
        x = -dir * 6.5;
      }
      a.pos.set(clamp(x, -HALF_W + 2, HALF_W - 2), 0, clamp(z, -HALF_D + 2, HALF_D - 2));
      a.vel.set(0, 0, 0);
      a.down = false;
      a.cool = 0;
      a.diving = false;
      if (a.anim) a.anim.play(a.isKeeper ? 'keeperIdle' : 'idle', { force: true });
      a.faceX = TEAMS[a.team].dir;
      a.faceZ = 0;
    }
  }

  function kickoff(team = 0) {
    kickoffTeam = team;
    state.phase = 'kickoff';
    hold = KICKOFF_HOLD;
    body.place(0, BALL_R, 0);
    body.lastTouch = null;
    body.lastTouchTeam = -1;
    formationReset(team);
    for (const g of goals) g.reset();
    if (ctx.ai) ctx.ai.reset();
    if (events.onPhase) events.onPhase('kickoff', team);
  }

  function scoreGoal(side) {
    if (state.phase !== 'play') return;
    // `side` is the goal that was scored into (+1 = goal at +X, defended by team 1)
    const scorer = side > 0 ? 0 : 1;
    state.score[scorer]++;
    state.lastScorer = scorer;
    state.phase = 'goal';
    hold = GOAL_HOLD;
    for (const a of agents) {
      if (a.team === scorer && !a.isKeeper) a.anim && a.anim.play('celebrate', { force: true });
    }
    if (events.onGoal) events.onGoal(scorer, side);
  }

  function restart(kind, pos) {
    if (state.phase !== 'play') return;
    state.phase = 'restart';
    hold = 0.55;
    if (kind === 'throw') {
      const z = Math.sign(pos.z) * (HALF_D - 0.4);
      body.place(clamp(pos.x, -HALF_W + 4, HALF_W - 4), BALL_R + 0.6, z);
    } else {
      const s = kind === 'goalkickR' ? 1 : -1;
      body.place(s * (HALF_W - 5.4), BALL_R, clamp(pos.z * 0.4, -6, 6));
    }
    if (events.onPhase) events.onPhase(kind, pos);
  }

  function update(dt) {
    switch (state.phase) {
      case 'kickoff':
        hold -= dt;
        body.place(0, BALL_R, 0);
        if (hold <= 0) {
          state.phase = 'play';
          if (events.onPhase) events.onPhase('play');
        }
        break;

      case 'goal':
        hold -= dt;
        if (hold <= 0) kickoff(state.lastScorer === 0 ? 1 : 0);
        break;

      case 'restart':
        hold -= dt;
        if (hold <= 0) {
          state.phase = 'play';
          if (events.onPhase) events.onPhase('play');
        }
        break;

      case 'play':
        state.clock -= dt;
        if (state.clock <= 0) {
          state.clock = 0;
          state.phase = 'fulltime';
          if (events.onPhase) events.onPhase('fulltime');
        }
        break;

      default:
        break;
    }

    if (body.lastTouchTeam >= 0) state.possession = body.lastTouchTeam;
  }

  function reset() {
    state.score[0] = 0; state.score[1] = 0;
    state.clock = MATCH_SECONDS;
    state.phase = 'kickoff';
    state.lastScorer = -1;
    state.possession = 0;
    kickoff(0);
  }

  return {
    state, update, kickoff, restart, scoreGoal, reset, clockText,
    formationReset,
    get phase() { return state.phase; },
    /** force a phase without running the transition (scenario staging) */
    setPhase(p, h = 0) { state.phase = p; hold = h; },
  };
}
