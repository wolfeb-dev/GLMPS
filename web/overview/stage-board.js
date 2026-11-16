// web/overview/stage-board.js - Stage Board view: 6-column pipeline board
// (Orchestrate, Execute, Adversarial, Gate, Commit, Learning) with one
// trajectory row per live session.
//
// Faithful port of the locked, screenshot-approved mockup variant H
// ("Hybrid stage board") - web/mockups/overview-redesign.html, search
// "===== H hybrid". Markup/CSS/JS there use sb-*/hcol/pcol classes; this file
// reproduces that look using the shared `state.board` data model built by
// server/lib/observability/stage-board.js (see buildBoard()).
//
// Two-entry-point pattern:
//   renderStageBoard(container, handlers) - first mount, builds the static
//     shell once (including the animated sparkline bars, so their CSS
//     keyframe animation never restarts on refresh).
//   updateStageBoard(state, handlers) - every SSE tick, patches text/rebuilds
//     the per-session rows from fresh state.
//
// XSS rule: all user/file/session data goes through textContent/createElement
// (via setText/el/chip below). innerHTML is not used; containers are emptied with clear().

import { setText, clear } from '../shared/dom-util.js';
import { interactive } from '../shared/a11y.js';
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { getState } from '../shared/api.js';
import { openFileDiff } from '../shared/file-actions.js';
import { closeDiffPopup } from '../shared/diff-popup.js';
// Pure derived logic lives in stage-board-calc.js so it can be tested
// (glmps-148). Import it rather than restating it here.
import {
  truncateText, fmtElapsed, toneOf,
  qaCountOf, qaSubLabel, fmtQaCount,
  TREND_FIELD, TREND_WARN_ON_UP, computeDelta,
} from './stage-board-calc.js';
import { buildDeltaChip, setDeltaChip } from './trend-render.js';

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function txt(s) { return document.createTextNode(String(s ?? '')); }
function chip(cls, label) {
  const c = el('span', cls);
  setText(c, label);
  return c;
}
// Shortens long user/session-derived text for a chip/tile label, e.g. a raw
// session prompt or an alert title. Always textContent'd by the caller - this
// only shortens the string, it never touches the DOM. Callers that truncate
// should also set the full string as the element's `title` attribute.
// (truncateText now lives in stage-board-calc.js.)
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag) { return document.createElementNS(NS, tag); }
function svgAttr(node, attrs) { for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; }
function iconSvg(pathD) {
  const svg = svgAttr(svgEl('svg'), { class: 'sb-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.appendChild(svgAttr(svgEl('path'), { d: pathD }));
  return svg;
}

const BOARD_STAGES = [
  { key: 'orchestrate', name: 'Orchestrate', ico: 'M4 6h16M4 12h16M4 18h10',                          colorVar: '--st-orch' },
  { key: 'execute',     name: 'Execute',     ico: 'M8 6l6 6-6 6',                                      colorVar: '--st-exec' },
  { key: 'adversarial', name: 'Adversarial', ico: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z',         colorVar: '--st-adv' },
  { key: 'gate',        name: 'Gate',        ico: 'M5 12l4 4L19 6',                                     colorVar: '--st-gate' },
  { key: 'commit',      name: 'Commit',      ico: 'M3 12h6M15 12h6M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',  colorVar: '--st-commit' },
  { key: 'learning',    name: 'Learning',    ico: 'M12 20a8 8 0 1 0-8-8',                               colorVar: '--st-learn' },
];
const COMMIT_COL = 4; // 0-indexed board column for Commit - git-derived, never a "current" position

function scVar(colorVar) { return `var(${colorVar}, var(--primary))`; }

// A tile keeps its value and delta and draws no spark. `filterable`: click
// toggles the module-level session-list filter (Uncommitted, At gate/review). Stalled is filterable too as of glmps-151, but it is built by
// buildStalledTile() rather than from this table.
const VITALS = [
  { key: 'uncommitted', label: 'Uncommitted',      filterable: true },
  { key: 'followups',   label: 'Follow-ups',       filterable: false },
  { key: 'gate',        label: 'At gate/review',   filterable: true },
];

let _container = null;
const _stageEls = new Map(); // key -> { name, cnt, det }
const _vitalEls = new Map(); // key -> { vv, vs, tile, delta, ... } (shape varies per tile)
// Row-2 poller (Budget/Alerts/Queue: not in the SSE state payload, fetched
// separately). Interval id lives at module scope so a re-mount (renderStageBoard
// called again) can clear the old one before starting a new one - otherwise
// every mount would leave its own setInterval running forever underneath.
let _pollTimer = null;
// GET /api/vitals-trends?window=2h points, oldest first; folded into the same
// 30s poller (see pollVitals), never a second timer. [] means "no data yet" -
// covers the endpoint not existing (Step 2's server half not merged as of
// this writing), a fetch failure, or a genuinely empty store; every consumer
// below treats that the same way: no delta, no sparkline, no console noise.
let _trendPoints = [];
// Click-to-filter state (docs/superpowers/specs/2026-07-22-vitals-trends-design.md
// Step 2): UI-only, module-level, cleared on reload/remount, never persisted.
// Filtering never changes what a tile counts - only which session rows render
// below. `_lastBoard`/`_lastHandlers` let a filter click re-render the body
// immediately instead of waiting for the next SSE tick.
const _cards = new Map(); // session id -> { id, title } from /api/state sessions
let _filterKey = null; // 'active' | 'uncommitted' | 'gate' | null
let _lastBoard = null;
let _lastHandlers = null;
// glmps-150 (Capture click-through): the full per-adapter capture-health detail
// (which adapters degraded and why) lives in state.adapterHealth, already on the
// client in the /api/state payload. board.vitals.capture only carries the count
// + worst adapter, so we stash the full map here each tick to feed the Capture
// tile's toggleable detail popover.
let _adapterHealth = {};
let _captureOpen = false;
let _captureDocBound = false;

// fmtElapsed / toneOf now live in stage-board-calc.js.

function gbadge(git) {
  if (!git) return null;
  if ((git.dirty ?? 0) > 0) return chip('sb-gbadge sb-dirty', `\u25CF ${git.dirty} dirty`);
  if ((git.ahead ?? 0) > 0) return chip('sb-gbadge sb-ahead', `\u2191${git.ahead} unpushed`);
  return chip('sb-gbadge sb-clean', '\u2713 clean');
}

// Built once at mount time - negative animation-delay staggers each bar's
// phase without restarting the loop on every render.
function buildSpark(sc) {
  const spark = el('div', 'sb-spark');
  for (let i = 0; i < 10; i++) {
    const bar = document.createElement('i');
    bar.style.background = sc;
    bar.style.animationDelay = `${(i * -0.24).toFixed(2)}s`;
    spark.appendChild(bar);
  }
  return spark;
}

function buildStageHead() {
  const head = el('div', 'sb-head');
  const corner = el('div', 'sb-corner');
  setText(corner, 'Sessions \u2193');
  head.appendChild(corner);

  const stages = el('div', 'sb-stages');
  for (const bs of BOARD_STAGES) {
    const sc = scVar(bs.colorVar);
    const stage = el('div', 'sb-stage');
    stage.style.setProperty('--sc', sc);

    const sh = el('div', 'sb-sh');
    const nodeMini = el('span', 'sb-node-mini');
    nodeMini.appendChild(iconSvg(bs.ico));
    sh.appendChild(nodeMini);

    const nameEl = el('span', 'sb-name');
    setText(nameEl, bs.name);
    sh.appendChild(nameEl);

    const cntEl = el('span', 'sb-cnt');
    cntEl.id = `sb-cnt-${bs.key}`;
    setText(cntEl, '0');
    sh.appendChild(cntEl);
    stage.appendChild(sh);

    const detEl = el('div', 'sb-detail');
    detEl.id = `sb-det-${bs.key}`;
    stage.appendChild(detEl);

    stage.appendChild(buildSpark(sc));
    stages.appendChild(stage);

    _stageEls.set(bs.key, { name: nameEl, cnt: cntEl, det: detEl });
  }
  head.appendChild(stages);
  return head;
}

function updateStageHead(board) {
  const stages = Array.isArray(board?.stages) ? board.stages : [];
  for (const bs of BOARD_STAGES) {
    const refs = _stageEls.get(bs.key);
    if (!refs) continue;
    const data = stages.find((s) => s.key === bs.key);
    setText(refs.name, data?.name ?? bs.name);
    setText(refs.cnt, String(data?.count ?? 0));
    setText(refs.det, data?.detail ?? '');
  }
}

// Eight tiles. Five are sourced from board.vitals, computed server-side by
// buildVitals() in server/lib/observability/stage-board.js (see
// docs/superpowers/specs/2026-07-22-vitals-trends-design.md Step 1):
// Uncommitted, Follow-ups, At gate/review, Stalled, Capture. The other three
// are QA health (its own /api/qa-trends fetch) and Alerts / Queue, fed by data
// outside the SSE payload (polled - see startVitalsPoller). The live count and
// the 5h budget are the topbar's alone (card glmps-2-0-137 phase 2), so they
// have no tile here. All tiles share the .sb-vtile chrome + value/label/sub
// anatomy so the ribbon reads as one system.
function buildVitals(handlers) {
  const wrap = el('div', 'sb-vitals');
  for (const v of VITALS) {
    const cls = ['sb-vtile'];
    if (v.filterable) cls.push('sb-vt-clickable');
    const tile = el('div', cls.join(' '));
    tile.id = `sb-vtile-${v.key}`;

    const host = tile;
    const vvRow = el('div', 'sb-vt-vv-row');
    const vv = el('div', 'sb-vv');
    setText(vv, '0');
    const delta = buildDeltaChip();
    vvRow.appendChild(vv);
    vvRow.appendChild(delta.wrap);
    const vl = el('div', 'sb-vl');
    setText(vl, v.label);
    const vs = el('div', 'sb-vs');
    host.appendChild(vvRow);
    host.appendChild(vl);
    host.appendChild(vs);

    if (v.filterable) {
      tile.setAttribute('aria-pressed', 'false');
      interactive(tile, () => toggleFilter(v.key), `${v.label}: filter the session list below`);
    }

    wrap.appendChild(tile);
    _vitalEls.set(v.key, { vv, vs, tile, delta });
  }
  wrap.appendChild(buildQaTile(handlers));
  wrap.appendChild(buildAlertsTile());
  wrap.appendChild(buildQueueTile(handlers));
  wrap.appendChild(buildStalledTile());
  wrap.appendChild(buildCaptureTile());
  return wrap;
}

// Renders the five state-backed vital tiles (Uncommitted, Follow-ups,
// At gate/review, Stalled, Capture) from `board.vitals`, computed server-side
// by buildVitals() in server/lib/observability/stage-board.js (see
// docs/superpowers/specs/2026-07-22-vitals-trends-design.md Step 1). This
// function only renders - it tolerates board.vitals being absent (older
// server, or a payload mid-upgrade) by falling back to zeros/placeholders
// instead of throwing.
function updateVitals(board) {
  const v = board?.vitals ?? null;

  const uncommitted = _vitalEls.get('uncommitted');
  if (uncommitted) {
    const u = v?.uncommitted ?? null;
    const count = u?.count ?? 0;
    setText(uncommitted.vv, String(count));
    let sub;
    if (u?.worst) {
      const dirty = u.worst.dirty ?? 0;
      sub = `${u.worst.project || '\u2013'}, ${dirty} file${dirty === 1 ? '' : 's'}`;
    } else {
      const dirtyFiles = u?.dirtyFiles ?? 0;
      sub = `${dirtyFiles} file${dirtyFiles === 1 ? '' : 's'}`;
    }
    setText(uncommitted.vs, sub);
    uncommitted.tile.classList.toggle('sb-vt-warn', count > 0);
  }

  const followupsTile = _vitalEls.get('followups');
  if (followupsTile) {
    const count = v?.followups?.count ?? 0;
    setText(followupsTile.vv, String(count));
    setText(followupsTile.vs, count > 0 ? 'to triage' : 'none open');
  }

  const gate = _vitalEls.get('gate');
  if (gate) {
    const g = v?.gate ?? null;
    const count = g?.count ?? 0;
    const longestMs = g?.longestMs ?? null;
    setText(gate.vv, String(count));
    // An unknown wait (a gate row with no loop.enteredTs) drops the duration
    // rather than printing "0s": a fabricated zero here would say "just
    // arrived" about a session that may have been parked for an hour.
    const waited = fmtElapsed(longestMs);
    setText(gate.vs, count === 0 ? 'none waiting' : (waited ? `waiting ${waited}` : 'waiting'));
    gate.tile.classList.toggle('sb-vt-warn', (longestMs ?? 0) > 15 * 60_000);
  }

  const stalled = _vitalEls.get('stalled');
  if (stalled) {
    const s = v?.stalled ?? null;
    const count = s?.count ?? 0;
    const oldestMs = s?.oldestMs ?? null;
    setText(stalled.vv, String(count));
    setText(stalled.vs, count > 0 ? `oldest ${fmtElapsed(oldestMs) ?? '0s'}` : 'all fresh');
    stalled.tile.classList.toggle('sb-vt-warn', count > 0);
  }

  const capture = _vitalEls.get('capture');
  if (capture) {
    const c = v?.capture ?? null;
    const degraded = c?.degraded ?? 0;
    setText(capture.vv, String(degraded));
    if (degraded > 0 && c?.worst) {
      const { adapter, reason } = c.worst;
      const reasonFull = String(reason ?? 'unknown reason');
      setText(capture.vs, `${adapter}: ${truncateText(reasonFull, 40)}`);
      capture.vs.title = `${adapter}: ${reasonFull}`;
    } else {
      setText(capture.vs, 'all adapters healthy');
      capture.vs.removeAttribute('title');
    }
    capture.tile.classList.toggle('sb-vt-warn', degraded > 0);
  }
}

// Stalled deliberately has NO `interactive()` wiring: buildBoard()'s rows
// (server/lib/observability/stage-board.js) carry no per-row stalled signal -
// stalled is derived from the raw `sessions` list's `live`+`lastTs`, which
// never reaches board.rows. Inventing a row-level proxy (e.g. "not live")
// would silently misclassify. See FINDINGS in the Step 2 handoff report.
function buildStalledTile() {
  const tile = el('div', 'sb-vtile');
  tile.id = 'sb-vtile-stalled';
  const vvRow = el('div', 'sb-vt-vv-row');
  const vv = el('div', 'sb-vv');
  setText(vv, '0');
  const delta = buildDeltaChip();
  vvRow.appendChild(vv);
  vvRow.appendChild(delta.wrap);
  const vl = el('div', 'sb-vl');
  setText(vl, 'Stalled');
  const vs = el('div', 'sb-vs');
  tile.appendChild(vvRow);
  tile.appendChild(vl);
  tile.appendChild(vs);
  // glmps-151: now filterable like the other flow tiles. It could not be before,
  // because rows carried no stall signal - the rule lived only in buildVitals,
  // which reads raw session summaries the client never receives.
  tile.setAttribute('aria-pressed', 'false');
  interactive(tile, () => toggleFilter('stalled'), 'Stalled: filter the session list below');
  _vitalEls.set('stalled', { vv, vs, tile, delta });
  return tile;
}

function buildCaptureTile() {
  const tile = el('div', 'sb-vtile sb-vt-clickable sb-vt-capture');
  tile.id = 'sb-vtile-capture';
  const vvRow = el('div', 'sb-vt-vv-row');
  const vv = el('div', 'sb-vv');
  setText(vv, '0');
  const delta = buildDeltaChip();
  vvRow.appendChild(vv);
  vvRow.appendChild(delta.wrap);
  const vl = el('div', 'sb-vl');
  setText(vl, 'Capture');
  const vs = el('div', 'sb-vs');
  tile.appendChild(vvRow);
  tile.appendChild(vl);
  tile.appendChild(vs);

  // glmps-150: click-through detail. Which adapters are degraded and why is
  // already on the client in state.adapterHealth, so the Capture tile toggles an
  // anchored popover listing them rather than deep-linking to a brand-new view.
  // Clicks inside the popover must not bubble to the tile (that would toggle it
  // shut); aria-expanded/aria-controls pair the button with the panel.
  const detail = el('div', 'sb-cap-detail hidden');
  detail.id = 'sb-cap-detail';
  detail.setAttribute('role', 'region');
  detail.setAttribute('aria-label', 'Capture adapter health');
  detail.addEventListener('click', (ev) => ev.stopPropagation());
  tile.appendChild(detail);

  tile.setAttribute('aria-expanded', 'false');
  tile.setAttribute('aria-controls', 'sb-cap-detail');
  interactive(tile, (ev) => toggleCaptureDetail(ev), 'Capture: show which adapters are degraded');
  bindCaptureDismiss();

  _vitalEls.set('capture', { vv, vs, tile, delta, detail });
  return tile;
}

// glmps-150: Capture popover open/close + render. The panel lists every degraded
// adapter (id, miss count, last drift reason, how long ago) from _adapterHealth,
// or a healthy empty state. It re-renders live while open (updateStageBoard).
function toggleCaptureDetail(ev) {
  if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
  _captureOpen = !_captureOpen;
  applyCaptureOpen();
}
function applyCaptureOpen() {
  const refs = _vitalEls.get('capture');
  if (!refs?.detail) return;
  refs.detail.classList.toggle('hidden', !_captureOpen);
  refs.tile.setAttribute('aria-expanded', String(_captureOpen));
  if (_captureOpen) renderCaptureDetail();
}
function renderCaptureDetail() {
  const refs = _vitalEls.get('capture');
  if (!refs?.detail) return;
  const panel = refs.detail;
  panel.replaceChildren(); // clear without innerHTML (XSS rule)
  const heading = el('div', 'sb-cap-detail-h');
  setText(heading, 'Capture adapter health');
  panel.appendChild(heading);

  const degraded = Object.entries(_adapterHealth || {})
    .filter(([, h]) => h && h.degraded)
    .sort((a, b) => (b[1]?.misses ?? 0) - (a[1]?.misses ?? 0));

  if (!degraded.length) {
    const ok = el('div', 'sb-cap-empty');
    setText(ok, 'All capture adapters healthy.');
    panel.appendChild(ok);
    return;
  }

  const list = el('ul', 'sb-cap-list');
  for (const [id, h] of degraded) {
    const row = el('li', 'sb-cap-row');
    const rowH = el('div', 'sb-cap-row-h');
    const name = el('span', 'sb-cap-name');
    setText(name, id);
    const misses = h?.misses ?? 0;
    rowH.appendChild(name);
    rowH.appendChild(chip('sb-cap-misses', `${misses} miss${misses === 1 ? '' : 'es'}`));
    row.appendChild(rowH);

    const reason = el('div', 'sb-cap-reason');
    setText(reason, h?.lastReason || 'shape drift (no reason recorded)');
    row.appendChild(reason);

    const ago = h?.lastMissTs ? fmtElapsed(Date.now() - h.lastMissTs) : null;
    const seen = el('div', 'sb-cap-seen');
    setText(seen, ago ? `last drift ${ago} ago` : 'last drift time unknown');
    row.appendChild(seen);

    list.appendChild(row);
  }
  panel.appendChild(list);
}
// Close on outside-click or Escape. Bound once (guarded) because renderStageBoard
// rebuilds the Capture tile on every remount. Tile/panel clicks stopPropagation,
// so this document listener only ever sees genuine outside clicks.
function bindCaptureDismiss() {
  if (_captureDocBound) return;
  _captureDocBound = true;
  document.addEventListener('click', () => {
    if (!_captureOpen) return;
    _captureOpen = false;
    applyCaptureOpen();
  });
  document.addEventListener('keydown', (ev) => {
    if (_captureOpen && ev.key === 'Escape') {
      _captureOpen = false;
      applyCaptureOpen();
    }
  });
}

// These three come from endpoints that are NOT part of the SSE state payload
// (GET /api/budget, /api/alerts, /api/backlog), so they get their own fetch
// loop: once on mount, then every 30s. A failed fetch leaves the tile's value
// at the en-dash placeholder with a short explanatory sub - it never fabricates
// a number.
function fetchJson(url) {
  return fetch(url).then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${url} ${res.status}`))));
}

// Sets a "<number>" + muted-unit value line (shared by QA "tests" and Budget
// "%"), baseline-aligned so the numeral reads at the same weight as a bare
// .sb-vv. En dash is the house "no value" placeholder.
function setUnitValue(vv, value, unit, fmt) {
  clear(vv);
  vv.appendChild(txt(value == null ? '\u2013' : (fmt ? fmt(value) : String(value))));
  if (value != null) vv.appendChild(chip('sb-vt-unit', unit));
}


// Alert deep-link resolution mirrors evaluation/alerts.js's "Go to source"
// button (the same mechanism the topbar alert pill's target resolution runs
// through): dispatch `mc-navigate` with the alert's own target view/id when
// it has one, otherwise fall back to the generic Alerts view - app.js's
// window listener resolves either through the same VIEW_REDIRECTS table
// (e.g. the retired 'alerts' name lands on Loop > Signals).
function buildAlertsTile() {
  const tile = el('div', 'sb-vtile sb-vt-clickable');
  tile.id = 'sb-vtile-alerts';
  const vvRow = el('div', 'sb-vt-vv-row');
  const vv = el('div', 'sb-vv');
  setText(vv, '\u2013');
  const delta = buildDeltaChip();
  vvRow.appendChild(vv);
  vvRow.appendChild(delta.wrap);
  const vl = el('div', 'sb-vl');
  setText(vl, 'Open alerts');
  const vs = el('div', 'sb-vs');
  setText(vs, 'Loading\u2026');
  tile.appendChild(vvRow);
  tile.appendChild(vl);
  tile.appendChild(vs);

  let topAlert = null;
  interactive(tile, () => {
    const view = topAlert?.target?.view || 'alerts';
    const sessionId = topAlert?.target?.id || null;
    window.dispatchEvent(new CustomEvent('mc-navigate', { detail: { view, sessionId, target: topAlert?.target ?? null } }));
  }, 'Open alerts: jump to the top alert');

  const refs = { tile, vv, vs, delta, setTop: (a) => { topAlert = a; } };
  _vitalEls.set('alerts', refs);
  return tile;
}

function renderAlertsTile(data) {
  const refs = _vitalEls.get('alerts');
  if (!refs) return;
  const { tile, vv, vs, setTop } = refs;
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  setText(vv, String(alerts.length));
  const top = alerts[0] ?? null;
  setTop(top);
  if (!alerts.length) {
    setText(vs, 'none open');
    vs.removeAttribute('title');
    tile.classList.remove('sb-vt-warn', 'sb-vt-bad');
    return;
  }
  const fullTitle = String(top?.title ?? '(untitled alert)');
  setText(vs, truncateText(fullTitle, 40));
  vs.title = fullTitle;
  const bad = alerts.some((a) => a?.severity === 'error' || a?.severity === 'critical');
  const warn = !bad && alerts.some((a) => a?.severity === 'warn');
  tile.classList.toggle('sb-vt-bad', bad);
  tile.classList.toggle('sb-vt-warn', warn);
}

function renderAlertsTileError() {
  const refs = _vitalEls.get('alerts');
  if (!refs) return;
  setText(refs.vv, '\u2013');
  setText(refs.vs, 'alerts unavailable');
  refs.vs.removeAttribute('title');
  refs.tile.classList.remove('sb-vt-warn', 'sb-vt-bad');
  refs.setTop(null);
}

function buildQueueTile(handlers) {
  const tile = el('div', 'sb-vtile sb-vt-split sb-vt-clickable');
  tile.id = 'sb-vtile-queue';

  const stack = el('div', 'sb-vt-stack');
  const vvRow = el('div', 'sb-vt-vv-row');
  const vv = el('div', 'sb-vv');
  setText(vv, '\u2013');
  const delta = buildDeltaChip();
  vvRow.appendChild(vv);
  vvRow.appendChild(delta.wrap);
  const vl = el('div', 'sb-vl');
  setText(vl, 'Queue');
  const vs = el('div', 'sb-vs');
  setText(vs, 'Loading\u2026');
  stack.appendChild(vvRow);
  stack.appendChild(vl);
  stack.appendChild(vs);
  tile.appendChild(stack);

  interactive(tile, () => handlers?.onNavigate?.('kanban'), 'Queue: open the Kanban board');

  const refs = { tile, vv, vs, delta };
  _vitalEls.set('queue', refs);
  return tile;
}

function renderQueueTile(data) {
  const refs = _vitalEls.get('queue');
  if (!refs) return;
  // GET /api/backlog?counts=1: the tile needs three numbers, and this polls
  // every 30 s, so it never pulls the multi-megabyte item list.
  const counts = data?.counts ?? {};
  const queued = counts.queued ?? 0, held = counts.held ?? 0, blocked = counts.blocked ?? 0;
  setText(refs.vv, String(queued));
  setText(refs.vs, blocked > 0 ? `${blocked} blocked` : (held > 0 ? `${held} held` : 'nothing blocked'));
}

function renderQueueTileError() {
  const refs = _vitalEls.get('queue');
  if (!refs) return;
  setText(refs.vv, '\u2013');
  setText(refs.vs, 'queue unavailable');
}

// Step 2 of docs/superpowers/specs/2026-07-22-vitals-trends-design.md.
// GET /api/vitals-trends?window=2h, fetched by the SAME 30s poller as
// Budget/Alerts/Queue above (see pollVitals) - never a second timer. Record
// shape: { ts, active, uncommitted, dirtyFiles, followups, atGate, stalled,
// degradedAdapters, budgetPct, alerts, queued }, oldest first, null for any
// field unknown at sample time. That endpoint's server half (the store + the
// route) is being built concurrently and is NOT merged as of this writing, so
// this 404s while both halves land - onTrendPointsUnavailable degrades to
// "no delta, no sparkline" with no console noise, and it lights up on its own
// once the route exists (Promise.allSettled already isolates this fetch's
// failure from the other three).

function renderTrendDeltas() {
  for (const [key, field] of Object.entries(TREND_FIELD)) {
    const refs = _vitalEls.get(key);
    if (!refs?.delta) continue;
    setDeltaChip(refs.delta, computeDelta(_trendPoints, field), TREND_WARN_ON_UP.has(key));
  }
}

function onTrendPoints(data) {
  _trendPoints = Array.isArray(data?.points) ? data.points : [];
  renderTrendDeltas();
}

function onTrendPointsUnavailable() {
  _trendPoints = [];
  renderTrendDeltas();
}

// Predicates mirror server/lib/observability/stage-board.js's buildVitals()
// rules exactly (uncommitted: committed === false; gate: stage 3 or 4) so a
// filtered view always matches what the corresponding tile counted. `active`
// matches every row - clicking it still toggles pressed/shows "showing N of
// N", per the design doc's literal "click Active sessions" filter target.
// `stalled` reads the row flag rather than recomputing a gap from lastTs: the
// server already applied the threshold in buildBoard using the same isStalled()
// the tile's count uses, so the filtered rows and the count cannot drift
// (glmps-151). Recomputing here would reintroduce exactly that risk.
const FILTER_PREDICATES = {
  active: () => true,
  uncommitted: (r) => r.committed === false,
  gate: (r) => r.stage === 3 || r.stage === 4,
  stalled: (r) => r.stalled === true,
};

function toggleFilter(key) {
  _filterKey = _filterKey === key ? null : key;
  for (const [k, refs] of _vitalEls) {
    if (!refs?.tile?.hasAttribute?.('aria-pressed')) continue;
    refs.tile.setAttribute('aria-pressed', String(_filterKey === k));
  }
  updateBody(_lastBoard, _lastHandlers);
}

async function pollVitals() {
  await Promise.allSettled([
    fetchJson('/api/alerts').then(renderAlertsTile).catch(renderAlertsTileError),
    fetchJson('/api/backlog?counts=1').then(renderQueueTile).catch(renderQueueTileError),
    fetchJson('/api/vitals-trends?window=2h').then(onTrendPoints).catch(onTrendPointsUnavailable),
  ]);
}

// Called once per mount, after buildVitals() has created the tile refs.
// renderStageBoard() clears any previous timer before calling this, so
// re-mounting the view never stacks duplicate 30s pollers.
function startVitalsPoller() {
  pollVitals();
  _pollTimer = setInterval(pollVitals, 30_000);
}

const baseName = (p) => String(p ?? '').split(/[/\\]/).pop();

/** The file named by a bubble's "editing <file>" text, or null (e.g. "editing files", skill labels). */
export function bubbleFile(doing) {
  const m = /^editing (\S.*)$/.exec(String(doing ?? '').trim());
  return m && m[1] !== 'files' ? m[1] : null;
}

/** Newest write event that carries a change and whose path (or label) is this file. */
export function findWriteForFile(events, file) {
  if (!file || !Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.op !== 'write' || !ev.change) continue;
    if (baseName(ev.path ?? ev.label) === file) return ev;
  }
  return null;
}

/** Newest Surface edit row (GET /api/surface/edits) for this session and file, or null. */
export function findEditForFile(edits, sessionId, file) {
  let best = null;
  for (const e of Array.isArray(edits) ? edits : []) {
    if (e?.sessionId !== sessionId || baseName(e.path) !== file || !e.repo || !e.rel) continue;
    if (!best || (e.ts ?? 0) > (best.ts ?? 0)) best = e;
  }
  return best;
}

// Claude Code edit events carry no change, so the session's own events rarely
// have one. The working tree against its upstream is the same diff the Surface
// edits window shows; it exists only for files inside a tracked repository.
async function gitChangeFor(sessionId, file) {
  const r = await fetch('/api/surface/edits');
  if (!r.ok) return null;
  const edit = findEditForFile((await r.json())?.edits, sessionId, file);
  if (!edit) return null;
  const d = await fetch(`/api/surface/file-diff?repo=${encodeURIComponent(edit.repo)}&path=${encodeURIComponent(edit.rel)}`);
  if (!d.ok) return null;
  const body = await d.json();
  return body?.change ? { path: edit.path, change: body.change } : null;
}

const toast = (msg) => window.dispatchEvent(new CustomEvent('mc-toast', { detail: String(msg) }));

// The popup lives on document.body, so the per-tick body rebuild never tears
// it down; _diffOpen lets updateBody close it only when its row stops showing
// that file. The shared popup owns Escape; outside click is ours (one listener).
let _diffOpen = null;
let _diffSeq = 0;
let _diffOutside = null;

function dropDiffOutside() {
  if (_diffOutside) { document.removeEventListener('click', _diffOutside, true); _diffOutside = null; }
}
function closeBubbleDiff() { _diffOpen = null; _diffSeq++; dropDiffOutside(); closeDiffPopup(); }

const liveFileBtn = (sessionId) => [...(_container?.querySelectorAll('.sb-filebtn') ?? [])].find((b) => b.dataset.sessionId === sessionId) ?? null;

async function openBubbleDiff(sessionId, file, anchor) {
  const seq = ++_diffSeq;
  let data;
  try { data = await getState(sessionId); }
  catch (e) { if (seq === _diffSeq) toast(`Could not load the events of ${sessionId} for the diff of ${file}: ${e?.message ?? e}`); return; }
  if (seq !== _diffSeq) return;
  let ev = findWriteForFile(data?.events, file);
  if (!ev) {
    try { ev = await gitChangeFor(sessionId, file); }
    catch (e) { console.error(`git diff of ${file} failed`, e); }
    if (seq !== _diffSeq) return;
  }
  const at = liveFileBtn(sessionId) ?? anchor;
  const popup = openFileDiff(at, { path: ev?.path ?? file, change: ev?.change ?? null, label: file });
  if (!ev) {
    const note = el('div', 'diff-empty');
    setText(note, `No recorded change to ${file}: the session did not capture one and the file is outside every tracked repository.`);
    popup.appendChild(note);
  }
  _diffOpen = { sessionId, file };
  dropDiffOutside();
  _diffOutside = (e) => {
    if (e.target?.closest?.('.diff-popup') || e.target?.closest?.('.sb-filebtn')) return;
    closeBubbleDiff();
  };
  document.addEventListener('click', _diffOutside, true);
}

function fileButton(row, file) {
  const b = el('button', 'sb-filebtn');
  b.type = 'button';
  b.dataset.sessionId = row.id;
  b.setAttribute('aria-label', `Show the diff of ${file}`);
  setText(b, file);
  // The row is itself an activatable item; keep this click and its Enter/Space
  // from also opening the session.
  b.addEventListener('keydown', (ev) => ev.stopPropagation());
  b.addEventListener('click', (ev) => { ev.stopPropagation(); openBubbleDiff(row.id, file, b); });
  return b;
}

function buildPop(row, cxPct) {
  const pop = el('div', 'sb-pop');
  pop.style.left = `clamp(106px, ${cxPct}%, calc(100% - 106px))`;

  const tone = toneOf(row.elapsedMs);
  const phaseLabel = row.phase?.label ?? row.stageName ?? '\u2014';
  const phaseDoing = row.phase?.doing ?? null;

  const r1 = el('div', 'sb-pr');
  r1.appendChild(chip('sb-phase', phaseLabel));
  const elapsedTxt = fmtElapsed(row.elapsedMs);
  const elapsedCls = tone === 'fresh' ? 'sb-mono' : `sb-mono sb-${tone}`;
  r1.appendChild(chip(elapsedCls, elapsedTxt ? `${elapsedTxt} here` : '\u2014'));
  pop.appendChild(r1);

  if (phaseDoing) {
    const r2 = el('div', 'sb-pr');
    const file = row.id ? bubbleFile(phaseDoing) : null;
    if (file) {
      const doing = el('span', 'sb-mono sb-muted');
      doing.appendChild(txt('editing '));
      doing.appendChild(fileButton(row, file));
      r2.appendChild(doing);
    } else r2.appendChild(chip('sb-mono sb-muted', phaseDoing));
    pop.appendChild(r2);
  }

  const r3 = el('div', 'sb-pr');
  const gb = gbadge(row.git);
  if (gb) r3.appendChild(gb);
  if ((row.followups ?? 0) > 0) r3.appendChild(chip('sb-bkbadge', `+${row.followups}`));
  if (r3.childNodes.length) pop.appendChild(r3);

  return pop;
}

// Trajectory dot state for board column `col` (0-indexed) given a session row.
function dotClasses(row, col) {
  if (col === COMMIT_COL) {
    if (row.committed === true) return ['sb-stn', 'sb-done'];
    if (row.committed === false) return ['sb-stn', 'sb-commit-dirty'];
    return ['sb-stn']; // unknown -> hollow
  }
  const pos0 = (row.stage ?? 1) - 1;
  if (col < pos0) return ['sb-stn', 'sb-done'];
  if (col === pos0) {
    const cls = ['sb-stn', 'sb-here'];
    const tone = toneOf(row.elapsedMs);
    if (tone === 'aging') cls.push('sb-aging');
    if (tone === 'old') cls.push('sb-old');
    return cls;
  }
  return ['sb-stn'];
}

function buildTrack(row) {
  const pos0 = (row.stage ?? 1) - 1;
  const f = pos0 / 5;
  const cxPct = (((pos0 + 0.5) / 6) * 100).toFixed(2);

  const track = el('div', 'sb-track');
  track.style.setProperty('--f', String(f));

  for (let col = 0; col < 6; col++) {
    const isCur = col === pos0;
    const colEl = el('div', isCur ? 'sb-col sb-cur' : 'sb-col');
    const stn = el('span', dotClasses(row, col).join(' '));
    colEl.appendChild(stn);
    if (isCur) colEl.appendChild(el('span', 'sb-cx'));
    track.appendChild(colEl);
  }
  track.appendChild(buildPop(row, cxPct));
  return track;
}

function buildSessionRow(row, handlers) {
  const rowEl = el('div', 'sb-row');

  const idCol = el('div', 'sb-id');
  const proj = el('div', 'sb-proj');
  const card = _cards.get(row.id);
  const cardTitle = card?.title ? truncateText(card.title, 48) : null;
  setText(proj, cardTitle || row.project || '\u2014');
  if (cardTitle && cardTitle !== card.title) proj.title = card.title;
  idCol.appendChild(proj);

  const sub = el('div', 'sb-sub');
  if (card?.id) {
    sub.appendChild(chip('sb-card-id', card.id));
    sub.appendChild(txt(' \u00B7 '));
  }
  sub.appendChild(chip('sb-mono', row.tool ?? '\u2014'));
  if (row.git?.branch) {
    sub.appendChild(txt(' \u00B7 '));
    sub.appendChild(chip('', row.git.branch));
  }
  idCol.appendChild(sub);
  rowEl.appendChild(idCol);

  rowEl.appendChild(buildTrack(row));

  if (row.id) {
    rowEl.classList.add('sb-clickable');
    bindItem(rowEl, {
      type: 'session', id: row.id,
      link: linkFor({ lens: 'session', sessionId: row.id }),
      open: () => (handlers.onOpenJob ?? handlers.onOpenSession)?.(row.id), label: `Session ${row.id}`,
    });
  }
  return rowEl;
}

function updateBody(board, handlers) {
  const body = _container?.querySelector('.sb-body');
  if (!body) return;
  // The rebuild below replaces every file button; keep keyboard focus on the
  // same session's button.
  const focusedId = document.activeElement?.classList?.contains('sb-filebtn') ? document.activeElement.dataset.sessionId : null;
  clear(body);
  const allRows = Array.isArray(board?.rows) ? [...board.rows] : [];
  allRows.sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0));

  // Click-to-filter (see toggleFilter): filters only which rows render here,
  // never what any tile counts - the tiles above always read board.vitals
  // for the whole fleet, untouched by _filterKey.
  const predicate = _filterKey ? FILTER_PREDICATES[_filterKey] : null;
  const rows = predicate ? allRows.filter(predicate) : allRows;

  if (predicate) {
    const info = el('div', 'sb-filter-info');
    setText(info, `showing ${rows.length} of ${allRows.length}`);
    body.appendChild(info);
  }

  if (!rows.length) {
    if (_diffOpen) closeBubbleDiff();
    const empty = el('div', 'sb-empty');
    // "no match" only when the filter actually excluded something - an empty
    // board stays "no active sessions" even while a filter is pressed.
    setText(empty, (predicate && allRows.length) ? 'No sessions match this filter.' : 'No active sessions.');
    body.appendChild(empty);
    return;
  }
  for (const row of rows) body.appendChild(buildSessionRow(row, handlers));
  if (focusedId) liveFileBtn(focusedId)?.focus();
  if (_diffOpen && !rows.some((r) => r.id === _diffOpen.sessionId && bubbleFile(r.phase?.doing) === _diffOpen.file)) closeBubbleDiff();
}

// Compact summary of GET /api/qa-trends (server/lib/observability/qa-trends-store.js,
// docs/superpowers/specs/2026-07-14-qa-trends-design.md): "is QA healthy right now
// and which way is it trending" at a glance, click-through to the full panel
// (/qa-trends). Fetched once per mount (QA data changes on CI-run cadence, not
// per SSE tick, so this does not re-fetch on every updateStageBoard() call).
// Lives in the top vitals row as a fifth tracking tile, so it wears the same
// .sb-vtile anatomy as the other four: value / label / sub.
// fmtQaCount now lives in stage-board-calc.js.

// CI-source points are the ground-truth "is CI healthy" signal (a local run has
// no conclusion). Prefer the newest CI point for the badge/current numbers;
// fall back to the newest point of ANY source so the tile still shows a real
// test count when only local runs exist, rather than going fully blank.
function pickQaLatest(points) {
  const ci = points.filter((p) => p?.source === 'ci');
  const latest = ci.length ? ci[ci.length - 1] : (points.length ? points[points.length - 1] : null);
  return { latest, hasCi: ci.length > 0 };
}

function qaBadgeState(conclusion) {
  if (conclusion === 'success') return 'good';
  if (conclusion === 'failure') return 'bad';
  return 'muted';
}

// qaCountOf now lives in stage-board-calc.js. It distinguishes "the sampler
// could not parse that run" from a real zero; see that module for why.

// trendFieldOf and qaSubLabel now live in stage-board-calc.js.

// Fills the tile from a fetched /api/qa-trends payload. Handles three states
// distinctly (never fabricates a value): no data at all, data but no CI-source
// point yet (local-only), and a real CI-backed reading.
function renderQaTileBody(refs, points) {
  const { tile, vv, vs } = refs;
  if (!points.length) {
    setUnitValue(vv, null, 'tests');
    setText(vs, 'No QA data yet');
    vs.classList.remove('sb-vt-sub-good', 'sb-vt-sub-bad');
    tile.classList.remove('sb-vt-bad');
    return;
  }

  const { latest, hasCi } = pickQaLatest(points);
  const state = hasCi ? qaBadgeState(latest.conclusion) : 'muted';

  // The verdict comes from the newest CI point, but its count may be null (an
  // unparsed run). Fall back to the newest point that does have a count so the
  // tile keeps showing the last known suite size instead of blanking to the
  // placeholder while the sub-line still reads "CI passing".
  const counted = [...points].reverse().find((p) => qaCountOf(p) != null);
  setUnitValue(vv, counted ? qaCountOf(counted) : null, 'tests', fmtQaCount);
  setText(vs, qaSubLabel(hasCi, state, latest));
  // Colour is never the only signal here: the sub-line spells the verdict out.
  vs.classList.toggle('sb-vt-sub-good', state === 'good');
  vs.classList.toggle('sb-vt-sub-bad', state === 'bad');
  tile.classList.toggle('sb-vt-bad', state === 'bad');
}

function buildQaTile(handlers) {
  const tile = el('div', 'sb-vtile sb-qatile sb-vt-split sb-vt-clickable');
  tile.id = 'sb-vtile-qa';

  const stack = el('div', 'sb-vt-stack');
  const vv = el('div', 'sb-vv sb-vt-vv-unit');
  setUnitValue(vv, null, 'tests');
  const vl = el('div', 'sb-vl');
  setText(vl, 'QA health');
  // The sub-line always carries text (loading / empty / verdict), so the row
  // reserves its height from first paint and never jumps when the fetch lands.
  const vs = el('div', 'sb-vs');
  setText(vs, 'Loading\u2026');
  stack.appendChild(vv);
  stack.appendChild(vl);
  stack.appendChild(vs);
  tile.appendChild(stack);

  interactive(tile, () => handlers?.onNavigate?.('qa-trends'), 'QA health: open the QA Trends panel');

  const refs = { tile, vv, vs };
  fetch('/api/qa-trends')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`qa-trends ${res.status}`))))
    .then((data) => renderQaTileBody(refs, Array.isArray(data?.points) ? data.points : []))
    .catch(() => {
      setUnitValue(vv, null, 'tests');
      setText(vs, 'QA data unavailable');
    });

  return tile;
}

// First mount: build the static shell once (stage headers + sparklines are
// fixed here so their CSS animation never restarts on refresh).
export function renderStageBoard(container, handlers) {
  // Clear any poller left running from a previous mount BEFORE rebuilding the
  // shell, so re-mounting this view never stacks duplicate 30s timers.
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _container = container;
  _stageEls.clear();
  _vitalEls.clear();
  // UI-only state, cleared on every remount (design doc: never persisted).
  _filterKey = null;
  _lastBoard = null;
  _lastHandlers = null;
  _captureOpen = false; // glmps-150: popover state never persists across remount
  _trendPoints = [];
  clear(container);

  container.appendChild(buildVitals(handlers));
  startVitalsPoller();

  const grid = el('div', 'sb-grid');

  const boardCard = el('div', 'sb-boardcard');
  boardCard.appendChild(buildStageHead());
  boardCard.appendChild(el('div', 'sb-body'));
  grid.appendChild(boardCard);


  container.appendChild(grid);
}

// Lens unmount (D-surface): stop the 30 s vitals poller and drop the container
// so a hidden Surface never keeps polling.
export function unmountStageBoard() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_diffOpen) closeBubbleDiff();
  _container = null;
}

// Every SSE tick: patch vitals + stage headers, rebuild the session rows and
// nothing else. Vitals (Uncommitted/
// Follow-ups/At gate/review/Stalled/Capture) arrive pre-computed on
// state.board.vitals (server/lib/observability/stage-board.js buildVitals());
// this file only renders them. Budget/Alerts/Queue patch on their own 30s
// poll instead (see pollVitals).
export function updateStageBoard(state, handlers) {
  if (!_container) return;
  const board = state?.board ?? { stages: [], rows: [] };
  // Cached so a filter-tile click (toggleFilter) can re-render the body
  // immediately instead of waiting for the next SSE tick.
  _lastBoard = board;
  _lastHandlers = handlers;
  _cards.clear();
  for (const sess of state?.sessions ?? []) if (sess?.id && sess.card) _cards.set(sess.id, sess.card);
  // glmps-150: stash the full per-adapter capture-health map for the Capture
  // popover (board.vitals only carries the count + worst adapter).
  _adapterHealth = state?.adapterHealth ?? {};
  updateVitals(board);
  updateStageHead(board);
  updateBody(board, handlers);
  if (_captureOpen) renderCaptureDetail(); // keep an open popover live on each tick
}
