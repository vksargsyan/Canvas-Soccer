// Ball integration + collision resolution.
//
//   createBallBody(cfg) -> { pos, vel, spin, grounded, step(dt, world),
//                            kick(dir, power, lift, curl), stop(), place(x,y,z) }
//
// `world` is supplied every step and may contain:
//   { bounds:{halfW,halfD}, goals:[goal], players:[{pos,vel,radius,id}],
//     events:{ onBounce(speed,pos), onPost(pos,speed), onGoal(side), onOut(kind,pos),
//              onTouch(player, speed), onNet(pos, speed) } }
//
// Model (arcade, but built on the right equations so it *behaves* like a ball):
//   * quadratic air drag                a = -kd |v| v
//   * Magnus force from spin            a = km (w x v)          -> curled shots bend
//   * impulsive bounce with speed-dependent restitution
//   * Coulomb friction at the contact patch, coupled to angular velocity, so
//     backspin checks up, topspin skids on, and a sliding ball converts to a
//     true roll (the classic 2/7 slip solution)
//   * rolling resistance + spin decay
//   * every step is sub-stepped so a 46 m/s shot cannot tunnel a 0.13 m post
//
// Also exports player separation and a ball/player interaction helper so sim/ai.js
// and sim/match.js do not each reimplement them.

import * as THREE from 'three';
import { BALL_R, MAX_BALL_SPEED, PLAYER_R } from '../core/constants.js';

// --- tuning (owned by the ball domain) --------------------------------------
// The world is roughly half life-size (60 x 40 pitch), so gravity is scaled up to
// keep flight times snappy and the ball readable at gameplay camera distance.
const G = -20.5;                 // m/s^2
const DRAG_K = 0.0195;           // quadratic drag coefficient / mass
const MAGNUS_K = 0.0125;         // Magnus coefficient / mass
const SPIN_AIR_DECAY = 0.34;     // 1/s, exponential decay of spin in flight
const E_BASE = 0.62;             // restitution at low impact speed
const E_MIN = 0.34;              // restitution at very hard impacts
const E_FADE = 13.0;             // impact speed at which restitution has halved-ish
const MU_IMPACT = 0.42;          // friction coefficient during a bounce
const MU_SLIDE = 0.46;           // sliding friction while grounded
const ROLL_RES = 2.35;           // m/s^2 rolling deceleration
const GRASS_CURVE = 0.030;       // how much vertical spin steers a rolling ball
const BOUNCE_MIN = 0.85;         // below this downward speed the ball settles
const REST_SPEED = 0.16;         // below this the ball is asleep
const SUB_MAX = 12;              // hard cap on collision sub-steps
const SUB_TRAVEL = 0.45;         // sub-step so the ball moves <= this * BALL_R

const POST_E = 0.66;             // posts are springy and loud
const POST_E_MIN = 0.34;         // ...but a hammered shot dies off the woodwork
const NET_PUSH = 34;             // how fast the mesh pushes the ball back out (1/s)
const NET_E = 0.045;             // the net returns almost none of the shot
const NET_DRAG = 9.0;            // tangential drag inside the net (1/s)

