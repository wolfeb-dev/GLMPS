// web/surface/lens.js
// Surface (touching, spatial): the globe (D17) under a console frame, an icon
// rail, docks, one context drawer on the right and camera presets. Every mark
// is a bindItem with a deep link; the URL carries layers, camera and
// selection, so a reload or a shared link reopens the same view. Each vital
// shows once (card glmps-2-0-137 phase 2): the live count and budget are the
// topbar's, the rest ride the Fleet ribbon; full-size views (board, code
// graph, cost, decisions) live on their own Work and Knowledge tabs.
import { loadScript } from '../shared/load-script.js';
import { linkFor } from '../shared/deep-link.js';
import { bindItem, collectItems, markSelected } from '../shared/interactive-item.js';
import { closeDiffPopup } from '../shared/diff-popup.js';
import { createGlobe } from './globe.js';
import { LAYERS, LAYER_GROUPS, loadSurfaceData, SURFACE_ITEM_TYPES } from './layers.js';
import { renderInspector, renderDeclaredPanel, PANEL_ITEM_TYPES } from './panels.js';
import { createDrawer } from './drawer.js';
import { createDock } from './docks.js';
import { icon } from './icons.js';
import { openFileEditor, openFileInIde } from '../shared/file-actions.js';
import { createHoverCard, buildModelFor } from './hover-card.js';
import { createEditsWindow, EDITS_ITEM_TYPES } from './edits-window.js';
import { createEditsStore } from './edits-store.js';
import { renderRepositories, renderLocation, renderFileTree, renderAgents } from './study-panels.js';
import { createTimelineStore, createTimelineBar } from './timeline.js';
import { createTracker, createTrackUi, makeResolver } from './track.js';
import { createSearch, SURFACE_SOURCE_TEXT } from '../shared/search.js';
import { createPin } from './pin.js';
import { createFleetDock } from './fleet-dock.js';
import { createLiveMotion } from './live-motion.js';
import { createWallMode, readWall } from './wall-mode.js';
import { createSessionsRoster } from './sessions-dock.js';
import { EVENT_ITEM_TYPES } from './event-layers.js';
import { createAlertsDock } from './alerts-dock.js';
import { openLoopRecord, openAlertRecord } from './records.js';
import { DATA_TYPES, LEDGER_ITEM_TYPES, createLedgerStore, loadLedger, fmt, renderLedgerPanel, renderStacks, registerDatatypeOpener } from './ledger.js';

export const ITEM_TYPES = Object.freeze({ layer: 'the layer\'s legend, source and freshness', ...SURFACE_ITEM_TYPES, ...LEDGER_ITEM_TYPES, ...EDITS_ITEM_TYPES, ...PANEL_ITEM_TYPES, ...EVENT_ITEM_TYPES });

