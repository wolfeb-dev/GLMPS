// web/surface/ledger.js
// The data types GLMPS holds, the Data ledger panel that counts them and names
// every player holding a copy, and the column bars on the platforms. The feed
// is GET /api/surface/ledger; it is fetched after the lens mounts, so a slow or
// failing ledger never delays the globe.
import { bindItem } from '../shared/interactive-item.js';
import { formatTime } from '../shared/time-format.js';

export const LEDGER_ITEM_TYPES = { datatype: 'the data type\'s count and every player holding a copy' };

// Order, key and colour are the operator's chosen mockup's; the ids are the feed's.
export const DATA_TYPES = Object.freeze([
  { id: 'markdown', key: '1', label: 'Markdown documents', color: '#7ec3ff' },
  { id: 'config', key: '2', label: 'Config files', color: '#5fd0d8' },
  { id: 'code', key: '3', label: 'Code files', color: '#b48cff' },
  { id: 'projects', key: '4', label: 'Projects', color: '#3d8bff' },
  { id: 'cards', key: '5', label: 'Kanban cards', color: '#f5a524' },
  { id: 'sessions', key: '6', label: 'Sessions', color: '#ff8a5b' },
  { id: 'learning', key: '7', label: 'Learning loops', color: '#3fb6a0' },
  { id: 'alerts', key: '8', label: 'Alerts', color: '#ff5b5b' },
]);

export const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US'));

// The ledger is slow cold, so the last measurement is kept client side and
// painted at once; the feed then replaces it.
export const LEDGER_CACHE_KEY = 'surface.ledger';
const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

function readCache(storage) {
  try {
    const c = JSON.parse(storage?.getItem(LEDGER_CACHE_KEY) ?? 'null');
    return c && Array.isArray(c.types) && c.types.length ? c : null;
  } catch { return null; }
}

