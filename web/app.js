// web/app.js
// GLMPS 2.0 shell: four pillars (Surface, Work, Evolution, Knowledge; card
// glmps-2-0-137) plus the session page, one URL scheme
// (web/shared/deep-link.js), the topbar with the shell-owned search, SSE, and
// the dock mount point. Each lens lives in web/<lens>/lens.js and mounts into
// #lens-root.
import { getStateSlim, onEvents, getLearning, fetchBudget, getBacklogCounts } from './shared/api.js';
import { countsAsLive } from './shared/dom-util.js';
import { mountLauncher } from './shared/launcher.js';
import { mountSettings } from './shared/settings.js';
import { mountVersion } from './shared/version-label.js';
import { registerView, getView, loadStyles } from './shared/view-registry.js';
import { parseLink, linkFor, resolveTarget } from './shared/deep-link.js';
import { openFileEditor } from './shared/file-actions.js';
import { mountDocks } from './shared/dock.js';
import { DOCKS } from './shared/dock-list.js';
import { createLensRouter } from './shared/lens-router.js';
import { createShellSearch } from './shared/search.js';

// styles: the sheets a lens needs beyond the shell's own (styles.css and the
// topbar bell's alerts.css stay in index.html), in the cascade order index.html
// used to give them. The router loads and awaits them before the lens mounts.
// Surface carries stage-board.css for its Fleet dock.
registerView('surface', { label: 'Surface', suffix: 'surface', load: () => import('./surface/lens.js'),
  styles: ['/shared/roster.css', '/overview/stage-board.css', '/observability/budget.css', '/observability/map.css', '/observability/decisions.css', '/surface/surface.css'] });
registerView('work', { label: 'Work', suffix: 'work', load: () => import('./work/lens.js'),
  styles: ['/shared/roster.css', '/observability/qa-trends.css', '/observability/budget.css', '/orchestration/board.css', '/work/work.css'] });
// Evolution keeps its /learning URL so old links work; it hosts the Loops tab
// and the instruction file view (the former Loops and Personality lenses).
registerView('learning', { label: 'Evolution', suffix: 'learning', load: () => import('./learning/lens.js'),
  styles: ['/evaluation/substrate-loop.css', '/evaluation/registry.css', '/learning/learning.css', '/loops/loops.css', '/personality/personality.css'] });
registerView('knowledge', { label: 'Knowledge', suffix: 'knowledge', load: () => import('./knowledge/lens.js'),
  styles: ['/shared/roster.css', '/observability/wiki.css', '/observability/map.css', '/observability/decisions.css', '/loops/loops.css', '/knowledge/knowledge.css'] });
registerView('session', { label: null, suffix: null, load: () => import('./shared/session-page.js') });

let lastState = null;
let serverBuildId = null;
let refreshTimer = null;

const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = String(msg);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}
window.addEventListener('mc-toast', (e) => toast(e.detail));

function onCopy(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('Copied. Paste it into the session terminal.'),
    (e) => toast(`Clipboard write failed: ${e?.message ?? e}`),
  );
}

function go(link) {
  const u = new URL(link, location.origin);
  return enter(parseLink(u.pathname, u.search), { push: true });
}

// Mounted once for every pillar; Surface lends it a richer source while on screen.
const search = createShellSearch(document.getElementById('topbar-search'), { getState: () => lastState, go: (link) => go(link) });

const ctx = {
  getState: () => lastState,
  search,
  fromLensLabel: () => (fromLens ? getView(fromLens)?.label ?? null : null),
  toast,
  go,
  handlers: {
    onOpenSession: (id) => go(linkFor({ lens: 'session', sessionId: id })),
    onOpenJob: (id) => go(linkFor({ lens: 'session', sessionId: id })),
    onSelectSession: (id) => go(linkFor({ lens: 'session', sessionId: id })),
    onOpenMap: (id) => go(linkFor({ lens: 'knowledge', tab: 'architecture', sel: id ? { type: 'session', id } : null })),
    onOpenFile: (path, diff) => openFileEditor(path, { diff }),
    onCopy,
    onNavigate: (view) => go(resolveTarget({ view })),
    onGo: (link) => go(link),
  },
};

