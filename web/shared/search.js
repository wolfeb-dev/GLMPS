// web/shared/search.js
// The shell's search (card glmps-2-0-137: one box in the topbar on every
// pillar, Ctrl+K focuses it). From two characters it lists what its current
// source has loaded (cards, repositories, files, agents, players), plus
// transcript matches from GET /api/search. Off Surface the shell's own source
// knows cards and live sessions and lands on their page; Surface lends a
// richer source while it is mounted, whose results fly the globe to the item.
// A combobox over a listbox: arrows move, Enter opens, Escape closes.
import { search as apiSearch, getBacklog } from './api.js';
import { linkFor } from './deep-link.js';
import { countsAsLive } from './dom-util.js';
import { RESIDENCY_WORD } from '../surface/globe-core.js';
import { since } from '../surface/format.js';
import { agentName } from '../surface/agent-name.js';

export const MIN_CHARS = 2;
const PER_KIND = 4;
const TOTAL = 16;
const SESSION_HITS = 4;
const REMOTE_DELAY_MS = 300;
export const KIND_WORD = { agent: 'Agent', repo: 'Repo', card: 'Card', file: 'File', player: 'Player', session: 'Session' };
const KIND_ORDER = ['agent', 'repo', 'card', 'file', 'player', 'session'];

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// Everything searchable that is already on the page, as plain entries.
export function buildEntries(api) {
  const out = [];
  const add = (kind, id, title, sub, extra = '') => out.push({ kind, id, title, sub, hay: `${title} ${id} ${sub} ${extra}`.toLowerCase() });
  const rows = api.data.residency?.ok ? api.data.residency.data.rows ?? [] : [];
  for (const r of rows) add('repo', r.repo, r.repo, `${RESIDENCY_WORD[r.residency] ?? r.residency}, ${r.path}`);
  for (const a of api.agentList?.() ?? []) add('agent', a.id, a.title, `${a.repo ? `in ${a.repo}` : 'outside every repository'}, ${a.lastTs ? since(a.lastTs) : 'no activity'}`, a.summary ?? '');
  for (const c of api.data.backlog?.ok ? api.data.backlog.data.items ?? [] : []) add('card', c.id, c.title ?? c.id, `${c.id}, ${c.state}${c.origin?.via ? `, from ${c.origin.via}` : ''}`);
  for (const p of api.players ?? []) add('player', p.id, p.name, p.where ?? p.provider ?? '');
  const seen = new Set();
  const file = (repo, rel, sub) => { const id = `${repo}/${rel}`; if (seen.has(id)) return; seen.add(id); add('file', id, rel, `${repo}, ${sub}`); };
  for (const e of api.edits?.get().edits ?? []) if (e.repo && e.rel) file(e.repo, e.rel, `edited ${since(e.ts)}`);
  for (const [repo, entry] of api.trees ?? []) for (const f of entry.tree.files ?? []) file(repo, f.path, f.status);
  return out;
}