const _m = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createBallBody(cfg = {}) {
  const pos = new THREE.Vector3(cfg.x || 0, cfg.y ?? BALL_R, cfg.z || 0);
  const vel = new THREE.Vector3();
  const spin = new THREE.Vector3();          // rad/s

  // one-shot signals the renderer polls (squash, trail reset, sfx pitch)
  let impactId = 0;
  const goalLatch = [false, false];
  let outLatch = 0;

  const body = {
    pos, vel, spin,
    grounded: true,
    inNet: false,
    lastTouch: null,
    lastTouchTeam: -1,
    impactId: 0,
    impactSpeed: 0,
    kickId: 0,
    kickPower: 0,

    place(x, y, z) {
      pos.set(x, y ?? BALL_R, z);
      vel.set(0, 0, 0);
      spin.set(0, 0, 0);
      body.grounded = pos.y <= BALL_R + 1e-3;
      body.inNet = false;
      goalLatch[0] = goalLatch[1] = false;
      // grace period: a restart that drops the ball on the touchline must not
      // immediately re-trigger the out-of-play event that caused it
      outLatch = 0.35;
      return body;
    },

    stop() { vel.set(0, 0, 0); spin.set(0, 0, 0); return body; },

    /**
     * dir  : direction on the ground plane (need not be normalised)
     * power: metres/second along dir
     * lift : upward metres/second
     * curl : sideways spin in rad/s; POSITIVE BENDS RIGHT relative to `dir`
     *
     * The spin the kick imparts is not arbitrary: a lofted strike is struck below
     * centre and therefore carries backspin proportional to how much it was lifted,
     * while a driven ball gets a little topspin so it dips and skids on.
     */
    kick(dir, power, lift = 0, curl = 0) {
      const len = Math.hypot(dir.x, dir.z) || 1;
      const dx = dir.x / len, dz = dir.z / len;
      vel.x = dx * power;
      vel.z = dz * power;
      vel.y = lift;

      // Spin is not free input: how the ball is struck decides it.
      //  * a ball rolled along the deck leaves the boot already rolling, so it
      //    carries pure topspin and does not waste energy skidding
      //  * a lofted strike is hit below centre and carries backspin, which the
      //    Magnus term turns into lift — that is what keeps a shot up long
      //    enough to arrive in the air instead of bouncing in
      const air = clamp(lift / 3.5, 0, 1);
      const loft = clamp(lift / Math.max(4, power * 0.55), 0, 1.2);
      const rollSpin = -power / BALL_R;                       // topspin, exact roll
      const airSpin = (0.30 + loft * 1.30) * power * 0.62;    // backspin
      const wBack = rollSpin * (1 - air) + airSpin * air;
      // backspin axis for travel dir d is (-dz, 0, dx)
      const wSide = -curl * 1.8;                 // +curl -> Magnus pushes right
      spin.set(-dz * wBack, wSide, dx * wBack);

      body.grounded = lift <= 0.01 && pos.y <= BALL_R + 1e-3;
      body.inNet = false;
      body.kickId++;
      body.kickPower = power;
      goalLatch[0] = goalLatch[1] = false;
      clampSpeed();
      return body;
    },

    step(dt, world) {
      const w = world || {};
      const s = vel.length();
      const n = clamp(Math.ceil((s * dt) / (BALL_R * SUB_TRAVEL)), 1, SUB_MAX);
      const h = dt / n;
      for (let i = 0; i < n; i++) integrate(h, w);
      clampSpeed();
    },
  };

  function clampSpeed() {
    const s = vel.length();
    if (s > MAX_BALL_SPEED) vel.multiplyScalar(MAX_BALL_SPEED / s);
    const w = spin.length();
    if (w > 240) spin.multiplyScalar(240 / w);
  }

  // --- contact-patch solve on a flat ground plane ---------------------------
  // Contact point velocity for normal +Y:  u = (vx + r*wz, vz - r*wx)
  // A tangential impulse jt (per unit mass) changes u by 3.5 * dv, so the impulse
  // that exactly kills slip is |u| / 3.5 — the standard 2/7 result for a sphere.
  function groundFriction(normalImpulse, mu) {
    const ux = vel.x + BALL_R * spin.z;
    const uz = vel.z - BALL_R * spin.x;
    const us = Math.hypot(ux, uz);
    if (us < 1e-5) return 0;
    const jt = Math.min(mu * normalImpulse, us / 3.5);
    const ax = -(ux / us) * jt, az = -(uz / us) * jt;
    vel.x += ax; vel.z += az;
    // dw = -(5 / 2r) * (yhat x dv)
    spin.x += -(2.5 / BALL_R) * az;
    spin.z += (2.5 / BALL_R) * ax;
    return jt;
  }

  function integrate(dt, world) {
    const ev = world.events || {};

    // --- aerodynamics ------------------------------------------------------
    const speed = vel.length();
    if (speed > 0.02) {
      const d = DRAG_K * speed * dt;
      vel.x -= vel.x * d; vel.y -= vel.y * d; vel.z -= vel.z * d;

      if (!body.grounded) {
        _m.crossVectors(spin, vel).multiplyScalar(MAGNUS_K * dt);
        vel.add(_m);
      }
    }
    vel.y += G * dt;

    // spin bleeds off in the air
    const sd = Math.exp(-SPIN_AIR_DECAY * dt);
    spin.multiplyScalar(sd);

    pos.addScaledVector(vel, dt);

    // --- ground ------------------------------------------------------------
    if (pos.y <= BALL_R) {
      pos.y = BALL_R;
      const down = -vel.y;
      if (down > BOUNCE_MIN) {
        // impulsive bounce: harder hits lose proportionally more energy
        const e = E_MIN + (E_BASE - E_MIN) / (1 + down / E_FADE);
        vel.y = down * e;
        groundFriction(down * (1 + e), MU_IMPACT);
        spin.y *= 0.80;
        body.grounded = false;
        body.impactId = ++impactId;
        body.impactSpeed = down;
        if (ev.onBounce) ev.onBounce(down, pos);
      } else {
        if (vel.y < 0) vel.y = 0;
        body.grounded = true;

        // sliding friction over the step (normal impulse = g * dt)
        groundFriction(-G * dt, MU_SLIDE);

        const ux = vel.x + BALL_R * spin.z;
        const uz = vel.z - BALL_R * spin.x;
        const slipping = Math.hypot(ux, uz) > 0.05;

        const hs = Math.hypot(vel.x, vel.z);
        if (!slipping && hs > 1e-4) {
          // true rolling: constant rolling resistance, spin locked to velocity
          const dec = Math.min(hs, ROLL_RES * dt);
          vel.x -= (vel.x / hs) * dec;
          vel.z -= (vel.z / hs) * dec;
          spin.z = -vel.x / BALL_R;
          spin.x = vel.z / BALL_R;
          // sidespin steers a rolling ball across the grass
          if (Math.abs(spin.y) > 0.2) {
            const k = GRASS_CURVE * spin.y * dt;
            const nx = vel.x, nz = vel.z;
            vel.x += nz * k; vel.z -= nx * k;
          }
        }
        spin.y *= Math.max(0, 1 - 2.6 * dt);

        if (hs < REST_SPEED && Math.abs(vel.y) < REST_SPEED) {
          vel.set(0, 0, 0);
          spin.multiplyScalar(Math.max(0, 1 - 6 * dt));
        }
      }
    } else {
      body.grounded = false;
    }

    // --- goals: posts, crossbar, net ---------------------------------------
    body.inNet = false;
    if (world.goals) {
      for (const g of world.goals) collideGoal(g, dt, ev);
    }

    // --- pitch bounds ------------------------------------------------------
    const b = world.bounds;
    if (b) {
      outLatch = Math.max(0, outLatch - dt);
      if (!body.inNet && outLatch <= 0) {
        if (Math.abs(pos.z) > b.halfD + BALL_R * 0.5) {
          outLatch = 0.6;
          if (ev.onOut) ev.onOut('throw', pos);
        } else if (Math.abs(pos.x) > b.halfW + BALL_R * 0.5) {
          const inMouth = Math.abs(pos.z) < 4 && pos.y < 3.2;
          if (!inMouth) {
            outLatch = 0.6;
            if (ev.onOut) ev.onOut(pos.x > 0 ? 'goalkickR' : 'goalkickL', pos);
          }
        }
      }
      // hard cage so the ball can never escape the stadium
      const cageX = b.halfW + 8, cageZ = b.halfD + 6;
      if (Math.abs(pos.x) > cageX) { pos.x = Math.sign(pos.x) * cageX; vel.x *= -0.35; }
      if (Math.abs(pos.z) > cageZ) { pos.z = Math.sign(pos.z) * cageZ; vel.z *= -0.35; }
    }
  }

  // A gentle ping off the woodwork springs away; a hammered shot loses most of
  // its energy to the frame and drops.
  function postE(v) { return POST_E_MIN + (POST_E - POST_E_MIN) / (1 + v / 16); }

  // -------------------------------------------------------------------------
  // goal frame + net
  // -------------------------------------------------------------------------
  function collideGoal(g, dt, ev) {
    const side = g.side;
    const gx = g.posts[0].x;
    const HW = Math.abs(g.posts[1].z);
    const barY = g.crossbarY;
    const depth = Math.abs(g.backX - gx);

    // quick reject: nowhere near this goal
    if (Math.abs(pos.x - gx) > depth + 2.0 || Math.abs(pos.z) > HW + 2.0 || pos.y > barY + 1.2) return;

    // ---- posts (vertical cylinders) ----
    for (const p of g.posts) {
      if (pos.y > barY + BALL_R) continue;
      const dx = pos.x - p.x, dz = pos.z - p.z;
      const rr = p.r + BALL_R;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const nx = dx / d, nz = dz / d;
      pos.x = p.x + nx * rr;
      pos.z = p.z + nz * rr;
      const vn = vel.x * nx + vel.z * nz;
      if (vn < 0) {
        const e = postE(-vn);
        vel.x -= (1 + e) * vn * nx;
        vel.z -= (1 + e) * vn * nz;
        // glancing contact off a round post kicks up sidespin
        const vt = -vel.x * nz + vel.z * nx;
        spin.y += vt * 1.4;
        body.impactId = ++impactId;
        body.impactSpeed = Math.abs(vn);
        if (ev.onPost) ev.onPost(pos, Math.abs(vn));
      }
    }

    // ---- crossbar (horizontal cylinder along Z at x = gx, y = barY) ----
    if (Math.abs(pos.z) <= HW + BALL_R) {
      const dx = pos.x - gx, dy = pos.y - barY;
      const rr = g.posts[0].r + BALL_R;
      const d2 = dx * dx + dy * dy;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2) || 1e-4;
        const nx = dx / d, ny = dy / d;
        pos.x = gx + nx * rr;
        pos.y = barY + ny * rr;
        const vn = vel.x * nx + vel.y * ny;
        if (vn < 0) {
          const e = postE(-vn);
          vel.x -= (1 + e) * vn * nx;
          vel.y -= (1 + e) * vn * ny;
          body.impactId = ++impactId;
          body.impactSpeed = Math.abs(vn);
          if (ev.onPost) ev.onPost(pos, Math.abs(vn));
        }
      }
    }

    // ---- net volume ----
    // Inside the mouth and past the goal line: the net is a soft, heavily damped
    // wall, so the ball sinks into it, pushes it out and drops rather than
    // bouncing off a hard plane.
    const inside = side > 0 ? pos.x > gx : pos.x < gx;
    if (!inside || pos.y > barY + BALL_R || Math.abs(pos.z) > HW + 0.35) return;

    body.inNet = true;

    if (!goalLatch[side > 0 ? 0 : 1] && g.contains(pos.x, pos.y, pos.z)) {
      goalLatch[side > 0 ? 0 : 1] = true;
      if (ev.onGoal) ev.onGoal(side, pos);
    }

    // The net is not a wall. It is a slack mesh: it absorbs almost all of the
    // shot, gives back a token 10%, and is pushed back out over a couple of
    // frames rather than instantly — which is exactly the window world/goal.js
    // needs to bulge the cloth. The ball ends up dead in the net, not rebounding
    // back onto the pitch.
    const ease = Math.min(1, NET_PUSH * dt);
    let hit = false;
    let struck = 0;

    // Back sheet slopes away from the crossbar: shallow at the top, deep at the
    // foot. world/goal.js owns that profile and publishes it as sheetDepthAt(y);
    // the fallback ramp only runs for a goal object that predates the accessor.
    const sheetDepth = g.sheetDepthAt
      ? g.sheetDepthAt(pos.y)
      : depth * (0.42 + 0.58 * clamp(1 - pos.y / barY, 0, 1));
    const sheet = gx + side * sheetDepth;
    const pen = side * (pos.x - sheet) + BALL_R;
    if (pen > 0) {
      pos.x -= side * pen * ease;
      const vin = side * vel.x;
      if (vin > 0) { struck = Math.max(struck, vin); vel.x = -side * vin * NET_E; }
      hit = true;
    }
    // hard backstop: nothing gets through the ground bar at the back of the net
    const maxDepth = depth - BALL_R * 0.5;
    if (side * (pos.x - gx) > maxDepth) {
      pos.x = gx + side * maxDepth;
      if (side * vel.x > 0) vel.x = 0;
    }

    // side panels
    const zpen = Math.abs(pos.z) + BALL_R - HW;
    if (zpen > 0) {
      const s = Math.sign(pos.z) || 1;
      pos.z -= s * zpen * ease;
      const vin = s * vel.z;
      if (vin > 0) { struck = Math.max(struck, vin); vel.z = -s * vin * NET_E; }
      hit = true;
    }

    // roof panel
    const ypen = pos.y + BALL_R - barY;
    if (ypen > 0 && Math.abs(pos.x - gx) > g.posts[0].r + BALL_R) {
      pos.y -= ypen * ease;
      if (vel.y > 0) { struck = Math.max(struck, vel.y); vel.y = -vel.y * NET_E; }
      hit = true;
    }

    if (hit) {
      // the mesh drags the ball down fast — this is what makes a goal read
      const k = Math.max(0, 1 - NET_DRAG * dt);
      vel.x *= k; vel.z *= k;
      if (vel.y > 0) vel.y *= k;
      spin.multiplyScalar(Math.max(0, 1 - 11 * dt));
      if (struck > 1.5) { body.impactId = ++impactId; body.impactSpeed = struck * 0.5; }
      if (ev.onNet) ev.onNet(pos, struck);
    }
  }

  return body;
}

