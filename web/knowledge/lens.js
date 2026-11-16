// web/knowledge/lens.js
// Knowledge (card glmps-2-0-137): the reference pillar. It opens on the Wiki
// tab, which mounts the wiki view that used to be the separate /wiki/ page;
// old /wiki/ links land here (web/shared/deep-link.js). Architecture graph is
// the code map full width with the Graphs table beneath it, and Decisions is
// the decision log; both used to be Surface side panels. A tab loads on first
// use and keeps its content for the life of the mount; the map re-focuses when
// a route names a different session.
import { createTabs } from '../shared/tabs.js';
import { linkFor } from '../shared/deep-link.js';
import { bandError, emptyState } from '../shared/bands.js';
import { openSelection } from '../shared/interactive-item.js';
import { renderGraphsTable } from './graphs-table.js';
import { mountGraphControls } from './graph-controls.js';

export const ITEM_TYPES = Object.freeze({
  decision: 'the decision\'s why and what changed',
  'graph-file': 'the file in the pop-out editor',
});

export const TABS = Object.freeze([
  { id: 'wiki', label: 'Wiki' },
  { id: 'architecture', label: 'Architecture graph' },
  { id: 'decisions', label: 'Decisions' },
]);
const TAB_IDS = new Set(TABS.map((t) => t.id));
export const tabFor = (r) => (TAB_IDS.has(r?.tab) ? r.tab : null);

export async function mount(root, route, ctx) {
  let left = false;
  const owns = () => !left && ctx.isCurrent?.() !== false;
  root.classList.add('knowledge-root');
  const cleanups = [];
  const loaded = {};

  // The page heading for assistive tech; the tab strip is the visible title.
  const heading = document.createElement('h2');
  heading.className = 'sr-only';
  heading.textContent = 'Knowledge';
  root.appendChild(heading);
  const tabs = createTabs(root, TABS, {
    label: 'Knowledge sections',
    idPrefix: 'kn',
    onSelect: (id) => {
      window.dispatchEvent(new CustomEvent('mc-link', { detail: { link: linkFor({ lens: 'knowledge', tab: id }) } }));
      return ensure(id);
    },
  });

  async function loadWiki() {
    const panel = tabs.panel('wiki');
    const mod = await import('../observability/wiki.js');
    if (!owns()) return;
    const cleanup = await mod.renderWiki(panel, { sessions: ctx.getState?.()?.sessions, isCurrent: owns });
    if (typeof cleanup !== 'function') return;
    // left while the wiki was still loading: release it now.
    if (left) cleanup(); else cleanups.push(cleanup);
  }

  let mapMod = null;
  let mapHost = null;
  // The session the map was last drawn around, so a later route naming
  // another session re-focuses the map that is already loaded.
  let mapFocus;
  const sessionOf = (sel) => (sel?.type === 'session' ? sel.id : undefined);
  async function loadArchitecture(sel) {
    const panel = tabs.panel('architecture');
    mapHost = document.createElement('div');
    mapHost.className = 'kn-map';
    const graphsHost = document.createElement('div');
    // Graph list, rebuild and secondary scan (moved from Settings, card glmps-2-0-140).
    const controlsHost = document.createElement('div');
    controlsHost.className = 'lp kn-graphs kn-graph-controls';
    panel.append(mapHost, graphsHost, controlsHost);
    const graphs = renderGraphsTable(graphsHost, { isCurrent: owns });
    mountGraphControls(controlsHost);
    const mod = await import('../observability/map.js');
    if (!owns()) return;
    mapMod = mod;
    await drawMap(sessionOf(sel));
    await graphs;
  }
  async function drawMap(sessionId) {
    mapFocus = sessionId;
    await mapMod.renderMap(mapHost, { onOpenJob: ctx.handlers?.onOpenJob, onOpenFile: ctx.handlers?.onOpenFile }, sessionId);
    const s = ctx.getState?.();
    if (s && owns()) mapMod.updateMap(s);
  }

  async function loadDecisions() {
    const mod = await import('../observability/decisions.js');
    if (!owns()) return;
    await mod.renderDecisions(tabs.panel('decisions'));
  }

  const LOADERS = { wiki: () => loadWiki(), architecture: (r) => loadArchitecture(r?.sel), decisions: () => loadDecisions() };
  async function ensure(id, r) {
    const focus = sessionOf(r?.sel);
    if (id === 'architecture' && loaded.architecture && focus && focus !== mapFocus) {
      mapFocus = focus;
      loaded.architecture = loaded.architecture.then(() => (mapMod && owns() ? drawMap(focus) : undefined)).catch((e) => {
        console.error('knowledge tab architecture failed', e);
        if (owns()) bandError(tabs.panel('architecture'), 'The Architecture graph tab', e);
      });
    }
    if (!loaded[id]) {
      loaded[id] = (LOADERS[id]?.(r) ?? Promise.resolve()).catch((e) => {
        console.error(`knowledge tab ${id} failed`, e);
        if (owns()) bandError(tabs.panel(id), `The ${TABS.find((t) => t.id === id)?.label ?? id} tab`, e);
      });
    }
    return loaded[id];
  }

  let notFound = null;
  const apply = async (r) => {
    if (!owns()) return;
    const id = tabFor(r) ?? tabs.active() ?? TABS[0].id;
    tabs.show(id);
    await ensure(id, r);
    if (!owns()) return;
    notFound?.remove(); notFound = null;
    // A session selection is the map's focus, not a row to open.
    if (r?.sel && r.sel.type !== 'session') {
      openSelection(tabs.panel(id), r.sel, { onMissing: (s) => { notFound = emptyState(tabs.panel(id), `Not found: ${s.type} ${s.id}. It may have been removed.`); } });
    }
  };
  await apply(route);

  return {
    update: apply,
    onState(s) { if (mapMod && owns()) mapMod.updateMap(s); },
    onEvent() {},
    unmount() {
      const owned = owns();
      left = true;
      for (const c of cleanups) { try { c(); } catch (e) { console.error('knowledge: cleanup failed', e); } }
      cleanups.length = 0;
      if (owned) root.classList.remove('knowledge-root');
    },
  };
}
