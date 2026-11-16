import fs from 'node:fs';
import path from 'node:path';

export function shadowFile(stateDir) {
  return path.join(stateDir, 'shadow', 'log.ndjson');
}

// wouldFire is intentionally NOT defaulted: it is a real behavioral
// observation (did the guard's trigger condition actually recur), not a
// bookkeeping flag every caller must supply. A caller that doesn't have a
// real counterfactual to report (most callers today) simply omits it, and
// the record persists with no wouldFire key at all, rather than a fabricated
// value. skill-trial.js's runTrial is the one caller with a real signal
// (wouldFire: !!result.gapRecurred) and keeps passing it explicitly.
export function recordShadow(stateDir, {
  taskClass = 'other',
  wouldFire,
  fired = false,
  sid = null,
  episodeId = null,
} = {}) {
  const file = shadowFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { taskClass, fired: !!fired, sid, ts: new Date().toISOString() };
  if (typeof wouldFire === 'boolean') record.wouldFire = wouldFire;
  if (episodeId) record.episodeId = episodeId;
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

// sinceTs (optional, epoch ms): when set, entries recorded strictly before it
// are excluded from the aggregation - the before/after split glmps-87's skill
// trial measurement needs (shadowRates(stateDir, { sinceTs: trial.startedTs })).
// Both existing call sites (the /api/promotion/shadow route and
// retireCandidatesFromTemplates's wiring) pass no second arg and are
// unaffected. An entry whose own `ts` can't be parsed is kept rather than
// dropped - fail-open, same discipline as a malformed JSON line being skipped
// rather than aborting the whole scan.
export function shadowRates(stateDir, { sinceTs } = {}) {
  const file = shadowFile(stateDir);
  if (!fs.existsSync(file)) return { byClass: {} };

  const raw = fs.readFileSync(file, 'utf8');
  const byClass = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }

    if (typeof sinceTs === 'number') {
      const entryMs = Date.parse(entry.ts);
      if (Number.isFinite(entryMs) && entryMs < sinceTs) continue;
    }

    const cls = entry.taskClass ?? 'other';
    if (!byClass[cls]) byClass[cls] = { n: 0, _fire: 0, _cfSum: 0, _cfN: 0, _episodes: new Set() };
    const g = byClass[cls];
    g.n++;
    if (entry.fired === true) {
      g._fire++;
      if (typeof entry.episodeId === 'string' && entry.episodeId) g._episodes.add(entry.episodeId);
    }
    if (typeof entry.wouldFire === 'boolean') {
      g._cfN++;
      if (entry.wouldFire === true) g._cfSum++;
    }
  }

  for (const cls of Object.keys(byClass)) {
    const g = byClass[cls];
    g.fireRate = g._fire / g.n;
    g.fireCount = g._fire;
    // Only entries that actually carry a real wouldFire (skill-trial.js's
    // sandboxed observation) contribute to counterfactualRate. A class with
    // zero such entries (every guard-loop writer, after this fix) reports
    // null - honestly absent - instead of a rate fabricated from nothing.
    g.counterfactualRate = g._cfN > 0 ? g._cfSum / g._cfN : null;
    g.episodeCount = g._episodes.size > 0 ? g._episodes.size : null;
    delete g._fire;
    delete g._cfSum;
    delete g._cfN;
    delete g._episodes;
  }

  return { byClass };
}

// lastFiredByClass(stateDir) -> { [taskClass]: epoch ms of the most recent
//   fired:true observation }
//
// Guard-staleness "last used" derivation (glmps-138 C1 fix): a guard's real
// usage signal is "did it actually fire", not "was it merely observed" -
// recordShadow() logs one observation per gap-detect pass regardless of
// whether the guard's condition matched, so counting mere observations would
// make every actively-scanned-but-rarely-triggered guard look "used" every
// tick. Only fired:true entries advance a class's last-used ts. A class with
// no fired:true entry at all (never observed, or observed but never fired)
// is simply absent from the returned map - same fail-open convention as
// shadowRates() above: no evidence is reported as no evidence, never invented.
export function lastFiredByClass(stateDir) {
  const file = shadowFile(stateDir);
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  const out = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.fired !== true) continue;
    const ms = Date.parse(entry.ts);
    if (!Number.isFinite(ms)) continue;
    const cls = entry.taskClass ?? 'other';
    if (!(cls in out) || ms > out[cls]) out[cls] = ms;
  }

  return out;
}

// firedCountInWindow(stateDir, { windowStart, now }) -> number
//
// Total count of fired:true observations across ALL classes within
// [windowStart, now] (both epoch ms). Backs the Loop view's guardHits metric
// (glmps-138 I1 fix): the previous implementation counted distinct guard
// SystemChange ROWS active in the window (guard IDEAS present), not actual
// shadow-arm fire EVENTS. This reads the real per-fire log instead - the
// only place in the codebase with a per-firing timestamp.
export function firedCountInWindow(stateDir, { windowStart = -Infinity, now = Date.now() } = {}) {
  const file = shadowFile(stateDir);
  if (!fs.existsSync(file)) return 0;
  const raw = fs.readFileSync(file, 'utf8');
  let count = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.fired !== true) continue;
    const ms = Date.parse(entry.ts);
    if (!Number.isFinite(ms)) continue;
    if (ms < windowStart || ms > now) continue;
    count++;
  }

  return count;
}
