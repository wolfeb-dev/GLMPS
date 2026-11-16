// web/surface/timeline.js
// The 24 h timeline in the foot bar (GET /api/timeline?hours=24). The model is
// pure and shared with the layers: an "as of" time filters the edit trails,
// alert pulses and card stacks to events at or before it; at Latest (as of is
// null) every layer keeps reading its live feed. The view is a native range
// input over per-kind lanes of ticks, so keyboard stepping, a label and a 44 px
// target come from the platform.
import { normPath, since } from './format.js';
import { formatTime } from '../shared/time-format.js';

export const TIMELINE_URL = '/api/timeline?hours=24';
export const KINDS = Object.freeze([
  { id: 'edit', label: 'Edits' },
  { id: 'card', label: 'Cards' },
  { id: 'gate', label: 'Gates' },
  { id: 'alert', label: 'Alerts' },
  { id: 'loop', label: 'Loops' },
]);
const KIND_IDS = new Set(KINDS.map((k) => k.id));
export const BUCKETS = 96;
// History seconds that pass per real second at 1x: a day replays in 2.4 minutes.
export const PLAY_MS_PER_S = 600000;
export const SPEEDS = Object.freeze([1, 2, 4]);
const PLAY_TICK_MS = 250;

export function normalizeTimeline(body) {
  const events = (Array.isArray(body?.events) ? body.events : [])
    .filter((e) => e && Number.isFinite(e.ts) && KIND_IDS.has(e.kind))
    .sort((a, b) => a.ts - b.ts);
  const to = Number.isFinite(body?.to) ? body.to : (events.at(-1)?.ts ?? Date.now());
  const hours = Number.isFinite(body?.hours) ? body.hours : 24;
  const from = Number.isFinite(body?.from) ? body.from : to - hours * 3600000;
  return { hours, from, to, truncated: body?.truncated === true, events };
}

// Counts per bucket and kind: the lanes draw one tick per non-empty bucket.
export function tickBuckets(events, from, to, n = BUCKETS) {
  const span = Math.max(1, to - from);
  const out = Array.from({ length: n }, () => ({}));
  for (const e of events) {
    if (e.ts < from || e.ts > to) continue;
    const i = Math.min(n - 1, Math.floor(((e.ts - from) / span) * n));
    out[i][e.kind] = (out[i][e.kind] ?? 0) + 1;
  }
  return out;
}

// Every edit known at or before asOf, newest first. The edits feed has the
// detail (add/del); the timeline reaches further back, with paths only.
// `resolve(absPath)` maps a path to { repo, rel } or null.
export function mergeEdits({ edits = [], events = [], asOf = null, resolve = () => null }) {
  const best = new Map();
  const take = (row) => {
    if (asOf != null && row.ts > asOf) return;
    const key = `${row.sessionId}|${normPath(row.path).toLowerCase()}`;
    const cur = best.get(key);
    if (!cur || row.ts > cur.ts || (row.ts === cur.ts && row.source === 'edits')) best.set(key, row);
  };
  for (const e of events) {
    if (e.kind !== 'edit' || !e.path || !e.sessionId) continue;
    const r = resolve(e.path);
    take({ path: e.path, repo: r?.repo ?? null, rel: r?.rel ?? null, ts: e.ts, add: null, del: null, sessionId: e.sessionId, title: e.title ?? null, source: 'timeline' });
  }
  for (const e of edits) {
    if (!e?.path || !Number.isFinite(e.ts)) continue;
    take({ path: e.path, repo: e.repo ?? null, rel: e.rel ?? null, ts: e.ts, add: e.add ?? null, del: e.del ?? null, sessionId: e.sessionId, title: e.title ?? null, tool: e.tool ?? null, source: 'edits' });
  }
  return [...best.values()].sort((a, b) => b.ts - a.ts);
}

