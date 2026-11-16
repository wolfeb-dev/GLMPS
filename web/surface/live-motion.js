// web/surface/live-motion.js
// The Surface's live motion: the SSE stream and board changes become pings on
// the agents' dials, arcs to GitHub, Slack and the model providers, amber
// rings for sessions waiting on the operator, and the roster the Sessions dock
// and Wall mode read. One requestAnimationFrame loop (frame-loop.js) runs only
// while a ping or an arc is in flight. All data reaches the DOM as text or
// attributes. Nothing here adds a server route or changes an event shape.
import { createPulseStore as createStore, providerFor, needsYou } from './heartbeat.js';
import { createFrameLoop } from './frame-loop.js';
import { arcPoints } from './layers.js';
import { PING_FROM, PING_TO } from './agent-dial.js';
import { duration } from './track.js';
import { FRESH_GIT_MS } from './director.js';

export const PING_MS = 900;
export const ARC_MS = 1600;
export const ROUND_TRIP_MS = 2200;
export const STILL_ARC_MS = 2000;
const MAX_FX = 60;
const MAX_PINGS_PER_SESSION = 6;
const SEED_LIMIT = 30;
const BOARD_IDS_LIMIT = 12;
const SLACK_FRESH_MS = 30_000;
const DEFAULT_STALE_MS = 15 * 60_000;

const ease = (k) => 1 - (1 - k) * (1 - k);
const num = (n) => n.toFixed(1);

// The part of a projected polyline that a packet has covered: the path up to
// `frac` of its on-screen length (broken where a point is off the globe) and
// the packet's position. Pure, so it is tested without a DOM.
export function arcSlice(pts, frac) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len, from: total });
    total += len;
  }
  if (!segs.length || total <= 0) return { d: '', head: null };
  const want = Math.max(0, Math.min(1, frac)) * total;
  let d = ''; let head = null; let prev = null;
  for (const s of segs) {
    if (s.from >= want) break;
    const t = Math.min(1, (want - s.from) / (s.len || 1));
    const end = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    d += `${prev === s.a ? '' : `M${num(s.a[0])},${num(s.a[1])}`}L${num(end[0])},${num(end[1])}`;
    prev = s.b; head = end;
  }
  return { d, head };
}

