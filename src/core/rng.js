// Seeded deterministic RNG. Nothing in this project may call Math.random().
//
//   import { rng, makeRng } from '../core/rng.js';
//
// `rng` is the shared gameplay stream (seed 1337). Anything that must not perturb
// that stream (texture bakes, mesh jitter) should allocate its own makeRng(seed).

export function makeRng(seed = 1337) {
  let a = (seed >>> 0) || 0x9e3779b9;

  function float() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    float,
    /** uniform in [lo, hi) */
    range(lo, hi) { return lo + (hi - lo) * float(); },
    /** integer in [0, n) */
    int(n) { return Math.min(n - 1, Math.floor(float() * n)); },
    /** random element */
    pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(float() * arr.length))]; },
    /** -1 or +1 */
    sign() { return float() < 0.5 ? -1 : 1; },
    /** uniform in [-1, 1) */
    unit() { return float() * 2 - 1; },
    /** approx. gaussian, mean 0 sigma 1 */
    gauss() { return (float() + float() + float() + float() - 2) * 1.1547; },
    /** true with probability p */
    chance(p) { return float() < p; },
    /** restart the stream — scenario setup calls this so frames are reproducible */
    reseed(s) { a = (s >>> 0) || 0x9e3779b9; },
  };
}

export const rng = makeRng(1337);
export const SEED = 1337;
