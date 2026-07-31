// Shared, read-only world constants. Right-handed, Y up, pitch centred on origin.
// Pitch plays along X (goal to goal); width runs along Z. 1 unit ~= 1 metre.
//
// This file is data only — no behaviour, no imports. Every other module reads from it.

export const FIELD_W = 60;                 // X, goal line to goal line
export const FIELD_D = 40;                 // Z, touchline to touchline
export const HALF_W = FIELD_W / 2;         // 30
export const HALF_D = FIELD_D / 2;         // 20

export const GOAL_HALF_W = 4;              // half width of the goal mouth (Z)
export const GOAL_H = 3;                   // crossbar height
export const GOAL_DEPTH = 2.5;             // how far the net runs behind the line
export const POST_R = 0.13;

export const BALL_R = 0.42;
export const PLAYER_H = 2.0;
export const PLAYER_R = 0.5;               // collision radius
export const TEAM_SIZE = 6;                // 5 outfield + 1 keeper

// Painted markings
export const LINE_T = 0.18;                // paint thickness
export const CENTER_R = 6.5;
export const BOX_W = 12;                   // penalty area depth along X
export const BOX_D = 24;                   // penalty area width along Z
export const SIX_W = 5;
export const SIX_D = 12;
export const PEN_SPOT = 8;                 // distance from goal line
export const CORNER_R = 1.1;

// Turf
export const STRIPES = 12;                 // mow stripes across the pitch (alternating along X)
export const STRIPE_W = FIELD_W / STRIPES;

// Off-pitch dressing
export const APRON_X = 35;                 // grass/concrete apron edge
export const APRON_Z = 25;
export const BOARD_X = 34.2;               // perimeter ad boards
export const BOARD_Z = 24.2;
export const STAND_X = 36.5;
export const STAND_Z = 26.5;
export const STAND_DEPTH = 16;
export const STAND_H = 13;

// Teams — index 0 attacks +X, index 1 attacks -X.
export const TEAMS = [
  {
    id: 0, name: 'RED', short: 'RED', dir: 1,
    kit: 0xd8262c, kitDark: 0x8f1418, trim: 0xffffff,
    shorts: 0xf2f2f2, socks: 0xd8262c, keeper: 0x2fd06a, keeperShorts: 0x16351f,
    crowd: [0xd8262c, 0xffffff, 0xf0a0a0, 0x9c1218],
  },
  {
    id: 1, name: 'BLU', short: 'BLU', dir: -1,
    kit: 0x2450c8, kitDark: 0x142e78, trim: 0xf5d020,
    shorts: 0x18306f, socks: 0x2450c8, keeper: 0xf58a1f, keeperShorts: 0x3a2008,
    crowd: [0x2450c8, 0xf5d020, 0xffffff, 0x1a2a5c],
  },
];

// Match tuning
export const MATCH_SECONDS = 180;
export const KICKOFF_HOLD = 1.2;
export const GOAL_HOLD = 3.6;

// Physics tuning (arcade, not simulation)
export const GRAVITY = -17.5;
export const AIR_DRAG = 0.055;
export const MAGNUS = 0.30;
export const RESTITUTION = 0.55;
export const ROLL_FRICTION = 0.72;
export const SPIN_DECAY = 0.86;
export const MAX_BALL_SPEED = 46;

// Player movement
export const RUN_SPEED = 8.2;
export const SPRINT_SPEED = 11.6;
export const KEEPER_SPEED = 7.0;
export const ACCEL = 34;