export function createTimelineStore() {
  let value = { status: 'loading', events: [], from: null, to: null, hours: 24, truncated: false, error: null };
  let asOf = null;
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(); };
  let cardEvents = new Map();
  let alertEvents = new Map();
  const index = () => {
    cardEvents = new Map(); alertEvents = new Map();
    for (const e of value.events) {
      if (e.kind === 'card' && e.cardId) { if (!cardEvents.has(e.cardId)) cardEvents.set(e.cardId, []); cardEvents.get(e.cardId).push(e); }
      if (e.kind === 'alert' && e.title) { if (!alertEvents.has(e.title)) alertEvents.set(e.title, []); alertEvents.get(e.title).push(e); }
    }
  };
  const store = {
    get: () => value,
    asOf: () => asOf,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setAsOf(ts) {
      let next = Number.isFinite(ts) ? ts : null;
      if (next != null && value.status !== 'ok') next = null;
      if (next != null) {
        next = Math.max(value.from, next);
        if (next >= value.to - 1000) next = null;
      }
      if (next === asOf) return;
      asOf = next; emit();
    },
    // A card's state as of the scrub time: its last event at or before it.
    // A card with events only after that time had not moved yet, so it is out;
    // a card the feed never mentions keeps its live state.
    cardState(card) {
      if (asOf == null) return card.state;
      const evs = cardEvents.get(card.id);
      if (!evs?.length) return card.state;
      let state = null;
      for (const e of evs) { if (e.ts <= asOf) state = e.state ?? card.state; else break; }
      return state;
    },
    // An alert is drawn once the feed has seen it; one the feed never mentions stays.
    alertShown(alert) {
      if (asOf == null) return true;
      const evs = alertEvents.get(alert.title);
      if (!evs?.length) return true;
      return evs[0].ts <= asOf;
    },
    async load(isDestroyed = () => false, fetchImpl = (u) => fetch(u)) {
      try {
        const res = await fetchImpl(TIMELINE_URL);
        if (!res.ok) throw new Error(`GET /api/timeline returned ${res.status}`);
        const body = normalizeTimeline(await res.json());
        if (isDestroyed()) return;
        value = { status: 'ok', error: null, ...body };
        index();
      } catch (e) {
        if (isDestroyed()) return;
        value = { status: 'unavailable', events: [], from: null, to: null, hours: 24, truncated: false, error: e.message.startsWith('GET ') ? e.message : `GET /api/timeline failed: ${e.message}` };
        asOf = null;
      }
      emit();
    },
  };
  return store;
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clock = (ts) => formatTime(ts, { date: false });

