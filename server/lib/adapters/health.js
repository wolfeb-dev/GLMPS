// server/lib/adapters/health.js
// Per-adapter capture-health registry (glmps-45, extended by glmps-72).
//
// Capture adapters parse undocumented third-party logs. When an upstream tool
// changes its schema, a record that *should* be meaningful stops matching the
// expected shape. Adapters call reportMiss() at their extract boundary in that
// case: the record is skipped (never a throw, never a bogus event) and the
// adapter is flagged degraded so the server/UI can surface the drift.
//
// Transient conditions (unparseable partial line, locked sqlite file) are NOT
// misses - only shape mismatches on successfully-read records are.
//
// glmps-72 closed three gaps in the original:
//
//   1. NO HISTORY. The registry was a module-level Map, so every miss ever
//      recorded was lost on restart and "has capture been silently dropping
//      records" was unanswerable for any past window. persistAdapterHealth /
//      loadAdapterHealth give it a disk round-trip.
//   2. NO RATE. A bare lifetime counter cannot tell one drift event from 208
//      per second, which is exactly why the agy-cli re-drain defect ran
//      unnoticed. A bounded ring of recent timestamps yields missesPerMin.
//   3. NO ALERT. `degraded` reached the UI only as a vitals field on
//      /api/state, so it sat there indefinitely. alert-sources.js now reads
//      this snapshot (source: 'capture-health').
//
// reportMiss keeps its original 2-argument signature. It is called from a
// dozen adapter extract boundaries on the hot path and none of them change;
// `now` is an optional third argument purely so tests need no clock control.
//
// Nothing here does I/O per miss, deliberately: a 208-per-second storm must
// not become 208 file writes per second. Persistence is the caller's timer.
import fs from 'node:fs';
import path from 'node:path';

// How many recent miss timestamps to retain per adapter for the rate. Bounded
// so a storm cannot grow memory without limit; once capped, missesPerMin is a
// FLOOR rather than an exact count, and adapterHealth says so via recentCapped.
const RECENT_CAP = 512;
const RATE_WINDOW_MS = 60_000;

// Phase K final review I4: the kernel's own health signals share this
// registry with the capture adapters. One list,
// exported from here, is what every consumer filters on: alert-sources.js
// renders these as "Kernel health: <id>" and stage-board.js's capture vital
// leaves them out (a mem0-lookup miss is not a degraded capture tool).
// 'retry-queue-write' and 'retry-queue-deadletter' are
// distinct from 'retry-queue' (the queue file's own read health).
export const KERNEL_HEALTH_IDS = Object.freeze(new Set(['mem0-lookup', 'mem0-migrate', 'gate-obligation-open', 'retry-queue', 'retry-queue-write', 'retry-queue-deadletter', 'finalize-sweep', 'judge-load',
  // Task 12b post-breaker residual N3: the launch feature's own kernel
  // signals (alert-sources.test.js scans the source for every launch-* key).
  'launch-broker-load', 'launch-broker-quarantine', 'launch-token-boot', 'launch-queue-ledger', 'launch-claim-stale-check',
  'launch-result-runner-failed', 'launch-result-ledger-patch', 'launch-nonce', 'launch-job-test-guard', 'launch-job-no-worktree', 'launch-trust',
  // Scan 2026-10-15 F2: the local-session key could not be created or read.
  'local-session-key-boot']));

const registry = new Map(); // adapterId -> { misses, lastReason, lastMissTs, firstMissTs, recent[], recentCapped }

/**
 * Record a validation miss for an adapter.
 * @param {string} adapterId - adapter id ('gemini-cli', 'claude-code', ...)
 * @param {string} reason    - short human-readable drift description
 * @param {{now?: number}} [opts] - injectable clock; tests only
 */
export function reportMiss(adapterId, reason, { now } = {}) {
  const ts = Number.isFinite(now) ? now : Date.now();
  const cur = registry.get(adapterId) ?? {
    misses: 0, lastReason: null, lastMissTs: null, firstMissTs: null, recent: [], recentCapped: false,
  };
  cur.misses += 1;
  cur.lastReason = reason ?? null;
  cur.lastMissTs = ts;
  if (cur.firstMissTs === null) cur.firstMissTs = ts;
  cur.recent.push(ts);
  if (cur.recent.length > RECENT_CAP) { cur.recent.shift(); cur.recentCapped = true; }
  registry.set(adapterId, cur);
}

/**
 * Snapshot of degraded adapters as a plain serializable object.
 * Healthy adapters are absent; presence means degraded.
 *
 * The original four fields (degraded, misses, lastReason, lastMissTs) are
 * unchanged, because /api/state and buildVitals already read them. The rest is
 * additive.
 */
export function adapterHealth({ now } = {}) {
  const ts = Number.isFinite(now) ? now : Date.now();
  const out = {};
  for (const [id, h] of registry) {
    const from = ts - RATE_WINDOW_MS;
    out[id] = {
      degraded: true,
      misses: h.misses,
      lastReason: h.lastReason,
      lastMissTs: h.lastMissTs,
      firstMissTs: h.firstMissTs ?? h.lastMissTs,
      missesPerMin: h.recent.filter((t) => t >= from).length,
      recentCapped: !!h.recentCapped,
    };
  }
  return out;
}

/**
 * Write the registry to `file` so a restart does not erase the drift history.
 * Atomic (tmp + rename) like the other small state writers here. Never throws:
 * losing a health snapshot must not take the server down.
 */
export function persistAdapterHealth(file) {
  try {
    const rows = {};
    for (const [id, h] of registry) rows[id] = h;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore a snapshot written by persistAdapterHealth. A missing or malformed
 * file is a no-op, never a crash: an unreadable health file must not stop the
 * server from booting, and starting with an empty registry is a safe, if
 * lossy, state.
 */
export function loadAdapterHealth(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const [id, h] of Object.entries(parsed)) {
    if (!h || typeof h !== 'object') continue;
    registry.set(id, {
      misses: Number.isFinite(h.misses) ? h.misses : 0,
      lastReason: h.lastReason ?? null,
      lastMissTs: Number.isFinite(h.lastMissTs) ? h.lastMissTs : null,
      firstMissTs: Number.isFinite(h.firstMissTs) ? h.firstMissTs : (Number.isFinite(h.lastMissTs) ? h.lastMissTs : null),
      recent: Array.isArray(h.recent) ? h.recent.filter(Number.isFinite).slice(-RECENT_CAP) : [],
      recentCapped: !!h.recentCapped,
    });
  }
  return true;
}

/** Clear all recorded misses (tests). */
export function resetAdapterHealth() {
  registry.clear();
}

/**
 * End a miss episode for one adapter: the
 * caller's own success path calls this so a signal that recovers is not
 * left permanently `degraded` until some unrelated later event happens to
 * overwrite it. Deleting the entry (not just zeroing `misses`) is what
 * makes the recurrence guarantee work: the NEXT reportMiss() call (if any)
 * gets a brand new firstMissTs, since firstMissTs is set only "if
 * cur.firstMissTs === null" on a freshly-created record - a stale operator
 * ack keyed off the OLD episode's alert id (which embeds firstMissTs, see
 * alert-sources.js) then never hides the new one.
 */
export function clearMiss(adapterId) {
  registry.delete(adapterId);
}
