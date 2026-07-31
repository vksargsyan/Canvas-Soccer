// Procedural SFX + crowd ambience. No audio files.
//
//   createAudio() -> { kick(power), tackle(), whistle(k), crowd(level), goal(),
//                      post(), unlock(), setMuted(b), suspended }
//
// IMPORTANT: an AudioContext cannot start without a user gesture. In a headless
// capture there is none, so the context is created lazily inside unlock() and every
// method is a guarded no-op until it is actually running. Nothing here may throw.

const HAS_AUDIO = typeof window !== 'undefined'
  && (typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined');

export function createAudio() {
  let ctx = null;
  let master = null;
  let crowdGain = null;
  let crowdSrc = null;
  let muted = false;
  let unlocked = false;

  const ok = () => !!(ctx && ctx.state === 'running' && !muted);

  function ensure() {
    if (ctx || !HAS_AUDIO) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  function unlock() {
    try {
      if (!ensure()) return false;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (!unlocked) { unlocked = true; startCrowd(); }
      return true;
    } catch (e) { return false; }
  }

  // ---- primitives ---------------------------------------------------------

  function env(node, t0, a, d, peak = 1) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    node.connect(g);
    g.connect(master);
    return g;
  }

  function noiseBuffer(seconds = 1) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // deterministic LCG so audio never touches Math.random
    let s = 22222;
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    return buf;
  }

  let noiseBuf = null;
  function noise(dur, filterType, freq, q, peak) {
    if (!noiseBuf) noiseBuf = noiseBuffer(1.5);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    src.connect(f);
    const t0 = ctx.currentTime;
    env(f, t0, 0.004, dur, peak);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
    return { src, f };
  }

  function tone(type, f0, f1, dur, peak) {
    const o = ctx.createOscillator();
    o.type = type;
    const t0 = ctx.currentTime;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    env(o, t0, 0.005, dur, peak);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    return o;
  }

  // ---- crowd --------------------------------------------------------------
  function startCrowd() {
    if (!ok()) return;
    try {
      if (!noiseBuf) noiseBuf = noiseBuffer(2.5);
      crowdSrc = ctx.createBufferSource();
      crowdSrc.buffer = noiseBuf;
      crowdSrc.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'bandpass'; lp.frequency.value = 520; lp.Q.value = 0.6;
      crowdGain = ctx.createGain();
      crowdGain.gain.value = 0.05;
      crowdSrc.connect(lp); lp.connect(crowdGain); crowdGain.connect(master);
      crowdSrc.start();
    } catch (e) { /* ignore */ }
  }

  // ---- public -------------------------------------------------------------

  function kick(power = 1) {
    if (!ok()) return;
    try {
      const p = Math.min(1.4, Math.max(0.2, power));
      noise(0.09, 'bandpass', 900 + p * 700, 1.2, 0.5 * p);
      tone('sine', 190 * p, 60, 0.14, 0.34 * p);
    } catch (e) { /* ignore */ }
  }

  function tackle() {
    if (!ok()) return;
    try {
      noise(0.28, 'lowpass', 700, 0.7, 0.42);
      tone('triangle', 120, 50, 0.2, 0.25);
    } catch (e) { /* ignore */ }
  }

  function post() {
    if (!ok()) return;
    try {
      tone('triangle', 880, 520, 0.5, 0.4);
      tone('sine', 1760, 1200, 0.35, 0.14);
    } catch (e) { /* ignore */ }
  }

  function whistle(k = 1) {
    if (!ok()) return;
    try {
      const dur = k > 1 ? 0.75 : 0.36;
      tone('square', 2350, 2500, dur, 0.16);
      tone('sine', 3100, 3250, dur, 0.10);
    } catch (e) { /* ignore */ }
  }

  function crowd(level = 0.3) {
    if (!ok() || !crowdGain) return;
    try {
      const t0 = ctx.currentTime;
      crowdGain.gain.cancelScheduledValues(t0);
      crowdGain.gain.setTargetAtTime(Math.max(0.001, Math.min(0.5, level)), t0, 0.4);
    } catch (e) { /* ignore */ }
  }

  function goal() {
    if (!ok()) return;
    try {
      crowd(0.42);
      whistle(1);
      tone('sawtooth', 320, 640, 0.5, 0.2);
      setTimeout(() => crowd(0.16), 4000);
    } catch (e) { /* ignore */ }
  }

  return {
    kick, tackle, whistle, crowd, goal, post, unlock,
    setMuted(v) { muted = !!v; if (master) { try { master.gain.value = v ? 0 : 0.55; } catch (e) {} } },
    get suspended() { return !ok(); },
    get context() { return ctx; },
  };
}