// The foot-bar control. Returns { destroy, tick }.
export function createTimelineBar(host, { store, reducedMotion = false }) {
  const bar = el('div', 'foot-timeline'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Timeline, last 24 hours');
  const mkBtn = (cls, text, label) => { const b = el('button', `tl-btn ${cls}`, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; };
  const prev = mkBtn('tl-prev', 'Prev', 'Previous event');
  const play = mkBtn('tl-play', 'Play', 'Play from the as-of time');
  const next = mkBtn('tl-next', 'Next', 'Next event');
  const speeds = el('span', 'tl-speeds'); speeds.setAttribute('role', 'group'); speeds.setAttribute('aria-label', 'Play speed');
  const speedBtns = SPEEDS.map((s) => { const b = mkBtn('tl-speed', `${s}x`, `Play at ${s}x`); b.dataset.speed = String(s); b.setAttribute('aria-pressed', s === 1 ? 'true' : 'false'); speeds.appendChild(b); return b; });
  const latest = mkBtn('tl-latest', 'Latest', 'Return to live data');
  const track = el('div', 'tl-track');
  const lanes = el('div', 'tl-lanes'); lanes.setAttribute('aria-hidden', 'true');
  const range = el('input', 'tl-range'); range.type = 'range'; range.setAttribute('aria-label', 'As-of time'); range.setAttribute('step', '60000');
  track.append(lanes, range);
  const asOfText = el('output', 'tl-asof', 'live');
  const legend = el('span', 'tl-legend'); legend.setAttribute('aria-label', 'Tick colours');
  for (const k of KINDS) { const i = el('span', `tl-key tl-k-${k.id}`); i.appendChild(el('span', 'tl-sw')); i.appendChild(document.createTextNode(k.label)); legend.appendChild(i); }
  const status = el('span', 'tl-status'); status.setAttribute('role', 'status');
  bar.append(prev, play, next, speeds, latest, track, asOfText, legend, status);
  host.appendChild(bar);

  let speed = 1; let timer = null; let drawnFor = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } play.textContent = 'Play'; play.setAttribute('aria-label', 'Play from the as-of time'); play.setAttribute('aria-pressed', 'false'); };
  const playing = () => timer != null;
  const listeners = [];
  const on = (t, type, fn) => { t.addEventListener(type, fn); listeners.push([t, type, fn]); };

  function drawLanes(v) {
    lanes.textContent = '';
    const buckets = tickBuckets(v.events, v.from, v.to);
    const peak = Math.max(1, ...buckets.flatMap((b) => Object.values(b)));
    KINDS.forEach((k, row) => {
      buckets.forEach((b, i) => {
        const n = b[k.id]; if (!n) return;
        const t = el('i', `tl-tick tl-k-${k.id}`);
        t.style.left = `${((i + 0.5) / buckets.length * 100).toFixed(2)}%`;
        t.style.top = `${row * 20}%`;
        t.style.opacity = String((0.45 + 0.55 * Math.min(1, n / peak)).toFixed(2));
        lanes.appendChild(t);
      });
    });
  }

  function paint() {
    const v = store.get();
    const ok = v.status === 'ok';
    for (const b of [prev, play, next, latest, ...speedBtns]) b.disabled = !ok;
    range.disabled = !ok;
    if (reducedMotion) { play.disabled = true; play.title = 'Auto-play is off under reduced motion. Use Prev and Next to step.'; speeds.hidden = true; }
    if (v.status === 'loading') status.textContent = 'Reading the timeline';
    else if (!ok) status.textContent = `The timeline feed is not available (${v.error}). Layers stay live.`;
    else if (!v.events.length) status.textContent = 'No events in the last 24 hours.';
    else status.textContent = v.truncated ? 'The feed is capped; the oldest events are not listed.' : '';
    legend.hidden = !ok;
    if (!ok) { asOfText.textContent = 'live'; stop(); lanes.textContent = ''; drawnFor = null; return; }
    if (drawnFor !== v) { drawLanes(v); drawnFor = v; range.setAttribute('min', String(v.from)); range.setAttribute('max', String(v.to)); }
    const a = store.asOf();
    range.value = String(a ?? v.to);
    range.setAttribute('aria-valuetext', a == null ? 'live, latest' : `${clock(a)}, ${since(a)}`);
    asOfText.textContent = a == null ? 'live' : `as of ${clock(a)} (${since(a)})`;
    latest.setAttribute('aria-pressed', a == null ? 'true' : 'false');
    if (a == null && playing()) stop();
  }

  const jump = (dir) => {
    const v = store.get(); const a = store.asOf() ?? v.to;
    const evs = v.events;
    if (dir < 0) { for (let i = evs.length - 1; i >= 0; i--) if (evs[i].ts < a - 500) { store.setAsOf(evs[i].ts); return; } store.setAsOf(v.from); }
    else { for (const e of evs) if (e.ts > a + 500) { store.setAsOf(e.ts); return; } store.setAsOf(null); }
  };
  on(prev, 'click', () => { stop(); jump(-1); });
  on(next, 'click', () => { stop(); jump(1); });
  on(latest, 'click', () => { stop(); store.setAsOf(null); });
  on(range, 'input', () => { stop(); store.setAsOf(Number(range.value)); });
  on(range, 'change', () => { store.setAsOf(Number(range.value)); });
  for (const b of speedBtns) on(b, 'click', () => {
    speed = Number(b.dataset.speed);
    for (const x of speedBtns) x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
  });
  on(play, 'click', () => {
    if (playing()) { stop(); return; }
    if (reducedMotion || store.get().status !== 'ok') return;
    if (store.asOf() == null) store.setAsOf(store.get().from + 1);
    play.textContent = 'Pause'; play.setAttribute('aria-label', 'Pause'); play.setAttribute('aria-pressed', 'true');
    timer = setInterval(() => {
      const a = store.asOf();
      if (a == null) { stop(); return; }
      store.setAsOf(a + PLAY_MS_PER_S * speed * (PLAY_TICK_MS / 1000));
    }, PLAY_TICK_MS);
  });
  const unsub = store.subscribe(paint);
  paint();
  return {
    destroy() {
      stop(); unsub();
      for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
      listeners.length = 0; bar.remove();
    },
    el: bar, playing,
    setSpeed: (s) => { speed = s; },
  };
}