// The session page's back button names the lens the operator came from.
let navLens = null;
let fromLens = null;
function markNav(lens) {
  if (lens === 'session' && navLens !== 'session') fromLens = navLens;
  navLens = lens;
  for (const a of document.querySelectorAll('#topbar nav a[data-lens]')) {
    const on = a.dataset.lens === lens;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

// Navigation lives in web/shared/lens-router.js (testable without booting
// the page); this file only wires it to the shell.
const router = createLensRouter({
  getRoot: () => document.getElementById('lens-root'),
  getSlot: () => document.getElementById('topbar-slot'),
  loadView: (lens) => getView(lens).load(),
  loadStyles: (lens) => loadStyles(getView(lens)?.styles),
  ctx, markNav, toast,
});
// The slim state keeps few ended sessions; the session page reads its own
// summary from state.sessions, so fetch it with the id before mounting it.
async function enter(route, opts) {
  if (route?.lens === 'session' && route.sessionId && !lastState?.sessions?.some((x) => x.id === route.sessionId)) {
    try { lastState = await getStateSlim(route.sessionId); } catch (e) { console.error('session summary', e); }
  }
  return router.enter(route, opts);
}

// A datum was activated (bindItem): record its link so reload and share work.
// While a lens is mounting or updating, a deep link's selection is reopened by
// clicking it (openSelection); that must not add a history entry.
window.addEventListener('mc-link', (e) => {
  const link = e.detail?.link;
  if (!link) return;
  if (location.pathname + location.search !== link) (router.isMounting() ? history.replaceState : history.pushState).call(history, {}, '', link);
  const u = new URL(link, location.origin);
  router.setRoute(parseLink(u.pathname, u.search));
});

// Alert "go to source" and any other jump: resolved through the one table.
window.addEventListener('mc-navigate', (e) => {
  const d = e.detail || {};
  go(resolveTarget(d.target ?? { view: d.view, id: d.sessionId ?? undefined }));
});

window.addEventListener('popstate', () => enter(parseLink(location.pathname, location.search)));

for (const a of document.querySelectorAll('#topbar nav a[data-lens]')) {
  a.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    // the active lens's own link keeps its current URL.
    router.goLens(a.dataset.lens);
  });
}

let usage = null;
function statLink(text, cls, link, title) {
  const a = document.createElement('a');
  a.className = cls; a.href = link; a.textContent = text;
  if (title) a.title = title;
  a.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); go(link); });
  return a;
}
function renderTopstats(state) {
  const stats = document.getElementById('topstats');
  stats.textContent = '';
  const live = (state?.sessions ?? []).filter(countsAsLive);
  stats.appendChild(statLink(`${live.length} live`, 'stat-live', linkFor({ lens: 'surface', panel: 'fleet' })));
  const h5 = usage?.fiveHour?.usedPercent; const d7 = usage?.sevenDay?.usedPercent;
  if (h5 != null || d7 != null) {
    const fmt = (v) => (v == null ? '-' : `${Math.round(v)}%`);
    const a = statLink(`5h ${fmt(h5)} / 7d ${fmt(d7)}`, 'stat-usage', linkFor({ lens: 'work', tab: 'cost' }), 'Plan usage: 5-hour and 7-day windows');
    if (Math.max(h5 ?? 0, d7 ?? 0) >= 80) a.classList.add('warn');
    stats.appendChild(a);
  }
}

function render(state) {
  lastState = state;
  document.getElementById('topstats')?.classList.remove('stale');
  router.current.handle?.onState(state);
  renderTopstats(state);
}

