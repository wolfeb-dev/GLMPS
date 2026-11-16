// web/loops/lens.js
// Loops: every registered background loop in one dense table, grouped by job,
// with status, cadence, age against its time limit, why it runs and the
// Personality cards that steer it. A row opens in place; a failing loop raises
// a banner. The Graphs table lives under Knowledge > Architecture graph
// (web/knowledge/graphs-table.js). Everything server-derived
// reaches the DOM through textContent.
import { getLoopCatalog, getPersonality } from '../shared/api.js';
import { clear } from '../shared/dom-util.js';
import { linkFor } from '../shared/deep-link.js';
import { formatTime } from '../shared/time-format.js';
import {
  SCOPES, STATUS_LABEL, ageNowS, cadence, fmtDuration, groupLoops, loopMatches, mergeSteers,
  modeLabel, nextRunText, slaFraction, statusOf, summarize,
} from './model.js';

export const ITEM_TYPES = Object.freeze({});

const SCOPE_KEY = 'glmps.loops.scope';
const REFRESH_MS = 15_000;
const TICK_MS = 30_000;
const BANNER_CAP = 3;
const COLS = 6;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function loadScope() {
  try {
    const v = localStorage.getItem(SCOPE_KEY);
    return SCOPES.some(([id]) => id === v) ? v : 'all';
  } catch { return 'all'; }
}
function saveScope(v) {
  try { localStorage.setItem(SCOPE_KEY, v); } catch { /* private mode: the scope simply does not persist */ }
}

function domId(prefix, name) { return `${prefix}-${String(name).replace(/[^A-Za-z0-9_-]/g, '-')}`; }