export function createLedgerStore({ storage = defaultStorage() } = {}) {
  const cached = readCache(storage);
  let value = cached
    ? { status: 'ok', types: cached.types, error: null, ts: cached.ts ?? null, refreshError: null, cached: true }
    : { status: 'loading', types: [], error: null, ts: null, refreshError: null, cached: false };
  const hidden = new Set();
  const subs = new Set();
  const emit = () => { for (const f of [...subs]) f(); };
  return {
    get: () => value,
    hidden,
    isHidden: (id) => hidden.has(id),
    setHidden(id, on) { if (on) hidden.add(id); else hidden.delete(id); emit(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    resolve(body) {
      value = { status: 'ok', types: Array.isArray(body?.types) ? body.types : [], error: null, ts: body?.ts ?? null, refreshError: null, cached: false };
      try { if (value.types.length) storage?.setItem(LEDGER_CACHE_KEY, JSON.stringify({ ts: value.ts, types: value.types })); } catch { /* private mode */ }
      emit();
    },
    fail(error) {
      value = value.types.length
        ? { ...value, refreshError: error }
        : { status: 'error', types: [], error, ts: null, refreshError: null, cached: false };
      emit();
    },
  };
}

export async function loadLedger(store, isDestroyed) {
  const url = '/api/surface/ledger';
  let res;
  try {
    res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
    const body = await res.json();
    if (!isDestroyed()) store.resolve(body);
  } catch (e) {
    if (!isDestroyed()) store.fail(e.message.startsWith('GET ') ? e.message : `GET ${url} failed: ${e.message}`);
  }
}

// What the Layers panel and the HUD say about the whole ledger.
export function ledgerStats(types) {
  const withCopy = types.filter((t) => (t.copies?.length ?? 0) > 0).length;
  return {
    types: types.length,
    onlyHere: types.reduce((a, t) => a + (t.onlyHere ?? 0), 0),
    coverage: types.length ? Math.round((withCopy / types.length) * 100) : 0,
  };
}

// The chips on one ledger row: each player holding a copy, then what stays on
// this disk. A type with no copy anywhere says so in words.
export function chipsFor(type, playerName) {
  const chips = (type.copies ?? []).map((c) => ({ cls: `lchip lchip-${c.player}`, text: `${playerName(c.player)} ${fmt(c.count)}` }));
  if (!chips.length) return [{ cls: 'lchip none', text: 'nowhere else' }];
  if ((type.onlyHere ?? 0) > 0) chips.push({ cls: 'lchip none', text: `only here ${fmt(type.onlyHere)}` });
  return chips;
}

// The columns of one platform's bars, in the study's type order: the local
// store holds every type in full, a remote player holds what the copies say.
const segHeight = (n) => (n == null ? 8 : 6 + 10 * Math.log10(n + 1));
export function stackFor(types, playerId) {
  const byId = new Map(types.map((t) => [t.id, t]));
  const out = [];
  for (const dt of DATA_TYPES) {
    const t = byId.get(dt.id);
    if (!t) continue;
    let count;
    if (playerId === 'local') count = t.count;
    else { const c = (t.copies ?? []).find((x) => x.player === playerId); if (!c) continue; count = c.count; }
    if (count === 0) continue;
    out.push({ type: dt.id, color: dt.color, label: t.label ?? dt.label, count, h: segHeight(count) });
  }
  return out;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const BAR_BASE = -24;
const COL_W = 5;
const COL_GAP = 1;

// Rebuilds every platform's columns from the store: hidden types drop out and
// the rest close up, so the histogram stays centred on the platform.
export function renderStacks(api, store) {
  const { types, status } = store.get();
  for (const m of api.playerMarks ?? []) {
    m.stack.textContent = '';
    if (status !== 'ok') continue;
    const segs = stackFor(types, m.p.id).filter((seg) => !store.isHidden(seg.type));
    const left = -(segs.length * COL_W + (segs.length - 1) * COL_GAP) / 2;
    segs.forEach((seg, i) => {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('class', 'seg'); r.setAttribute('data-type', seg.type);
      r.setAttribute('x', String(left + i * (COL_W + COL_GAP))); r.setAttribute('width', String(COL_W));
      r.setAttribute('y', (BAR_BASE - seg.h).toFixed(1)); r.setAttribute('height', seg.h.toFixed(1));
      r.setAttribute('fill', seg.color);
      const t = document.createElementNS(SVG_NS, 'title'); t.textContent = `${seg.label}: ${fmt(seg.count)}`; r.appendChild(t);
      m.stack.appendChild(r);
    });
  }
}

function dtInspect(api, dt, store) {
  const t = store.get().types.find((x) => x.id === dt.id);
  if (!t) return { title: dt.label, empty: store.get().status === 'error' ? `Data ledger not available: ${store.get().error}` : 'The ledger has not loaded yet.' };
  const name = (id) => api.players?.find((p) => p.id === id)?.name ?? id;
  return {
    title: t.label ?? dt.label,
    word: `${fmt(t.count)} on this disk`,
    facts: [
      ...(t.copies ?? []).map((c) => [name(c.player), c.count == null ? 'copy held, count not captured' : fmt(c.count)]),
      ['only on this disk', fmt(t.onlyHere)],
      ['shown on the globe', store.isHidden(dt.id) ? 'no' : 'yes'],
    ],
  };
}

export function registerDatatypeOpener(api, store) {
  api.registerOpener('datatype', (id) => {
    const dt = DATA_TYPES.find((d) => d.id === id);
    if (!dt) return false;
    api.inspect(dtInspect(api, dt, store));
    return true;
  });
}

// The Data ledger panel: one row per type with its count and a chip per
// holder. Rows exist from the first paint (the static type list); the numbers
// arrive with the feed.
export function renderLedgerPanel(dock, api, store) {
  const render = () => {
    const { status, types, error, ts, refreshError, cached } = store.get();
    const body = dock.body; body.textContent = '';
    if (status === 'error') {
      const p = document.createElement('p'); p.className = 'band-error'; p.textContent = `Data ledger not available: ${error}`; body.appendChild(p);
      dock.subEl.textContent = 'The globe and its other panels do not depend on it.';
      dock.subEl.hidden = false;
      return;
    }
    const byId = new Map(types.map((t) => [t.id, t]));
    const players = new Set(types.flatMap((t) => (t.copies ?? []).map((c) => c.player)));
    dock.subEl.hidden = false;
    dock.subEl.textContent = status === 'ok' ? `Each type, its count on this disk, and every player holding a copy. ${types.length} types, ${players.size} players.` : 'Measuring the types on this disk.';
    const name = (id) => { const p = api.players?.find((x) => x.id === id); return p?.short ?? p?.name ?? id; };
    for (const dt of DATA_TYPES) {
      const t = byId.get(dt.id);
      const row = document.createElement('div'); row.className = `lrow${store.isHidden(dt.id) ? ' off' : ''}`;
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = dt.color; sw.setAttribute('aria-hidden', 'true');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = t?.label ?? dt.label;
      const loc = document.createElement('span'); loc.className = 'loc'; loc.textContent = t ? fmt(t.count) : '';
      const chips = document.createElement('span'); chips.className = 'chips';
      if (t) for (const c of chipsFor(t, name)) { const s = document.createElement('span'); s.className = c.cls; s.textContent = c.text; chips.appendChild(s); }
      else { const s = document.createElement('span'); s.className = 'lchip skel'; s.textContent = status === 'ok' ? 'not in the feed' : 'measuring'; chips.appendChild(s); }
      row.append(sw, nm, loc, chips);
      bindItem(row, { type: 'datatype', id: dt.id, link: api.link({ type: 'datatype', id: dt.id }), open: () => api.open({ type: 'datatype', id: dt.id }), label: t ? `${t.label ?? dt.label}: ${fmt(t.count)} on this disk` : `${dt.label}: counting` });
      body.appendChild(row);
    }
    dock.footEl.hidden = false;
    dock.footEl.textContent = ts ? `measured ${formatTime(ts)}: git ls-files over the residency checkouts, the backlog, sessions found per tool, and the learning and alert stores. Off-disk copies are stated per player.${refreshError ? ` Refresh failed, showing the last measurement: ${refreshError}` : cached ? ' Refreshing.' : ''}` : 'Counts come from this disk and the local server.';
  };
  render();
  return store.subscribe(render);
}
