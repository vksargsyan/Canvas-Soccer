// Boot profiler. Records how long each procedural bake takes and how often it is
// asked for, so startup cost can be attributed to a named texture instead of
// guessed at. Zero cost when disabled.
//
// Enable with ?prof=1 (or window.__PROFILE = true before the module graph loads).
// Read the result with window.__bootProfile.table().

const ON = (() => {
  try {
    if (typeof window === 'undefined') return false;
    if (window.__PROFILE) return true;
    return /[?&]prof=1/.test(window.location.search || '');
  } catch { return false; }
})();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** key -> { ms, calls, misses } */
const rows = new Map();
const T0 = now();

function record(key, ms, miss) {
  let r = rows.get(key);
  if (!r) { r = { ms: 0, calls: 0, misses: 0 }; rows.set(key, r); }
  r.calls++;
  if (miss) { r.misses++; r.ms += ms; }
}

/**
 * Wrap a memo() implementation so every miss is timed and every call counted.
 * Returns the original function untouched when profiling is off.
 */
export function instrumentMemo(memoFn, prefix) {
  if (!ON) return memoFn;
  return function profiledMemo(key, make) {
    let missed = false;
    const t = now();
    const v = memoFn(key, () => { missed = true; return make(); });
    const dt = now() - t;
    record(prefix + '/' + key, dt, missed);
    if (missed && dt > 40) {
      // eslint-disable-next-line no-console
      console.log(`[prof] ${Math.round(dt)}ms  ${prefix}/${key}  @${Math.round(now() - T0)}ms`);
    }
    return v;
  };
}

/** Time a named startup stage (always recorded, even without a memo). */
export function stage(name, fn) {
  if (!ON) return fn();
  const t = now();
  const v = fn();
  const dt = now() - t;
  record('stage/' + name, dt, true);
  // eslint-disable-next-line no-console
  console.log(`[prof] ${Math.round(dt)}ms  STAGE ${name}  @${Math.round(now() - T0)}ms`);
  return v;
}

export function mark(name) {
  if (!ON) return;
  // eslint-disable-next-line no-console
  console.log(`[prof] MARK ${name} @${Math.round(now() - T0)}ms`);
}

export const profiling = ON;

if (ON && typeof window !== 'undefined') {
  window.__bootProfile = {
    get elapsed() { return now() - T0; },
    rows,
    table() {
      const out = [...rows.entries()]
        .map(([key, r]) => ({ key, ms: Math.round(r.ms), calls: r.calls, bakes: r.misses }))
        .sort((a, b) => b.ms - a.ms);
      const total = out.reduce((s, r) => (r.key.startsWith('stage/') ? s : s + r.ms), 0);
      return { totalBakeMs: Math.round(total), elapsedMs: Math.round(now() - T0), rows: out };
    },
  };
}
