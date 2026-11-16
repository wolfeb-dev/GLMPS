// web/shared/roster.js
// The live-sessions roster rail and the Projects navigator - moved out of
// the retired 1.x dashboard view module (D24, Task 14) so the two lenses
// that actually render them (web/observability/map.js's Surface graph
// panel, web/orchestration/board.js's Work kanban rail) share one copy
// instead of importing a 1.x view module that no longer exists.
// XSS discipline: all user/file/session data goes through
// textContent/createElement (via setText/el/chip below). innerHTML is not
// used; containers are emptied with clear().

import { getProjects, rebuildGraph, postTerminal, addBacklogItem } from './api.js';
import { sessionColor } from './session-color.js';
import { interactive } from './a11y.js';
import { setText, countsAsLive, clear } from './dom-util.js';
import { fleetDriftCount } from '../overview/workspace-view.js';

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

function buildScopeStrip(session, handlers) {
  const scope = session?.scope;
  if (!scope) return null;

  // The job card is a <button>, so we cannot nest another <button> inside it.
  // Use a div with role="button" + tabindex so it's keyboard-accessible.
  // onOpenMap is passed as interactive()'s onActivate (not a bare click binding)
  // so Enter/Space keydown calls it directly with the keydown event - keeping
  // stopPropagation working for both the click AND the keyboard path (it must
  // not bubble to the parent onOpenJob button or the roster row's own select).
  const strip = el('div', 'dash-scope');
  const openMap = (e) => {
    e.stopPropagation();          // don't bubble to the parent onOpenJob
    handlers?.onOpenMap?.(session.id);
  };
  interactive(strip, openMap, 'open code map');

  // Zone chips
  const zones = Array.isArray(scope.zones) ? scope.zones : [];
  for (const z of zones) {
    const envCls = z.env === 'prod' ? 'dash-zchip dash-zchip-prod' : 'dash-zchip dash-zchip-dev';
    const zchip = el('span', envCls);
    const nameSpan = el('span', 'dash-zname');
    setText(nameSpan, z.zone ?? '');
    zchip.appendChild(nameSpan);
    const countSpan = el('span', 'dash-zcount');
    setText(countSpan, String(z.count ?? 0));
    zchip.appendChild(countSpan);
    strip.appendChild(zchip);
  }

  // Guard pill. Fix round 1, M7: text carries the meaning (the class's
  // color is the reinforcement, same as the zone chips above), no emoji -
  // "prod safe"/"N in prod" read the same to a screen reader either way.
  const guardCls = scope.allDev ? 'dash-guard ok' : 'dash-guard warn';
  const guard = el('span', guardCls);
  if (scope.allDev) {
    setText(guard, 'prod safe');
  } else {
    const n = Array.isArray(scope.protected) ? scope.protected.length : 0;
    setText(guard, n + ' in prod');
  }
  strip.appendChild(guard);

  return strip;
}

