// web/learning/lens.js
// Evolution (URL /learning): one header line (title, the 30-day sentence,
// Review N proposals), the four outcome metrics (D6b), then one panel whose
// header is the tab strip: Capabilities, Impact ledger, Experiments, Loops. It
// opens on Capabilities, the six-kind registry, whose second view holds the
// instruction file previews (the former Personality lens) and the lesson
// ledger. Tabs load on first use, so the page only pays for what is looked at
// (phase 2, Q3; glmps-2-0-63 R3). Card glmps-2-0-137 folded Loops and
// Personality in, dropped the Memory and Signals tabs (alerts live on
// Surface), and made Experiments a tab of its own.
import { buildBands, focusBand, bandError, emptyState } from '../shared/bands.js';
import { createTabs } from '../shared/tabs.js';
import { openSelection, markSelected } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { renderOutcomeMetrics, renderMetricDetail } from './outcome-metrics.js';
import { mountSynthControls } from './synth-controls.js';
import { LOOP_WINDOW_DAYS } from '../evaluation/substrate-loop.js';

export const ITEM_TYPES = Object.freeze({
  metric: 'the metric\'s evidence rows and basis',
  card: 'the card on Work',
  'ci-run': 'the CI run on Work',
  session: 'the session page',
  guard: 'the guard\'s ledger detail',
  capability: 'the registry row\'s detail',
});

export const TABS = Object.freeze([
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'ledger', label: 'Impact ledger' },
  { id: 'experiments', label: 'Experiments' },
  { id: 'loops', label: 'Loops' },
]);
const TAB_IDS = new Set(TABS.map((t) => t.id));
// Capabilities shows the registry rows, or the instruction files behind them.
export const CAPABILITY_VIEWS = Object.freeze([
  { id: 'registry', label: 'Registry' },
  { id: 'files', label: 'Instruction files' },
]);
export const capViewFor = (r) => (r?.seg === 'files' ? 'files' : null);

// Tab and segment names that no longer exist, and the tab that holds what they
// showed. Signals was the alerts feed (now Surface) plus loop signals; Memory
// became a kind of the registry.
const RETIRED_TABS = Object.freeze({ registry: 'capabilities', memory: 'capabilities', files: 'capabilities', signals: 'ledger', outcomes: 'experiments' });

// Which tab a route lands on. Old links name the Loop and Registry bands
// (band=loop, band=registry, seg=outcomes), a retired tab, or a tab of the
// old strip, which recorded itself as band=<id>; selections name
// the tab that holds the item. null means "leave the current tab alone".
export function tabFor(r) {
  if (TAB_IDS.has(r?.tab)) return r.tab;
  if (RETIRED_TABS[r?.tab]) return RETIRED_TABS[r.tab];
  if (RETIRED_TABS[r?.seg]) return RETIRED_TABS[r.seg];
  if (TAB_IDS.has(r?.seg)) return r.seg;
  if (TAB_IDS.has(r?.band)) return r.band;
  if (RETIRED_TABS[r?.band]) return RETIRED_TABS[r.band];
  if (r?.band === 'loop') return 'ledger';
  if (r?.sel?.type === 'guard') return 'ledger';
  if (r?.sel?.type === 'capability') return 'capabilities';
  if (r?.sel?.type === 'loop') return 'loops';
  return null;
}

// the registry keeps a module-level container;
// only the mount that last started it may release it.
let mountSeq = 0;
let registryOwner = 0;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const plural = (n, one, many) => (n === 1 ? one : many);

// The header sentence, in counts: a regression can undo an adoption made
// before the window, so this never turns them into a rate.
export function summaryLine(lm) {
  const a = lm?.acceptance;
  const r = lm?.regression;
  if (!Number.isFinite(a?.accepted) || !Number.isFinite(a?.proposed) || !Number.isFinite(r?.reverted)) return null;
  return `Last ${LOOP_WINDOW_DAYS} days: ${a.accepted} of ${a.proposed} ${plural(a.proposed, 'proposal', 'proposals')} adopted, ${r.reverted} ${plural(r.reverted, 'regression', 'regressions')} against them.`;
}

async function pendingProposals() {
  try {
    const res = await fetch('/api/learning');
    if (!res.ok) throw new Error(`GET /api/learning returned ${res.status}`);
    const data = await res.json();
    return (data.items ?? []).filter((i) => i.status === 'pending').length;
  } catch (e) {
    console.error('learning: pending proposal count failed', e);
    return null;
  }
}

