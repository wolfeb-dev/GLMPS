// web/work/lens.js
// Work (delivery, history, quality and cost): Board, History, QA trends and
// Cost tabs (card glmps-2-0-137 phase 4). The header carries the title and
// the CI chip, which opens QA trends. History is the searchable record of
// ended sessions; it replaces the recently ended band that sat under the
// board. Cost is the analytics view full width; the topbar budget pill and
// old analytics links land on it. A tab loads on first use and keeps its
// content for the life of the mount, except History, which re-renders when a
// route names a different tool; old band= links pick the matching tab.
import { bandError, emptyState } from '../shared/bands.js';
import { openSelection, markSelected } from '../shared/interactive-item.js';
import { closeCardDrawer } from '../orchestration/board-drawer.js';
import { createTabs } from '../shared/tabs.js';
import { linkFor } from '../shared/deep-link.js';

export const ITEM_TYPES = Object.freeze({
  card: 'the card drawer',
  'ci-run': 'the CI run\'s counts and conclusion',
});

export const TABS = Object.freeze([
  { id: 'board', label: 'Board' },
  { id: 'history', label: 'History' },
  { id: 'qa', label: 'QA trends' },
  { id: 'cost', label: 'Cost' },
]);
const TAB_IDS = new Set(TABS.map((t) => t.id));
// The 1.x and pre-tab band names, and the item types each tab holds.
const BAND_TAB = { board: 'board', record: 'history', gates: 'qa' };
const SEL_TAB = { card: 'board', 'ci-run': 'qa' };
const RECENT = 8;

export function tabFor(r) {
  if (TAB_IDS.has(r?.tab)) return r.tab;
  if (r?.tool) return 'history';
  if (BAND_TAB[r?.band]) return BAND_TAB[r.band];
  if (SEL_TAB[r?.sel?.type]) return SEL_TAB[r.sel.type];
  return null;
}