export function createLiveMotion({ api, reduced = false, now = Date.now, clock = () => performance.now(), getJson, visible = () => true, announce = () => {}, onChange = () => {} }) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, cls) => { const e = document.createElementNS(SVG_NS, tag); if (cls) e.setAttribute('class', cls); return e; };
  const fetchJson = getJson ?? (async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
    return res.json();
  });
  const store = createStore();
  const fx = [];
  const provInFlight = new Set();
  const seen = new Map(); // card id -> { devTs, gateTs }
  const waitingBy = new Map(); // card id -> session id
  const lastStatus = new Map();
  const lastTry = new Map();
  let gone = false; let joining = false; let warned = false;
  let staleMs = api.data.live?.ok ? api.data.live.data.staleMs ?? DEFAULT_STALE_MS : DEFAULT_STALE_MS;
  const group = api.globe.layerGroup('motion', () => { for (const f of fx) if (f.type === 'arc') drawArc(f, clock()); });
  const alive = () => !gone && api.destroyed !== true;
  const warn = (text) => { if (warned) return; warned = true; api.empty?.(text); };
  const agents = () => api.agents ?? null;
  const toolOf = (sid) => api.ctx?.getState?.()?.sessions?.find((s) => s.id === sid)?.tool ?? null;
  const playerAt = (id) => { const p = (api.players ?? []).find((x) => x.id === id); return p && Number.isFinite(p.lon) && Number.isFinite(p.lat) ? [p.lon, p.lat] : null; };

  const loop = createFrameLoop({ step: () => step() });

  function dropFx(i) {
    const f = fx[i];
    f.el?.remove(); f.dot?.remove();
    if (f.type === 'arc' && f.provider) provInFlight.delete(f.sid);
    fx.splice(i, 1);
  }

  function addPing(sid, tone) {
    if (reduced || !visible() || document.hidden) return;
    const m = agents()?.get(sid);
    if (!m || fx.filter((f) => f.type === 'ping' && f.sid === sid).length >= MAX_PINGS_PER_SESSION) return;
    fx.push({ type: 'ping', sid, tone, born: clock(), ttl: PING_MS, el: m.dial.addPing(tone) });
    capFx(); loop.wake();
  }

  function addArc(sid, to, tone, { roundTrip = false, provider = false } = {}) {
    if (!visible() || document.hidden || !agents()?.get(sid) || !playerAt(to)) return;
    if (provider && provInFlight.has(sid)) return;
    const el = svgEl('path', `live-arc arc-${tone}`); el.setAttribute('aria-hidden', 'true');
    const dot = reduced ? null : svgEl('circle', `live-dot dot-${tone}`);
    if (dot) { dot.setAttribute('r', '3.2'); dot.setAttribute('aria-hidden', 'true'); }
    group.appendChild(el); if (dot) group.appendChild(dot);
    if (provider) provInFlight.add(sid);
    const f = { type: 'arc', sid, to, tone, roundTrip, provider, born: clock(), ttl: reduced ? STILL_ARC_MS : roundTrip ? ROUND_TRIP_MS : ARC_MS, el, dot };
    fx.push(f); drawArc(f, f.born);
    capFx(); loop.wake();
  }
  const capFx = () => { while (fx.length > MAX_FX) dropFx(0); };

  function drawArc(f, t) {
    const from = api.agentPos?.(f.sid, api.globe.getCamera().k);
    const to = playerAt(f.to);
    const pts = from && to ? arcPoints(api.d3, from, to, api.globe.project) : [];
    const k = Math.min(1, Math.max(0, (t - f.born) / f.ttl));
    // Under reduced motion the line is drawn whole and held still.
    const travel = reduced ? 1 : f.roundTrip ? (k < 0.5 ? k * 2 : 2 - k * 2) : Math.min(1, k / 0.7);
    const drawn = arcSlice(pts, reduced ? 1 : f.roundTrip ? Math.min(1, k * 2) : travel);
    f.el.setAttribute('d', drawn.d);
    f.el.setAttribute('opacity', reduced ? '0.8' : k > 0.7 ? (Math.max(0, (1 - k) / 0.3) * 0.9).toFixed(2) : '0.9');
    if (f.dot) {
      const head = arcSlice(pts, travel).head;
      if (head) { f.dot.setAttribute('cx', num(head[0])); f.dot.setAttribute('cy', num(head[1])); f.dot.removeAttribute('display'); } else f.dot.setAttribute('display', 'none');
    }
  }

  function step() {
    const t = clock();
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      const k = (t - f.born) / f.ttl;
      if (k >= 1) { dropFx(i); continue; }
      if (f.type === 'ping') {
        f.el.setAttribute('r', num(PING_FROM + (PING_TO - PING_FROM) * ease(k)));
        f.el.setAttribute('opacity', (0.9 * (1 - k)).toFixed(2));
      } else drawArc(f, t);
    }
    return fx.length > 0;
  }

  // --- status, dial and roster ------------------------------------------------
  const lastTsOf = (m) => m.s.lastTs ?? 0;
  const statusOf = (m, n) => store.status(m.s.id, n, { staleMs, lastTs: lastTsOf(m) });
  function wordOf(m, status, n) {
    if (status === 'waiting') return `needs you ${duration(n - (store.summary(m.s.id, n).waiting?.since ?? n))}`;
    if (status === 'fail') return 'gate failed';
    if (status === 'idle') return 'idle';
    const c = store.callsPerMinute(m.s.id, n);
    return c ? `${c} ${c === 1 ? 'call' : 'calls'} a minute` : 'quiet';
  }

  function paintMark(m, n) {
    const status = statusOf(m, n);
    m.dial.paint(store.ticks(m.s.id, n), status);
    if (m.g.dataset.state !== status) m.g.dataset.state = status;
    const label = `Agent ${m.name}, ${wordOf(m, status, n)}`;
    if (m.g.getAttribute('aria-label') !== label) m.g.setAttribute('aria-label', label);
    const before = lastStatus.get(m.s.id);
    if (before !== status) {
      lastStatus.set(m.s.id, status);
      if (before != null && status === 'waiting') announce(`${m.name} needs you`);
      else if (before != null && status === 'fail') announce(`${m.name}: gate did not pass`);
    }
  }

  function paintAll() {
    const n = now();
    for (const m of agents()?.list() ?? []) paintMark(m, n);
  }

  // The roster's colour: green for the Director's fresh-git window after a commit, push or pass.
  const STATUS_TONE = { waiting: 'warn', fail: 'err', idle: 'idle', active: 'info' };
  function toneOf(id, status, n) {
    if (status !== 'active') return STATUS_TONE[status];
    return store.ticks(id, n).slice(0, Math.ceil(FRESH_GIT_MS / 1000)).includes('ok') ? 'ok' : 'info';
  }
  // The roster line says what the session is doing; the rate has its own column.
  function lineOf(m, status, sum, n) {
    if (status === 'idle') { const last = Math.max(sum.lastTs ?? 0, lastTsOf(m)); return last ? `idle ${duration(n - last)}` : 'idle'; }
    if (status === 'active' && sum.lastLabel) return sum.lastLabel.slice(0, 80);
    return wordOf(m, status, n);
  }

  function rows() {
    const n = now();
    const order = { waiting: 0, fail: 1, active: 2, idle: 3 };
    return (agents()?.list() ?? []).map((m) => {
      const status = statusOf(m, n);
      const sum = store.summary(m.s.id, n);
      return { id: m.s.id, name: m.short, repo: m.repo?.repo ?? null, status, tone: toneOf(m.s.id, status, n), word: lineOf(m, status, sum, n), series: store.series(m.s.id, n), cpm: store.callsPerMinute(m.s.id, n), waitingSince: sum.waiting?.since ?? null, lastTs: Math.max(sum.lastTs ?? 0, lastTsOf(m)) };
    }).sort((a, b) => order[a.status] - order[b.status] || (a.status === 'waiting' ? (a.waitingSince ?? 0) - (b.waitingSince ?? 0) : b.cpm - a.cpm || b.lastTs - a.lastTs));
  }

  function directorInputs() {
    const n = now();
    return (agents()?.list() ?? []).map((m) => {
      const status = statusOf(m, n);
      return { id: m.s.id, waiting: status === 'waiting', failing: status === 'fail', lastGitTs: store.summary(m.s.id, n).lastGitTs, cpm: store.callsPerMinute(m.s.id, n), idle: status === 'idle' };
    });
  }

  function headsUp(id) {
    const m = agents()?.get(id);
    if (!m) return '';
    const n = now(); const sum = store.summary(id, n);
    const action = sum.lastLabel ? sum.lastLabel.slice(0, 60) : wordOf(m, statusOf(m, n), n);
    const ago = sum.lastTs != null ? `${duration(n - sum.lastTs)} ago` : 'no events yet';
    return `${m.short}: ${action} | ${ago} | ${store.callsPerMinute(id, n)}/min`;
  }

  // --- live sessions ---------------------------------------------------------
  // A session that streams events but is not on the ring joins on one refetch
  // of the live sessions. A session the feed does not list is retried at most
  // every 15 s.
  async function join(sid) {
    if (joining || !agents()) return;
    const t = now();
    if (t - (lastTry.get(sid) ?? 0) < 15_000) return;
    lastTry.set(sid, t);
    joining = true;
    try {
      const body = await fetchJson('/api/sessions/live');
      if (!alive()) return;
      if (Number.isFinite(body?.staleMs)) staleMs = body.staleMs;
      const added = agents().add(Array.isArray(body?.sessions) ? body.sessions : []);
      if (added.length) { paintAll(); onChange(added); }
    } catch (e) { warn(`Live sessions could not be refetched: ${e.message}`); } finally { joining = false; }
  }

  // --- the event stream ------------------------------------------------------
  function onEvents(sid, events) {
    const n = now();
    const r = store.push(sid, events, n);
    const m = agents()?.get(sid);
    if (!m) { join(sid); return; }
    for (const tone of r.pings) addPing(sid, tone);
    if (r.push) addArc(sid, 'github', 'ok');
    const provider = providerFor(toolOf(sid));
    if (provider) addArc(sid, provider, 'info', { roundTrip: true, provider: true });
    paintMark(m, n);
  }

  // --- the board -------------------------------------------------------------
  // The backlog store writes ISO strings; numbers are accepted too. Unparseable is 0.
  const ms = (ts) => { const v = typeof ts === 'number' ? ts : Date.parse(ts); return Number.isFinite(v) ? v : 0; };
  const lastOf = (log) => (Array.isArray(log) ? log.reduce((a, e) => Math.max(a, ms(e?.ts)), 0) : 0);
  function ingestCard(card, { seed = false } = {}) {
    if (!card?.id) return;
    const n = now();
    const sid = card.runSession?.sessionId ?? null;
    const prev = seen.get(card.id);
    const devTs = lastOf(card.devLog); const gateTs = ms(card.gate?.ts);
    seen.set(card.id, { devTs, gateTs });

    if (sid && needsYou(card)) {
      const since = Math.min(n, ms(card.updatedAt) || devTs || n);
      store.setWaiting(sid, { since, reason: card.state, cardId: card.id });
      waitingBy.set(card.id, sid);
    } else if (waitingBy.has(card.id)) {
      const was = waitingBy.get(card.id); waitingBy.delete(card.id);
      if (store.summary(was, n).waiting?.cardId === card.id) store.setWaiting(was, null);
    }
    if (seed || !sid || !agents()?.get(sid)) { paintAll(); return; }

    const fresh = (ts, was) => ts > (was ?? n - SLACK_FRESH_MS);
    const newGate = gateTs > 0 && fresh(gateTs, prev?.gateTs);
    const newDev = devTs > 0 && fresh(devTs, prev?.devTs);
    if (newGate) {
      const bad = card.gate.status === 'FAIL' || card.gate.status === 'CONCERNS';
      if (bad || card.gate.status === 'PASS') { store.mark(sid, bad ? 'err' : 'ok', n); addPing(sid, bad ? 'err' : 'ok'); }
    }
    if (card.origin?.via === 'slack' && (newGate || newDev)) addArc(sid, 'slack', 'info');
    paintAll();
  }

  async function readCards(ids, opts) {
    await Promise.all(ids.map(async (id) => {
      try { const card = await fetchJson(`/api/backlog/${encodeURIComponent(id)}`); if (alive()) ingestCard(card, opts); }
      catch (e) { warn(`Live motion could not read card ${id}: ${e.message}`); }
    }));
  }

  // Held cards and Slack-born cards in flight are read once at mount, so a
  // waiting session shows amber at once and the first later devlog entry arcs.
  function seed() {
    const items = api.data.backlog?.ok ? api.data.backlog.data.items ?? [] : [];
    const ids = items.filter((c) => c.state === 'held' || c.state === 'idle' || (c.origin?.via === 'slack' && ['queued', 'in_progress', 'in_review'].includes(c.state))).map((c) => c.id).slice(0, SEED_LIMIT);
    return readCards(ids, { seed: true });
  }

  return {
    store, rows, directorInputs, headsUp, seed, paintAll, statusOf: (id) => { const m = agents()?.get(id); return m ? statusOf(m, now()) : null; },
    onEvent(p) {
      if (!alive() || !p) return;
      if (p.type === 'events' && p.sessionId && Array.isArray(p.events) && p.events.length) onEvents(p.sessionId, p.events);
      else if (p.type === 'backlog' && Array.isArray(p.ids)) readCards(p.ids.slice(0, BOARD_IDS_LIMIT), {});
    },
    // The lens's existing 500 ms readout tick drives the per-second dial and timers.
    tick() { if (alive()) paintAll(); },
    active: () => loop.active(),
    effects: () => fx.length,
    destroy() {
      gone = true;
      loop.destroy();
      while (fx.length) dropFx(fx.length - 1);
      group.textContent = '';
    },
  };
}
