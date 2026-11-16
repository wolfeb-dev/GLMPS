// GET /api/timeline: one compact, time-ordered event list for the last N hours,
// merged from five in-memory or already-stored sources so the Surface foot-bar
// scrubber needs one request. Pure: server.js hands in the data.
//
// Event: { ts, kind, sessionId?, cardId?, cardTitle?, path?, title?, severity?,
//          state?, loop?, outcome? }, ts in epoch ms, ascending.
//   edit   agent file edit (per-session event log, kind 'file-edit')
//   card   backlog item activity / state change
//   gate   a card's gate verdict (state = PASS, WAIVED, CONCERNS, ...)
//   alert  an alert from the alerts feed
//   loop   a loop run (last run, plus the recent failures the registry keeps)

export const DEFAULT_HOURS = 24;
export const MAX_HOURS = 72;
export const MAX_EVENTS = 5000;

const TITLE_MAX = 140;

export function clampHours(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOURS;
  return Math.min(n, MAX_HOURS);
}

function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

const clip = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}...` : t; };

/**
 * @param {object} src
 * @param {number} src.now
 * @param {number} [src.hours]
 * @param {Iterable<[string, object[]]>} [src.eventsBySession] the in-memory per-session event log
 * @param {(sessionId: string) => ({id: string, title: string}|undefined)} [src.cardOf]
 * @param {object[]} [src.cards] backlog items
 * @param {object[]} [src.alerts]
 * @param {Record<string, object>} [src.loops] loop registry snapshot
 */
export function buildTimeline({ now, hours = DEFAULT_HOURS, eventsBySession = [], cardOf = () => undefined, cards = [], alerts = [], loops = {} }) {
  const h = clampHours(hours);
  const to = now;
  const from = now - h * 3600_000;
  const inWindow = (ts) => ts != null && ts >= from && ts <= to;
  const out = [];

  for (const [sessionId, events] of eventsBySession) {
    const card = cardOf(sessionId);
    for (const e of events ?? []) {
      if (e?.kind !== 'file-edit' || !e.path) continue;
      const ts = toMs(e.ts);
      if (!inWindow(ts)) continue;
      const ev = { ts, kind: 'edit', sessionId, path: e.path };
      if (card) { ev.cardId = card.id; ev.cardTitle = card.title; }
      out.push(ev);
    }
  }

  for (const c of cards ?? []) {
    const base = { cardId: c.id, cardTitle: c.title };
    const seen = [];
    for (const a of c.activity ?? []) {
      const ts = toMs(a?.ts);
      if (!inWindow(ts)) continue;
      seen.push(ts);
      out.push({ ts, kind: 'card', ...base, state: c.state, title: clip(a.text) });
    }
    // updatedAt is the only state-change stamp when no activity line covers it.
    const upd = toMs(c.updatedAt);
    if (inWindow(upd) && !seen.some((t) => Math.abs(t - upd) < 2000)) out.push({ ts: upd, kind: 'card', ...base, state: c.state });
    const g = c.gate;
    const gts = toMs(g?.ts);
    if (g && inWindow(gts)) out.push({ ts: gts, kind: 'gate', ...base, state: g.status });
  }

  for (const a of alerts ?? []) {
    const ts = toMs(a?.ts);
    if (!inWindow(ts)) continue;
    const ev = { ts, kind: 'alert', title: clip(a.title), severity: a.severity };
    if (a.sessionId) ev.sessionId = a.sessionId;
    out.push(ev);
  }

  for (const [name, rec] of Object.entries(loops ?? {})) {
    const seen = new Set();
    const lts = toMs(rec?.lastRunTs);
    if (inWindow(lts)) { seen.add(lts); out.push({ ts: lts, kind: 'loop', loop: name, outcome: rec.lastOutcome ?? undefined }); }
    for (const f of rec?.recentFailures ?? []) {
      const ts = toMs(f?.ts);
      if (inWindow(ts) && !seen.has(ts)) { seen.add(ts); out.push({ ts, kind: 'loop', loop: name, outcome: 'failed' }); }
    }
  }

  out.sort((a, b) => a.ts - b.ts);
  const truncated = out.length > MAX_EVENTS;
  return { hours: h, from, to, truncated, events: truncated ? out.slice(out.length - MAX_EVENTS) : out };
}
