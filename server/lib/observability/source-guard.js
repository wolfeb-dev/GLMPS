// server/lib/observability/source-guard.js
// Per-source failure isolation for the capture watch loop (glmps-47).
//
// Polling active files / SQLite DBs can throw EPERM/EBUSY when the native tool
// holds a lock (especially on Windows), and a malformed record can make an
// extractor throw. Either way, one bad source must never stop extraction of
// the others - and a hot poll loop must not hammer a locked file or spam the
// log. run() wraps one source's unit of work: failures are caught, retried
// with exponential backoff (skip-and-continue between retries), and warned
// about at most once per debounce window per source.

/**
 * @param {object} [opts]
 * @param {number} [opts.baseBackoffMs=1000]  - first retry delay after a failure
 * @param {number} [opts.maxBackoffMs=60000]  - backoff cap
 * @param {number} [opts.warnEveryMs=30000]   - min interval between warnings per key
 * @param {(msg: string) => void} [opts.log]  - warning sink (default console.error)
 * @param {() => number} [opts.now]           - clock (injectable for tests)
 */
export function createSourceGuard({
  baseBackoffMs = 1000,
  maxBackoffMs = 60000,
  warnEveryMs = 30000,
  log = console.error,
  now = Date.now,
} = {}) {
  const failing = new Map(); // key -> { failures, nextRetryAt }
  const warnAt = new Map();  // key -> last warning ts

  function emitWarn(key, message) {
    const t = now();
    if (t - (warnAt.get(key) ?? -Infinity) < warnEveryMs) return;
    warnAt.set(key, t);
    log(`[capture] ${key}: ${message}`);
  }

  /**
   * Run one source's unit of work.
   * @returns {{ok:true, value:any} | {ok:false, error?:Error, skipped?:true}}
   */
  function run(key, fn) {
    const st = failing.get(key);
    const t = now();
    if (st && t < st.nextRetryAt) return { ok: false, skipped: true };
    try {
      const value = fn();
      if (st) { failing.delete(key); warnAt.delete(key); }
      return { ok: true, value };
    } catch (error) {
      const failures = (st?.failures ?? 0) + 1;
      const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (failures - 1));
      failing.set(key, { failures, nextRetryAt: t + backoff });
      emitWarn(key, `read failed (${failures}x, retry in ${backoff}ms): ${error?.message ?? error}`);
      return { ok: false, error };
    }
  }

  /** Standalone debounced warning (e.g. a skipped record inside a source). */
  function warn(key, message) { emitWarn(key, message); }

  return { run, warn };
}
