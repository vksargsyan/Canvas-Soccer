// Procedural SFX + stadium ambience. WebAudio only — no audio files, no RNG from
// Math.random (a small deterministic LCG drives every "randomised" detail).
//
//   createAudio() -> {
//     kick(power), pass(power), tackle(), post(), net(power), whistle(kind),
//     footstep(intensity, surface), crowd(level), setDanger(x), goal(), save(),
//     ui(kind), unlock(), setMuted(b), update(dt), suspended, context
//   }
//
// HEADLESS SAFETY: an AudioContext cannot start without a user gesture, and the
// capture harness never produces one. The context is created lazily, every public
// method is a guarded no-op until it is genuinely running, and nothing in this file
// may throw under any circumstance.

const HAS_AUDIO = typeof window !== 'undefined'
  && (typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined');

export function createAudio() {
  let ctx = null;
  let master = null;        // everything lands here
  let comp = null;          // glue compressor before the destination
  let dry = null;           // SFX bus
  let verb = null;          // convolver
  let verbSend = null;
  let muted = false;
  let started = false;      // ambience running

  // crowd bed nodes
  let crowdBus = null, crowdLow = null, crowdMid = null, crowdFilter = null;
  let crowdSrcs = [];
  let crowdLevel = 0.14, crowdTarget = 0.14, danger = 0;

  let noiseBuf = null;
  let voices = 0;
  const lastAt = Object.create(null);

  // deterministic jitter — never Math.random
  let seed = 0x9e3779b9;
  function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const jit = (a) => 1 + (rnd() * 2 - 1) * a;

  const ok = () => !!(ctx && ctx.state === 'running' && !muted && master);
  const now = () => (ctx ? ctx.currentTime : 0);

  // rate-limit so a burst of sim events cannot spawn hundreds of voices
  function gate(key, minGap) {
    const t = now();
    if (lastAt[key] !== undefined && t - lastAt[key] < minGap) return false;
    lastAt[key] = t;
    return voices < 28;
  }

  // ------------------------------------------------------------------ graph
  function ensure() {
    if (ctx || !HAS_AUDIO) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();

      comp = ctx.createDynamicsCompressor();
      try {
        comp.threshold.value = -16;
        comp.knee.value = 22;
        comp.ratio.value = 4;
        comp.attack.value = 0.004;
        comp.release.value = 0.22;
      } catch (e) { /* ignore */ }
      comp.connect(ctx.destination);

      master = ctx.createGain();
      master.gain.value = 0.62;
      master.connect(comp);

      dry = ctx.createGain();
      dry.gain.value = 1;
      dry.connect(master);

      // stadium tail
      verb = ctx.createConvolver();
      verb.buffer = impulse(1.9, 2.6);
      verbSend = ctx.createGain();
      verbSend.gain.value = 0.30;
      verbSend.connect(verb);
      verb.connect(master);
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  function noiseBuffer(seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    return buf;
  }

  // Procedural stadium impulse: a short cluster of early reflections followed by a
  // smooth exponential tail, decorrelated between channels.
  function impulse(seconds, decay) {
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    let s = 7654321;
    const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        d[i] = r() * Math.pow(1 - t, decay) * 0.7;
      }
      // early reflections
      const taps = [0.011, 0.019, 0.031, 0.047, 0.068, 0.091];
      for (let k = 0; k < taps.length; k++) {
        const i = Math.floor((taps[k] + ch * 0.003) * ctx.sampleRate);
        if (i < n) d[i] += (k % 2 ? -1 : 1) * (0.55 - k * 0.07);
      }
    }
    return buf;
  }

  function unlock() {
    try {
      if (!ensure()) return false;
      if (ctx.state === 'suspended') {
        const p = ctx.resume();
        if (p && p.then) p.then(() => { try { startAmbience(); } catch (e) {} }).catch(() => {});
      }
      startAmbience();
      return true;
    } catch (e) { return false; }
  }

  // Self-arm: if anything at all in the page produces a gesture, come alive.
  // Also give the HUD's own controls click feedback without needing the integrator
  // to wire anything — the classes come from ui/hud.js, which this file ships with.
  if (typeof window !== 'undefined') {
    const arm = () => { unlock(); };
    try {
      window.addEventListener('pointerdown', arm, { once: true, capture: true });
      window.addEventListener('keydown', arm, { once: true, capture: true });
      window.addEventListener('touchstart', arm, { once: true, capture: true });
      window.addEventListener('pointerdown', (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('.cs-cta')) ui('confirm');
        else if (t.closest('.cs-btn') || t.closest('.cs-sys')) ui('tap');
      }, true);
    } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------- primitives
  function track(node, until) {
    voices++;
    const ms = Math.max(40, (until - now()) * 1000 + 120);
    setTimeout(() => {
      voices = Math.max(0, voices - 1);
      try { node.disconnect(); } catch (e) { /* ignore */ }
    }, ms);
  }

  /** Amplitude envelope -> dry bus (+ optional reverb send). */
  function shape(src, t0, attack, hold, decay, peak, send = 0.5) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.0004, peak), t0 + attack);
    if (hold > 0) g.gain.setValueAtTime(Math.max(0.0004, peak), t0 + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);
    src.connect(g);
    g.connect(dry);
    if (send > 0 && verbSend) {
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(verbSend);
    }
    track(g, t0 + attack + hold + decay);
    return g;
  }

  function noiseVoice(opts) {
    const { t0, dur, type = 'bandpass', f0, f1 = f0, q = 1, peak = 0.3, attack = 0.002, send = 0.4 } = opts;
    if (!noiseBuf) noiseBuf = noiseBuffer(2.0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.85 + rnd() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(Math.max(20, f0), t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    f.Q.value = q;
    src.connect(f);
    shape(f, t0, attack, 0, dur, peak, send);
    src.start(t0 + rnd() * 0.5);
    src.stop(t0 + dur + 0.08);
    return src;
  }

  function toneVoice(opts) {
    const { t0, type = 'sine', f0, f1 = f0, dur, peak = 0.2, attack = 0.004, hold = 0, send = 0.35, detune = 0 } = opts;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    if (detune) o.detune.value = detune;
    shape(o, t0, attack, hold, dur, peak, send);
    o.start(t0);
    o.stop(t0 + attack + hold + dur + 0.08);
    return o;
  }

  // ----------------------------------------------------------------- ambience
  function startAmbience() {
    if (started || !ok()) return;
    started = true;
    try {
      if (!noiseBuf) noiseBuf = noiseBuffer(3.0);

      crowdBus = ctx.createGain();
      crowdBus.gain.value = crowdLevel;
      crowdBus.connect(master);
      // a little of the bed through the tail keeps it sitting in the bowl
      if (verbSend) {
        const s = ctx.createGain(); s.gain.value = 0.25;
        crowdBus.connect(s); s.connect(verbSend);
      }

      // low rumble
      const l = ctx.createBufferSource();
      l.buffer = noiseBuf; l.loop = true; l.playbackRate.value = 0.72;
      crowdLow = ctx.createBiquadFilter();
      crowdLow.type = 'lowpass'; crowdLow.frequency.value = 260; crowdLow.Q.value = 0.4;
      const lg = ctx.createGain(); lg.gain.value = 0.55;
      l.connect(crowdLow); crowdLow.connect(lg); lg.connect(crowdBus);
      l.start();

      // mid "murmur" — this is the band that opens up as danger rises
      const m = ctx.createBufferSource();
      m.buffer = noiseBuf; m.loop = true; m.playbackRate.value = 1.13;
      crowdFilter = ctx.createBiquadFilter();
      crowdFilter.type = 'bandpass'; crowdFilter.frequency.value = 620; crowdFilter.Q.value = 0.55;
      crowdMid = ctx.createGain(); crowdMid.gain.value = 0.5;
      m.connect(crowdFilter); crowdFilter.connect(crowdMid); crowdMid.connect(crowdBus);
      m.start();

      // slow breathing so the bed never sounds like static
      const lfo = ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 0.09;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.16;
      lfo.connect(lfoG); lfoG.connect(crowdMid.gain);
      lfo.start();

      const lfo2 = ctx.createOscillator();
      lfo2.type = 'sine'; lfo2.frequency.value = 0.031;
      const lfo2G = ctx.createGain(); lfo2G.gain.value = 120;
      lfo2.connect(lfo2G); lfo2G.connect(crowdFilter.frequency);
      lfo2.start();

      crowdSrcs = [l, m, lfo, lfo2];
    } catch (e) { started = false; }
  }

  function applyCrowd() {
    if (!ok() || !crowdBus) return;
    try {
      const t = now();
      const lvl = Math.max(0.001, Math.min(0.6, crowdTarget + danger * 0.16));
      crowdBus.gain.cancelScheduledValues(t);
      crowdBus.gain.setTargetAtTime(lvl, t, 0.55);
      if (crowdFilter) {
        crowdFilter.frequency.cancelScheduledValues(t);
        crowdFilter.frequency.setTargetAtTime(560 + danger * 700, t, 0.8);
      }
    } catch (e) { /* ignore */ }
  }

  function crowd(level = 0.16) {
    crowdTarget = Math.max(0, Math.min(0.55, level));
    crowdLevel = crowdTarget;
    applyCrowd();
  }

  function setDanger(x) {
    const v = Math.max(0, Math.min(1, x || 0));
    if (Math.abs(v - danger) < 0.02) return;
    danger = v;
    applyCrowd();
  }

  /** One-shot crowd reaction: swell, hold, settle. */
  function reaction(peak, rise, hold, fall) {
    if (!ok() || !crowdBus) return;
    try {
      const t = now();
      const base = Math.max(0.001, crowdTarget);
      crowdBus.gain.cancelScheduledValues(t);
      crowdBus.gain.setValueAtTime(Math.max(0.001, crowdBus.gain.value), t);
      crowdBus.gain.linearRampToValueAtTime(peak, t + rise);
      crowdBus.gain.setValueAtTime(peak, t + rise + hold);
      crowdBus.gain.exponentialRampToValueAtTime(base, t + rise + hold + fall);
      if (crowdFilter) {
        crowdFilter.frequency.cancelScheduledValues(t);
        crowdFilter.frequency.setValueAtTime(crowdFilter.frequency.value, t);
        crowdFilter.frequency.linearRampToValueAtTime(1650, t + rise);
        crowdFilter.frequency.setTargetAtTime(560 + danger * 700, t + rise + hold, fall * 0.4);
      }
    } catch (e) { /* ignore */ }
  }

  function applause(t0, dur, density, level) {
    // sparse filtered clicks read as clapping without a sample
    const n = Math.min(46, Math.round(dur * density));
    for (let i = 0; i < n; i++) {
      const t = t0 + (i / n) * dur + rnd() * 0.03;
      noiseVoice({
        t0: t, dur: 0.035 + rnd() * 0.03, type: 'bandpass',
        f0: 1400 + rnd() * 2200, q: 1.6, peak: level * (0.4 + rnd() * 0.6), send: 0.7,
      });
    }
  }

  // ------------------------------------------------------------------- SFX
  /** Ball strike. `power` ~0..1.4; louder, deeper and longer as it rises. */
  function kick(power = 1) {
    if (!ok() || !gate('kick', 0.045)) return;
    try {
      const p = Math.max(0.15, Math.min(1.4, power));
      const t = now();
      // leather transient
      noiseVoice({ t0: t, dur: 0.045, type: 'bandpass', f0: 2600 * jit(0.08), f1: 900, q: 0.9, peak: 0.30 * p, attack: 0.001, send: 0.28 });
      // body thump — deeper the harder it is hit
      toneVoice({ t0: t, type: 'sine', f0: 235 * (1.25 - p * 0.42) * jit(0.05), f1: 48, dur: 0.11 + p * 0.06, peak: 0.42 * p, attack: 0.002, send: 0.2 });
      // sub for weight
      toneVoice({ t0: t, type: 'sine', f0: 90 * jit(0.04), f1: 38, dur: 0.16 + p * 0.1, peak: 0.24 * p, attack: 0.003, send: 0.1 });
      // air / skin slap
      noiseVoice({ t0: t + 0.004, dur: 0.09 + p * 0.05, type: 'lowpass', f0: 1500 * p + 300, q: 0.6, peak: 0.14 * p, send: 0.5 });
    } catch (e) { /* ignore */ }
  }

  /** Softer, shorter strike for a pass. */
  function pass(power = 0.6) {
    if (!ok() || !gate('pass', 0.05)) return;
    try {
      const p = Math.max(0.15, Math.min(1, power));
      const t = now();
      noiseVoice({ t0: t, dur: 0.03, type: 'bandpass', f0: 2100 * jit(0.1), f1: 800, q: 1.1, peak: 0.18 * p, attack: 0.001, send: 0.25 });
      toneVoice({ t0: t, type: 'sine', f0: 260 * jit(0.06), f1: 70, dur: 0.09, peak: 0.26 * p, attack: 0.002, send: 0.2 });
    } catch (e) { /* ignore */ }
  }

  /** Ball on the woodwork: inharmonic metal partials over a hard transient. */
  function post() {
    if (!ok() || !gate('post', 0.08)) return;
    try {
      const t = now();
      const f = 760 * jit(0.06);
      noiseVoice({ t0: t, dur: 0.03, type: 'highpass', f0: 3000, q: 0.7, peak: 0.22, attack: 0.001, send: 0.4 });
      const partials = [1, 2.41, 3.83, 5.17, 7.02];
      const amps = [0.30, 0.17, 0.11, 0.07, 0.04];
      for (let i = 0; i < partials.length; i++) {
        toneVoice({
          t0: t, type: 'sine', f0: f * partials[i], f1: f * partials[i] * 0.985,
          dur: 0.9 - i * 0.11, peak: amps[i], attack: 0.001, send: 0.85,
        });
      }
      toneVoice({ t0: t, type: 'triangle', f0: 150, f1: 60, dur: 0.16, peak: 0.2, send: 0.2 });
      reaction(Math.max(0.001, crowdTarget) + 0.14, 0.12, 0.3, 1.4);
    } catch (e) { /* ignore */ }
  }

  /** Ball hitting the net — a soft, high, quickly-damped rustle. */
  function net(power = 1) {
    if (!ok() || !gate('net', 0.06)) return;
    try {
      const p = Math.max(0.2, Math.min(1.4, power));
      const t = now();
      noiseVoice({ t0: t, dur: 0.22 * p, type: 'highpass', f0: 2600, f1: 1400, q: 0.5, peak: 0.16 * p, attack: 0.004, send: 0.6 });
      noiseVoice({ t0: t + 0.02, dur: 0.34, type: 'bandpass', f0: 1200, f1: 620, q: 0.8, peak: 0.09 * p, attack: 0.02, send: 0.7 });
      toneVoice({ t0: t, type: 'sine', f0: 120, f1: 55, dur: 0.12, peak: 0.1 * p, send: 0.3 });
    } catch (e) { /* ignore */ }
  }

  /** Studs-and-shoulder contact: body thud plus a turf scrape. */
  function tackle() {
    if (!ok() || !gate('tackle', 0.07)) return;
    try {
      const t = now();
      toneVoice({ t0: t, type: 'sine', f0: 165 * jit(0.08), f1: 42, dur: 0.20, peak: 0.42, attack: 0.002, send: 0.3 });
      noiseVoice({ t0: t, dur: 0.06, type: 'lowpass', f0: 900, q: 0.7, peak: 0.34, attack: 0.001, send: 0.3 });
      // grass slide
      noiseVoice({ t0: t + 0.02, dur: 0.42, type: 'bandpass', f0: 2600, f1: 700, q: 0.5, peak: 0.16, attack: 0.03, send: 0.55 });
      reaction(Math.max(0.001, crowdTarget) + 0.07, 0.14, 0.2, 1.1);
    } catch (e) { /* ignore */ }
  }

  /** Footfall on turf. `surface`: 'grass' | 'dirt' | 'concrete'. */
  function footstep(intensity = 0.5, surface = 'grass') {
    if (!ok() || !gate('foot', 0.055)) return;
    try {
      const i = Math.max(0.1, Math.min(1, intensity));
      const t = now();
      const conf = surface === 'concrete'
        ? { f: 3200, q: 1.4, low: 260, peak: 0.16 }
        : surface === 'dirt'
          ? { f: 1500, q: 0.6, low: 150, peak: 0.13 }
          : { f: 2100, q: 0.5, low: 130, peak: 0.11 };
      noiseVoice({ t0: t, dur: 0.05 + rnd() * 0.02, type: 'bandpass', f0: conf.f * jit(0.18), f1: conf.f * 0.45, q: conf.q, peak: conf.peak * i, attack: 0.001, send: 0.3 });
      toneVoice({ t0: t, type: 'sine', f0: conf.low * jit(0.12), f1: 45, dur: 0.06, peak: 0.09 * i, attack: 0.001, send: 0.15 });
    } catch (e) { /* ignore */ }
  }

  /** Referee whistle. k>=2 is the long full-time blast. */
  function whistle(k = 1) {
    if (!ok()) return;
    try {
      const t = now();
      const dur = k >= 2 ? 0.95 : 0.34;
      const f = 2480;
      // pea rattle: fast frequency warble on the fundamental
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      const lfo = ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 26;
      const lg = ctx.createGain(); lg.gain.value = 190;
      lfo.connect(lg); lg.connect(o.frequency);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f * 1.05; bp.Q.value = 5;
      o.connect(bp);
      shape(bp, t, 0.012, dur * 0.62, dur * 0.42, 0.20, 0.7);
      o.start(t); o.stop(t + dur + 0.2);
      lfo.start(t); lfo.stop(t + dur + 0.2);
      // breathy top
      noiseVoice({ t0: t, dur: dur * 0.9, type: 'bandpass', f0: 3500, q: 6, peak: 0.07, attack: 0.015, send: 0.7 });
      toneVoice({ t0: t, type: 'sine', f0: f * 1.5, dur: dur * 0.85, peak: 0.045, attack: 0.02, send: 0.7 });
      if (k >= 2) reaction(Math.max(0.001, crowdTarget) + 0.2, 0.5, 1.2, 3.0);
    } catch (e) { /* ignore */ }
  }

  /** Big one: net, roar, claps, air horn. */
  function goal() {
    if (!ok()) return;
    try {
      const t = now();
      net(1.2);
      reaction(0.5, 0.35, 2.4, 4.5);
      applause(t + 0.18, 2.6, 16, 0.10);
      // stadium horn — a stacked fifth, slightly detuned
      toneVoice({ t0: t + 0.06, type: 'sawtooth', f0: 196, dur: 0.9, hold: 0.35, peak: 0.11, attack: 0.05, send: 0.8 });
      toneVoice({ t0: t + 0.06, type: 'sawtooth', f0: 294, dur: 0.9, hold: 0.35, peak: 0.085, attack: 0.06, send: 0.8, detune: 8 });
      toneVoice({ t0: t + 0.62, type: 'sawtooth', f0: 392, dur: 1.1, hold: 0.3, peak: 0.075, attack: 0.05, send: 0.8 });
      // rising cheer sweep
      noiseVoice({ t0: t + 0.05, dur: 1.6, type: 'bandpass', f0: 420, f1: 1800, q: 0.5, peak: 0.16, attack: 0.25, send: 0.9 });
    } catch (e) { /* ignore */ }
  }

  /** Keeper save / near miss — a shorter "ooooh". */
  function save() {
    if (!ok()) return;
    try {
      const t = now();
      noiseVoice({ t0: t, dur: 0.05, type: 'lowpass', f0: 1100, q: 0.6, peak: 0.24, attack: 0.001, send: 0.3 });
      reaction(Math.max(0.001, crowdTarget) + 0.20, 0.18, 0.5, 2.0);
      applause(t + 0.25, 1.1, 10, 0.06);
    } catch (e) { /* ignore */ }
  }

  /** UI feedback. kind: 'tap' | 'confirm' | 'back'. */
  function ui(kind = 'tap') {
    if (!ok() || !gate('ui', 0.04)) return;
    try {
      const t = now();
      if (kind === 'confirm') {
        toneVoice({ t0: t, type: 'triangle', f0: 660, dur: 0.09, peak: 0.13, send: 0.2 });
        toneVoice({ t0: t + 0.07, type: 'triangle', f0: 990, dur: 0.14, peak: 0.11, send: 0.25 });
      } else if (kind === 'back') {
        toneVoice({ t0: t, type: 'triangle', f0: 520, f1: 330, dur: 0.12, peak: 0.10, send: 0.2 });
      } else {
        toneVoice({ t0: t, type: 'square', f0: 1250, f1: 1100, dur: 0.035, peak: 0.055, send: 0.15 });
      }
    } catch (e) { /* ignore */ }
  }

  /** Optional per-frame hook; keeps the bed drifting if a caller wants it. */
  function update() { /* the LFOs run in the audio graph; nothing to do per frame */ }

  return {
    kick, pass, tackle, post, net, whistle, footstep, crowd, setDanger,
    goal, save, ui, unlock, update,
    setMuted(v) {
      muted = !!v;
      try { if (master) master.gain.value = muted ? 0 : 0.62; } catch (e) { /* ignore */ }
    },
    get muted() { return muted; },
    get suspended() { return !ok(); },
    get context() { return ctx; },
  };
}
