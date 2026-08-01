# Canvas Soccer

An arcade football game in the browser, built with [three.js](https://threejs.org/).
Plain ES modules, no build step, and **no binary assets** — every texture, sprite sheet
and sound is generated procedurally at runtime from canvas 2D and WebAudio.

## Play

Serve the directory and open it (ES modules do not load over `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Controls

The left hand plays the game, the right hand steers — so **A**, **S** and **D**
are actions, not movement, and two of them change meaning with the ball. The
on-screen legend says which half of the game you are in and relabels itself.

| Input | Attacking | Defending |
|---|---|---|
| **Arrows**, left stick, or the on-screen stick | Move the selected player | ← |
| **D**, or pad **A** | Shoot — hold to power it | ← |
| **S**, or pad **X** | Pass | Tap: switch player · Hold: close him down |
| **A**, or pad **B** | Lob | Slide tackle |
| **Shift**, or pad **RT** | Sprint | ← |
| **H** · **Esc** | Show the controls · Pause | ← |

Holding **S** while defending does not take the ball off anyone by itself: it
puts your man on the carrier's shoulder and leans on him, and the contested
possession model decides whether the challenge is won.

The first click or keypress starts live play (and unlocks audio — browsers require a
user gesture before an `AudioContext` may start).

## Layout

```
index.html                 importmap, canvas host, boot only. No game logic.
vendor/three/              three.js r160, vendored as plain ES-module text
src/main.js                wiring + fixed-timestep loop + window.__debug
src/core/rng.js            seeded mulberry32. Nothing calls Math.random()
src/core/constants.js      shared world constants (data only)
src/core/engine.js         renderer, scene, post chain, resize, quality tiers
src/core/assets.js         procedural textures: turf, ad boards, crowd, faces, kits, ball
src/world/pitch.js         mow stripes, painted lines, wear decals
src/world/stadium.js       stands, instanced crowd, boards, floodlights, roof, jumbotron
src/world/goal.js          goal frame + verlet net
src/entities/player.js     chibi rig, kit/skin/hair/number variation
src/entities/animation.js  procedural animation state machine
src/entities/ball.js       ball mesh, spin, trail ribbon
src/sim/physics.js         ball integration (drag, Magnus, bounce, roll) + collisions
src/sim/ai.js              formations, roles, goalkeeper AI
src/sim/match.js           rules, phases, kickoff, goals, clock, score
src/fx/vfx.js              impact bursts, dust, scuff, confetti, goal explosion
src/fx/camera.js           camera director: follow, shake, cinematic cuts
src/audio/audio.js         procedural SFX + crowd ambience
src/ui/hud.js              scoreboard, virtual stick, action buttons, banners
```

### Why three.js is vendored

three.js r160 is checked in under `vendor/three/` as plain text ES modules (see
`vendor/README.md`) so the game runs deterministically and without network access.
The paths mirror `https://unpkg.com/three@0.160.0/{build,examples/jsm}/` exactly, so
pointing the two importmap entries at those URLs is the only change needed to load
from the CDN instead.

## Determinism & the debug harness

Everything random comes from `src/core/rng.js`. `src/main.js` exposes:

```js
window.__debug = {
  ready,                    // true after the first successful frame
  scenario(name),           // arrange the world deterministically
  settle(),                 // 120 fixed 1/60 steps + one render, then freeze
  perf(),                   // { fps, drawCalls, triangles, programs }
  state(),                  // { score, phase, clock, ballPos, players }
};
```

Scenarios: `kickoff`, `attack`, `shot`, `goal`, `tackle`, `closeup`, `keeper`, `wide`.

## Camera / geometry gotchas

- The stand roofs sit at `y = 31` with their inner edge 29 units out (`ROOF_Y` /
  `ROOF_IN` in `world/stadium.js`). A camera above the roof looking down at a shallow
  angle is silently occluded by it, so `broadcast` stays *under* the roofline and
  `wide` is steep enough (height/back > ~1.07) to look *over* it.
- Painted-line quads are wound for a `+Y` normal; XZ-plane loops need reversed indices.