export async function mount(root, route, ctx) {
  // false once a newer navigation owns the root; a stale mount skips
  // every root and document-wide write (the selection mark).
  // A tab still loading when the lens is left must not write after unmount.
  let left = false;
  const owns = () => !left && ctx.isCurrent?.() !== false;
  const me = ++mountSeq;

  const head = el('header', 'learn-head');
  head.appendChild(el('h2', 'learn-title', 'Evolution'));
  const summary = el('span', 'learn-summary');
  head.appendChild(summary);
  const reviewHost = el('div', 'learn-head-actions');
  head.appendChild(reviewHost);
  root.appendChild(head);

  // The band keeps its id (band-metrics) for deep links; its heading is the
  // page title above, so the duplicate "Outcomes" heading goes.
  const bands = buildBands(root, [{ id: 'metrics', title: 'Outcomes' }]);
  const metricsBody = bands.get('metrics');
  const metricsSec = metricsBody.parentNode;
  metricsSec.setAttribute('aria-label', 'Outcome metrics');
  metricsSec.removeAttribute('aria-labelledby');
  metricsSec.children[0].remove();
  const detail = document.createElement('div');
  let metricsError = null;
  let metricsSettled = false;
  // The metrics feed can take 10 s or more; the tabs below must not wait on
  // it, or the page sits blank under its title. Only a metric deep link does.
  // Task 16 (carried Task 6 minor): detail is attached on every path, so a
  // deep-linked selection's message is visible even when the metrics failed.
  const tiles = document.createElement('div');
  tiles.appendChild(el('p', 'band-empty', 'Loading outcome metrics...'));
  metricsBody.append(tiles, detail);
  const metricsP = (async () => {
    try {
      const res = await fetch('/api/learning/outcome-metrics');
      if (!res.ok) throw new Error(`GET /api/learning/outcome-metrics returned ${res.status}`);
      const data = await res.json();
      if (!owns()) return;
      tiles.textContent = '';
      renderOutcomeMetrics(tiles, data, { onOpen: (m) => renderMetricDetail(detail, m, { go: ctx.go }) });
    } catch (e) { metricsError = e; tiles.textContent = ''; bandError(tiles, 'The outcome metrics', e); }
    metricsSettled = true;
  })();

  const card = el('section', 'learn-card');
  card.setAttribute('aria-label', 'Evolution sections');
  root.appendChild(card);
  const tabs = createTabs(card, TABS, {
    label: 'Evolution sections',
    idPrefix: 'lt',
    className: 'learn-tabs',
    onSelect: (id) => { recordTab(id); return ensure(id); },
  });
  const panels = Object.fromEntries(TABS.map((t) => [t.id, tabs.panel(t.id)]));

  const loop = await import('../evaluation/substrate-loop.js');
  let changesP = null;
  const changes = () => (changesP ??= loop.fetchChanges());
  // The header sentence comes from the same feed as the ledger, so it fills
  // in when that lands instead of holding the page.
  changes().then((d) => { summary.textContent = summaryLine(d?.loopMetrics) ?? ''; });
  const loaded = {};
  let registryP = null;
  let reg = null;
  let ledgerSection = null;

  const loading = (panel, what) => panel.appendChild(el('p', 'band-empty', `Loading ${what}...`));
  // The selected tab is in the URL (mc-link records it in history); a tab
  // chosen by a route is already there.
  const recordTab = (id) => window.dispatchEvent(new CustomEvent('mc-link', { detail: { link: linkFor({ lens: 'learning', tab: id }) } }));

  async function loadLedger() {
    const panel = panels.ledger;
    loading(panel, 'the ledger');
    const d = await changes();
    panel.textContent = '';
    if (!d) { panel.appendChild(el('div', 'an-empty', 'Loop data unavailable: the /api/changes endpoint failed to respond.')); return; }
    panel.classList.add('an-root', 'sl-root');
    const list = Array.isArray(d.changes) ? d.changes : [];
    ledgerSection = loop.buildLedgerSection(list, ctx.handlers);
    panel.appendChild(ledgerSection);
    // The loop's own KPI cards stay one click away; stacked above the table
    // they pushed the ledger off the first screen. Loop liveness is the Loops
    // tab's job, so it is not repeated here.
    const metrics = document.createElement('details');
    metrics.className = 'learn-loop-metrics';
    const metricsSum = document.createElement('summary');
    metricsSum.textContent = `Loop metrics, last ${LOOP_WINDOW_DAYS} days`;
    metrics.append(metricsSum, loop.buildMetricsStrip(d.loopMetrics));
    panel.appendChild(metrics);
    const trend = loop.buildNorthStar(d.scoreboard);
    if (trend) panel.appendChild(trend);
    panel.appendChild(loop.buildSpineSection(list, ctx.handlers));
  }

  // Experiments: Harness Quality, routing compliance, Champion-vs-Challenger
  // and the Eval set (the old Outcomes segment), as a tab of its own.
  async function loadExperiments() {
    const panel = panels.experiments;
    panel.classList.add('an-root', 'sl-root');
    await loop.mountOutcomes(panel);
  }

  // Capabilities: a two-way view switch over the registry and the instruction
  // file previews (the former Personality lens, mounted as it was).
  const capViewBtns = {};
  const capViews = {};
  let capView = null;
  let filesHandle = null;
  let filesP = null;
  const capSwitch = el('div', 'learn-capviews');
  capSwitch.setAttribute('role', 'group');
  capSwitch.setAttribute('aria-label', 'Capabilities view');
  for (const v of CAPABILITY_VIEWS) {
    const b = el('button', 'learn-capview', v.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => showCapView(v.id));
    capViewBtns[v.id] = b;
    capSwitch.appendChild(b);
    const body = el('div', 'learn-capview-body');
    body.hidden = true;
    capViews[v.id] = body;
  }
  // Memory digest and the Push action sit in the registry view as one
  // disclosure; the Memory tab that used to hold them is gone.
  const memoryDetails = document.createElement('details');
  memoryDetails.className = 'learn-memory';
  const memorySum = document.createElement('summary');
  memorySum.textContent = 'Memory digest and shared memory (push approved facts to agents)';
  const memoryBody = el('div', 'learn-slot');
  memoryDetails.append(memorySum, memoryBody);
  const registryBody = el('div', 'learn-registry');
  capViews.registry.append(memoryDetails, registryBody);
  const lessonsHost = el('div', 'learn-lessons');
  const filesBody = el('div', 'learn-files');
  capViews.files.append(lessonsHost, filesBody);
  panels.capabilities.append(capSwitch, capViews.registry, capViews.files);

  async function showCapView(id, { fromRoute = false, route = null } = {}) {
    for (const v of CAPABILITY_VIEWS) {
      capViewBtns[v.id].setAttribute('aria-pressed', String(v.id === id));
      capViews[v.id].hidden = v.id !== id;
    }
    const changed = capView !== id;
    capView = id;
    if (changed && !fromRoute) {
      window.dispatchEvent(new CustomEvent('mc-link', { detail: { link: linkFor({ lens: 'learning', tab: 'capabilities', seg: id === 'files' ? 'files' : null }) } }));
    }
    if (id === 'registry') return ensureRegistry();
    // The lesson ledger is drawn by the registry's own fetch batch.
    ensureRegistry().catch((e) => console.error('evolution: the registry failed to load for the lesson ledger', e));
    const first = !filesP;
    filesP ??= (async () => {
      const mod = await import('../personality/lens.js');
      if (!owns()) return;
      filesHandle = await mod.mount(filesBody, route ?? { lens: 'personality' }, { ...ctx, isCurrent: owns });
    })();
    await filesP;
    if (!first && route) filesHandle?.update(route);
  }

  let loopsHandle = null;
  async function loadLoops(route) {
    const mod = await import('../loops/lens.js');
    if (!owns()) return;
    // The learning loop's status and Run now (moved from Settings, card
    // glmps-2-0-140) sit above the loop catalog, in hosts of their own so the
    // catalog's mount cannot clear them.
    const synthHost = el('div', 'lp learn-synth');
    const loopsHost = el('div', 'learn-loops');
    panels.loops.append(synthHost, loopsHost);
    mountSynthControls(synthHost);
    loopsHandle = await mod.mount(loopsHost, route ?? { lens: 'loops' }, { ...ctx, isCurrent: owns });
  }

  function ensureRegistry() {
    if (registryP) return registryP;
    // registry.js's mc-research-candidate live-update
    // handler reaches its container by id ('view-registry') while the Learning
    // lens is mounted; see registry.js's own comment on bindRegistryEvents.
    registryBody.id = 'view-registry';
    loading(registryBody, 'the registry');
    registryP = (async () => {
      reg = await import('../evaluation/registry.js');
      if (!owns()) return;
      registryOwner = me;
      try { await reg.renderRegistry(registryBody, { slots: { memory: memoryBody }, pageAll: true, lessonsHost }); }
      catch (e) {
        registryBody.textContent = '';
        bandError(registryBody, 'The capability registry', e);
      }
    })();
    return registryP;
  }

  async function ensure(id, route) {
    if (loaded[id]) return loaded[id];
    if (id === 'ledger') loaded[id] = loadLedger();
    else if (id === 'experiments') loaded[id] = loadExperiments();
    else if (id === 'loops') loaded[id] = loadLoops(route);
    else {
      const view = capViewFor(route) ?? 'registry';
      loaded[id] = capView ? Promise.resolve() : showCapView(view, { fromRoute: true, route: view === 'files' ? route : null });
    }
    try { await loaded[id]; } catch (e) { console.error(`learning tab ${id} failed`, e); if (owns()) bandError(panels[id], `The ${id} tab`, e); }
    return loaded[id];
  }

  // A tab chosen in code (the Review action), as opposed to by a route.
  async function select(id) {
    const changed = tabs.active() !== id;
    tabs.show(id);
    if (changed) recordTab(id);
    await ensure(id);
  }

  // The header action: jump to the guard proposals waiting for a decision.
  const pending = await pendingProposals();
  if (pending) {
    const review = el('button', 'learn-review', `Review ${pending} proposal${pending === 1 ? '' : 's'}`);
    review.type = 'button';
    review.title = 'Open the Registry filtered to guard proposals awaiting a decision';
    review.addEventListener('click', async () => {
      const mod = await import('../evaluation/registry.js');
      mod.setRegistryFilter({ kinds: ['guard'], states: ['proposed'] });
      await select('capabilities');
      await showCapView('registry');
    });
    reviewHost.appendChild(review);
  }

  const apply = async (r) => {
    if (!owns()) return;
    // Fix round 1 (the same pattern as the other lenses): clear the detail pane on
    // every call, not just when r.sel is set - otherwise a popstate to a
    // different (or missing) selection leaves the previous metric's detail
    // block sitting underneath a fresh not-found notice, or showing when the
    // URL carries no selection at all. The not-found notice also moves from
    // metricsBody (which also holds the tile row) to detail, the same
    // container renderMetricDetail draws into, so both paths clear together.
    detail.textContent = '';
    if (!r.sel) markSelected(null);
    // Only a route that names a different tab waits on a tab load; a plain
    // selection or deselection on the current tab stays synchronous, as it was
    // before the tabs existed.
    const tab = tabFor(r) ?? tabs.active() ?? 'capabilities';
    if (tab !== tabs.active()) {
      tabs.show(tab);
      await ensure(tab, r);
      if (!owns()) return;
    } else if (tab === 'loops') loopsHandle?.update(r);
    else if (tab === 'capabilities') {
      const want = capViewFor(r) ?? (r.sel?.type === 'capability' || r.band === 'registry' || r.seg === 'memory' ? 'registry' : null);
      if (want === 'files' && capView === 'files') filesHandle?.update(r);
      else if (want && want !== capView) await showCapView(want, { fromRoute: true, route: want === 'files' ? r : null });
      if (!owns()) return;
    }
    // The folded-in views open their own selections (a loop row, a file card).
    if (tab === 'loops' || (tab === 'capabilities' && capView === 'files')) return;
    if (r.seg === 'memory' || r.tab === 'memory') memoryDetails.open = true;
    if (r.band === 'metrics') focusBand('metrics');
    // A metric that could not be found because its feed failed is not
    // "not found": say which failure stands in the way.
    const missing = (s) => (s.type === 'metric' && metricsError
      ? emptyState(detail, `The metric ${s.id} cannot be shown: the outcome metrics failed to load (${metricsError.message ?? metricsError}).`)
      : emptyState(detail, `Not found: ${s.type} ${s.id}. It may have left the window or been removed.`));
    // The ledger pages and collapses rule groups, so a guard link first
    // brings its row into view.
    if (r.sel?.type === 'guard') ledgerSection?.reveal?.(r.sel.id);
    // Once the metrics have landed a selection stays synchronous, as it was.
    if (!metricsSettled && (r.sel?.type === 'metric' || r.band === 'metrics')) { await metricsP; if (!owns()) return; }
    if (r.sel) openSelection(root, r.sel, { onMissing: missing });
  };
  await apply(route);
  return {
    update: apply,
    onState() {},
    onEvent() {},
    // without this, registry.js's module-level
    // container reference keeps the whole detached Registry subtree alive
    // (unreachable to GC) for as long as the page stays open after leaving
    // Learning - a lens unmount used to be a no-op here.
    unmount() {
      left = true;
      if (registryOwner === me) { reg?.unmountRegistry(); registryOwner = 0; }
      for (const h of [loopsHandle, filesHandle]) {
        try { h?.unmount(); } catch (e) { console.error('evolution: unmounting a folded-in view failed', e); }
      }
    },
  };
}