//
// One compact capsule row per live session. Each row:
//   session-colored left border | dot | title | elapsed | step badge | agent
//   + a .dash-roster-scope slot for the scope strip (buildScopeStrip output)
// Single-click -> opts.onSelect(session); "open" control -> handlers.onOpenJob(id)
//
function _elapsedStr(lastTs) {
  if (!lastTs) return '';
  const sec = Math.floor((Date.now() - lastTs) / 1000);   // lastTs is epoch ms
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

const STAGE_NAMES = ['', 'Orchestrate', 'Execute', 'Adversarial', 'Gate', 'Learning'];

// Throttled poll of GET /api/workspace, same TTL idea as the project-nav fetch
// below: fillRoster reads the cached count synchronously (never blocks the
// per-SSE-tick roster rebuild on a network round trip) and this kicks a
// background refresh when the cache goes stale, patching the live badge
// in place once it lands.
let _driftCache = { count: 0, fetchedAt: 0, error: null };
const DRIFT_TTL_MS = 15_000;
function refreshDriftCount(rail) {
  const now = Date.now();
  if (now - _driftCache.fetchedAt < DRIFT_TTL_MS) return;
  _driftCache.fetchedAt = now;   // stamp before the request lands so concurrent ticks don't pile up fetches
  // an error response is a failure, not data - its body
  // has no sessions and used to read as a healthy "0 drifting".
  fetch('/api/workspace').then((r) => {
    if (!r.ok) throw new Error(`GET /api/workspace returned ${r.status}`);
    return r.json();
  }).then((data) => {
    _driftCache.count = fleetDriftCount(data?.sessions ?? []);
    _driftCache.error = null;
    paintDriftBadge(rail.querySelector('.dash-roster-drift'));
  // a background 15s poll, not a user action - toasting
  // every failed tick would spam the operator while the feed is down, but
  // the failure still gets a named reason instead of vanishing.
  }).catch((e) => {
    console.error('roster: drift count refresh failed', e);
    _driftCache.error = e?.message ?? String(e);
    paintDriftBadge(rail.querySelector('.dash-roster-drift'));
  });
}

// The badge says "drift unknown" (reason in its title) while the last poll
// failed, never a stale or fabricated count.
function paintDriftBadge(badge) {
  if (!badge) return;
  if (_driftCache.error) {
    setText(badge, 'drift unknown');
    badge.title = `Drift count unavailable: ${_driftCache.error}`;
    badge.classList.remove('has-drift');
    return;
  }
  setText(badge, `${_driftCache.count} drifting`);
  badge.title = '';
  badge.classList.toggle('has-drift', _driftCache.count > 0);
}

/**
 * Fill `rail` with the live-sessions roster.
 * opts: { onSelect(session), focusedId, includeEnded }. Both of dashboard.js's
 * former callers (web/observability/map.js's Surface graph panel, the only
 * one that still uses fillRoster today) always pass onSelect and focusedId;
 * there is no canvas here to flood with a module-level "focused session" the
 * way the retired dashboard.js's setFocusedSession did, so a caller that
 * omits onSelect simply gets a roster with no click behavior rather than a
 * broken fallback (deviation from the brief's literal helper list, recorded
 * in the task report).
 */
export function fillRoster(rail, state, handlers, opts = {}) {
  // Preserve the project-nav section across roster rebuilds: it lives in this
  // same rail, and clear() would tear it down every SSE tick (the cause
  // of the nav flicker). Detach the live node, rebuild the roster, then
  // re-attach the SAME node at the end so it is reused, not recreated.
  const navSection = rail.querySelector('.dash-nav-section');
  clear(rail);
  const onSelect = opts.onSelect ?? null;
  const focused = opts.focusedId ?? null;

  const hdr = el('div', 'dash-roster-header');
  const titleRow = el('div', 'dash-roster-title');
  const bar = el('span', '');
  bar.setAttribute('aria-hidden', 'true');
  titleRow.appendChild(bar);
  titleRow.appendChild(txt('Live sessions'));
  const sessions   = state?.sessions ?? [];
  // glmps-8b: this "Live sessions" roster is an active-work view
  // (drives the count badge below and the empty state), not the general
  // session history list, so internal sessions (tagged internal:true, not
  // removed from state.sessions) are excluded here via the shared
  // countsAsLive predicate.
  const liveSessions = sessions.filter(countsAsLive)
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  const countBadge = el('span', 'dash-roster-live-count');
  setText(countBadge, liveSessions.length > 0 ? `${liveSessions.length} active` : '0 active');
  titleRow.appendChild(countBadge);
  const driftBadge = el('span', 'dash-roster-drift');
  paintDriftBadge(driftBadge);
  titleRow.appendChild(driftBadge);
  hdr.appendChild(titleRow);
  rail.appendChild(hdr);
  refreshDriftCount(rail);

  const list = el('div', 'dash-roster-list');
  list.setAttribute('role', 'list');

  if (liveSessions.length === 0) {
    const empty = el('div', 'dash-roster-empty');
    setText(empty, 'No active sessions right now.');
    list.appendChild(empty);
  } else {
    for (const session of liveSessions) {
      const color = sessionColor(session.id);
      const loop  = session.loop ?? null;
      const stage = loop?.stage ?? null;
      const isFocused = session.id === focused;

      const row = el('div', `dash-roster-row${isFocused ? ' is-focused' : ''}`);
      row.setAttribute('role', 'listitem');
      row.style.setProperty('--session-color', color);
      row.setAttribute('aria-current', isFocused ? 'true' : 'false');

      // Click -> select this session.
      const select = () => { onSelect?.(session); };
      interactive(row, select, session.title ?? session.id ?? 'Untitled');
      row.setAttribute('role', 'listitem');   // interactive() defaults to role="button"; restore list semantics

      // Inner content
      const inner = el('div', 'dash-roster-inner');

      // Top row: dot + title + elapsed
      const top = el('div', 'dash-roster-top');
      const dot = el('span', 'dash-roster-dot');
      top.appendChild(dot);
      const titleEl = el('span', 'dash-roster-name');
      setText(titleEl, session.title ?? session.id ?? 'Untitled');
      top.appendChild(titleEl);
      const elapsed = el('span', 'dash-roster-elapsed');
      setText(elapsed, _elapsedStr(session.lastTs));
      top.appendChild(elapsed);
      inner.appendChild(top);

      // Meta row: step badge + agent name
      const meta = el('div', 'dash-roster-meta');
      if (stage != null) {
        const stepBadge = el('span', 'dash-roster-step');
        setText(stepBadge, STAGE_NAMES[stage] ?? `Step ${stage}`);
        meta.appendChild(stepBadge);
      }
      if (loop?.agent) {
        const agentEl = el('span', 'dash-roster-agent');
        setText(agentEl, loop.agent);
        meta.appendChild(agentEl);
      }
      inner.appendChild(meta);

      // Scope strip slot
      const scopeSlot = el('div', 'dash-roster-scope');
      const strip = buildScopeStrip(session, handlers);
      if (strip) scopeSlot.appendChild(strip);
      inner.appendChild(scopeSlot);

      row.appendChild(inner);

      // "open" control (navigates to Detail view)
      const openBtn = el('button', 'dash-roster-open');
      openBtn.type = 'button';
      openBtn.title = 'Open in Detail view';
      openBtn.setAttribute('aria-label', 'Open detail for ' + (session.title ?? session.id ?? ''));
      setText(openBtn, '\u2192');
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers?.onOpenJob?.(session.id);
      });
      row.appendChild(openBtn);

      list.appendChild(row);
    }
  }

  rail.appendChild(list);

  // Optional "Recent" section of ended sessions. Ended dots are static, they
  // don't pulse.
  //
  // glmps-8b: an internal session (GLMPS's
  // own worker spawn, e.g. the memory distiller's headless claude -p calls)
  // is excluded from liveSessions above, but while its process is still
  // genuinely running it is NOT `!s.live` either, so a plain `!s.live` filter
  // here made it satisfy neither bucket: invisible on this whole panel until
  // it finished. Silence is its own kind of lie ("tag, don't hide"), so a
  // still-running internal session is included here too, but WITHOUT the
  // is-ended class: that class's styling (dimmed opacity, frozen dot, "this
  // stopped" framing) would be a different false claim for a process that is
  // actually still alive. is-internal is its own honest, deprioritized
  // marker; a session that is BOTH internal and genuinely ended gets both
  // classes, since both facts are true at once.
  if (opts.includeEnded) {
    const ended = (state?.sessions ?? [])
      .filter(s => !countsAsLive(s) && s.format !== 'remote')
      .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
      .slice(0, 12);
    if (ended.length > 0) {
      const sub = el('div', 'dash-roster-subhead');
      setText(sub, 'Recent');
      rail.appendChild(sub);
      const elist = el('div', 'dash-roster-list');
      elist.setAttribute('role', 'list');
      for (const session of ended) {
        const sel = session.id === focused;
        const rowClasses = ['dash-roster-row'];
        if (!session.live) rowClasses.push('is-ended');
        if (session.internal) rowClasses.push('is-internal');
        if (sel) rowClasses.push('is-focused');
        const row = el('div', rowClasses.join(' '));
        row.setAttribute('role', 'listitem');
        row.style.setProperty('--session-color', sessionColor(session.id));
        const choose = () => { onSelect?.(session); };
        const label = (session.title ?? session.id ?? 'Untitled') + (session.internal ? ' (internal worker session)' : '');
        interactive(row, choose, label);
        row.setAttribute('role', 'listitem');   // interactive() defaults to role="button"; restore list semantics
        const inner = el('div', 'dash-roster-inner');
        const top = el('div', 'dash-roster-top');
        top.appendChild(el('span', 'dash-roster-dot'));
        const nameEl = el('span', 'dash-roster-name');
        setText(nameEl, session.title ?? session.id ?? 'Untitled');
        top.appendChild(nameEl);
        const elapsed = el('span', 'dash-roster-elapsed');
        setText(elapsed, _elapsedStr(session.lastTs));
        top.appendChild(elapsed);
        inner.appendChild(top);
        // Honest label, not just a color/opacity cue (accessibility: color/
        // dimming alone must not be the only indicator this row is different).
        if (session.internal) {
          const meta = el('div', 'dash-roster-meta');
          const badge = el('span', 'dash-roster-internal-badge');
          setText(badge, 'internal');
          badge.title = 'GLMPS worker session (e.g. memory distiller extraction), not a user session';
          meta.appendChild(badge);
          inner.appendChild(meta);
        }
        row.appendChild(inner);
        elist.appendChild(row);
      }
      rail.appendChild(elist);
    }
  }

  // Re-attach the preserved project-nav node so roster rebuilds reuse it
  // instead of recreating it (eliminates the per-tick flicker).
  if (navSection) rail.appendChild(navSection);
}

