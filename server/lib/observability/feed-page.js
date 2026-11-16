// Server-side paging of the per-session feed on /api/state?session= (card
// glmps-2-0-runtime-58, session-detail spec section 8 item 5). The response
// used to carry the whole in-memory log (up to 2,000 events, 378 KB for one
// live session on 2026-10-25) on every mount. `limit` keeps the newest N
// events; `before` (epoch ms) keeps only events strictly older than it, so a
// client walks back with before=page.nextBefore. Without either the feed is
// returned whole, so existing callers are unchanged.
//
// Event ts comes in two shapes: Claude transcript events carry ISO strings,
// done-gate and most other sources carry epoch ms. Every comparison, and
// nextBefore, uses epoch ms so a client gets one type back.
//
// A page never splits a run of events that share a timestamp: the next page
// asks for ts < nextBefore and would otherwise skip the rest of the run, so
// the page grows past `limit` to include it.

export const MAX_FEED_LIMIT = 2000;

function parseLimit(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), MAX_FEED_LIMIT);
}

function parseBefore(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(raw);
  return Number.isFinite(d) ? d : null;
}

export function tsMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0;
  if (typeof ts === 'string') { const d = Date.parse(ts); return Number.isFinite(d) ? d : 0; }
  return 0;
}

export function pageFeed(log, { limit, before } = {}) {
  const events = Array.isArray(log) ? log : [];
  const lim = parseLimit(limit);
  const bef = parseBefore(before);
  const total = events.length;
  if (lim == null && bef == null) {
    return { events, page: { total, returned: total, limit: null, before: null, hasMore: false, nextBefore: null } };
  }
  const older = bef == null ? events : events.filter(e => tsMs(e?.ts) < bef);
  let start = 0;
  if (lim != null && older.length > lim) {
    start = older.length - lim;
    const edge = tsMs(older[start]?.ts);
    while (start > 0 && tsMs(older[start - 1]?.ts) === edge) start--;
  }
  const out = start ? older.slice(start) : older;
  const hasMore = start > 0;
  return {
    events: out,
    page: { total, returned: out.length, limit: lim, before: bef, hasMore, nextBefore: hasMore ? tsMs(out[0]?.ts) : null },
  };
}
