// apps/shell/src/shell-window.js
// The one window: a BaseWindow holding the dashboard, Slack and splitter
// WebContentsViews. Every decision (bounds, URL routing, permissions,
// shortcuts) comes from the pure modules in ./lib; this file only applies them.
import { app, BaseWindow, WebContentsView, session, ipcMain, desktopCapturer, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLayout, ratioFromPointer, nudgeRatio, edgeRatio, presetRatio, splitLabel, DEFAULT_RATIO, SPLITTER_PX, MIN_PANE_PX } from './lib/layout.js';
import { matchShortcut } from './lib/shortcuts.js';
import { classifyUrl, SLACK_HOME } from './lib/navigation.js';
import { openExternalSafely, dashboardLoadedDecision, slackToDashboardAction } from './lib/window-decisions.js';
import { permissionDecision, ORIGIN_SCOPED } from './lib/permissions.js';
import { chromeUserAgent } from './lib/user-agent.js';
import { mayRequestDisplayMedia, displayMediaCallbackArgs, mayClaimScreenShareSlot, offerSystemAudio, isScreenShareShowing, isScreenShareAbandoned, withTimeout } from './lib/screen-share.js';
import { statusView, offlineView } from './lib/status-format.js';
import { iconDir } from './lib/icon-paths.js';
import { SCHEME, localPageUrl, resolveLocalPage } from './lib/local-pages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RENDERER_DIR = path.join(HERE, '..', 'renderer');
export const PRELOAD_DIR = path.join(HERE, 'preload');
export const ASSETS_DIR = path.join(HERE, '..', 'assets');
export const PARTITIONS = Object.freeze({ dashboard: 'persist:glmps', slack: 'persist:slack', local: 'shell-local' });
// false: the 6 px strip keeps the pointer through setPointerCapture while dragging.
// true: a drag expands the splitter view over the whole window (transparent)
// so the pointer can never leave it.
// Step 8 decision: true. Each WebContentsView is its own top-level WebContents
// (its own frame tree and RenderWidgetHostInputEventRouter), tiled by the
// BaseWindow's native Views compositor, which hit-tests each new input event
// against whichever view's current bounds it lands in. setPointerCapture()
// only holds a pointer within the capturing document's own event-target
// chain; it has no defined effect once the OS delivers an event to a sibling
// WebContents, so a fast drag from the 6 px strip into the dashboard or Slack
// pane hands subsequent pointermove/pointerup events to that pane, never back
// to the splitter's document (documented Electron BrowserView/WebContentsView
// limitation: cross-view drag needs an overlay, not JS-level pointer capture).
// A literal physical-mouse confirmation could not be run in this build
// session (no interactive desktop session was available to simulate real OS
// input; see Task 5 FINDINGS) - flagged for the operator to sanity check.
export const OVERLAY_DRAG = true;
const GROUND = '#0a0b0d';

const secure = (extra = {}) => ({ contextIsolation: true, nodeIntegration: false, sandbox: true, ...extra });

// Best-effort origin extraction for the permission REQUEST handler's
// `details`. `requestingUrl` is itself documented for exactly this handler -
// session.md, setPermissionRequestHandler's own `webContents` bullet: "if the
// request comes from a subframe you should use `requestingUrl` to check the
// request origin" - and `details.securityOrigin` is the CHECK handler's
// confirmed field for the same purpose. What is not vendored is
// structures/media-access-permission-request.md, the page that would confirm
// requestingUrl actually lives on `details` (as opposed to some other
// argument) for a `media`/`display-capture` request specifically; both names
// are tried here rather than assumed from only one source. `requestingUrl` is
// a full URL and is turned into an origin; `securityOrigin` is assumed to
// already be one.
// Must run before app 'ready'. The shell's own pages are served from this
// scheme, not file://: the packaged app turns GrantFileProtocolExtraPrivileges
// off, which leaves a file:// page inside app.asar as an empty document.
export function registerLocalScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
}