// Stable per-project accent derived from a simple hash of the key string.
// Returns one of the design-system accent hex values so pills pick up color.
const _NAV_COLORS = [
  '#4a8cd8', // info
  '#a878d8', // accent
  '#3fb87f', // success
  '#e0a23a', // warning
  '#d4a437', // primary
];
function _projectColor(key) {
  let h = 0;
  for (let i = 0; i < (key ?? '').length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return _NAV_COLORS[h % _NAV_COLORS.length];
}

let _navCache = null;   // { projects, terminals, fetchedAt }
const NAV_TTL_MS = 15_000;
let _navCollapsed = false;  // persists the Projects section collapsed/expanded state across rebuilds

/**
 * Build (or rebuild) the ".dash-nav-section" inside railEl.
 * Guard: if any quick-add input inside the existing nav has focus, skip the rebuild.
 * handlers: { onOpenProject } (optional, currently unused - rows are non-navigable stubs)
 */
export async function fillProjectNav(railEl, { onSelectProject = null, selectedProject = null } = {}) {
  // Early-out: don't disturb a section the user is mid-interaction with, and
  // skip the (cached) fetch when we'd bail anyway. The authoritative swap below
  // re-checks these guards at DOM-mutation time.
  const pre = railEl.querySelector('.dash-nav-section');
  if (pre) {
    const focused = document.activeElement;
    if (focused && pre.contains(focused) && focused.tagName === 'INPUT') return;
    if (pre.querySelector('.dash-nav-term-menu:not([hidden])')) return;
  }

  // Throttle network fetches: reuse cached data if it is less than NAV_TTL_MS old.
  let projects = [];
  let terminals = [];
  let failed = false;   // true when /api/projects could not be reached (server needs a restart)
  let cfgError = null;  // the reason /api/config failed, shown in place of the terminal buttons
  const now = Date.now();
  if (_navCache && (now - _navCache.fetchedAt) < NAV_TTL_MS) {
    projects  = _navCache.projects;
    terminals = _navCache.terminals;
  } else {
    let projOk = true;
    // both rejections are logged with their cause; the
    // config response is status-checked, and its failure is shown (the
    // terminal buttons would otherwise just never appear).
    const [projData, cfgData] = await Promise.all([
      getProjects().catch((e) => { console.error('roster: GET /api/projects failed', e); projOk = false; return { projects: [] }; }),
      fetch('/api/config').then((r) => {
        if (!r.ok) throw new Error(`GET /api/config returned ${r.status}`);
        return r.json();
      }).catch((e) => { console.error('roster: GET /api/config failed', e); cfgError = e?.message ?? String(e); return { terminals: [] }; }),
    ]);
    projects  = projData?.projects  ?? [];
    terminals = cfgData?.terminals  ?? [];
    // Only cache a successful fetch, so a failed one retries on the next tick.
    if (projOk && !cfgError) _navCache = { projects, terminals, fetchedAt: Date.now() };
    if (!projOk) failed = true;
  }

  // Skip the rebuild entirely when nothing visible changed. Combined with
  // fillRoster preserving the existing node, this kills the per-tick churn that
  // made the Projects list blank-and-reload every few seconds.
  const sig = JSON.stringify({
    s: selectedProject ?? null, c: _navCollapsed, f: failed, cf: cfgError,
    t: terminals.map((t) => t.label),
    p: projects.map((p) => [p.key, p.sessionCount, p.liveCount, p.lastTs, p.branch, p.backlogOpen, p.graph?.needsUpdate]),
  });
  const cur = railEl.querySelector('.dash-nav-section');
  if (cur && cur.dataset.navSig === sig) return;

  const section = el('div', 'dash-nav-section');
  section.dataset.navSig = sig;

  // Read module-level state so the collapsed position survives rebuilds.
  const hdr = el('div', 'dash-nav-header');

  const titleRow = el('div', 'dash-nav-title-row');
  const bar = el('span', 'dash-nav-accent-bar');
  bar.setAttribute('aria-hidden', 'true');
  titleRow.appendChild(bar);

  const titleTxt = el('span', 'dash-nav-title');
  setText(titleTxt, 'Projects');
  titleRow.appendChild(titleTxt);

  const countBadge = el('span', 'dash-roster-live-count dash-nav-count');
  setText(countBadge, String(projects.length));
  titleRow.appendChild(countBadge);

  const toggle = el('button', 'dash-nav-toggle');
  toggle.type = 'button';
  toggle.title = _navCollapsed ? 'Expand Projects' : 'Collapse Projects';
  toggle.setAttribute('aria-label', 'Toggle Projects section');
  setText(toggle, _navCollapsed ? '\u25B8' : '\u25BE');
  titleRow.appendChild(toggle);

  hdr.appendChild(titleRow);
  section.appendChild(hdr);

  const list = el('div', 'dash-nav-list');
  list.setAttribute('role', 'list');
  // Reflect persisted collapsed state immediately so the section renders correctly.
  if (_navCollapsed) list.style.display = 'none';

  // In select mode (Kanban), a leading "All projects" row clears the filter.
  if (onSelectProject) {
    const allSelected = selectedProject == null || selectedProject === 'all';
    const allRow = el('div', 'dash-roster-row dash-nav-row dash-nav-all dash-nav-selectable' + (allSelected ? ' is-focused' : ''));
    allRow.dataset.projKey = 'all'; // lets callers swap the active highlight in place (no re-render)
    allRow.setAttribute('role', 'listitem');
    const allInner = el('div', 'dash-roster-inner');
    const allTop = el('div', 'dash-roster-top');
    const allName = el('span', 'dash-roster-name');
    setText(allName, 'All projects');
    allTop.appendChild(allName);
    const allHint = el('span', 'dash-roster-elapsed');
    setText(allHint, 'show every ticket');
    allTop.appendChild(allHint);
    allInner.appendChild(allTop);
    allRow.appendChild(allInner);
    const selectAll = () => onSelectProject('all');
    interactive(allRow, selectAll, 'All projects');
    allRow.setAttribute('role', 'listitem');   // interactive() defaults to role="button"; restore list semantics
    list.appendChild(allRow);
  }

  for (const proj of projects) {
    const color = _projectColor(proj.key ?? proj.name ?? '');
    const isSelected = !!onSelectProject && selectedProject === (proj.key ?? proj.name);
    const row = el('div', 'dash-roster-row dash-nav-row' + (onSelectProject ? ' dash-nav-selectable' : '') + (isSelected ? ' is-focused' : ''));
    row.dataset.projKey = String(proj.key ?? proj.name ?? ''); // for in-place highlight swap
    row.setAttribute('role', 'listitem');
    row.style.setProperty('--session-color', color);

    const inner = el('div', 'dash-roster-inner');

    // Top line: name + last-activity elapsed
    const top = el('div', 'dash-roster-top');
    const nameEl = el('span', 'dash-roster-name');
    setText(nameEl, proj.name ?? proj.key ?? '');
    top.appendChild(nameEl);
    const elapsed = el('span', 'dash-roster-elapsed');
    setText(elapsed, _elapsedStr(proj.lastTs));
    top.appendChild(elapsed);
    inner.appendChild(top);

    // Pill row
    const meta = el('div', 'dash-roster-meta dash-nav-pills');

    // Session count
    const sessCount = proj.sessionCount ?? 0;
    meta.appendChild(chip('dash-roster-step', `${sessCount} sess`));

    // Live count - only if > 0
    if ((proj.liveCount ?? 0) > 0) {
      const liveP = chip('dash-roster-step dash-nav-pill-live', `${proj.liveCount} live`);
      meta.appendChild(liveP);
    }

    // Branch
    if (proj.branch) {
      meta.appendChild(chip('dash-roster-step', proj.branch));
    }

    // Backlog open count
    if ((proj.backlogOpen ?? 0) > 0) {
      meta.appendChild(chip('dash-roster-step dash-nav-pill-backlog', `${proj.backlogOpen} open`));
    }

    // Graph stale - clickable rebuild button
    if (proj.graph?.needsUpdate) {
      const staleBtn = el('button', 'dash-roster-step dash-nav-pill-stale dash-nav-pill-btn');
      staleBtn.type = 'button';
      setText(staleBtn, 'graph stale \u27F3');
      // Fix round 1, M8 / round 2, R2-1: the toast used to fire
      // unconditionally before the request even landed, and a failure left
      // the button stuck disabled on "rebuilding..." forever. rebuildGraph now
      // rejects on a real failure (api.js), but the real route also answers
      // 200 with a non-empty `skipped` array when this root's rebuild was
      // already in flight - that is not success (nothing was rebuilt) and
      // not a thrown error either, so it needs its own branch. A single-root
      // request only ever produces at most one skipped entry (its own).
      staleBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        staleBtn.disabled = true;
        setText(staleBtn, 'rebuilding\u2026');
        try {
          const result = await rebuildGraph(proj.path);
          if (result?.skipped?.length > 0) {
            staleBtn.disabled = false;
            setText(staleBtn, 'graph stale \u27F3');
            window.dispatchEvent(new CustomEvent('mc-toast', { detail: `The graph for ${proj.key} is already rebuilding.` }));
            return;
          }
          window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Rebuilding graph for ' + proj.key + '\u2026' }));
        } catch (err) {
          staleBtn.disabled = false;
          setText(staleBtn, 'graph stale \u27F3');
          window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Could not rebuild the graph for ${proj.key}: ${err.message}` }));
        }
      });
      meta.appendChild(staleBtn);
    } else if ((proj.graph?.nodes ?? 0) === 0) {
      // No graph yet - offer to build one
      const buildBtn = el('button', 'dash-roster-step dash-nav-pill-build dash-nav-pill-btn');
      buildBtn.type = 'button';
      setText(buildBtn, 'build graph \u27F3');
      buildBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        buildBtn.disabled = true;
        setText(buildBtn, 'building\u2026');
        try {
          const result = await rebuildGraph(proj.path);
          if (result?.skipped?.length > 0) {
            buildBtn.disabled = false;
            setText(buildBtn, 'build graph \u27F3');
            window.dispatchEvent(new CustomEvent('mc-toast', { detail: `The graph for ${proj.key} is already rebuilding.` }));
            return;
          }
          window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Rebuilding graph for ' + proj.key + '\u2026' }));
        } catch (err) {
          buildBtn.disabled = false;
          setText(buildBtn, 'build graph \u27F3');
          window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Could not build the graph for ${proj.key}: ${err.message}` }));
        }
      });
      meta.appendChild(buildBtn);
    }

    inner.appendChild(meta);

    if (terminals.length > 0) {
      const termWrap = el('div', 'dash-nav-term-wrap');

      const termBtn = el('button', 'dash-nav-term-btn');
      termBtn.type = 'button';
      termBtn.title = 'Open terminal in this project';
      setText(termBtn, '>_');
      termWrap.appendChild(termBtn);

      const menu = el('div', 'dash-nav-term-menu');
      menu.setAttribute('role', 'menu');
      menu.hidden = true;

      for (const t of terminals) {
        const item = el('button', 'dash-nav-term-item');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        setText(item, t.label ?? t.command ?? '');
        const termLabel = t.label ?? t.command ?? '';
        const projPath  = proj.path ?? '';
        // toast only after the request actually succeeds,
        // not before it has even been sent; a failure gets its own named
        // toast instead of silently vanishing under "queued".
        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          menu.hidden = true;
          try {
            await postTerminal({ terminal: termLabel, cwd: projPath });
            window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Terminal request queued' }));
          } catch (err) {
            window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Terminal request failed: ${err.message}` }));
          }
        });
        menu.appendChild(item);
      }

      termBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.hidden) {
          menu.hidden = false;
          // Add a one-shot outside-click listener each time the menu opens.
          // Using { once: true } ensures it self-removes after one firing so
          // listeners do not accumulate across renders.
          setTimeout(() => {
            document.addEventListener('click', () => { menu.hidden = true; }, { once: true, capture: false });
          }, 0);
        } else {
          menu.hidden = true;
        }
      });

      termWrap.appendChild(menu);
      top.appendChild(termWrap);   // sits on the title line, not its own row (compact)
    }

    const qaWrap = el('div', 'dash-nav-qa-wrap');
    const qaInput = el('input', 'dash-nav-qa-input');
    qaInput.type = 'text';
    qaInput.placeholder = 'File a ticket\u2026';
    qaInput.setAttribute('aria-label', `File a ticket for ${proj.name ?? proj.key ?? ''}`);
    const projKey = proj.key ?? proj.name ?? '';
    // the input used to clear and toast "Ticket filed"
    // unconditionally, before the POST even resolved - a failure lost the
    // operator's typed text AND claimed success. Clear and toast success
    // only once filed; on failure the text stays in the box (nothing to
    // retype) and the toast names the real reason.
    qaInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const val = qaInput.value.trim();
        if (!val) return;
        qaInput.disabled = true;
        try {
          // addBacklogItem now rejects on a real failure
          // itself (api.js), so there is no success-shaped { error } to
          // check for here any more.
          await addBacklogItem({ project: projKey, title: val });
          qaInput.value = '';
          window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Ticket filed' }));
        } catch (err) {
          window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Could not file the ticket: ${err.message}` }));
        } finally {
          qaInput.disabled = false;
        }
      }
    });
    qaWrap.appendChild(qaInput);
    inner.appendChild(qaWrap);

    row.appendChild(inner);

    // Select mode: clicking the row body (not the terminal/quick-add controls)
    // filters the Kanban board to this project.
    if (onSelectProject) {
      const projKeySel = proj.key ?? proj.name ?? '';
      row.addEventListener('click', (e) => {
        if (e.target.closest('.dash-nav-term-wrap, .dash-nav-qa-wrap')) return;
        onSelectProject(projKeySel, proj);
      });
      // Keyboard layer only - the click binding above already handles both
      // real clicks and (via el.click() from Enter/Space) this synthetic one;
      // its e.target.closest() guard still resolves correctly since a
      // synthetic click's target is the row itself.
      interactive(row, undefined, proj.name ?? proj.key ?? '');
      row.setAttribute('role', 'listitem');   // interactive() defaults to role="button"; restore list semantics
    }

    list.appendChild(row);
  }

  if (projects.length === 0) {
    const empty = el('div', 'dash-roster-empty');
    setText(empty, failed
      ? 'Projects unavailable. Restart the server to enable the project list.'
      : 'No projects found.');
    list.appendChild(empty);
  }
  if (cfgError) {
    const note = el('div', 'dash-roster-empty');
    note.setAttribute('role', 'status');
    setText(note, `Terminal buttons unavailable: ${cfgError}.`);
    list.appendChild(note);
  }

  section.appendChild(list);

  // Collapse toggle - writes back to module-level _navCollapsed so state
  // survives the next rebuild (fillProjectNav reads it when rebuilding).
  toggle.addEventListener('click', () => {
    _navCollapsed = !_navCollapsed;
    list.style.display = _navCollapsed ? 'none' : '';
    setText(toggle, _navCollapsed ? '\u25B8' : '\u25BE');
    toggle.title = _navCollapsed ? 'Expand Projects' : 'Collapse Projects';
  });

  // Atomic swap - synchronous, no await between read and mutate, so two
  // concurrent fillProjectNav calls (e.g. a view re-render racing an SSE tick)
  // cannot both append. Remove EVERY existing section, which also self-heals any
  // duplicates that slipped in before this guard existed. Re-check the
  // focus/flyout guards here since state may have changed during the await.
  const existings = [...railEl.querySelectorAll('.dash-nav-section')];
  const focusedNow = document.activeElement;
  for (const ex of existings) {
    if (focusedNow && ex.contains(focusedNow) && focusedNow.tagName === 'INPUT') return;
    if (ex.querySelector('.dash-nav-term-menu:not([hidden])')) return;
  }
  existings.forEach((e) => e.remove());
  railEl.appendChild(section);
}