// the board (board.js) keeps module-level state;
// only the mount that last started it may release it.
let mountSeq = 0;
let boardOwner = 0;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export async function mount(root, route, ctx) {
  // false once a newer navigation owns the root; a stale mount skips
  // every root and document-wide write (selection mark, card drawer).
  const owns = () => ctx.isCurrent?.() !== false;
  const me = ++mountSeq;
  const cleanups = [];
  root.classList.add('work-root');

  const head = el('header', 'work-head');
  head.appendChild(el('h2', 'work-title', 'Work'));
  const ciChip = el('button', 'work-chip work-chip--ci');
  ciChip.type = 'button';
  ciChip.appendChild(el('span', 'work-chip-text', 'CI: loading'));
  ciChip.setAttribute('aria-controls', 'wk-panel-qa');
  head.append(ciChip);
  root.appendChild(head);

  const loaded = {};
  const tabs = createTabs(root, TABS, {
    label: 'Work sections',
    idPrefix: 'wk',
    onSelect: (id) => {
      window.dispatchEvent(new CustomEvent('mc-link', { detail: { link: linkFor({ lens: 'work', tab: id }) } }));
      return ensure(id);
    },
  });
  ciChip.title = 'Open QA trends';
  ciChip.addEventListener('click', () => tabs.select('qa'));

  const qa = await import('../observability/qa-trends.js');
  let qaData = null;
  const qaP = qa.fetchQaTrends().then((d) => {
    qaData = d;
    const s = qa.ciSummary(d?.points);
    ciChip.children[0].textContent = s ? s.text : 'CI: no runs yet';
    if (s) ciChip.classList.add(s.ok ? 'work-chip--ok' : 'work-chip--bad');
    if (s) ciChip.title = `${s.ok ? 'Latest sampled run: no failing tests' : `Latest sampled run: ${s.fail} failing`}. Open QA trends.`;
  }).catch((e) => {
    console.error('QA trends failed', e);
    ciChip.children[0].textContent = 'CI: unavailable';
    ciChip.title = `QA trends failed to load: ${e?.message ?? e}`;
  });

  const board = await import('../orchestration/board.js');
  async function loadBoard() {
    if (!owns()) return;
    boardOwner = me;
    // The board's own controls (quick-add, search, runner, View) share one
    // bar at the top of its main column, beside the project sidebar.
    const bar = el('div', 'work-board-bar');
    const cleanup = await board.renderBacklog(tabs.panel('board'), ctx.handlers, { head: bar });
    const main = tabs.panel('board').querySelector('.kanban-main');
    if (main) main.insertBefore(bar, main.firstChild);
    cleanups.push(() => { if (boardOwner === me) { cleanup?.(); boardOwner = 0; } });
  }
  // The tool filter the History tab was rendered with, so a later route that
  // names another tool re-renders it instead of keeping the first filter.
  let historyTool;
  let historyCleanup = null;
  async function loadHistory(r) {
    const hist = await import('../observability/history.js');
    if (!owns()) return;
    historyTool = r?.tool;
    const cleanup = await hist.renderHistory(tabs.panel('history'), ctx.handlers, r?.tool ? { tool: r.tool } : {}, { endedOnly: true, recent: RECENT });
    if (!owns()) { cleanup?.(); return; }
    historyCleanup = cleanup;
  }
  cleanups.push(() => { historyCleanup?.(); historyCleanup = null; });
  // The chart pulls the vega scripts, which a visit that never opens QA
  // trends should not pay for.
  async function loadQa() {
    await qaP;
    if (!owns()) return;
    await qa.renderQaTrends(tabs.panel('qa'), qaData ? { data: qaData } : {});
  }
  async function loadCost() {
    const m = await import('../observability/analytics.js');
    if (!owns()) return;
    await m.renderAnalytics(tabs.panel('cost'));
  }
  const LOADERS = { board: () => loadBoard(), history: (r) => loadHistory(r), qa: () => loadQa(), cost: () => loadCost() };
  const failed = (id) => (e) => {
    loaded[id] = null;
    console.error(`work tab ${id} failed`, e);
    if (owns()) bandError(tabs.panel(id), `The ${TABS.find((t) => t.id === id)?.label ?? id} tab`, e);
  };
  function ensure(id, r) {
    if (id === 'history' && loaded.history && r?.tool && r.tool !== historyTool) {
      historyTool = r.tool;
      loaded.history = loaded.history.then(() => {
        if (!owns()) return;
        historyCleanup?.(); historyCleanup = null;
        return loadHistory(r);
      }).catch(failed('history'));
    }
    if (!loaded[id]) loaded[id] = LOADERS[id](r).catch(failed(id));
    return loaded[id];
  }

  // one not-found notice at a time; a cleared selection
  // (Back to /work) unmarks the item and closes the card drawer, which
  // lives on document.body and so also closes on unmount.
  let notFound = null;
  const apply = async (r) => {
    if (!owns()) return;
    notFound?.remove(); notFound = null;
    const id = tabFor(r) ?? tabs.active() ?? 'board';
    tabs.show(id);
    // The board loads first whatever the tab: its sidebar and drawer are
    // what a card link from any pillar expects.
    await ensure('board');
    await ensure(id, r);
    if (!owns()) return;
    if (r.sel) openSelection(tabs.panel(id), r.sel, { onMissing: (s) => { notFound = emptyState(tabs.panel(id), `Not found: ${s.type} ${s.id}. It may have been archived or removed.`); } });
    else { closeCardDrawer(); markSelected(null); }
  };
  await apply(route);
  await qaP;
  return {
    update: apply,
    onState() {},
    onEvent(p) { if (p.type === 'backlog') board.onBacklogEvent(p); },
    unmount() {
      for (const c of cleanups) { try { c(); } catch (e) { console.error('work: cleanup failed', e); } }
      cleanups.length = 0;
      if (owns()) { closeCardDrawer(); root.classList.remove('work-root'); }
    },
  };
}