export async function mount(root, route, ctx) {
  const owns = () => ctx.isCurrent?.() !== false;
  const wrap = el('div', 'lp');
  root.appendChild(wrap);

  const head = el('header', 'lp-head');
  head.append(el('h2', null, 'Loops'), el('span', 'lp-muted', 'Every background loop, what it runs on, and which Personality files steer it'));
  wrap.appendChild(head);
  const content = el('div', 'lp-content');
  const loading = el('p', 'lp-muted', 'Loading...');
  loading.setAttribute('role', 'status');
  content.appendChild(loading);
  wrap.appendChild(content);

  let catalog;
  let names = new Map();
  const [cat, pers] = await Promise.allSettled([getLoopCatalog(), getPersonality()]);
  if (!owns()) return inert();
  if (cat.status === 'rejected') {
    clear(content);
    const box = el('div', 'lp-error');
    box.setAttribute('role', 'alert');
    box.append(el('p', null, `Could not load the loops: ${cat.reason?.message ?? cat.reason}. Nothing was changed; check that the server is running, then try again.`));
    const retry = el('button', 'lp-btn', 'Try again');
    retry.type = 'button';
    let inner = null;
    retry.addEventListener('click', () => { wrap.remove(); mount(root, route, ctx).then((h) => { inner = h; }); });
    box.appendChild(retry);
    content.appendChild(box);
    return {
      update: (r) => inner?.update(r), onState: (s) => inner?.onState(s), onEvent: (p) => inner?.onEvent(p),
      unmount() { if (inner) inner.unmount(); else wrap.remove(); },
    };
  }
  catalog = cat.value;
  names = cardNameMap(pers);

  const state = {
    scope: loadScope(), q: '', open: new Set(), fetchedAt: Date.now(), loops: catalog.loops ?? [],
    refreshing: false, lastError: null,
  };
  const nameOf = (id) => names.get(id) ?? id;
  const elapsed = () => Date.now() - state.fetchedAt;

  clear(content);
  const summaryEl = el('section', 'lp-summary');
  summaryEl.setAttribute('aria-label', 'Summary');
  const bannersEl = el('div', 'lp-banners');

  const bar = el('div', 'lp-bar');
  bar.setAttribute('role', 'search');
  const segLabel = el('span', 'lp-label', 'Show');
  segLabel.id = 'lp-scope-l';
  const seg = el('div', 'lp-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-labelledby', 'lp-scope-l');
  const segBtns = SCOPES.map(([id, text]) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.dataset.v = id;
    b.addEventListener('click', () => { state.scope = id; saveScope(id); render(); });
    seg.appendChild(b);
    return b;
  });
  const searchLabel = el('label', 'lp-label', 'Search');
  searchLabel.setAttribute('for', 'lp-search');
  const input = el('input', 'lp-search');
  input.id = 'lp-search';
  input.type = 'search';
  input.placeholder = 'Loop or Personality card';
  input.addEventListener('input', () => { state.q = input.value; render(); });
  const countEl = el('span', 'lp-count');
  countEl.setAttribute('role', 'status');
  bar.append(segLabel, seg, searchLabel, input, countEl);

  const noteEl = el('p', 'lp-muted lp-note');
  noteEl.setAttribute('role', 'status');
  noteEl.hidden = true;

  const table = el('table', 'lp-table');
  table.appendChild(el('caption', 'lp-sr', 'Loops, grouped by job'));
  const thead = el('thead');
  const hr = el('tr');
  for (const [text, cls] of [['Loop', ''], ['Status', ''], ['Runs', 'c-runs'], ['Age vs limit', ''], ['Why it runs', 'c-why'], ['Steered by', '']]) {
    const th = el('th', cls, text);
    th.setAttribute('scope', 'col');
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  const tableWrap = el('div', 'lp-tablewrap');
  tableWrap.appendChild(table);

  const none = el('p', 'lp-muted lp-none');
  none.hidden = true;
  const clearBtn = el('button', 'lp-btn', 'Clear filters');
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => { state.scope = 'all'; saveScope('all'); state.q = ''; input.value = ''; render(); });

  content.append(summaryEl, bannersEl, bar, noteEl, tableWrap, none);

  const rowEls = new Map();

  function stat(n, label, cls) {
    const d = el('div', `lp-stat${cls ? ` ${cls}` : ''}`);
    d.append(el('b', null, String(n)), el('span', null, label));
    summaryEl.appendChild(d);
  }

  function chips(steers, emptyText) {
    const list = mergeSteers(steers);
    if (!list.length) return el('span', 'lp-muted', emptyText);
    const wrapEl = el('div', 'lp-chips');
    for (const c of list) {
      const chip = el('span', `lp-chip${c.direct ? '' : ' ind'}`);
      chip.title = modeLabel(c);
      chip.appendChild(document.createTextNode(nameOf(c.card)));
      if (c.writes) chip.appendChild(el('span', 'lp-w', 'writes'));
      if (!c.direct) chip.appendChild(el('span', 'lp-sr', ' (indirect)'));
      wrapEl.appendChild(chip);
    }
    return wrapEl;
  }

  function statusCell(kind) {
    const td = el('td');
    td.appendChild(el('span', `lp-st ${kind}`, STATUS_LABEL[kind]));
    return td;
  }

  function slaCell(loop, kind) {
    const td = el('td', 'c-age');
    const age = ageNowS(loop, elapsed());
    if (age == null) { td.appendChild(el('span', 'lp-muted', 'no runs')); return td; }
    const frac = slaFraction(age, loop.sla?.maxAgeMs);
    const text = loop.sla?.maxAgeMs > 0 ? `${fmtDuration(age * 1000)} / ${fmtDuration(loop.sla.maxAgeMs)}` : fmtDuration(age * 1000);
    if (frac != null) {
      const bar2 = el('span', `lp-sla ${kind}`);
      bar2.setAttribute('aria-hidden', 'true');
      const fill = el('i');
      fill.style.setProperty('width', `${Math.round(frac * 100)}%`);
      bar2.appendChild(fill);
      td.appendChild(bar2);
    }
    td.appendChild(el('span', 'lp-age', text));
    return td;
  }

  function detailRow(loop, kind, now) {
    const tr = el('tr', 'lp-detail');
    tr.id = domId('lp-d', loop.name);
    const td = el('td');
    td.colSpan = COLS;
    td.setAttribute('colspan', String(COLS));
    const dl = el('dl', 'lp-detail-grid');
    const add = (k, v, cls) => {
      const d = el('div');
      d.append(el('dt', null, k), el('dd', cls || null, v));
      dl.appendChild(d);
      return d;
    };
    const about = loop.about;
    if (!about) add('About', 'This loop has no description record yet.');
    else {
      if (about.produces) add('Produces', about.produces);
      if (about.why) add('Why', about.why);
    }
    if (loop.lastReason) add('Last error', loop.lastReason, kind === 'failing' ? 'lp-bad' : null);
    const next = nextRunText(loop, now);
    const nd = add('Next run', next.text);
    if (next.ts) nd.querySelector('dd').title = formatTime(next.ts);
    const steers = mergeSteers(about?.steers);
    const sd = el('div', 'lp-wide');
    sd.appendChild(el('dt', null, 'Steered by'));
    const dd = el('dd');
    if (!steers.length) dd.textContent = about ? 'Mechanical: no model prompt and no Personality card steers this loop.' : 'Not described.';
    else {
      const ul = el('ul', 'lp-steer-list');
      for (const c of steers) {
        const li = el('li');
        const href = linkFor({ lens: 'personality', sel: { type: 'card', id: c.card } });
        const a = el('a', 'lp-card-link', nameOf(c.card));
        a.href = href;
        a.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
          e.preventDefault();
          ctx.go?.(href);
        });
        li.append(a, el('span', 'lp-muted', ` ${modeLabel(c)}`));
        ul.appendChild(li);
      }
      dd.appendChild(ul);
    }
    sd.appendChild(dd);
    dl.appendChild(sd);
    td.appendChild(dl);
    tr.appendChild(td);
    return tr;
  }

  function toggle(name) {
    if (state.open.has(name)) state.open.delete(name); else state.open.add(name);
    render();
    rowEls.get(name)?.focus();
  }

  function loopRow(loop, kind, now) {
    const isOpen = state.open.has(loop.name);
    const tr = el('tr', `lp-row${isOpen ? ' open' : ''}`);
    tr.dataset.loop = loop.name;
    tr.setAttribute('tabindex', '0');
    tr.setAttribute('aria-expanded', String(isOpen));
    tr.setAttribute('aria-controls', domId('lp-d', loop.name));
    const nameTd = el('td', 'c-name');
    nameTd.append(el('span', 'lp-caret', isOpen ? 'v' : '>'), el('span', 'mono', loop.name));
    tr.appendChild(nameTd);
    tr.appendChild(statusCell(kind));
    tr.appendChild(el('td', 'c-runs lp-muted', cadence(loop.trigger)));
    tr.appendChild(slaCell(loop, kind));
    tr.appendChild(el('td', 'c-why', loop.about?.why ?? ''));
    const steerTd = el('td');
    steerTd.appendChild(chips(loop.about?.steers, loop.about ? 'mechanical' : 'not described'));
    tr.appendChild(steerTd);
    tr.addEventListener('click', () => toggle(loop.name));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(loop.name); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const rows = [...tbody.querySelectorAll('.lp-row')];
      const i = rows.indexOf(tr);
      const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
    });
    rowEls.set(loop.name, tr);
    return tr;
  }

  function render() {
    const now = Date.now();
    const ms = elapsed();
    const focused = document.activeElement?.closest?.('.lp-row')?.dataset?.loop ?? null;
    const all = state.loops;
    const s = summarize(all, ms);

    clear(summaryEl);
    stat(s.total, s.total === 1 ? 'loop' : 'loops');
    stat(s.ok, 'ok', 'ok');
    stat(s.idle, 'idle, nothing to do');
    stat(s.failing, 'failing', s.failing ? 'bad' : '');
    stat(s.never, 'never ran');
    if (s.stale) stat(s.stale, 'stale', 'warn');
    stat(s.steered, 'steered by Personality');
    stat(s.mechanical, 'mechanical, no LLM');

    clear(bannersEl);
    const failing = all.filter((l) => statusOf(l, ms) === 'failing').sort((a, b) => (b.consecutiveFailures ?? 0) - (a.consecutiveFailures ?? 0));
    for (const l of failing.slice(0, BANNER_CAP)) {
      const b = el('div', 'lp-banner');
      const n = l.consecutiveFailures ?? 0;
      const link = el('button', 'lp-linkbtn', l.name);
      link.type = 'button';
      link.addEventListener('click', () => reveal(l.name));
      b.append(link, el('b', null, n > 0 ? ` failing ${n} ${n === 1 ? 'run' : 'runs'} in a row. ` : ' last run failed. '), document.createTextNode(l.lastReason ?? ''));
      bannersEl.appendChild(b);
    }
    if (failing.length > BANNER_CAP) bannersEl.appendChild(el('p', 'lp-muted', `${failing.length - BANNER_CAP} more failing; filter on Needs attention to see them.`));

    segBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.scope)));

    clear(tbody);
    rowEls.clear();
    const shown = all.filter((l) => loopMatches(l, state, nameOf, ms));
    for (const g of groupLoops(shown)) {
      const gr = el('tr', 'lp-grp');
      const th = el('th', null, g.title);
      th.setAttribute('colspan', String(COLS));
      th.setAttribute('scope', 'colgroup');
      th.appendChild(el('span', null, `${g.loops.length}`));
      gr.appendChild(th);
      tbody.appendChild(gr);
      for (const l of g.loops) {
        const kind = statusOf(l, ms);
        tbody.appendChild(loopRow(l, kind, now));
        if (state.open.has(l.name)) tbody.appendChild(detailRow(l, kind, now));
      }
    }
    tableWrap.hidden = shown.length === 0;
    none.hidden = shown.length > 0;
    clear(none);
    if (!shown.length) {
      none.appendChild(document.createTextNode(all.length ? 'No loops match these filters. ' : 'No loops are registered. '));
      if (all.length) none.appendChild(clearBtn);
    }
    countEl.textContent = `${shown.length} of ${all.length} loops`;

    noteEl.hidden = !state.lastError;
    noteEl.textContent = state.lastError ? `Could not refresh the loops (${state.lastError}). Showing the data from ${formatTime(state.fetchedAt)}.` : '';

    if (focused && rowEls.has(focused)) rowEls.get(focused).focus();
  }

  function reveal(name) {
    if (!state.loops.some((l) => l.name === name)) {
      state.lastError = null;
      noteEl.hidden = false;
      noteEl.textContent = `No loop called "${name}" is registered. It may have been renamed or removed.`;
      return;
    }
    if (!state.loops.some((l) => l.name === name && loopMatches(l, state, nameOf, elapsed()))) {
      state.scope = 'all'; saveScope('all'); state.q = ''; input.value = '';
    }
    state.open.add(name);
    render();
    const row = rowEls.get(name);
    row?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    row?.focus?.();
  }

  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const c = await getLoopCatalog();
      if (disposed) return;
      state.loops = c.loops ?? [];
      state.fetchedAt = Date.now();
      state.lastError = null;
      if (!names.size) { try { names = cardNameMap({ status: 'fulfilled', value: await getPersonality() }); } catch { /* ids stay as names */ } }
    } catch (e) {
      if (disposed) return;
      state.lastError = e.message;
    } finally { state.refreshing = false; }
    if (!disposed) render();
  }

  function maybeRefresh() { if (Date.now() - state.fetchedAt >= REFRESH_MS) refresh(); }

  let disposed = false;
  const timer = setInterval(() => { if (!disposed) render(); }, TICK_MS);
  timer?.unref?.();

  render();
  if (route?.sel?.type === 'loop') reveal(route.sel.id);

  const handle = {
    update(r) { if (r?.sel?.type === 'loop') reveal(r.sel.id); },
    onState() { maybeRefresh(); },
    onEvent() { maybeRefresh(); },
    unmount() { disposed = true; clearInterval(timer); wrap.remove(); },
  };
  return handle;
}

function cardNameMap(settled) {
  const m = new Map();
  if (settled?.status !== 'fulfilled') return m;
  for (const g of settled.value?.groups ?? []) for (const c of g.cards ?? []) if (c?.id) m.set(c.id, c.name ?? c.id);
  return m;
}

function inert() { return { update() {}, onState() {}, onEvent() {}, unmount() {} }; }