// The link layers (loops, remote links, usage, trails) start off: lines between places clutter the globe.
const DEFAULT_LAYERS = ['players', 'agents', 'cards', 'alerts', 'gates', 'prs', 'graticule', 'labels'];
const DEFAULT_CAM = { lon: -98.5, lat: 32, k: 1 };
const RESET_KEY = '0';
const PHONE_QUERY = '(max-width: 560px)';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export async function mount(root, route, ctx) {
  // false once a newer navigation owns the root; a
  // stale mount skips root and document-wide writes, and its late unmount
  // releases only what it created (listeners, timers, its globe).
  const owns = () => ctx.isCurrent?.() !== false;
  root.classList.add('surface-root');
  const frame = el('div', 'surface-frame'); root.appendChild(frame);
  const rail = el('nav', 'surface-iconrail'); rail.setAttribute('aria-label', 'Surface tools'); frame.appendChild(rail);
  const stage = el('div', 'surface-stage'); frame.appendChild(stage);
  const foot = el('footer', 'surface-footbar'); root.appendChild(foot);
  const footLine = el('div', 'foot-line'); foot.appendChild(footLine);
  // Feed notices raised before the Alerts dock exists wait here for it.
  const earlyFeeds = [];
  const leftDocks = el('div', 'surface-left'); stage.appendChild(leftDocks);
  const side = el('div', 'surface-side'); stage.appendChild(side);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const phone = () => matchMedia(PHONE_QUERY).matches;
  if (!window.d3) await loadScript('/vendor/d3.min.js');
  let topology = null;
  try {
    const res = await fetch('/vendor/countries-110m.json');
    if (!res.ok) throw new Error(`GET /vendor/countries-110m.json returned ${res.status}`);
    topology = await res.json();
  } catch (e) { earlyFeeds.push(`Coastlines failed to load: ${e.message}`); }

  // Q2 view state the shared route does not carry: the tracked agent and the
  // as-of time ride the query string beside layers and camera.
  const q0 = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  let state = { layers: new Set(route.layers ?? DEFAULT_LAYERS), sel: route.sel, panel: route.panel };
  const selectedPlace = () => (state.sel?.type === 'player' ? String(state.sel.id) : null);
  let tracker = null;
  const timeline = createTimelineStore();
  let camTimer = null;
  let flying = false;
  let activePreset = null;
  const syncPresets = () => { for (const b of flyList.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.preset === activePreset ? 'true' : 'false'); };
  const withExtras = (u) => {
    const [path, qs = ''] = u.split('?');
    const q = new URLSearchParams(qs);
    q.delete('track'); q.delete('asof');
    if (tracker?.active()) q.set('track', tracker.active());
    const a = timeline.asOf();
    if (a != null) q.set('asof', String(Math.round(a)));
    const out = q.toString();
    return out ? `${path}?${out}` : path;
  };
  const urlNow = () => withExtras(linkFor({ lens: 'surface', layers: [...state.layers], cam: globe.getCamera(), sel: state.sel, panel: state.panel }));
  let urlTimer = null;
  const writeUrl = () => { clearTimeout(urlTimer); urlTimer = setTimeout(() => history.replaceState({}, '', urlNow()), 300); };
  const globe = createGlobe(stage, {
    d3: window.d3, topology, reducedMotion: reduced, camera: route.cam ?? DEFAULT_CAM,
    onCamera: () => {
      clearTimeout(camTimer); camTimer = setTimeout(() => history.replaceState({}, '', urlNow()), 400);
      // A drag or wheel after a preset means the camera is no longer on it.
      if (!flying && activePreset) { activePreset = null; syncPresets(); }
      // Tracking holds the camera on the agent: a zoom keeps it, a drag snaps back.
      if (tracker?.active() && !tracker.isFlying()) tracker.relock();
    },
    onRender: () => tracker?.scheduleInView(),
  });
  // The globe appended its canvas and marks after the panels; the panels must
  // sit above them.
  stage.appendChild(leftDocks); stage.appendChild(side);

  const launchers = [];
  const syncRail = () => { for (const l of launchers) { const on = l.isOn(); l.btn?.classList.toggle('on', on); l.btn?.setAttribute('aria-pressed', on ? 'true' : 'false'); } };
  // On a phone the docks share one bottom sheet, so opening one closes the rest.
  const docks = [];
  const onDock = (self) => (open) => { if (open && phone()) for (const d of docks) if (d !== self()) d.close(); syncRail(); };
  // The operator's default view opens with neither Layers nor the data-type columns on (card glmps-2-0-208).
  const layersDock = createDock(side, { id: 'layers', title: 'Layers', iconName: 'layers', sub: ' ', foldable: true, open: false, onChange: onDock(() => layersDock) });
  const ledgerDock = createDock(leftDocks, { id: 'ledger', title: 'Data ledger', iconName: 'ledger', open: false, onChange: onDock(() => ledgerDock) });
  docks.push(layersDock, ledgerDock);
  const ledgerStore = createLedgerStore();
  const editsStore = createEditsStore();
  const treePick = { repo: null };
  let editsTouched = false;
  const editsDock = createDock(side, { id: 'edits', title: 'Recent edits', iconName: 'edits', open: false, onChange: onDock(() => editsDock) });
  docks.push(editsDock);
  // The live sessions on the ring lead the right column, above Layers (mockup E).
  const sessionsDock = createDock(side, { id: 'sessions', title: 'Sessions', iconName: 'agents', foldable: true, open: !phone(), onChange: onDock(() => sessionsDock) });
  side.insertBefore(sessionsDock.el, layersDock.el);
  docks.push(sessionsDock);
  let alertsUi = null;
  // The Alerts view is built once and moved into the drawer whenever its tab
  // opens, so feeds and acknowledgements survive switching views.
  const alertsView = { el: Object.assign(el('div', 'drawer-alerts'), { id: 'dock-alerts' }), subEl: el('p', 'dock-sub'), body: el('div', 'drawer-alerts-body'), footEl: el('div', 'panel-foot') };
  alertsView.el.append(alertsView.subEl, alertsView.body, alertsView.footEl);
  const DRAWER_TABS = [{ id: 'attention', label: 'Alerts' }, { id: 'repos', label: 'Repo inspector' }, { id: 'declared', label: 'Policy bounds' }];
  const panels = createDrawer(side, {
    tabs: DRAWER_TABS,
    onTab: (id) => { api.panelOpeners[id]?.(); history.replaceState({}, '', urlNow()); },
    onOpen: () => { layersDock.fold(true); if (phone()) for (const d of docks) d.close(); syncRail(); },
    onClose: (id) => {
      if (state.panel === id) state.panel = null;
      // the inspector is what shows a marked item's detail; once another view
      // replaces it or it is closed, the mark goes too, or a screen reader
      // keeps announcing a mark/row as selected after its detail is gone.
      if (id === 'inspector') markSelected(null);
      if (!panels.ids().length && !tracker?.active() && !phone()) layersDock.fold(false);
      syncRail();
      history.replaceState({}, '', urlNow());
    },
  });
  side.insertBefore(panels.el, side.firstChild);
  const openers = new Map();
  const data = await loadSurfaceData(ctx);
  const api = {
    globe, d3: window.d3, data, ctx, panels,
    // Task 12: a layer's own async work (a fetch, an animated flyTo) can
    // still be in flight when the lens unmounts; every such continuation
    // checks this before touching the DOM so it becomes a clean no-op
    // instead of throwing into a torn-down page.
    destroyed: false,
    link: (sel) => linkFor({ lens: 'surface', layers: [...state.layers], sel }),
    open: (sel) => openSel(sel),
    registerOpener: (type, fn) => { if (!openers.has(type)) openers.set(type, []); openers.get(type).push(fn); },
    inspect: (model) => panels.open('inspector', model.title, (body) => renderInspector(body, model)),
    empty: (text) => { if (alertsUi) alertsUi.feed(text); else earlyFeeds.push(text); },
    localPos: () => api.local ?? [DEFAULT_CAM.lon, DEFAULT_CAM.lat],
    remotePos: () => null,
    // Per repository, zoom to position: a hidden layer is never placed, so a
    // position cannot come from the marker having been drawn.
    repoLocators: new Map(),
    repoPos: (repo) => api.repoLocators.get(repo)?.(globe.getCamera().k) ?? null,
    flyTo: ([lon, lat], k = 6) => globe.flyTo({ lon, lat, k }),
    phone, ledgerStore, edits: editsStore, timeline,
    // A link between places draws when its layer is on, or when the selected place is one of its ends.
    linkShown: (layerId, places) => state.layers.has(layerId) || (selectedPlace() != null && places.includes(selectedPlace())),
    // The Location drill-down: what one player holds, by data type.
    location: (player, model) => panels.open('location', 'Location', (b) => { renderLocation(b, api, player, model); }),
  };
  alertsUi = createAlertsDock(alertsView, {
    api, isDestroyed: () => api.destroyed,
    renderHistory: async (b) => { const m = await import('../evaluation/alerts.js'); if (!api.destroyed) await m.renderAlerts(b, { dismissedOnly: true }); },
  });
  for (const text of earlyFeeds.splice(0)) alertsUi.feed(text);

  function openSel(sel) {
    if (!sel) return false;
    state.sel = sel;
    syncLinks();
    for (const fn of openers.get(sel.type) ?? []) {
      if (fn(sel.id)) {
        // openers call api.inspect()/api.flyTo() directly
        // (unlike Learning/Work, which restore a deep-linked selection
        // by finding the bound element and clicking it - interactive-item.js
        // openSelection - so bindItem's own markSelected never runs here).
        // Mark the matching globe mark/row as the selection the same way a
        // direct click on it would.
        const found = collectItems(document.body).find((e) => e.dataset.itemType === sel.type && e.dataset.itemId === String(sel.id));
        if (found) markSelected(found);
        return true;
      }
    }
    api.inspect({ title: 'Not found', empty: `Not found: ${sel.type} ${sel.id}. It may have been removed or its feed is not available.` });
    return false;
  }

  const built = new Map();
  // A layer group shows when its toggle is on, or when the selected place has a link in it.
  function syncLinks() {
    for (const layer of LAYERS) {
      if (!layer.link) continue;
      const forced = selectedPlace() != null && !!built.get(layer.id)?.touches?.(selectedPlace());
      globe.setLayerVisible(layer.id, state.layers.has(layer.id) || forced);
    }
  }
  // Layers share one api object (a layer may publish helpers on it, such as
  // players' localPos and files' showTree) and each gets its own SVG group.
  for (const layer of LAYERS) {
    const group = globe.layerGroup(layer.id);
    const out = layer.build(api, group) ?? { count: null, place() {} };
    built.set(layer.id, out);
    globe.layerGroup(layer.id, out.place);
    globe.setLayerVisible(layer.id, state.layers.has(layer.id));
  }
  syncLinks();
  globe.svg.classList.toggle('labels-off', !state.layers.has('labels'));

  // Live motion: the SSE stream and board changes drawn on the agents ring
  // (card glmps-2-0-204). The announcer is the one polite live region for
  // "needs you" and gate failures, since the dials themselves are decoration.
  const announcer = el('div', 'sr-only'); announcer.setAttribute('role', 'status'); announcer.setAttribute('aria-live', 'polite');
  root.appendChild(announcer);
  let layerRows = null;
  let fleet = null;
  let wall = null;
  let roster = null;
  const motion = createLiveMotion({
    api, reduced,
    visible: () => state.layers.has('agents'),
    announce: (text) => { announcer.textContent = text; },
    onChange: () => { const n = layerRows?.get('agents')?.n; if (n) n.textContent = String(built.get('agents')?.count ?? ''); },
  });
  api.onEvent = (p) => motion.onEvent(p);

  // One Layers-panel row: checkbox, swatch, the name (opens its legend), the
  // count and the key.
  function layerRow({ id, domId, label, swatch, count, key, checked, onToggle, legend }) {
    const row = el('div', 'layer-row'); if (!checked) row.classList.add('off');
    const box = el('input'); box.type = 'checkbox'; box.checked = checked; box.id = domId;
    box.setAttribute('aria-label', `Show ${label}`);
    box.addEventListener('change', () => { row.classList.toggle('off', !box.checked); onToggle(box.checked); });
    const sw = el('span', 'sw'); sw.style.background = swatch; sw.setAttribute('aria-hidden', 'true');
    const name = el('button', 'layer-name', label); name.type = 'button';
    legend(name);
    const n = el('span', 'n', count == null ? '' : String(count));
    const k = el('kbd', 'key', key);
    row.append(box, sw, name, n, k);
    return { row, box, name, n };
  }

  // Rows sit under real headings: Data (what we hold), then the layers by
  // what they show. Each group is a labelled group so a screen reader hears
  // the heading with its rows.
  // Fly to (the camera presets) leads the panel, so the controls that used to
  // float over the globe live in one place.
  const controlSection = (cls, id, label) => {
    const sec = el('div', `layer-group ${cls}`); sec.setAttribute('role', 'group');
    const h = el('h3', 'layer-group-h', label); h.id = `layer-group-${id}`; sec.setAttribute('aria-labelledby', h.id);
    const list = el('div', `layer-list ${cls}-list`); sec.append(h, list);
    layersDock.body.appendChild(sec);
    return list;
  };
  const flyList = controlSection('surface-presets', 'fly', 'Fly to');
  const groupLists = new Map();
  for (const g of LAYER_GROUPS) {
    const sec = el('div', 'layer-group'); sec.setAttribute('role', 'group');
    const h = el('h3', 'layer-group-h', g.label); h.id = `layer-group-${g.id}`; sec.setAttribute('aria-labelledby', h.id);
    const list = el('div', 'layer-list'); sec.append(h, list);
    layersDock.body.appendChild(sec); groupLists.set(g.id, list);
  }
  const typeRows = new Map();
  for (const dt of DATA_TYPES) {
    const r = layerRow({
      id: dt.id, domId: `layer-type-${dt.id}`, label: dt.label, swatch: dt.color, count: null, key: dt.key, checked: false,
      onToggle: (on) => ledgerStore.setHidden(dt.id, !on),
      legend: (name) => bindItem(name, { type: 'datatype', id: dt.id, link: api.link({ type: 'datatype', id: dt.id }), open: () => api.open({ type: 'datatype', id: dt.id }), label: `${dt.label} data type` }),
    });
    ledgerStore.setHidden(dt.id, true);
    typeRows.set(dt.id, r);
    groupLists.get('data').appendChild(r.row);
  }
  registerDatatypeOpener(api, ledgerStore);
  layerRows = new Map();
  for (const layer of LAYERS) {
    const count = built.get(layer.id)?.count;
    const r = layerRow({
      id: layer.id, domId: `layer-${layer.id}`, label: layer.label, swatch: layer.swatch, count, key: layer.key, checked: state.layers.has(layer.id),
      onToggle: (on) => {
        if (on) state.layers.add(layer.id); else state.layers.delete(layer.id);
        if (layer.link) syncLinks(); else globe.setLayerVisible(layer.id, on);
        if (layer.id === 'labels') globe.svg.classList.toggle('labels-off', !on);
        history.replaceState({}, '', urlNow());
        syncLayerCount();
      },
      legend: (name) => bindItem(name, {
        type: 'layer', id: layer.id, link: api.link({ type: 'layer', id: layer.id }),
        open: () => api.inspect({ title: layer.label, word: `Source: ${layer.source}`, facts: [['key', layer.key], ['items', built.get(layer.id)?.count ?? 'drawn'], ['shown', state.layers.has(layer.id) ? 'yes' : 'no'], ...(built.get(layer.id)?.facts?.() ?? [])], rows: built.get(layer.id)?.rows?.() }),
        label: `${layer.label} layer legend`,
      }),
    });
    layerRows.set(layer.id, r);
    if (built.get(layer.id)?.hidden) r.row.hidden = true;
    r.box.addEventListener('click', (e) => { if (e.altKey) solo(layer.id); });
    (groupLists.get(layer.group) ?? groupLists.get('work')).appendChild(r.row);
  }
  // The Layers header says how many of the layers it lists are on.
  function syncLayerCount() {
    const shown = LAYERS.filter((l) => !built.get(l.id)?.hidden);
    layersDock.subEl.hidden = false;
    layersDock.subEl.textContent = `${shown.filter((l) => state.layers.has(l.id)).length} of ${shown.length} on`;
  }
  syncLayerCount();
  // A layer whose data moved (the timeline landed, the edits changed) recounts its row.
  function refreshEventLayers() {
    if (api.destroyed) return;
    for (const l of LAYERS) {
      const b = built.get(l.id);
      if (!b?.refresh || !['gates', 'trails'].includes(l.id)) continue;
      b.refresh();
      const n = layerRows.get(l.id)?.n; if (n) n.textContent = b.count == null ? '' : String(b.count);
    }
  }
  // Alt-click a checkbox to see one layer alone; alt-click it again to put
  // the layers back as they were.
  let soloed = null;
  const setLayerOn = (id, on) => { const box = layerRows.get(id).box; if (box.checked !== on) { box.checked = on; box.dispatchEvent(new Event('change')); } };
  function solo(id) {
    const restore = soloed?.id === id ? soloed.prev : null;
    soloed = restore ? null : { id, prev: soloed?.prev ?? new Set(state.layers) };
    for (const l of LAYERS) setLayerOn(l.id, restore ? restore.has(l.id) : l.id === id);
  }
  api.registerOpener('layer', (id) => { const r = layerRows.get(id); if (!r) return false; r.name.click(); return true; });
  // Task 12: a layer's own action can ask to be made visible (files'
  // "Show file tree" button would otherwise build marks nobody sees, since
  // the files layer starts off by default) - reuses the row checkbox's own
  // change handler so the URL and the checkbox state stay in sync.
  api.showLayer = (id) => { const box = layerRows.get(id)?.box; if (box && !box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); } };
  const resetBtn = el('button', 'layer-reset'); resetBtn.type = 'button';
  resetBtn.appendChild(el('span', 'name', 'Reset view')); resetBtn.appendChild(el('kbd', 'key', RESET_KEY));
  resetBtn.addEventListener('click', () => globe.flyTo(DEFAULT_CAM));
  layersDock.body.appendChild(resetBtn);
  layersDock.footEl.hidden = false;
  layersDock.footEl.textContent = 'Counts are this disk and the local server, now. Each platform states how its placement is known.';

  // The stack panels and docks the rail opens. A launcher is a bindItem of
  // type panel, so it has a link and the URL reopens it.
  api.panelOpeners = {
    ledger: () => { state.panel = 'ledger'; ledgerDock.open(); syncRail(); },
    layers: () => { state.panel = 'layers'; layersDock.open(); layersDock.fold(false); syncRail(); },
    edits: () => { editsTouched = true; state.panel = 'edits'; editsDock.open(); syncRail(); },
    sessions: () => { state.panel = 'sessions'; sessionsDock.open(); sessionsDock.fold(false); syncRail(); },
    repos: () => { state.panel = 'repos'; panels.open('repos', 'Repo inspector', (b) => renderRepositories(b, api)); },
    files: () => { state.panel = 'files'; panels.open('files', 'File tree', (b) => renderFileTree(b, api, treePick)); },
    agents: () => { state.panel = 'agents'; panels.open('agents', 'Agents', (b) => { renderAgents(b, api); }); },
    declared: () => { state.panel = 'declared'; panels.open('declared', 'Policy bounds', (b) => renderDeclaredPanel(b, api)); },
    // What the retired Now lens showed: the Fleet board and the loop orbits.
    fleet: () => { state.panel = 'fleet'; fleet.open(); },
    // Every alert link lands on the drawer's Alerts tab (globe pulses, server
    // alert targets); the id stays 'attention' so old links open it.
    attention: () => { state.panel = 'attention'; panels.open('attention', 'Alerts', (b) => { b.appendChild(alertsView.el); }); syncRail(); },
    loops: () => { state.panel = 'loops'; api.showLayer('loops'); },
  };

  const addLauncher = ({ id, label, iconName, isOn, toggle }) => launchers.push({ id, label, iconName, isOn, toggle });
  addLauncher({ id: 'sessions', label: 'Sessions', iconName: 'agents', isOn: () => sessionsDock.isOpen(), toggle: () => (sessionsDock.isOpen() ? sessionsDock.close() : api.panelOpeners.sessions()) });
  addLauncher({ id: 'layers', label: 'Layers', iconName: 'layers', isOn: () => layersDock.isOpen(), toggle: () => (layersDock.isOpen() ? layersDock.close() : api.panelOpeners.layers()) });
  addLauncher({ id: 'ledger', label: 'Data ledger', iconName: 'ledger', isOn: () => ledgerDock.isOpen(), toggle: () => (ledgerDock.isOpen() ? ledgerDock.close() : api.panelOpeners.ledger()) });
  addLauncher({ id: 'edits', label: 'Recent edits', iconName: 'edits', isOn: () => editsDock.isOpen(), toggle: () => { editsTouched = true; if (editsDock.isOpen()) editsDock.close(); else api.panelOpeners.edits(); } });
  // The drawer opens on Alerts; its tabs reach the Repo inspector and Policy bounds.
  addLauncher({ id: 'attention', label: 'Context drawer', iconName: 'alerts', isOn: () => panels.ids().length > 0, toggle: () => (panels.ids().length ? panels.close() : api.panelOpeners.attention()) });

  api.registerOpener('panel', (id) => { if (!api.panelOpeners[id]) return false; api.panelOpeners[id](); return true; });
  api.registerOpener('loop', (id) => { api.showLayer('loops'); openLoopRecord(api, String(id)); return true; });
  api.registerOpener('alert', (id) => openAlertRecord(api, id));

  function buildRail() {
    for (const l of launchers) {
      const b = el('button', 'rail-btn'); b.type = 'button'; b.title = l.label; b.appendChild(icon(l.iconName));
      bindItem(b, { type: 'panel', id: l.id, link: linkFor({ lens: 'surface', layers: [...state.layers], panel: l.id }), open: () => { l.toggle(); syncRail(); }, label: l.label });
      l.btn = b; rail.appendChild(b);
    }
    // The board has one home, on Work (story 15).
    const work = el('a', 'rail-btn rail-link'); work.href = linkFor({ lens: 'work', tab: 'board' });
    work.title = 'Board (on Work)'; work.setAttribute('aria-label', 'Board on Work'); work.appendChild(icon('kanban'));
    work.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || !ctx.go) return; e.preventDefault(); ctx.go(work.getAttribute('href')); });
    rail.appendChild(work);
    const reset = el('button', 'rail-btn rail-reset'); reset.type = 'button'; reset.title = `Reset view (${RESET_KEY})`; reset.setAttribute('aria-label', 'Reset view'); reset.appendChild(icon('reset'));
    reset.addEventListener('click', () => globe.flyTo(DEFAULT_CAM));
    rail.appendChild(reset);
    syncRail();
  }

  const resFeed = data.residency;
  const rowsAll = resFeed?.ok ? resFeed.data.rows ?? [] : [];
  const paintLedger = () => {
    const { status, types } = ledgerStore.get();
    if (status !== 'ok') return;
    for (const [id, r] of typeRows) { const t = types.find((x) => x.id === id); r.n.textContent = t ? fmt(t.count) : ''; }
  };
  const unsubs = [ledgerStore.subscribe(paintLedger), ledgerStore.subscribe(() => renderStacks(api, ledgerStore))];
  unsubs.push(renderLedgerPanel(ledgerDock, api, ledgerStore));
  // A stored measurement is already in the store: paint it before the feed answers.
  paintLedger(); renderStacks(api, ledgerStore);
  const typeKeys = new Map(DATA_TYPES.map((d) => [d.key, d.id]));
  // A stat link named a row of the retired Pulse dock; it now opens the
  // Fleet ribbon tile that shows the same vital. The live count and budget
  // have no tile: they are the topbar's.
  api.registerOpener('stat', (id) => {
    if (id === 'loops') { api.showLayer('loops'); return true; }
    if (id === 'unpushed') { api.panelOpeners.repos(); return true; }
    fleet.open();
    const tile = root.querySelector(`#sb-vtile-${String(id).replace(/[^a-z-]/g, '')}`);
    if (tile) { tile.scrollIntoView?.({ block: 'nearest' }); tile.focus?.(); }
    return true;
  });

  // Presets fly the camera and open the panel that explains where it landed.
  const playersCam = () => {
    const ps = (api.players ?? []).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
    if (!ps.length) return { ...DEFAULT_CAM };
    const lon = ps.reduce((a, p) => a + p.lon, 0) / ps.length, lat = ps.reduce((a, p) => a + p.lat, 0) / ps.length;
    return { lon, lat, k: 2 };
  };
  const openPanel = (id) => api.panelOpeners[id]?.();
  const PRESETS = [
    { id: 'players', label: 'Players', go: () => { openPanel('ledger'); return globe.flyTo(playersCam()); } },
    { id: 'local', label: 'Local store', go: () => { openPanel('repos'); return api.flyTo(api.localPos(), 6); } },
    { id: 'files', label: 'File tree', go: () => { api.showLayer('files'); openPanel('files'); return api.flyTo(api.localPos(), 8); } },
    { id: 'agents', label: 'Agents', go: () => { openPanel('agents'); return api.flyTo(api.localPos(), 5); } },
    { id: 'kanban', label: 'Kanban', go: () => { api.showLayer('cards'); return api.flyTo(api.localPos(), 5); } },
    { id: 'loops', label: 'Loops', go: () => { api.showLayer('loops'); return api.flyTo(api.localPos(), 5); } },
    { id: 'alerts', label: 'Alerts', go: () => { api.showLayer('alerts'); return api.flyTo(api.localPos(), 5); } },
    { id: 'github', label: 'GitHub', go: () => { api.open({ type: 'player', id: 'github' }); } },
    { id: 'global', label: 'Global', go: () => { const c = globe.getCamera(); return globe.flyTo({ lon: c.lon, lat: c.lat, k: 0.9 }); } },
  ];
  for (const p of PRESETS) {
    const b = el('button', 'preset-btn', p.label); b.type = 'button'; b.dataset.preset = p.id; b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', async () => {
      activePreset = p.id; syncPresets(); flying = true;
      try { await p.go(); } finally { flying = false; }
    });
    flyList.appendChild(b);
  }

  // The footer readouts: centre, zoom, frame time, then a one-line hint.
  const readout = (label) => { const s = el('span', 'readout'); s.appendChild(document.createTextNode(`${label} `)); const b = el('b'); s.appendChild(b); footLine.appendChild(s); return b; };
  const footCentre = readout('centre'), footZoom = readout('zoom'), footFrame = readout('frame');
  footLine.appendChild(el('span', 'foot-hint', 'drag to rotate, wheel to zoom, click a platform to open it'));
  const footFeed = el('span', 'foot-feed'); footLine.appendChild(footFeed);
  const tick = () => {
    const c = globe.getCamera();
    footCentre.textContent = `${Math.abs(c.lon).toFixed(1)}${c.lon < 0 ? 'W' : 'E'} ${Math.abs(c.lat).toFixed(1)}${c.lat < 0 ? 'S' : 'N'}`;
    footZoom.textContent = `${c.k.toFixed(2)}x`;
    footFrame.textContent = `${globe.frameMs().toFixed(1)} ms`;
    const ts = resFeed?.ok ? resFeed.data.ts : null;
    footFeed.textContent = ts ? `residency ${Math.max(0, Math.round((Date.now() - ts) / 60000))} min old` : '';
    tracker?.tick();
    motion.tick();
    wall?.tick();
    roster?.setRoster(motion.rows(), { lockedId: wall?.lockedId() ?? null, wall: wall?.isOn() ?? false });
  };
  const hudTimer = setInterval(tick, 500);
  // Loop dots sit by the clock, so the globe is redrawn now and then while
  // they are shown; nothing else about the view changes.
  const orbitTimer = setInterval(() => { if (state.layers.has('loops') || selectedPlace() === 'local') globe.render(); }, 20000);
  tick();

  // Task 16, W-I5 (WCAG 2.1.4): the single-key shortcuts never take a
  // Ctrl/Meta/Alt chord (Ctrl+F is the browser's find), never fire while
  // typing in an editable field, and only answer focus inside this lens (or
  // no focus at all), so the topbar, a dock or the editor keep their keys.
  // Camera reset is 0: R was always Residency, so reset was unreachable.
  const keyed = new Map();
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && t.nodeType === 1 && t !== document.body && t !== document.documentElement) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable === true || t.closest?.('[contenteditable="true"]')) return;
      if (!root.contains(t)) return;
    }
    const k = String(e.key).toLowerCase();
    // T tracks the hovered or selected agent; with none, it is the Edit trails layer's key.
    if (k === 't') {
      const tgt = hover.itemTarget();
      const id = tgt?.type === 'agent' ? tgt.id : state.sel?.type === 'agent' ? state.sel.id : null;
      if (id) { api.toggleTrack(id); return; }
    }
    if (k === '/') { e.preventDefault(); search.focus(); return; }
    if (typeKeys.has(k)) { const box = typeRows.get(typeKeys.get(k)).box; box.checked = !box.checked; box.dispatchEvent(new Event('change')); return; }
    // E is both the Alert pulses layer and edit-the-hovered-file; the file wins
    // while a file is hovered, the layer otherwise.
    if (k === 'e' && hover.fileTarget()) { keyed.get('e')(e); return; }
    const layer = LAYERS.find((l) => l.key.toLowerCase() === k);
    if (layer) { const box = layerRows.get(layer.id).box; box.checked = !box.checked; box.dispatchEvent(new Event('change')); return; }
    if (keyed.has(k)) { keyed.get(k)(e); return; }
    if (e.key === ' ' && t === stage) { e.preventDefault(); state.spin = !state.spin; globe.setAutoRotate(state.spin); }
    if (e.key === RESET_KEY) globe.flyTo(DEFAULT_CAM);
  };
  window.addEventListener('keydown', onKey);

  buildRail();
  // The hover card reads only what is already loaded; E and I act on the file
  // it is showing.
  const modelFor = buildModelFor({ api, layers: LAYERS, built, launchers, state, itemTypes: ITEM_TYPES });
  const hover = createHoverCard(root, { modelFor });
  const fileActions = ctx.fileActions ?? { openFileEditor, openFileInIde };
  const editsWindow = createEditsWindow(editsDock, { api, store: editsStore, actions: fileActions });
  // The window opens by itself the first time a session is found working; once
  // the operator has opened or closed it, it stays as they left it.
  const openOnWork = editsStore.subscribe(() => {
    const { status, edits } = editsStore.get();
    if (editsTouched || status !== 'ok' || phone()) return;
    if (edits.some((e) => e.state === 'working')) { editsTouched = true; editsDock.open(); syncRail(); }
  });
  keyed.set('d', () => { editsTouched = true; editsDock.toggle(); });
  keyed.set('e', () => { const f = hover.fileTarget(); if (f) fileActions.openFileEditor(f); });
  keyed.set('i', () => { const f = hover.fileTarget(); if (f) fileActions.openFileInIde(f); });
  loadLedger(ledgerStore, () => api.destroyed);
  editsStore.start(() => api.destroyed);

  const resolvePath = makeResolver(() => rowsAll);

  const topbar = el('div', 'surface-topbar'); stage.appendChild(topbar);
  const topRow = el('div', 'surface-toprow');
  // The shell owns the topbar search (card glmps-2-0-137); Surface lends it a
  // source whose results fly the globe. Without a shell (a bare mount) the
  // search stays in the canvas header.
  const shellSearch = ctx.search ?? null;
  const searchHost = el('div', 'surface-searchhost');
  if (!shellSearch) { topRow.append(searchHost); stage.classList.add('has-canvas-search'); }
  topbar.append(topRow);

  const trackDock = createDock(side, { id: 'track', title: 'Tracking', iconName: 'agents', sub: 'Camera locked on the agent. Esc stops.', open: false, onChange: (open) => { onDock(() => trackDock)(open); if (!open && tracker?.active()) api.stopTrack(); } });
  docks.push(trackDock);
  // The tracking card leads the right column, and the Layers panel folds to make room for it.
  side.insertBefore(trackDock.el, side.firstChild);
  const trackUi = createTrackUi(stage);
  // While an agent is tracked the header carries the breadcrumb and (without a
  // shell slot) the search, which goes back to the canvas header when tracking stops.
  function placeChrome() {
    if (!shellSearch) (tracker.active() ? trackUi.right : topRow).appendChild(searchHost);
    root.classList.toggle('is-tracking', !!tracker.active());
  }
  tracker = createTracker({ api, stage, dock: trackDock, timeline, edits: editsStore, resolve: resolvePath, getState: () => ctx.getState?.(), ui: trackUi, onPin: (id) => pin.open({ type: 'agent', id }), onChange: () => { if (api.destroyed) return; wall?.onTrackChange(); placeChrome(); if (tracker.active()) layersDock.fold(true); else if (!panels.ids().length && !phone()) layersDock.fold(false); writeUrl(); syncRail(); } });
  api.trackedId = () => tracker.active();
  api.toggleTrack = (id) => (tracker.active() === id ? tracker.stop() : tracker.start(id));
  api.stopTrack = () => tracker.stop();

  // Enter on a result flies to the item and opens it the way a click would.
  const flyThenOpen = (sel, pos, k = 6) => {
    window.dispatchEvent(new CustomEvent('mc-link', { detail: { link: api.link(sel) } }));
    if (pos) api.flyTo(pos, k);
    api.open(sel);
  };
  function activateResult(e) {
    if (e.kind === 'session' && !api.agentPos?.(e.id, 1)) { api.ctx.go(linkFor({ lens: 'session', sessionId: e.id })); return; }
    if (e.kind === 'agent' || e.kind === 'session') flyThenOpen({ type: 'agent', id: e.id }, api.agentPos?.(e.id, 6));
    else if (e.kind === 'repo') flyThenOpen({ type: 'repo', id: e.id }, null);
    else if (e.kind === 'player') flyThenOpen({ type: 'player', id: e.id }, null);
    else if (e.kind === 'card') {
      const card = (api.data.backlog?.ok ? api.data.backlog.data.items ?? [] : []).find((c) => c.id === e.id);
      const stack = card ? api.cardStackOf(card) : 'local';
      flyThenOpen({ type: 'card-stack', id: stack }, api.stackPos?.(stack));
    } else if (e.kind === 'file') flyThenOpen({ type: 'file', id: e.id }, api.repoPos?.(String(e.id).split('/')[0]) ?? api.localPos(), 10);
    stage.focus?.();
  }
  let releaseSearch = null;
  const search = shellSearch ?? createSearch(searchHost, { api, activate: activateResult });
  if (shellSearch && owns()) releaseSearch = shellSearch.setSource({ api, activate: activateResult, ...SURFACE_SOURCE_TEXT });

  const pin = createPin({ panels, modelFor, urlNow, ctx });
  const baseInspect = api.inspect;
  api.inspect = (model) => baseInspect(state.sel && (model.word || model.facts?.length || model.rows?.length) ? { ...model, actions: [...(model.actions ?? []), pin.button({ ...state.sel })] } : model);

  const tlBar = createTimelineBar(foot, { store: timeline, reducedMotion: reduced });
  foot.insertBefore(tlBar.el, footLine);
  let seenAsOf = timeline.asOf();
  const offTimeline = timeline.subscribe(() => {
    const a = timeline.asOf();
    if (a !== seenAsOf) { seenAsOf = a; for (const l of LAYERS) built.get(l.id)?.refresh?.(); writeUrl(); }
    tracker.refresh();
  });
  timeline.load(() => api.destroyed).then(() => {
    if (api.destroyed) return;
    refreshEventLayers();
    const want = Number(q0.get('asof'));
    if (Number.isFinite(want) && want > 0) timeline.setAsOf(want);
    writeUrl();
  });
  unsubs.push(offTimeline, editsStore.subscribe(() => { tracker.refresh(); refreshEventLayers(); }));
  const onLink = () => writeUrl();
  window.addEventListener('mc-link', onLink);
  // Escape peels one layer: results, then the pin form, then tracking.
  const onEsc = (e) => {
    if (e.key !== 'Escape' || e.target === search.input) return;
    if (search.isOpen()) { search.close(); return; }
    if (panels.has('pin')) { panels.close('pin'); return; }
    if (tracker.active()) api.stopTrack();
  };
  window.addEventListener('keydown', onEsc);

  fleet = createFleetDock(root, { handlers: ctx.handlers, getState: () => ctx.getState?.(), isCurrent: owns, phone: phone() });
  roster = createSessionsRoster(sessionsDock, { onPick: (id) => { if (!wall.pick(id)) api.open({ type: 'agent', id }); } });
  root.insertBefore(fleet.el, foot);
  wall = createWallMode({ api, motion, tracker, home: () => DEFAULT_CAM, reduced });
  const wallBar = el('div', 'surface-wall'); wallBar.append(wall.btn, wall.headsUp);
  stage.appendChild(wallBar);
  motion.seed();

  // Not awaited: the camera flight is the long part, and the card is open at once.
  if (owns() && q0.get('track')) tracker.start(q0.get('track'));
  // A linked panel opens at once; it does not need the Fleet board. A
  // selection waits for it, since a stat link names a Fleet ribbon tile.
  if (owns() && route.panel && api.panelOpeners?.[route.panel]) api.panelOpeners[route.panel]();
  await fleet.ready();
  if (owns() && readWall()) wall.set(true, { save: false });

  if (owns() && route.sel) openSel(route.sel);

  return {
    update(r) {
      // Back/Forward changes the layer set; every difference
      // goes through the row checkbox's own change path, so the globe, the
      // checkbox and the URL written next all agree with the screen.
      const want = new Set(r.layers ?? DEFAULT_LAYERS);
      for (const layer of LAYERS) {
        const box = layerRows.get(layer.id)?.box;
        if (box && box.checked !== want.has(layer.id)) { box.checked = want.has(layer.id); box.dispatchEvent(new Event('change')); }
      }
      if (r.cam) globe.setCamera(r.cam, { silent: true });
      if (r.panel && api.panelOpeners?.[r.panel]) api.panelOpeners[r.panel]();
      if (r.sel) openSel(r.sel);
      // The tracked agent and as-of time live in the query string.
      const q = new URLSearchParams(location.search);
      const tr = q.get('track');
      if (tr && tracker.active() !== tr) tracker.start(tr); else if (!tr && tracker.active()) tracker.stop();
      const ao = Number(q.get('asof'));
      timeline.setAsOf(Number.isFinite(ao) && ao > 0 ? ao : null);
    },
    onState(s) { api.onState?.(s); tracker.onState(); fleet.onState(s); },
    onEvent(p) { api.onEvent?.(p); },
    unmount() {
      api.destroyed = true;
      // #lens-root is shared by every lens.
      if (owns()) root.classList.remove('surface-root', 'is-tracking');
      clearTimeout(camTimer);
      clearInterval(hudTimer);
      clearInterval(orbitTimer);
      wall?.destroy(); wallBar?.remove(); motion.destroy(); announcer.remove();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onEsc);
      window.removeEventListener('mc-link', onLink);
      clearTimeout(urlTimer);
      releaseSearch?.();
      if (!shellSearch) search.destroy();
      alertsUi.destroy(); tracker.destroy(); trackUi.destroy(); tlBar.destroy(); fleet.destroy();
      for (const u of unsubs) u();
      editsStore.stop();
      editsWindow.unsubscribe(); openOnWork();
      hover.destroy();
      globe.destroy();
      // a popup already open when the operator navigates
      // away must not linger over the next page - the shared 1.x singleton
      // has no lifecycle of its own, so the surface lens closes it here.
      if (owns()) closeDiffPopup();
    },
  };
}
