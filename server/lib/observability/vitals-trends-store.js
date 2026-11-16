// server/lib/observability/vitals-trends-store.js
//
// Stage Board vitals trend store (docs/superpowers/specs/
// 2026-07-22-vitals-trends-design.md, Step 2). Append-only NDJSON store at
// <stateDir>/vitals-trends/history.ndjson, one point per sampler tick (~30s,
// see server.js's vitalsTrendsTickFn). Mirrors qa-trends-store.js's
// conventions: synchronous fs, tolerant reads (malformed lines skipped,
// missing file -> []), fail-open writes.
//
// Point shape (EXACT, per the design's record contract):
//   { ts, active, uncommitted, dirtyFiles, followups, atGate, stalled,
//     degradedAdapters, budgetPct, alerts, queued }
//
// NULL DISCIPLINE IS THE POINT OF THIS FEATURE (per the spec, and this repo's
// stage-board.js buildVitals precedent it mirrors): any field whose input is
// missing, unavailable, or failed to compute is `null`, never `0`. Number(null)
// is 0 (not NaN), so a bare Number.isFinite() guard would silently accept a
// missing value as a real zero -- two bugs shipped this week for exactly that
// reason. sampleVitals below checks `== null` before ever touching Number()/
// typeof on a field, and readVitalsTrends passes stored values through
// unchanged (JSON.parse's `null` stays `null`, never gets coerced).
//
// This module is split like qa-trends-store.js:
//   1. The plain store (vitalsTrendsFile/readVitalsTrends/appendVitalsPoint) --
//      synchronous fs, no network, fully unit-tested.
//   2. Pure shaping (sampleVitals) and the window parser (parseWindowMs) used
//      by the GET /api/vitals-trends route.
// server.js's periodic tick (vitalsTrendsTickFn) composes the inputs to
// sampleVitals from the same internal producers /api/state, /api/budget,
// /api/alerts and /api/backlog already use, and calls appendVitalsPoint --
// that orchestration is I/O glue and lives in server.js, not here, same split
// as qa-trends-store.js's own sampleLatestRun vs. its pure core.
import fs from 'node:fs';
import path from 'node:path';

// Every field except `ts`, in the exact record shape order from the design.
export const FIELD_KEYS = [
  'active', 'uncommitted', 'dirtyFiles', 'followups', 'atGate',
  'stalled', 'degradedAdapters', 'budgetPct', 'alerts', 'queued',
];

export const RETENTION_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h, per the design's "operational read" default


export function vitalsTrendsFile(stateDir) {
  return path.join(stateDir, 'vitals-trends', 'history.ndjson');
}

// Parse one NDJSON line -> a record, or null if blank/malformed/missing a
// valid numeric ts. Shared by readVitalsTrends and the prune pass below so
// both apply exactly the same tolerance rule.
function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  let rec;
  try { rec = JSON.parse(t); } catch { return null; }
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return null;
  return rec;
}