// ---------------------------------------------------------------------------
// player <-> player separation
// ---------------------------------------------------------------------------

export function separatePlayers(players, dt) {
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (a.down || b.down) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const min = PLAYER_R * 2 * 0.82;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) * 0.5;
      const nx = dx / d, nz = dz / d;
      a.pos.x -= nx * push; a.pos.z -= nz * push;
      b.pos.x += nx * push; b.pos.z += nz * push;
    }
  }
}

// ---------------------------------------------------------------------------
// player <-> ball
// ---------------------------------------------------------------------------

// Vertical collider bands for a 2.0 m chibi. `r` scales the horizontal radius,
// `e` is restitution, `lift` is how much of the closing speed becomes upward
// velocity, `spin` how much tangential slip becomes yaw spin.
const BAND_FOOT_Y = 0.42;      // boots / shins
const BAND_TORSO_Y = 1.18;     // hips, chest, arms
const BAND_HEAD_Y = 1.90;      // the big chibi head
const BAND = {
  foot: { r: 0.72, e: 0.26, lift: 0.06, spin: 1.15, kind: 'foot' },
  torso: { r: 1.00, e: 0.40, lift: 0.22, spin: 0.90, kind: 'torso' },
  head: { r: 0.78, e: 0.62, lift: 0.55, spin: 0.55, kind: 'head' },
};