// Slim state (live sessions, board, tools, health). The session page also
// reads its own summary from state.sessions, so its id rides along.
function fetchState() {
  const route = router.current.route ?? parseLink(location.pathname, location.search);
  return getStateSlim(route?.lens === 'session' ? route.sessionId : null);
}
function updateUsage(data) {
  usage = data?.usage ?? null;
  if (lastState) renderTopstats(lastState);
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try { render(await fetchState()); }
    catch (e) {
      console.error('state refresh failed', e);
      const stats = document.getElementById('topstats');
      stats?.classList.add('stale');
      if (stats) stats.title = `Live state is stale: ${e.message}`;
    }
  }, 2000);
}

function navBadge(lens, count, title) {
  const a = document.querySelector(`#topbar nav a[data-lens="${lens}"]`);
  if (!a) return;
  let badge = a.querySelector('.nav-badge');
  if (!count) { if (badge) badge.hidden = true; a.removeAttribute('aria-label'); return; }
  if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge'; a.appendChild(badge); }
  badge.hidden = false;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.title = title;
  // Name the count for assistive tech; the link text alone is just the lens name.
  a.setAttribute('aria-label', `${a.firstChild?.textContent?.trim() || lens}, ${title}`);
}
function updateLearningDot(data) {
  const pending = (Array.isArray(data?.items) ? data.items : []).filter((i) => i.status === 'pending').length;
  navBadge('learning', pending, `${pending} guard proposal${pending === 1 ? '' : 's'} awaiting review`);
}
async function updateWorkDot() {
  try {
    const c = await getBacklogCounts();
    const n = (c.queued ?? 0) + (c.held ?? 0);
    navBadge('work', n, `${n} backlog item${n === 1 ? '' : 's'} queued or held`);
  } catch (e) { console.error('work badge', e); navBadge('work', 0, ''); }
}

function onServerHello(buildId) {
  if (!buildId) return;
  if (serverBuildId == null) { serverBuildId = buildId; return; }
  if (buildId === serverBuildId) return;
  if (!document.getElementById('editor-pane')?.classList.contains('hidden')) { toast('Server restarted with new code. Reload when ready.'); return; }
  location.reload();
}

(async () => {
  // The launchers mount into #topbar-tools (the right-hand cluster beside
  // #topstats), not #topbar itself, so they wrap and collapse together with
  // the live stats as one unit on narrow screens (see #topbar-tools, styles.css).
  const topbarTools = document.getElementById('topbar-tools');
  mountVersion(document.getElementById('brand-version'));
  if (topbarTools) {
    // The launcher needs /api/config; it mounts into a placeholder slot (kept
    // first in the cluster) so the first state render never waits on it.
    const launcherSlot = document.createElement('span');
    launcherSlot.className = 'tb-slot';
    topbarTools.appendChild(launcherSlot);
    mountLauncher(launcherSlot).catch((e) => console.error('launcher', e));
    mountSettings(topbarTools);
  }
  fetchBudget().then(updateUsage).catch((e) => console.error('usage', e));
  setInterval(() => fetchBudget().then(updateUsage).catch((e) => console.error('usage', e)), 60000);
  getLearning().then(updateLearningDot).catch((e) => console.error('learning badge', e));
  updateWorkDot();
  mountDocks(document.getElementById('huddle-dock'), DOCKS, { toast });
  try { render(await fetchState()); } catch (e) { toast(`Could not load live state: ${e.message}`); }
  await enter(parseLink(location.pathname, location.search));
  onEvents((payload) => {
    if (payload.type === 'hello') { onServerHello(payload.buildId); return; }
    router.current.handle?.onEvent(payload);
    if (payload.type === 'backlog') { updateWorkDot(); window.dispatchEvent(new Event('mc-alerts-refresh')); return; }
    if (payload.type === 'events') scheduleRefresh();
    if (payload.type === 'workspace') { window.dispatchEvent(new CustomEvent('mc-workspace', { detail: payload })); scheduleRefresh(); }
    if (payload.type === 'loop') window.dispatchEvent(new Event('mc-alerts-refresh'));
  });
})();