const scoreOf = (e, q) => {
  const t = e.title.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (new RegExp(`[\\s/_.-]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 1;
  if (t.includes(q)) return 2;
  if (e.id.toLowerCase().includes(q)) return 3;
  return e.hay.includes(q) ? 4 : -1;
};

export function rankEntries(entries, query) {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_CHARS) return [];
  const per = new Map();
  const hits = entries.map((e) => ({ e, s: scoreOf(e, q) })).filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || KIND_ORDER.indexOf(a.e.kind) - KIND_ORDER.indexOf(b.e.kind) || a.e.title.localeCompare(b.e.title));
  const out = [];
  for (const { e } of hits) {
    const n = per.get(e.kind) ?? 0;
    if (n >= PER_KIND) continue;
    per.set(e.kind, n + 1); out.push(e);
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).slice(0, TOTAL);
}

// Transcript matches folded to one entry per session.
export function sessionEntries(body, api) {
  const names = new Map((api.agentList?.() ?? []).map((a) => [a.id, a.title]));
  const seen = new Set(); const out = [];
  for (const r of body?.results ?? []) {
    if (!r?.sessionId || seen.has(r.sessionId)) continue;
    seen.add(r.sessionId);
    const snippet = String(r.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    out.push({ kind: 'session', id: r.sessionId, title: names.get(r.sessionId) ?? `Session ${r.sessionId.slice(0, 8)}`, sub: snippet || `line ${r.lineNo}`, hay: '' });
    if (out.length >= SESSION_HITS) break;
  }
  return out;
}

function highlight(node, text, q) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) { node.textContent = text; return; }
  node.append(document.createTextNode(text.slice(0, i)));
  node.append(el('mark', null, text.slice(i, i + q.length)));
  node.append(document.createTextNode(text.slice(i + q.length)));
}

export const SURFACE_SOURCE_TEXT = Object.freeze({
  label: 'Search Surface: cards, repositories, files, agents, players',
  placeholder: 'Fly to a card, repo, file, agent or place',
  empty: (q) => `Nothing on Surface matches "${q}".`,
});
let searchSeq = 0;

// source() answers the current { api, activate, label?, placeholder?, empty? };
// a plain { api, activate } is a fixed source (Surface's own fallback box).
export function createSearch(host, { api, activate, source = null, searchFn = apiSearch, onClose = () => {} }) {
  const src = source ?? (() => ({ api, activate, ...SURFACE_SOURCE_TEXT }));
  const uid = ++searchSeq;
  const box = el('div', 'surface-search'); box.setAttribute('role', 'search');
  const label = el('label', 'sr-only');
  const input = el('input', 'surface-search-input'); input.type = 'search'; input.id = `search-input-${uid}`;
  input.setAttribute('autocomplete', 'off');
  label.setAttribute('for', input.id);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', `search-list-${uid}`);
  const field = el('div', 'surface-search-field'); field.append(input);
  const list = el('ul', 'surface-search-list'); list.id = `search-list-${uid}`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Search results'); list.hidden = true;
  const optId = (i) => `search-${uid}-opt-${i}`;
  function relabel() {
    const s = src();
    label.textContent = s.label ?? SURFACE_SOURCE_TEXT.label;
    input.setAttribute('placeholder', s.placeholder ?? SURFACE_SOURCE_TEXT.placeholder);
  }
  relabel();
  const status = el('p', 'sr-only'); status.setAttribute('role', 'status');
  box.append(label, field, list, status);
  host.appendChild(box);

  let items = []; let active = -1; let q = ''; let seq = 0; let remoteTimer = null; let remote = { state: 'idle', entries: [], error: null };
  const listeners = [];
  const on = (t, type, fn) => { t.addEventListener(type, fn); listeners.push([t, type, fn]); };
  const isOpen = () => !list.hidden;

  function setActive(i) {
    active = i;
    list.querySelectorAll('[role="option"]').forEach((o, n) => o.setAttribute('aria-selected', n === i ? 'true' : 'false'));
    if (i >= 0) { input.setAttribute('aria-activedescendant', optId(i)); list.querySelectorAll('[role="option"]')[i]?.scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }

  function close() {
    const was = isOpen();
    list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1;
    clearTimeout(remoteTimer); seq++;
    if (was) onClose();
    return was;
  }

  function paint() {
    list.textContent = '';
    const shown = [...items, ...remote.entries];
    shown.forEach((e, i) => {
      const li = el('li', `sr-opt sr-${e.kind}`); li.id = optId(i); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
      const kind = el('span', 'sr-kind', KIND_WORD[e.kind] ?? e.kind);
      const title = el('span', 'sr-title'); highlight(title, e.title, q);
      const sub = el('span', 'sr-sub', e.sub);
      li.append(kind, title, sub);
      li.addEventListener('mousedown', (ev) => ev.preventDefault());
      li.addEventListener('click', () => choose(e));
      list.appendChild(li);
    });
    const note = (cls, text) => { const li = el('li', `sr-note ${cls}`, text); li.setAttribute('role', 'presentation'); list.appendChild(li); };
    if (remote.state === 'loading') note('sr-loading', 'Searching session text');
    if (remote.state === 'error') note('sr-error', `Session text search is not available: ${remote.error}`);
    if (!shown.length && remote.state !== 'loading') note('sr-empty', (src().empty ?? SURFACE_SOURCE_TEXT.empty)(q));
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
    status.textContent = shown.length ? `${shown.length} result${shown.length === 1 ? '' : 's'}` : (remote.state === 'loading' ? 'Searching' : 'No results');
    box.setAttribute('aria-busy', remote.state === 'loading' ? 'true' : 'false');
    setActive(shown.length ? Math.min(Math.max(active, 0), shown.length - 1) : -1);
  }
  const all = () => [...items, ...remote.entries];

  function choose(e) { close(); src().activate(e); }

  async function runRemote(mySeq) {
    remote = { state: 'loading', entries: [], error: null }; paint();
    try {
      const body = await searchFn(q);
      if (mySeq !== seq) return;
      if (body?.error) throw new Error(body.error);
      remote = { state: 'done', entries: sessionEntries(body, src().api), error: null };
    } catch (e) {
      if (mySeq !== seq) return;
      remote = { state: 'error', entries: [], error: e.message };
    }
    const keep = active; paint(); if (keep >= 0) setActive(Math.min(keep, all().length - 1));
  }

  function onInput() {
    q = input.value.trim().toLowerCase();
    clearTimeout(remoteTimer); seq++;
    remote = { state: 'idle', entries: [], error: null };
    if (q.length < MIN_CHARS) { items = []; const was = isOpen(); list.hidden = true; input.setAttribute('aria-expanded', 'false'); status.textContent = q.length ? `Type ${MIN_CHARS} or more characters` : ''; if (was) onClose(); return; }
    items = rankEntries(buildEntries(src().api), q);
    active = 0; paint();
    const mine = seq;
    remoteTimer = setTimeout(() => runRemote(mine), REMOTE_DELAY_MS);
  }
  on(input, 'input', onInput);
  on(input, 'keydown', (e) => {
    const n = all().length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen()) { onInput(); return; } if (n) setActive((active + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive((active - 1 + n) % n); }
    else if (e.key === 'Home' && isOpen() && n) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && isOpen() && n) { e.preventDefault(); setActive(n - 1); }
    else if (e.key === 'Enter') { const pick = all()[active]; if (pick) { e.preventDefault(); choose(pick); } }
    else if (e.key === 'Escape') { e.stopPropagation(); if (!close()) { input.value = ''; q = ''; items = []; onClose(); } }
  });
  on(box, 'focusout', (e) => { if (!box.contains(e.relatedTarget)) close(); });

  return {
    input, el: box, isOpen, close, relabel,
    // re-run the current query against the current source (it changed or loaded more)
    refresh() { if (isOpen() || input.value.trim().length >= MIN_CHARS) onInput(); },
    focus() { input.focus(); input.select?.(); },
    hasFocus: () => document.activeElement === input,
    destroy() {
      clearTimeout(remoteTimer); seq++;
      for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
      listeners.length = 0; box.remove();
    },
  };
}

// The shell's own source: what the shell already holds (live sessions in the
// slim state) plus the backlog, fetched when the box is focused. Results land
// on the page that shows them.
const SHELL_TEXT = Object.freeze({
  label: 'Search GLMPS: cards and live sessions',
  placeholder: 'Search cards and sessions (Ctrl+K)',
  empty: (q) => `No card or live session matches "${q}".`,
});
const BACKLOG_TTL_MS = 30000;

export function shellApi(getState, backlog) {
  return {
    data: { backlog },
    agentList: () => (getState?.()?.sessions ?? []).filter(countsAsLive).map((s) => ({
      id: s.id, title: agentName(getState(), s.id), repo: s.repo ?? null, lastTs: s.lastTs ?? null, summary: s.title ?? null,
    })),
  };
}

export function shellActivate(go) {
  return (e) => {
    if (e.kind === 'card') go(linkFor({ lens: 'work', sel: { type: 'card', id: e.id } }));
    else if (e.kind === 'agent' || e.kind === 'session') go(linkFor({ lens: 'session', sessionId: e.id }));
    else if (e.kind === 'repo' || e.kind === 'file' || e.kind === 'player') go(linkFor({ lens: 'surface', sel: { type: e.kind, id: e.id } }));
  };
}

// Mounted once, in the topbar, for every pillar. A lens lends a source with
// setSource() and gets back the function that releases it.
export function createShellSearch(host, { getState, go, searchFn = apiSearch, fetchBacklog = getBacklog }) {
  let backlog = null;
  let backlogAt = 0;
  let backlogP = null;
  const lent = [];
  const own = { activate: shellActivate(go), ...SHELL_TEXT };
  Object.defineProperty(own, 'api', { get: () => shellApi(getState, backlog), enumerable: true });
  const current = () => lent[lent.length - 1] ?? own;
  const search = createSearch(host, { source: current, searchFn });
  search.el.classList.add('shell-search');
  search.input.setAttribute('aria-keyshortcuts', 'Control+K');

  function loadBacklog() {
    if (backlogP || Date.now() - backlogAt < BACKLOG_TTL_MS) return backlogP;
    backlogP = Promise.resolve().then(() => fetchBacklog()).then(
      (data) => { backlog = { ok: true, data: { items: Array.isArray(data?.items) ? data.items : [] } }; },
      (e) => { console.error('search: backlog fetch failed', e); backlog = { ok: false, error: e.message }; },
    ).finally(() => { backlogAt = Date.now(); backlogP = null; if (current() === own) search.refresh(); });
    return backlogP;
  }
  const onFocus = () => { if (current() === own) loadBacklog(); };
  search.input.addEventListener('focus', onFocus);

  // Ctrl+K (Cmd+K) from anywhere but another text field, which may bind the
  // key itself; the browser's own binding for it is the address-bar search,
  // which this page has no use for.
  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'k') return;
    const t = e.target;
    if (t && t !== search.input && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? '') || t.isContentEditable === true || t.closest?.('[contenteditable="true"]'))) return;
    e.preventDefault();
    search.focus();
    onFocus();
  };
  window.addEventListener('keydown', onKey);

  return {
    input: search.input,
    el: search.el,
    focus: () => { search.focus(); onFocus(); },
    isOpen: search.isOpen,
    close: search.close,
    setSource(src) {
      const entry = { ...src };
      lent.push(entry);
      search.close(); search.relabel();
      return () => {
        const i = lent.indexOf(entry);
        if (i < 0) return;
        lent.splice(i, 1);
        search.close(); search.relabel();
      };
    },
    destroy() {
      window.removeEventListener('keydown', onKey);
      search.input.removeEventListener('focus', onFocus);
      search.destroy();
    },
  };
}