/**
 * Nudge / dribble contact. Returns the player who touched the ball this step, or null.
 * Deliberate kicks come from sim/match.js and sim/ai.js via body.kick().
 *
 * The player is a moving cylinder: the ball bounces off it with restitution AND
 * inherits a share of the player's momentum, so running through the ball shoves it
 * forward instead of letting it hang in the air.
 */
export function ballPlayerContact(body, players, dt, events = {}) {
  let touched = null;
  for (const p of players) {
    if (p.down) continue;
    // Three bands, not one cylinder: the boots are narrow and dead, the torso is
    // wide and soft, the head is narrow and lively. One cutoff made a header and
    // a shin deflection behave identically.
    const y = body.pos.y;
    let band;
    if (y < BAND_FOOT_Y) band = BAND.foot;
    else if (y < BAND_TORSO_Y) band = BAND.torso;
    else if (y < BAND_HEAD_Y) band = BAND.head;
    else continue;                                  // sails over

    const reach = PLAYER_R * band.r + BALL_R * 0.95;
    const dx = body.pos.x - p.pos.x;
    const dz = body.pos.z - p.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > reach * reach) continue;
    const d = Math.sqrt(d2) || 1e-4;
    const nx = dx / d, nz = dz / d;

    body.pos.x = p.pos.x + nx * reach;
    body.pos.z = p.pos.z + nz * reach;

    const pvx = p.vel ? p.vel.x : 0;
    const pvz = p.vel ? p.vel.z : 0;
    const relx = body.vel.x - pvx;
    const relz = body.vel.z - pvz;
    const vn = relx * nx + relz * nz;
    let impact = 0;
    if (vn < 0) {
      // restitution against the body, resolved in the player's frame
      body.vel.x -= (1 + band.e) * vn * nx;
      body.vel.z -= (1 + band.e) * vn * nz;
      // scuffed contact spins the ball
      const vt = -relx * nz + relz * nx;
      body.spin.y += vt * band.spin;
      // a head or chest contact pops the ball up; a boot keeps it down
      if (band.lift > 0) body.vel.y += Math.min(-vn, 14) * band.lift;
      impact = -vn;
    }
    // momentum transfer: a striker running onto the ball drives it on
    const pv = Math.hypot(pvx, pvz);
    if (pv > 0.2) {
      const along = (pvx * nx + pvz * nz) / pv;
      if (along > 0) {
        const push = Math.min(1, 26 * dt) * along;
        body.vel.x += (pvx * 1.28 - body.vel.x) * push;
        body.vel.z += (pvz * 1.28 - body.vel.z) * push;
        impact = Math.max(impact, pv * along * 0.4);
      }
    }
    // rolling spin follows the new velocity when the ball is on the deck
    if (body.grounded) {
      body.spin.z = -body.vel.x / BALL_R;
      body.spin.x = body.vel.z / BALL_R;
    }

    body.lastTouch = p;
    body.lastTouchTeam = p.team;
    body.lastTouchPart = band.kind;
    touched = p;
    if (events.onTouch) events.onTouch(p, impact, band.kind);
  }
  return touched;
}
