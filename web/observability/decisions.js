// web/observability/decisions.js - architectural decision log (glmps-143).
// Cross-repo "what changed and why", grouped by date.
//
// XSS: every value here is file/git/config-derived (repo paths, commit subjects,
// commit bodies, settings keys). All of it goes through textContent via el().
// innerHTML is not used; containers are emptied with clear().
//
// Density: the store holds hundreds of rows. Rendering all of them builds
// thousands of nodes for a list nobody scrolls to the end of, so rows are
// paged in at PAGE_SIZE with an explicit "Show more" (a real virtual scroller
// would need a build step this project does not have). The count readout always
// states the true total, so paging is visible rather than a silent truncation.

import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';

import { clear } from '../shared/dom-util.js';
const PAGE_SIZE = 100;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

const dayKey = (ts) => {
  const d = new Date(Number(ts) || 0);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'unknown';
};

const repoLabel = (p) => String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || String(p ?? '');

function groupByDay(entries) {
  const map = new Map();
  for (const e of entries) {
    const k = dayKey(e.ts);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function buildSectionChips(sections) {
  const wrap = el('div', 'dl-sections');
  for (const [key, d] of Object.entries(sections ?? {})) {
    for (const name of d?.added ?? []) wrap.appendChild(el('span', 'dl-chip dl-chip--add', `+ ${key}: ${name}`));
    for (const name of d?.removed ?? []) wrap.appendChild(el('span', 'dl-chip dl-chip--rem', `- ${key}: ${name}`));
  }
  return wrap;
}

function buildEntry(entry) {
  const isConfig = entry.source === 'config';
  const row = el('div', `dl-entry${isConfig ? ' dl-entry--config' : ''}`);

  const head = el('div', 'dl-entry-head');
  head.appendChild(el('span', 'dl-repo', repoLabel(entry.repo)));
  if (entry.commit) head.appendChild(el('span', 'dl-sha', String(entry.commit).slice(0, 7)));
  head.appendChild(el('span', 'dl-what', entry.what ?? '(no subject)'));
  row.appendChild(head);

  // one state (dl-entry--open) drives both the visual
  // clamp (decisions.css) and the "Show more" button's own label/
  // aria-expanded. A second, independently-toggled class (is-open) let the
  // two disagree the moment the button's own click also bubbled into the
  // row's separate toggle - the button ended up SAYING "Show less" while
  // the row had just flipped back closed. sync() reads the one class both
  // toggles now share; the button's own handler stops the click from
  // reaching the row so one click is one toggle, not two.
  let moreBtn = null;
  const syncMoreButton = () => {
    if (!moreBtn) return;
    const open = row.classList.contains('dl-entry--open');
    moreBtn.textContent = open ? 'Show less' : 'Show more';
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  const why = String(entry.why ?? '').trim();
  if (why) {
    row.appendChild(el('p', 'dl-why', why));
    // Only offer expansion when there is plausibly something clipped. The clamp
    // is 2 lines; this threshold is a cheap proxy that avoids a layout read.
    if (why.length > 140) {
      moreBtn = el('button', 'dl-more', 'Show more');
      moreBtn.type = 'button';
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        row.classList.toggle('dl-entry--open');
        syncMoreButton();
      });
      row.appendChild(moreBtn);
    }
  }

  if (isConfig && entry.sections) row.appendChild(buildSectionChips(entry.sections));

  const id = entry.commit ? String(entry.commit).slice(0, 12) : `${entry.repo}:${entry.ts ?? entry.what}`;
  bindItem(row, {
    type: 'decision', id,
    link: linkFor({ lens: 'knowledge', tab: 'decisions', sel: { type: 'decision', id } }),
    open: () => { row.classList.toggle('dl-entry--open'); syncMoreButton(); }, label: `Decision in ${repoLabel(entry.repo)}: ${entry.what ?? ''}`,
  });
  return row;
}

export async function renderDecisions(container) {
  clear(container);
  const state = { entries: [], repos: [], repo: '', q: '', shown: PAGE_SIZE };

  const toolbar = el('div', 'dl-toolbar');

  const repoSel = el('select', 'dl-filter');
  repoSel.setAttribute('aria-label', 'Filter by repository');
  const list = el('div', 'dl-list');

  const search = el('input', 'dl-filter dl-search');
  search.type = 'search';
  search.placeholder = 'Filter by text...';
  search.setAttribute('aria-label', 'Filter decisions by text');

  const count = el('span', 'dl-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');

  toolbar.append(repoSel, search, count);
  container.append(toolbar, list);

  function visible() {
    const q = state.q.toLowerCase();
    return state.entries.filter((e) => {
      if (state.repo && e.repo !== state.repo) return false;
      if (!q) return true;
      return `${e.what ?? ''} ${e.why ?? ''}`.toLowerCase().includes(q);
    });
  }

  function draw() {
    clear(list);
    const rows = visible();
    const page = rows.slice(0, state.shown);

    count.textContent = rows.length === page.length
      ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`
      : `showing ${page.length} of ${rows.length}`;

    if (!rows.length) {
      list.appendChild(el('p', 'dl-empty', 'No decisions recorded yet. The sweep runs hourly and on server start.'));
      return;
    }

    for (const [day, items] of groupByDay(page)) {
      const group = el('div', 'dl-day');
      group.appendChild(el('div', 'dl-day-date', day));
      const box = el('div', 'dl-entries');
      for (const e of items) box.appendChild(buildEntry(e));
      group.appendChild(box);
      list.appendChild(group);
    }

    if (page.length < rows.length) {
      const more = el('button', 'dl-showmore', `Show ${Math.min(PAGE_SIZE, rows.length - page.length)} more`);
      more.type = 'button';
      more.addEventListener('click', () => { state.shown += PAGE_SIZE; draw(); });
      list.appendChild(more);
    }
  }

  repoSel.addEventListener('change', () => { state.repo = repoSel.value; state.shown = PAGE_SIZE; draw(); });
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = search.value; state.shown = PAGE_SIZE; draw(); }, 150);
  });

  count.textContent = 'loading...';
  try {
    const res = await fetch('/api/decisions?limit=1000');
    const data = await res.json();
    state.entries = Array.isArray(data.entries) ? data.entries : [];
    state.repos = Array.isArray(data.repos) ? data.repos : [];
  } catch {
    state.entries = [];
    state.repos = [];
  }

  repoSel.appendChild(el('option', null, 'All repositories')).value = '';
  for (const r of state.repos) {
    const o = el('option', null, repoLabel(r));
    o.value = r;
    repoSel.appendChild(o);
  }

  draw();
}