// The three local views share PARTITIONS.local; the handler goes on that
// session only, so the dashboard and Slack sessions cannot load these pages.
export function installLocalPages() {
  const ses = session.fromPartition(PARTITIONS.local);
  if (ses.protocol.isProtocolHandled(SCHEME)) return;
  ses.protocol.handle(SCHEME, async (request) => {
    const hit = resolveLocalPage(request.url, RENDERER_DIR);
    if (!hit) return new Response('not found', { status: 404 });
    try {
      return new Response(await fs.readFile(hit.file), { headers: { 'content-type': hit.contentType } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function originFromRequestDetails(details) {
  try {
    if (details?.requestingUrl) return new URL(details.requestingUrl).origin;
  } catch { /* requestingUrl was present but not a parseable absolute URL: securityOrigin is tried next, not a bare failure */ }
  return details?.securityOrigin ?? null;
}

export function installPermissionPolicy({ log = () => {}, dashboardOrigin = null } = {}) {
  for (const [role, partition] of Object.entries(PARTITIONS)) {
    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const origin = originFromRequestDetails(details);
      // Named and logged, not just silently denied, so a live check turns
      // this up at once if the field-name guess above is wrong, rather than
      // huddles quietly never working and nothing in the log explaining why.
      // ORIGIN_SCOPED (permissions.js) is the one list of which permissions
      // this matters for, not a second copy of 'media'/'display-capture' here.
      if (role !== 'local' && ORIGIN_SCOPED.has(permission) && !origin) {
        log('warn', 'media denied: no requesting origin', { role, permission });
      }
      callback(permissionDecision({ role, permission, mediaTypes: details?.mediaTypes, origin, dashboardOrigin }));
    });
    // Check handler: `requestingOrigin` is the handler's own documented
    // parameter (session.md); `details.securityOrigin` ("for media, hid, usb
    // and serial checks") is a confirmed fallback. `details.mediaType` is a
    // single 'video' | 'audio' | 'unknown' string, not an array; normalised
    // to the mediaTypes shape permissionDecision expects.
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      const origin = requestingOrigin || details?.securityOrigin;
      return permissionDecision({ role, permission, mediaTypes: details?.mediaType ? [details.mediaType] : undefined, origin, dashboardOrigin });
    });
  }
  // Slack may refuse huddles to a browser it does not recognise (huddle plan
  // Facts): present the slack partition as plain Chrome, never Electron.
  // ses.setUserAgent affects WebContents created after this call
  // (session.md); it runs here, before any Slack WebContentsView exists.
  // NOTE (open risk, not closed by this): this rewrites navigator.userAgent
  // only. Chromium computes navigator.userAgentData's brands list separately,
  // from its own build info, and Electron's setUserAgent does not touch it -
  // Slack (or any site) can still read userAgentData.brands and see Chromium
  // version/brand data inconsistent with the spoofed legacy string. Recorded
  // in docs/desktop-shell.md for the operator's live check.
  const slackSession = session.fromPartition(PARTITIONS.slack);
  slackSession.setUserAgent(chromeUserAgent(slackSession.getUserAgent()));
}

export function createShellWindow({ settings, writer, kernel, slackUrl = SLACK_HOME, openExternal, log, notify = () => {},
  serviceName = 'GLMPS2', onRetry = () => {}, onOpenLogs = () => {}, onStatusChange = () => {},
  dashboardLoadTimeoutMs = 20_000 }) {
  installLocalPages();
  let ratio = settings.splitRatio;
  let slackVisible = settings.slackVisible;
  let swapped = settings.swapped;
  let dragging = false;
  let focused = 'dashboard';
  let lastLayout = null;
  let offlineVisible = true;      // shown from launch until the first good health check: never a blank pane
  let supervisorSnap = { state: 'checking', reason: null, attempts: 0, maxAttempts: 5 };
  let loadFailure = null;         // 'load-failed:<description>' while the dashboard page is broken
  let forceLoad = true;           // load the dashboard on the next up snapshot
  let offlineReady = false;
  // Screen-share slot: null (idle) while no
  // getDisplayMedia request is open; the same object from the moment a
  // request is accepted (`{ loading: true }`, mutated in place rather than
  // replaced once sources arrive, so a `closed` mark made on it while loading
  // is never lost under a reassignment) until it is settled - `resolve` is
  // added once desktopCapturer.getSources answers and the picker is actually
  // shown. mayClaimScreenShareSlot (screen-share.js) is the pure decision
  // over whether a new request may claim this; isScreenShareShowing is the
  // pure decision shortcutsSuspended reads below - a request merely loading
  // sources (which can take up to GET_SOURCES_TIMEOUT_MS) must not lock the
  // operator out of the three pane shortcuts, only one the picker has
  // actually shown and is waiting on the operator's own choice.
  let pendingPicker = null;
  let pickerRequestId = 0;
  const shortcutsSuspended = () => isScreenShareShowing(pendingPicker);

  const b = settings.bounds;
  const win = new BaseWindow({
    width: b?.width ?? 1440, height: b?.height ?? 900, ...(b ? { x: b.x, y: b.y } : {}),
    minWidth: SPLITTER_PX + 2 * MIN_PANE_PX, minHeight: 400,
    title: statusView(supervisorSnap, { now: Date.now() }).title, backgroundColor: GROUND, show: false,
    icon: path.join(iconDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, assetsDir: ASSETS_DIR }), 'icon.ico'),
  });
  const views = {
    dashboard: new WebContentsView({ webPreferences: secure({ session: session.fromPartition(PARTITIONS.dashboard) }) }),
    slack: new WebContentsView({ webPreferences: secure({ session: session.fromPartition(PARTITIONS.slack) }) }),
    offline: new WebContentsView({ webPreferences: secure({ session: session.fromPartition(PARTITIONS.local), preload: path.join(PRELOAD_DIR, 'offline.cjs') }) }),
    // Added after offline so the splitter is already topmost of the panes: a
    // drag start then has no reparenting to do, which can cost the pointer capture.
    splitter: new WebContentsView({ webPreferences: secure({ session: session.fromPartition(PARTITIONS.local), preload: path.join(PRELOAD_DIR, 'splitter.cjs') }) }),
    // Screen-share source picker: a local page, shown only while a
    // Slack getDisplayMedia request is pending.
    picker: new WebContentsView({ webPreferences: secure({ session: session.fromPartition(PARTITIONS.local), preload: path.join(PRELOAD_DIR, 'picker.cjs') }) }),
  };
  for (const v of Object.values(views)) { v.setBackgroundColor(GROUND); win.contentView.addChildView(v); }
  views.picker.setVisible(false);
  // Belt-and-suspenders alongside installPermissionPolicy's session-level
  // setUserAgent (web-contents.md: `contents.setUserAgent` overrides the
  // session-wide value for this one WebContents; harmless to set it twice to
  // the same already-stripped string).
  views.slack.webContents.setUserAgent(chromeUserAgent(views.slack.webContents.getUserAgent()));

  function applyLayout() {
    const { width, height } = win.getContentBounds();
    const l = computeLayout({ width, height, ratio, slackVisible, swapped });
    ratio = l.ratio;
    lastLayout = l;
    views.dashboard.setBounds(l.dashboard);
    views.offline.setBounds(l.dashboard);
    views.offline.setVisible(offlineVisible);
    views.dashboard.setVisible(!offlineVisible);
    views.slack.setVisible(Boolean(l.slack));
    if (l.slack) views.slack.setBounds(l.slack);
    views.splitter.setVisible(Boolean(l.splitter));
    if (l.splitter) views.splitter.setBounds(dragging && OVERLAY_DRAG ? { x: 0, y: 0, width, height } : l.splitter);
    // Always kept full-window sized, like offline's bounds are always kept
    // current even while hidden; only its own visibility (showPicker/closePicker)
    // decides whether it is ever seen.
    views.picker.setBounds({ x: 0, y: 0, width, height });
  }

  function focusView(role) { focused = role; views[role].webContents.focus(); }
  function setSlackVisible(v) {
    slackVisible = v;
    if (!v && focused === 'slack') focusView('dashboard');
    writer.update({ slackVisible });
    applyLayout();
  }
  function runShortcut(action) {
    if (action === 'toggle-slack') setSlackVisible(!slackVisible);
    else if (action === 'swap-sides') { swapped = !swapped; writer.update({ swapped }); applyLayout(); if (!sw.isDestroyed()) sendRatio(); }
    else if (action === 'reload-focused') views[focused].webContents.reload();
    else if (action.startsWith('split-')) setRatio(presetRatio(action, win.getContentBounds().width));
  }
  function setRatio(next) {
    if (next === null) return;
    ratio = next;
    applyLayout();
    writer.update({ splitRatio: ratio });
    if (!sw.isDestroyed()) sendRatio();
  }

  // 'allow' when the view may navigate itself; otherwise the URL was handed
  // to the other pane or the system browser, or blocked and logged.
  function route(role, url) {
    const kind = classifyUrl({ role, url, kernelOrigin: kernel.origin });
    if (kind === 'internal') return 'allow';
    if (kind === 'to-dashboard') {
      // a stale loadFailure from an earlier broken
      // dashboard page must not shadow this fresh navigation - without this,
      // did-finish-load's own `!loadFailure` guard would keep the offline
      // page up forever even once this new page has actually loaded.
      // beginDashboardLoad also re-arms the load timeout (item 1) against
      // this attempt, and disarms whatever loadDashboard's own timer left
      // pending, rather than leaving a stale one to misfire on this page.
      // only while the kernel is answering - otherwise the
      // offline page keeps its true reason instead of a load failure.
      if (slackToDashboardAction(supervisorSnap.state) === 'load') beginDashboardLoad(url);
      focusView('dashboard');
      return 'handled';
    }
    if (kind === 'to-slack') { if (!slackVisible) setSlackVisible(true); views.slack.webContents.loadURL(url); focusView('slack'); return 'handled'; }
    if (kind === 'external') {
      // Task 15, SF-2: a failed open now also notifies the operator; the
      // unsafe-URL refusal stays log-only (window-decisions.js).
      void openExternalSafely({ url, openExternal, log, notify, role });
      return 'handled';
    }
    log('warn', 'blocked navigation', { role, url: String(url).slice(0, 200) });
    return 'handled';
  }

  for (const role of ['dashboard', 'slack']) {
    const wc = views[role].webContents;
    wc.setWindowOpenHandler(({ url }) => {
      // A window.open inside the pane's own origin navigates the pane; nothing
      // ever gets a second window (security checklist item 14).
      if (route(role, url) === 'allow') setImmediate(() => wc.loadURL(url));
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event) => { if (route(role, event.url) !== 'allow') event.preventDefault(); });
    wc.on('will-redirect', (event) => { if (event.isMainFrame && route(role, event.url) !== 'allow') event.preventDefault(); });
    wc.on('focus', () => { focused = role; });
    // Suspended (event still consumed, but the action withheld) while a
    // screen-share request is open or loading: PR #29 review - toggling
    // Slack's visibility, swapping panes or reloading this view out from
    // under a pending getDisplayMedia() request would disrupt or orphan it.
    // The picker's own before-input-event (below) is not suspended by this.
    wc.on('before-input-event', (event, input) => {
      const action = matchShortcut(input);
      if (action) { event.preventDefault(); if (!shortcutsSuspended()) runShortcut(action); }
    });
  }
  const sw = views.splitter.webContents;
  sw.setWindowOpenHandler(() => ({ action: 'deny' }));
  sw.on('will-navigate', (event) => event.preventDefault());
  // The splitter can hold keyboard focus (it is a tabbable role="separator"),
  // so the three shell shortcuts must still fire from there, not just from
  // the dashboard and Slack panes. Suspended while the picker is open/loading,
  // same as the dashboard's and Slack's own handler above.
  sw.on('before-input-event', (event, input) => {
    const action = matchShortcut(input);
    if (action) { event.preventDefault(); if (!shortcutsSuspended()) runShortcut(action); }
  });
  // track focus onto the splitter itself too, so
  // Ctrl+Alt+R fired while the splitter holds focus reloads the splitter
  // (views[focused].webContents.reload() below already handles any role in
  // `views`; only the tracking was missing).
  function onSplitterFocus() { focused = 'splitter'; }
  sw.on('focus', onSplitterFocus);

  // Every IPC channel is only honoured from the window it belongs to; a
  // message from any other webContents is dropped.
  const fromWc = (wc, fn) => (e, ...args) => { if (e.sender === wc) return fn(e, ...args); };
  const sendRatio = () => sw.send('splitter:ratio', Math.round(ratio * 100), splitLabel({ ratio, swapped }));

  // the stuck-drag gap. `dragging` was previously
  // cleared only by 'splitter:end'. If that message never arrives - the
  // splitter's renderer crashes or hangs mid-drag, the window loses focus
  // (alt-tab, or the pointer is released outside the window so no
  // 'pointerup' ever reaches the splitter's document), or the drag simply
  // goes quiet - `dragging` stays true forever, and under OVERLAY_DRAG the
  // full-window transparent splitter view keeps eating every pointer event
  // in the dashboard and Slack panes until the app is restarted. endDrag() is
  // the single reset path, reachable from a clean end, a window blur, a dead
  // or hung splitter renderer, and a 2 s no-progress watchdog.
  const DRAG_WATCHDOG_MS = 2_000;
  let dragWatchdog = null;
  function armDragWatchdog() {
    clearTimeout(dragWatchdog);
    dragWatchdog = setTimeout(endDrag, DRAG_WATCHDOG_MS);
  }
  function endDrag() {
    clearTimeout(dragWatchdog);
    dragWatchdog = null;
    if (!dragging) return;
    dragging = false;
    if (OVERLAY_DRAG) views.splitter.setBackgroundColor(GROUND);
    applyLayout();
    writer.update({ splitRatio: ratio });
    if (!sw.isDestroyed()) sendRatio();
  }
  function onWinBlur() { endDrag(); }
  win.on('blur', onWinBlur);
  // The renderer crashed: its document and JS state (the drag ratio it was
  // tracking, its splitter:mode) are gone with it, so the page is reloaded
  // and told its mode and ratio again once it comes back, not left blank.
  // the resend is a single persistent listener,
  // registered once here rather than freshly inside loadSplitter() on every
  // call - so any number of loads (the initial one, and any number of crash
  // reloads) can never stack multiple pending resends against one
  // did-finish-load, by construction, not by careful bookkeeping.
  function onSplitterLoaded() { sw.send('splitter:mode', { overlay: OVERLAY_DRAG }); sendRatio(); }
  sw.on('did-finish-load', onSplitterLoaded);
  function loadSplitter() { sw.loadURL(localPageUrl('splitter.html')); }
  // capped the same as Slack's crash reload (3 per
  // 10 minutes), so a genuine crash loop stops reloading rather than
  // spinning forever.
  let splitterCrashes = [];
  function onSplitterGone(_event, details) {
    if (sw.isDestroyed()) return;
    log('error', 'splitter renderer process gone', { reason: details?.reason ?? 'unknown' });
    endDrag();
    const t = Date.now();
    // The push happens before this check, so `length` here already counts
    // this crash: <=3 permits exactly 3 reloads per 10-minute window (this
    // crash included) - the 4th and later crashes in that window get none -
    // not 4 (fix round 2: documented per the reviewer's ambiguity flag, same
    // wording at all three crash caps in this file).
    splitterCrashes = splitterCrashes.filter((x) => t - x < 600_000).concat(t);
    if (splitterCrashes.length <= 3) loadSplitter();
  }
  function onSplitterUnresponsive() {
    if (sw.isDestroyed()) return;
    log('warn', 'splitter renderer is unresponsive', {});
    endDrag();
  }
  sw.on('render-process-gone', onSplitterGone);
  sw.on('unresponsive', onSplitterUnresponsive);

  const handlers = {
    'splitter:start': fromWc(sw, (e) => {
      dragging = true;
      armDragWatchdog();
      // Explicit z-order: View.addChildView(view) re-adding a view that is
      // already a child moves it to the end of the parent's child array,
      // which is the top of the stacking order. The initial setup loop above
      // happens to add the splitter view last (so it already painted on top
      // implicitly), but nothing pinned that: a later view added after it
      // (an offline overlay, say) would silently sit above the splitter
      // during an OVERLAY_DRAG expansion and eat its pointer events. Make the
      // ordering an explicit invariant of drag start instead of an accident
      // of object key order. Verified against the shipped Electron 44.4.5
      // binary by the smoke probe: after 'splitter:start' the splitter is
      // win.contentView.children's last entry and its bounds cover the whole
      // window; after 'splitter:end' it is back to the thin strip.
      const kids = win.contentView.children;
      if (kids[kids.length - 1] !== views.splitter) win.contentView.addChildView(views.splitter);
      if (OVERLAY_DRAG) { views.splitter.setBackgroundColor('#00000000'); applyLayout(); }
    }),
    'splitter:move': fromWc(sw, (e, screenX) => {
      if (!dragging || !Number.isFinite(screenX)) return;
      armDragWatchdog();
      const c = win.getContentBounds();
      ratio = ratioFromPointer({ pointerX: screenX - c.x, width: c.width, swapped });
      applyLayout();
      sendRatio();
    }),
    'splitter:end': fromWc(sw, (e, screenX) => {
      handlers['splitter:move'](e, screenX);
      endDrag();
    }),
    'splitter:nudge': fromWc(sw, (e, dir) => {
      setRatio(nudgeRatio({ ratio, width: win.getContentBounds().width, dir, swapped }));
    }),
    'splitter:edge': fromWc(sw, (e, which) => {
      setRatio(edgeRatio({ edge: which === 'home' ? 'home' : 'end', width: win.getContentBounds().width, swapped }));
    }),
    'splitter:reset': fromWc(sw, () => {
      setRatio(DEFAULT_RATIO);
    }),
  };

  // Supervision glue: the supervisor reports the kernel's health.
  // loadFailure is a second, independent reason to show the offline page - a
  // page that loaded then crashed, or never finished loading, even while the
  // kernel itself answers healthy - so it takes precedence over the
  // supervisor's own up/degraded read (effectiveSnapshot).
  const effectiveSnapshot = () => (loadFailure ? { ...supervisorSnap, state: 'offline', reason: loadFailure } : supervisorSnap);
  function pushStatus() {
    const es = effectiveSnapshot();
    if (!win.isDestroyed()) win.setTitle(statusView(es, { now: Date.now() }).title);
    onStatusChange(es);
  }
  function pushOffline() {
    if (!offlineReady || views.offline.webContents.isDestroyed()) return;
    views.offline.webContents.send('offline:state', offlineView(effectiveSnapshot(), { kernelUrl: kernel.url, serviceName, slackVisible }));
  }
  function setOffline(v) { offlineVisible = v; applyLayout(); }
  // a page that neither finishes loading
  // nor fails outright (a hung request, a kernel that accepted the TCP
  // connection but never answers HTTP) would otherwise leave the offline page
  // showing "Loading the dashboard" forever. Both dashboard-load entry points
  // (the supervisor's own loadDashboard, and a to-dashboard route from Slack)
  // go through this so neither can leave a stale timer armed against the
  // other's more recent attempt.
  const DASHBOARD_LOAD_TIMEOUT_MS = dashboardLoadTimeoutMs;
  let loadTimeout = null;
  function clearLoadTimeout() { clearTimeout(loadTimeout); loadTimeout = null; }
  function beginDashboardLoad(url) {
    clearLoadTimeout();
    loadFailure = null;
    views.dashboard.webContents.loadURL(url);
    loadTimeout = setTimeout(() => {
      loadTimeout = null;
      if (views.dashboard.webContents.isDestroyed()) return;
      loadFailure = 'load-failed:timeout';
      log('warn', 'dashboard did not finish loading within the timeout', { ms: DASHBOARD_LOAD_TIMEOUT_MS, url });
      setOffline(true);
      pushOffline();
      pushStatus();
    }, DASHBOARD_LOAD_TIMEOUT_MS);
  }
  function loadDashboard() {
    forceLoad = false;
    beginDashboardLoad(kernel.url);
  }
  function onSupervisor(snap) {
    // the supervisor keeps ticking on its own timer
    // after the window (and its views) are closed; nothing here should touch
    // a destroyed window.
    if (win.isDestroyed()) return;
    const wasUp = supervisorSnap.state === 'up' || supervisorSnap.state === 'degraded';
    supervisorSnap = snap;
    const isUp = snap.state === 'up' || snap.state === 'degraded';
    if (isUp && (forceLoad || !wasUp)) loadDashboard();
    if (!isUp) {
      // a kernel that flaps up then down otherwise
      // leaves the load timer armed from the up transition's loadDashboard()
      // call; left running, it would later fire and set
      // load-failed:timeout over this down state's own, truer reason.
      clearLoadTimeout();
      loadFailure = null;
      setOffline(true); // a down kernel explains a failed page; show that instead
    }
    pushOffline();
    pushStatus();
  }
  const dwc = views.dashboard.webContents;
  dwc.on('did-finish-load', () => {
    if (dwc.isDestroyed()) return;
    clearLoadTimeout();
    // a kernel page that finishes after the load timeout fired
    // clears load-failed:timeout instead of staying behind the timeout page.
    const d = dashboardLoadedDecision({ loadFailure, url: dwc.getURL(), kernelOrigin: kernel.origin });
    if (d.clearFailure) loadFailure = null;
    if (d.reveal) { setOffline(false); pushOffline(); pushStatus(); }
  });
  dwc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (dwc.isDestroyed()) return;
    if (!isMainFrame || errorCode === -3) return; // -3 is ERR_ABORTED: a navigation replaced this one
    clearLoadTimeout();
    loadFailure = `load-failed:${errorDescription}`;
    log('warn', 'dashboard failed to load', { errorCode, errorDescription, url: validatedURL });
    setOffline(true);
    pushOffline();
    pushStatus();
  });
  dwc.on('render-process-gone', (_e, details) => {
    if (dwc.isDestroyed()) return;
    clearLoadTimeout();
    loadFailure = `load-failed:renderer ${details.reason}`;
    log('error', 'dashboard renderer gone', details);
    setOffline(true);
    pushOffline();
    pushStatus();
  });
  let slackCrashes = [];
  views.slack.webContents.on('render-process-gone', (_e, details) => {
    if (views.slack.webContents.isDestroyed()) return;
    const t = Date.now();
    // <=3 permits exactly 3 reloads per 10-minute window, not 4 - see the
    // splitter's identical crash cap above for the full note.
    slackCrashes = slackCrashes.filter((x) => t - x < 600_000).concat(t);
    log('error', 'slack renderer gone', { ...details, recent: slackCrashes.length });
    if (slackCrashes.length <= 3) views.slack.webContents.reload();
  });
  const ow = views.offline.webContents;
  ow.setWindowOpenHandler(() => ({ action: 'deny' }));
  ow.on('will-navigate', (event) => event.preventDefault());
  // the offline page is a real focusable view like the
  // splitter and the dashboard/Slack panes - the three shell shortcuts must
  // still fire from it, and Ctrl+Alt+R must know it is the focused view.
  function onOfflineFocus() { focused = 'offline'; }
  ow.on('focus', onOfflineFocus);
  ow.on('before-input-event', (event, input) => {
    const action = matchShortcut(input);
    if (action) { event.preventDefault(); if (!shortcutsSuspended()) runShortcut(action); }
  });
  // the offline view can crash too - it must come back
  // and re-announce the current state, not stay dark. The persistent
  // did-finish-load listener (registered once, like the splitter's) covers
  // the initial load, this crash reload, and a manual Ctrl+Alt+R reload
  // alike, with no possibility of stacking. Capped the same as Slack's (3 per
  // 10 minutes).
  function onOfflineLoaded() { offlineReady = true; pushOffline(); }
  ow.on('did-finish-load', onOfflineLoaded);
  function loadOffline() { ow.loadURL(localPageUrl('offline.html')); }
  let offlineCrashes = [];
  function onOfflineGone(_event, details) {
    if (ow.isDestroyed()) return;
    offlineReady = false;
    log('error', 'offline-page renderer gone', { reason: details?.reason ?? 'unknown' });
    const t = Date.now();
    // <=3 permits exactly 3 reloads per 10-minute window, not 4 - see the
    // splitter's identical crash cap above for the full note.
    offlineCrashes = offlineCrashes.filter((x) => t - x < 600_000).concat(t);
    if (offlineCrashes.length <= 3) loadOffline();
  }
  ow.on('render-process-gone', onOfflineGone);
  handlers['offline:retry'] = fromWc(ow, () => retry());
  handlers['offline:open-logs'] = fromWc(ow, () => onOpenLogs());
  function retry() {
    forceLoad = true;
    loadFailure = null;
    return onRetry();
  }

  // Screen-share picker: a local page like the splitter and offline
  // views - sandboxed, preload-exposed fixed functions, every message it
  // sends checked against this view's own webContents. (pendingPicker and
  // shortcutsSuspended are declared with the rest of this closure's state,
  // above, since the dashboard/Slack/splitter/offline handlers above also
  // read shortcutsSuspended.)
  const pw = views.picker.webContents;
  pw.setWindowOpenHandler(() => ({ action: 'deny' }));
  pw.on('will-navigate', (event) => event.preventDefault());
  function onPickerFocus() { focused = 'picker'; }
  pw.on('focus', onPickerFocus);
  // Not suspended by shortcutsSuspended: the picker is the one view meant to
  // hold focus during its own request, and Ctrl+Alt+R reloading it is the
  // operator's manual recovery if it ever gets stuck.
  pw.on('before-input-event', (event, input) => {
    const action = matchShortcut(input);
    if (action) { event.preventDefault(); runShortcut(action); }
  });
  let pickerPrevFocused = 'dashboard';
  let pickerReady = false;
  function sendPickerState() {
    if (pickerReady && pendingPicker?.resolve) {
      pw.send('picker:sources', { sources: pendingPicker.sources, canShareAudio: pendingPicker.canShareAudio, requestId: pendingPicker.requestId });
    }
  }
  function showPicker() {
    // Explicit z-order, same invariant as 'splitter:start' above: the most
    // recently added child paints on top, and the picker must sit above
    // every pane (including the splitter mid-drag) while it is open.
    win.contentView.addChildView(views.picker);
    views.picker.setVisible(true);
    pickerPrevFocused = focused;
    focusView('picker');
    sendPickerState();
  }
  function hidePicker() {
    views.picker.setVisible(false);
    // Clears the renderer's own tile list immediately, rather than leaving a
    // stale list briefly visible the next time the picker is shown (PR #29
    // the next request sends its own sources right away.
    if (!pw.isDestroyed()) pw.send('picker:clear');
    if (views[pickerPrevFocused] && !views[pickerPrevFocused].webContents.isDestroyed()) focusView(pickerPrevFocused);
  }
  // Persistent did-finish-load listener (same shape as the splitter's and
  // offline's): covers the initial load and any crash reload below, and
  // re-announces whatever request is still open rather than leaving a picker
  // that came back blank mid-request.
  function onPickerLoaded() { pickerReady = true; sendPickerState(); }
  pw.on('did-finish-load', onPickerLoaded);
  function loadPicker() { pw.loadURL(localPageUrl('picker.html')); }
  // Settles whatever request currently owns the slot, regardless of which
  // request a caller thinks it is answering - used only by main-process-
  // initiated paths (a crashed/unresponsive renderer, the window closing)
  // that must deny the in-flight request no matter what. Ignores a slot that
  // is merely `{ loading: true }` (no resolve yet) - there is nothing to
  // settle until the picker has actually been shown.
  function forceSettlePicker(sourceId, includeAudio) {
    if (!pendingPicker?.resolve) return;
    const { resolve } = pendingPicker;
    pendingPicker = null;
    hidePicker();
    resolve({ sourceId, includeAudio });
  }
  // IPC-sourced settle (from the picker page itself): additionally must match
  // the requestId the picker was actually shown with (PR #29 review, minor),
  // so a delayed message from an already-settled request can never be
  // misapplied to whatever request now owns the slot.
  function settlePicker(sourceId, includeAudio, requestId) {
    if (pendingPicker?.requestId !== requestId) return;
    forceSettlePicker(sourceId, includeAudio);
  }
  // Capped the same as the splitter's and offline's (3 reloads per 10
  // minutes): a renderer that crashes mid-request would otherwise leave
  // Slack's getDisplayMedia() promise hanging forever, since nothing would
  // ever call the pending callback - forceSettlePicker(null, false) denies
  // that one request outright (fail closed) before the reload.
  let pickerCrashes = [];
  function onPickerGone(_event, details) {
    if (pw.isDestroyed()) return;
    pickerReady = false;
    log('error', 'picker renderer gone', { reason: details?.reason ?? 'unknown' });
    forceSettlePicker(null, false);
    const t = Date.now();
    pickerCrashes = pickerCrashes.filter((x) => t - x < 600_000).concat(t);
    if (pickerCrashes.length <= 3) loadPicker();
  }
  pw.on('render-process-gone', onPickerGone);
  // PR #29 review, minor: an unresponsive (hung, not crashed) renderer gets
  // the same treatment as a crashed one - deny the pending request and reload
  // it - rather than leaving the slot claimed forever against a picker that
  // will never answer. Uncapped, same as the splitter's own 'unresponsive'
  // handler (only render-process-gone is reload-capped).
  function onPickerUnresponsive() {
    if (pw.isDestroyed()) return;
    log('warn', 'picker renderer is unresponsive', {});
    forceSettlePicker(null, false);
    loadPicker();
  }
  pw.on('unresponsive', onPickerUnresponsive);
  handlers['picker:choose'] = fromWc(pw, (e, sourceId, includeAudio, requestId) => settlePicker(sourceId, Boolean(includeAudio), Number(requestId)));
  handlers['picker:cancel'] = fromWc(pw, (e, requestId) => settlePicker(null, false, Number(requestId)));

  // A hung desktopCapturer.getSources lookup must not claim the slot forever
  // (re-review, load-bearing #1): raced against this via withTimeout, whose
  // rejection reaches the same named catch below as any other failed step.
  const GET_SOURCES_TIMEOUT_MS = 10_000;
  // Tags a thrown/rejected error with which step produced it, so the one
  // catch at the bottom can log *which* of getSources, showPicker or mapping
  // the operator's choice into the callback actually failed (re-review #3),
  // instead of one undifferentiated "desktopCapturer.getSources failed".
  function failedStep(step, err) {
    throw Object.assign(new Error(err?.message ?? String(err)), { step, cause: err });
  }

  // Installed on the slack partition's session only (never the dashboard's):
  // a request from the dashboard pane simply has no handler to answer it,
  // which electron-44.4.5/api/session.md's own Facts (see the huddle plan)
  // says denies the request outright.
  session.fromPartition(PARTITIONS.slack).setDisplayMediaRequestHandler((request, callback) => {
    // Answered exactly once (PR #29 review, Important #4): a guard, not just
    // careful chaining, since a throw anywhere in the chain below must still
    // resolve Chromium's own callback rather than leaving getDisplayMedia()
    // hanging and risking a second, later call.
    let answered = false;
    const answerOnce = (result) => { if (answered) return; answered = true; callback(result); };

    // The slot is claimed synchronously, before the first await, precisely so
    // a second request arriving while desktopCapturer.getSources is still
    // in flight sees it occupied (PR #29 review, Important #1) - without
    // this, both requests would pass this check and race the same picker UI.
    if (!mayRequestDisplayMedia({ securityOrigin: request.securityOrigin }) || !mayClaimScreenShareSlot(pendingPicker)) {
      answerOnce(null);
      return;
    }
    // One stable object for this request's whole lifetime, mutated in place
    // (never replaced) - so a `closed` mark made on it by the window's
    // 'closed' handler while it is still `{ loading: true }` (re-review #2)
    // is still visible to the `slot.closed` check below even after sources
    // arrive and this same object gains `sources`/`resolve`/`requestId`.
    const slot = { loading: true };
    pendingPicker = slot;
    const requestId = ++pickerRequestId;
    let shown = false; // whether showPicker() actually ran, for the catch below

    (async () => {
      let sources;
      try {
        // Two calls, one per type, rather than one call for both:
        // desktopCapturer does not document its id string's shape
        // (desktop-capturer.md is not among the vendored electron-44.4.5
        // pages - see the PR notes), so the picker's "Screens" / "Windows"
        // grouping is tagged here from the request actually made, never
        // guessed from parsing a source's id.
        const [screens, windows] = await withTimeout(
          Promise.all([
            desktopCapturer.getSources({ types: ['screen'] }),
            desktopCapturer.getSources({ types: ['window'] }),
          ]),
          GET_SOURCES_TIMEOUT_MS,
          'desktopCapturer.getSources timed out',
        );
        const tag = (kind) => (s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), kind });
        sources = [...screens.map(tag('screen')), ...windows.map(tag('window'))];
      } catch (err) {
        failedStep('getSources', err);
      }

      // The window closed while this request was still loading sources
      // (re-review #2): answer callback(null) and stop here, never call
      // showPicker on a window (and picker view) that no longer exists.
      if (isScreenShareAbandoned(slot)) { answerOnce(null); return; }

      // Looping system audio back into the huddle plays it back to every
      // participant (PR #29 review, Important #3): offered unchecked by
      // default, and only when the web content itself asked for audio and
      // Electron documents loopback support (session.md: Windows only).
      const canShareAudio = offerSystemAudio({ platform: process.platform, audioRequested: request.audioRequested });

      let choice;
      try {
        choice = await new Promise((resolve) => {
          Object.assign(slot, { sources, canShareAudio, resolve, requestId });
          pendingPicker = slot;
          shown = true;
          showPicker();
        });
      } catch (err) {
        failedStep('showPicker', err);
      }

      try {
        answerOnce(displayMediaCallbackArgs({ sourceId: choice.sourceId, sources, includeAudio: choice.includeAudio }));
      } catch (err) {
        failedStep('callback mapping', err);
      }
    })().catch((err) => {
      // hidePicker before clearing the slot (re-review #3): only meaningful
      // (and only safe to call) if showPicker actually ran and the window is
      // still around; settling via the normal picker flow already hid it, so
      // this mainly covers showPicker itself having thrown.
      if (shown && !win.isDestroyed()) {
        try { hidePicker(); } catch { /* window or view already gone */ }
      }
      pendingPicker = null;
      log('error', 'screen-share request failed', { step: err.step ?? 'unknown', message: err.cause?.message ?? err.message });
      answerOnce(null);
    });
  });

  for (const [channel, fn] of Object.entries(handlers)) ipcMain.on(channel, fn);

  const persistBounds = () => writer.update({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  win.on('resize', () => { applyLayout(); persistBounds(); });
  win.on('move', persistBounds);
  win.on('closed', () => {
    clearTimeout(dragWatchdog);
    clearLoadTimeout();
    for (const [channel, fn] of Object.entries(handlers)) ipcMain.removeListener(channel, fn);
    win.removeListener('blur', onWinBlur);
    if (!sw.isDestroyed()) {
      sw.removeListener('render-process-gone', onSplitterGone);
      sw.removeListener('unresponsive', onSplitterUnresponsive);
      sw.removeListener('focus', onSplitterFocus);
      sw.removeListener('did-finish-load', onSplitterLoaded);
    }
    if (!ow.isDestroyed()) {
      ow.removeListener('render-process-gone', onOfflineGone);
      ow.removeListener('focus', onOfflineFocus);
      ow.removeListener('did-finish-load', onOfflineLoaded);
    }
    if (!pw.isDestroyed()) {
      pw.removeListener('render-process-gone', onPickerGone);
      pw.removeListener('unresponsive', onPickerUnresponsive);
      pw.removeListener('focus', onPickerFocus);
      pw.removeListener('did-finish-load', onPickerLoaded);
    }
    // A request still loading sources (re-review #2): forceSettlePicker
    // ignores a loading slot (there is no resolve to settle yet), so the
    // slot is marked closed in place instead - the getSources continuation
    // checks isScreenShareAbandoned(slot) on that same object once it
    // resolves, and answers callback(null) there rather than calling
    // showPicker on a window that is already gone.
    if (pendingPicker && !pendingPicker.resolve) pendingPicker.closed = true;
    // Answers callback(null) for a request the picker had already been shown
    // for (PR #29 review, minor) rather than leaving Chromium's own
    // getDisplayMedia() promise hanging once the window - and the picker that
    // would have answered it - is gone. setDisplayMediaRequestHandler(null)
    // resets the slack session's handler to its default state (session.md).
    forceSettlePicker(null, false);
    session.fromPartition(PARTITIONS.slack).setDisplayMediaRequestHandler(null);
    // BaseWindow does not close its views' webContents (base-window.md, Resource management).
    for (const v of Object.values(views)) if (!v.webContents.isDestroyed()) v.webContents.close();
  });

  loadSplitter();
  loadOffline();
  loadPicker();
  views.slack.webContents.loadURL(slackUrl);
  // The dashboard itself is never loaded eagerly here: it loads on the first
  // up/degraded supervisor snapshot (loadDashboard, via onSupervisor). Until
  // that first tick lands, offlineVisible starts true, so the offline page -
  // never a blank dashboard pane - is what is shown.

  // the one place that reveals the window, shared by the normal
  // (non-hidden) launch, the tray's "Show window" / left-click, and a second
  // instance being launched while this one is already running - previously
  // three separate copies (this file's own show(), plus a duplicate
  // isMinimized/restore/show/focus in main.js for the other two), only one of
  // which ever applied the persisted maximized state.
  //
  // Reads writer.current().maximized (not the settings snapshot this window
  // was constructed with), so a maximize state that changed mid-session -
  // the user un-maximizing, or a later reconciliation - is never stale here.
  function showWindow() {
    if (win.isMinimized()) win.restore();
    if (writer.current().maximized) win.maximize();
    applyLayout();
    win.show();
    win.focus();
  }
  // A --hidden (launch-at-login) start: lay the panes out so the window is
  // ready the instant it is shown, but never call win.maximize() here - per
  // base-window.md, maximize() "will also show (but not focus) the window if
  // it isn't being displayed already", which is exactly what a hidden start
  // must not do. The persisted maximized flag is applied by showWindow()
  // itself instead, at the moment the window is actually revealed.
  function prepareHidden() { applyLayout(); }

  return {
    win, views, applyLayout, runShortcut,
    onSupervisor, retry, effectiveSnapshot,
    showWindow, prepareHidden,
    reloadAll() { views.dashboard.webContents.reload(); views.slack.webContents.reload(); },
    state: () => ({ ratio, slackVisible, swapped, focused, dragging, layout: lastLayout, offlineVisible, supervisor: supervisorSnap }),
  };
}
