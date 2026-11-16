// web/overview/stage-board-calc.js
//
// Pure derived logic for the Stage Board. Extracted from stage-board.js
// (glmps-148), which carried this inline and was never loaded by `npm test` --
// the tile wording, truncation and the null-vs-zero contract below had zero
// automated coverage despite the last two being where the real bugs were.
//
// No DOM, no fetch, no clock of its own: everything here is a function of its
// arguments, so server/test/stage-board-calc.test.js can import it directly.
// Same shape as web/observability/analytics-calc.js.

// Shortens a string for display. Never touches the DOM; callers that truncate
// should also set the full string as the element's `title` attribute.
export function truncateText(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}


export function fmtElapsed(ms) {
  if (ms == null) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

// fresh < 5min, aging < 15min, else old - per the locked spec.
export function toneOf(elapsedMs) {
  if (elapsedMs == null) return 'fresh';
  if (elapsedMs < 5 * 60_000) return 'fresh';
  if (elapsedMs < 15 * 60_000) return 'aging';
  return 'old';
}

// "1h12m" / "12m" / "now" until an epoch-ms deadline. `nowMs` is injected so
// this is testable; production callers omit it.
export function fmtResetIn(resetsAt, nowMs = Date.now()) {
  if (typeof resetsAt !== 'number') return null;
  const diff = resetsAt - nowMs;
  if (diff <= 0) return 'now';
  const mins = Math.round(diff / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}


// A point's test count, or null when the sampler could not parse that run's
// log (real condition: qa-trends points carry testCount/pass/fail null with a
// conclusion still set). Distinguishes "not parsed" from a real zero.
// Note the explicit null/empty check before Number(): Number(null) is 0, not
// NaN, so a Number.isFinite() guard alone would silently accept an unparsed
// run as a real zero (measured: it did).
export function qaCountOf(point) {
  const raw = point?.testCount;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Field-value extractor for a vitals-trends point, matching qaCountOf's
// null-safety contract above, for the same reason.
export function trendFieldOf(field) {
  return (point) => {
    const raw = point?.[field];
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
}

export function fmtQaCount(n) {
  return (Number(n) || 0).toLocaleString();
}

// Sub-line wording. The CI verdict leads (that is the health read); a non-zero
// failing count is appended only when there is one, so the common healthy case
// stays a single short phrase instead of "CI passing / all passing".
export function qaSubLabel(hasCi, state, latest) {
  const head = !hasCi
    ? 'Local runs only'
    : state === 'good' ? 'CI passing'
    : state === 'bad' ? 'CI failing'
    : `CI ${latest?.conclusion ?? 'unknown'}`;
  const fail = Number(latest?.fail) || 0;
  return fail > 0 ? `${head} \u00B7 ${fmtQaCount(fail)} failed` : head;
}

// The Fleet board tiles' value and delta, kept apart from the DOM so the
// change arithmetic is testable on its own.

// Tile key -> the vitals-trends record's field name.
export const TREND_FIELD = {
  active: 'active',
  uncommitted: 'uncommitted',
  followups: 'followups',
  gate: 'atGate',
  stalled: 'stalled',
  capture: 'degradedAdapters',
  budget: 'budgetPct',
  alerts: 'alerts',
  queue: 'queued',
};

// Tiles where a rising number is worse, so the delta chip takes the warning
// tint. The rest stay neutral: up is not unambiguously good or bad for them.
export const TREND_WARN_ON_UP = new Set(['uncommitted', 'alerts', 'stalled', 'queue', 'budget']);

const ONE_HOUR_MS = 60 * 60_000;
const TREND_TOLERANCE_MS = 5 * 60_000;

// The point nearest exactly one hour before the newest, or null when none
// falls within tolerance: a distant point is never passed off as "an hour ago".
export function findHourAgoPoint(points) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  if (typeof last?.ts !== 'number') return null;
  const targetTs = last.ts - ONE_HOUR_MS;
  let best = null;
  let bestGap = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i];
    if (typeof p?.ts !== 'number') continue;
    const gap = Math.abs(p.ts - targetTs);
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  return (best && bestGap <= TREND_TOLERANCE_MS) ? best : null;
}

// Null when there is no baseline or either end is null/non-numeric, never a
// fabricated 0: Number(null) is 0, so null is checked before any coercion.
export function computeDelta(points, field) {
  if (!points.length) return null;
  const last = points[points.length - 1];
  const baseline = findHourAgoPoint(points);
  if (!baseline) return null;
  const a = last[field];
  const b = baseline[field];
  if (a == null || b == null) return null;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return null;
  return na - nb;
}