// Tolerant read: missing file -> [], malformed/incomplete lines skipped.
// Always returns points sorted ascending by ts (oldest first, the API
// contract's ordering). opts.sinceMs (epoch ms), when given, drops any point
// older than the cutoff -- the read-side half of the window contract; the
// route computes sinceMs from `?window=` via parseWindowMs and passes it in
// here, so this function's own filtering semantics never change.
export function readVitalsTrends(stateDir, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(vitalsTrendsFile(stateDir), 'utf8');
  } catch {
    return [];
  }
  const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const rows = [];
  for (const line of raw.split('\n')) {
    const rec = parseLine(line);
    if (!rec) continue;
    if (sinceMs != null && rec.ts < sinceMs) continue;
    rows.push(rec);
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

// Drop every on-disk point older than (referenceTs - RETENTION_MS), rewriting
// the file. Malformed lines encountered along the way are silently dropped
// too (parseLine already tolerates them) -- pruning must be safe even when the
// file has accumulated garbage, never throw, and never grow unbounded. A
// missing file is a no-op (nothing to prune yet).
function pruneToRetention(stateDir, referenceTs) {
  const file = vitalsTrendsFile(stateDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const cutoff = referenceTs - RETENTION_MS;
  const kept = [];
  for (const line of raw.split('\n')) {
    const rec = parseLine(line);
    if (!rec) continue; // malformed -- dropped, not carried forward
    if (rec.ts < cutoff) continue; // outside the trailing 24h -- pruned
    kept.push(JSON.stringify(rec));
  }
  const body = kept.length ? kept.join('\n') + '\n' : '';
  try { fs.writeFileSync(file, body); } catch { /* fail-open: next append/prune retries */ }
}

// Append one point, then prune the store to the trailing 24h relative to the
// point's own ts. Fail-open: any I/O error (missing/locked dir, read-only FS)
// is swallowed and returns false, same posture as qa-trends-store.js's
// appendPoint. Rejects a non-object point or one without a valid finite `ts`
// (ts drives both ordering and the prune cutoff, so a point without one can
// never be placed correctly -- mirrors appendPoint's own runId validation).
export function appendVitalsPoint(stateDir, point) {
  if (!point || typeof point !== 'object') return false;
  if (typeof point.ts !== 'number' || !Number.isFinite(point.ts)) return false;
  try {
    const dir = path.join(stateDir, 'vitals-trends');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(vitalsTrendsFile(stateDir), JSON.stringify(point) + '\n');
    pruneToRetention(stateDir, point.ts);
    return true;
  } catch {
    return false;
  }
}


// `v == null` catches both null and undefined BEFORE any Number() coercion --
// the load-bearing check per this module's header comment. Number(null) is 0,
// so checking `typeof v === 'number'` alone would let a caller-passed `null`
// slip through as 0 the moment someone refactors this into a bare coercion;
// the explicit `== null` guard is what stops that.
function numOrNull(v) {
  if (v == null) return null;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// Builds one record from already-computed values -- pure, no I/O, no
// Date.now() (the caller supplies `ts` explicitly, same discipline as
// stage-board.js's buildVitals taking `now` as a parameter rather than
// reaching for the clock itself). Any field missing, null, undefined, or not
// a finite number becomes `null` in the output; a real 0 is preserved as 0.
//
// @param {object} inputs
// @param {number} [inputs.ts] epoch ms; invalid/missing -> null (see above).
// @returns {{ ts:number|null, active:number|null, uncommitted:number|null,
//   dirtyFiles:number|null, followups:number|null, atGate:number|null,
//   stalled:number|null, degradedAdapters:number|null, budgetPct:number|null,
//   alerts:number|null, queued:number|null }}
export function sampleVitals(inputs = {}) {
  const src = inputs && typeof inputs === 'object' ? inputs : {};
  const point = { ts: numOrNull(src.ts) };
  for (const k of FIELD_KEYS) point[k] = numOrNull(src[k]);
  return point;
}


const WINDOW_RE = /^(\d+(?:\.\d+)?)(h|m)$/i;

// Parses a window string like '2h' or '30m' into milliseconds, clamped to the
// store's 24h retention. Anything unparseable (missing, wrong shape, <=0, an
// unsupported unit like 'd') falls back to DEFAULT_WINDOW_MS rather than
// erroring -- the route's contract is "always returns something sane", never
// a 400, per the design.
export function parseWindowMs(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  const m = WINDOW_RE.exec(s);
  if (!m) return DEFAULT_WINDOW_MS;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MS;
  const ms = m[2].toLowerCase() === 'h' ? n * 60 * 60 * 1000 : n * 60 * 1000;
  return Math.min(ms, RETENTION_MS);
}

// synchronous collectCurrentAlerts() scan on its own 30s cadence) ----------
//
// collectCurrentAlerts() (server.js) is a fully synchronous scan over the
// whole event log (poison-scan + injection-scan + egress-scan), measured at
// 1.3-1.8s on the live server. That is the node-event-loop-git-subprocess-
// guard lesson's exact failure mode, just via a sync scan instead of
// execFileSync: calling it every 30s tick, forever, would stall the event
// loop (SSE + all HTTP) on that cadence even with no browser open. The board
// half of the tick avoids this because gitStatusFor is already stale-while-
// revalidate; this is the equivalent discipline for the alerts field.
//
// The fix is a shared last-known-count cache that GET /api/alerts ALSO
// writes to (server.js): a browser polling that route every 30s keeps the
// cache fresh "for free", so the tick never needs its own recompute. When no
// browser is polling, the tick's OWN recompute is throttled to at most once
// per ALERTS_MAX_STALE_MS via a SEPARATE gate (`recomputeGate`) from the
// cache's own freshness (`cache`) -- deliberately two clocks, not one:
// `cache.ts` only advances on a value the caller actually has in hand (from
// GET /api/alerts, or from the tick's own successful recompute); the
// recompute gate advances the moment the tick DECIDES to recompute, before
// knowing whether collectCurrentAlerts() will throw, precisely so a failing
// recompute still throttles the next retry to once per floor interval
// instead of hammering it every 30s. Every field/producer in this tick is
// meant to record null over a substitute (this module's whole reason for
// existing); this policy is what keeps that true for `alerts` too instead of
// silently drifting a value forward as "sampled now" when it wasn't.
export const ALERTS_MAX_STALE_MS = 5 * 60 * 1000; // 5 min

/**
 * Pure decision: given the shared last-known-alert-count cache and the
 * tick's own recompute-attempt gate, decides whether the tick should reuse
 * the cached count, recompute it now (caller's job to actually call
 * collectCurrentAlerts() and update both `cache` and `recomputeGate`), or
 * record null. Never calls collectCurrentAlerts() itself, never touches
 * Date.now() (the caller supplies `now`), never mutates its inputs.
 *
 * @param {{value:number|null, ts:number}} cache          last known count + when it was captured.
 * @param {{ts:number}} recomputeGate                      when the tick itself last attempted a recompute.
 * @param {number} now                                     epoch ms.
 * @param {number} [floorMs]                                default ALERTS_MAX_STALE_MS.
 * @returns {{ action: 'reuse'|'recompute'|'null', value: number|null }}
 */
export function decideAlertsSource(cache, recomputeGate, now, floorMs = ALERTS_MAX_STALE_MS) {
  const c = cache && typeof cache === 'object' ? cache : { value: null, ts: 0 };
  const g = recomputeGate && typeof recomputeGate === 'object' ? recomputeGate : { ts: 0 };
  const cacheTs = typeof c.ts === 'number' && Number.isFinite(c.ts) ? c.ts : 0;
  const gateTs = typeof g.ts === 'number' && Number.isFinite(g.ts) ? g.ts : 0;
  const cacheFresh = c.value != null && (now - cacheTs) < floorMs;
  if (cacheFresh) return { action: 'reuse', value: c.value };
  const gateElapsed = (now - gateTs) >= floorMs;
  if (gateElapsed) return { action: 'recompute', value: null };
  return { action: 'null', value: null };
}
