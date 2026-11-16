// web/observability/history.js
import { getStateFields, search, resume } from '../shared/api.js';
import { toolColorClass, badgeText } from '../shared/grid.js';
import { interactive } from '../shared/a11y.js';
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { setText, cwdLastSeg, countsAsLive, clear } from '../shared/dom-util.js';

// the toast-text decision pulled out of doResume's
// closure so it is testable without a DOM harness. `result` is resume()'s
// resolved body on success (null on failure); `error` is the thrown Error
// on failure (resume() now throws on a non-2xx response with the server's
// own error text - see api.js). A cwd fallback (the session's folder no
// longer exists, the server opened its own cwd instead) is named rather
// than looking like an ordinary success.
export function resumeToast(result, error) {
  if (error || !result) return error?.message || 'Resume failed';
  // Fix round 1, m6: a service-mode kernel answers launched: 'queued'
  // instead of opening anything - naming that is the whole point of the
  // launch queue being visible rather than looking like silence.
  if (result.launched === 'queued') return result.client ? `Queued: ${result.clientName || result.client} will open it` : 'Queued: the desktop shell will open it';
  if (result.cwdFallback) return `Resume opened in ${result.cwd}: the session's folder no longer exists`;
  if (result.launched === 'antigravity') return 'Resume opened in Antigravity';
  return 'Resume opened in a new terminal';
}

// Same shape for the "Open workspace" button (Antigravity sessions cannot
// be resumed, so it opens the folder in the IDE instead). Same (result,
// error) calling convention as resumeToast, and the same cwdFallback
// contract: a requested cwd the server could not use is named rather than
// looking like an ordinary success (pre-step (a), Task 12b review).
export function workspaceToast(result, error) {
  if (error || !result) return error?.message || 'Resume failed';
  // the workspace route never queues through the broker
  // (it calls spawnEditorApp directly, never launchNative, and a
  // service-mode kernel now refuses it outright with a named 409 instead -
  // handled by the error branch above). The 'queued' branch fix round 1
  // added here was dead code; removed rather than left as a trap for a
  // state this route can never actually produce.
  if (result.opened === 'queued') return `Queued: ${result.clientName || result.client || 'the client'} will open the workspace`;
  if (result.cwdFallback) return `Opened workspace in ${result.cwd}: the session's folder no longer exists`;
  return 'Opening workspace in Antigravity (conversation resume not supported)';
}

function relTime(ts) {
  if (ts == null) return '';
  if (!Number.isFinite(ts)) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  let diff = Date.now() - ms;
  diff = Math.max(0, diff);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Prefer a stamped worktree.parent (glmps-71) over the cwd's own last segment,
// which for a worktree-isolated session's cwd would be the worktree dir itself
// (e.g. "session-abc123") - fragmenting it out of its real project's history.
function projectOf(entry) {
  const parent = entry?.worktree && typeof entry.worktree.parent === 'string' ? entry.worktree.parent : '';
  return parent || cwdLastSeg(entry?.cwd);
}

function applyFilters(history, sessions, filters) {
  const { project, tool, dateRange, skillQ } = filters;
  const now = Date.now();

  return history.filter(h => {
    // project filter
    if (project !== 'all') {
      if (projectOf(h) !== project) return false;
    }
    // tool filter
    if (tool !== 'all') {
      if (h.tool !== tool) return false;
    }
    // date filter - live sessions skip date filter (they're pinned).
    // glmps-8b: an internal session (GLMPS's own worker
    // spawn) does not count as live here either, or it would be permanently
    // pinned above the date filter regardless of age.
    const isLive = sessions.some(s => s.id === h.id && countsAsLive(s));
    if (!isLive && dateRange !== 'all') {
      const days = dateRange === '7' ? 7 : 30;
      const cutoff = now - days * 86400 * 1000;
      const ts = h.lastTs < 1e12 ? h.lastTs * 1000 : h.lastTs;
      if (ts < cutoff) return false;
    }
    // skill text filter
    if (skillQ) {
      const q = skillQ.toLowerCase();
      const match = (h.skillsUsed ?? []).some(sk => sk.toLowerCase().includes(q));
      if (!match) return false;
    }
    return true;
  });
}

function buildFilters(history, filtersState, toolDisplayNames = {}) {
  const bar = document.createElement('div');
  bar.className = 'hist-filters';

  // Project select
  const projectSel = document.createElement('select');
  projectSel.className = 'hist-select';
  const allProj = document.createElement('option');
  allProj.value = 'all';
  setText(allProj, 'All projects');
  projectSel.appendChild(allProj);
  const projects = [...new Set(history.map(h => projectOf(h)).filter(Boolean))].sort();
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p;
    setText(opt, p);
    projectSel.appendChild(opt);
  }
  projectSel.value = filtersState.project;

  // Tool select
  const toolSel = document.createElement('select');
  toolSel.className = 'hist-select';
  const allToolsOpt = document.createElement('option');
  allToolsOpt.value = 'all';
  setText(allToolsOpt, 'All tools');
  toolSel.appendChild(allToolsOpt);
  // Dynamically build from distinct tools in history
  const distinctTools = [...new Set(history.map(h => h.tool).filter(Boolean))].sort();
  for (const toolId of distinctTools) {
    const opt = document.createElement('option');
    opt.value = toolId;
    setText(opt, toolDisplayNames[toolId] ?? toolId);
    toolSel.appendChild(opt);
  }
  toolSel.value = filtersState.tool;

  // Date select
  const dateSel = document.createElement('select');
  dateSel.className = 'hist-select';
  for (const [val, label] of [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']]) {
    const opt = document.createElement('option');
    opt.value = val;
    setText(opt, label);
    dateSel.appendChild(opt);
  }
  dateSel.value = filtersState.dateRange;

  // Skill input
  const skillInput = document.createElement('input');
  skillInput.type = 'text';
  skillInput.className = 'hist-input';
  skillInput.placeholder = 'Filter by skill\u2026';
  skillInput.value = filtersState.skillQ;

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'hist-input hist-search';
  searchInput.placeholder = 'Full-text search\u2026';

  // Placeholders vanish on input and the selects have no visible label, so
  // each control carries its own name and a form field name.
  for (const [c, name, label] of [[projectSel, 'project', 'Filter by project'], [toolSel, 'tool', 'Filter by tool'], [dateSel, 'date', 'Filter by date'], [skillInput, 'skill', 'Filter by skill'], [searchInput, 'q', 'Search session transcripts']]) {
    c.name = `hist-${name}`;
    c.setAttribute('aria-label', label);
  }
  bar.setAttribute('role', 'search');
  bar.setAttribute('aria-label', 'Session history');
  bar.appendChild(projectSel);
  bar.appendChild(toolSel);
  bar.appendChild(dateSel);
  bar.appendChild(skillInput);
  bar.appendChild(searchInput);

  return { bar, projectSel, toolSel, dateSel, skillInput, searchInput };
}

function buildSkillChips(skillsUsed) {
  const wrap = document.createElement('div');
  wrap.className = 'skill-chips';
  const skills = skillsUsed ?? [];
  const shown = skills.slice(0, 3);
  for (const sk of shown) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-skill';
    setText(chip, sk.split(':').pop() ?? sk);
    wrap.appendChild(chip);
  }
  if (skills.length > 3) {
    const more = document.createElement('span');
    more.className = 'chip chip-more';
    setText(more, `+${skills.length - 3}`);
    more.title = skills.slice(3).join(', ');
    wrap.appendChild(more);
  }
  if (skills.length > 0) {
    wrap.title = skills.join(', ');
  }
  return wrap;
}

function buildResumeMenu(entry, handlers, menuCleanups) {
  // Container for button + popup
  const wrap = document.createElement('div');
  wrap.className = 'resume-wrap';
  wrap.style.position = 'relative';

  const btn = document.createElement('button');
  btn.className = 'hist-action-btn';
  setText(btn, 'Resume \u25BE');

  let menuEl = null;

  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function openMenu(e) {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }

    menuEl = document.createElement('div');
    menuEl.className = 'resume-menu';

    const items = [
      ['In a new terminal', () => doResume('terminal')],
      ['Copy command', () => {
        handlers.onCopy(`claude --resume ${entry.id}`);
        closeMenu();
      }],
    ];

    for (const [label, action] of items) {
      const row = document.createElement('div');
      row.className = 'resume-menu-row';
      setText(row, label);
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        action();
      });
      interactive(row);
      menuEl.appendChild(row);
    }

    wrap.appendChild(menuEl);
  }

  async function doResume(location) {
    closeMenu();
    try {
      const result = await resume(entry.id, entry.cwd, location);
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: resumeToast(result) }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: resumeToast(null, e) }));
    }
  }

  btn.addEventListener('click', openMenu);
  wrap.appendChild(btn);

  // Track for cleanup
  menuCleanups.push(closeMenu);

  return { wrap, closeMenu };
}

function buildTableRow(entry, sessions, handlers, menuCleanups) {
  const row = document.createElement('div');
  row.className = 'hist-row';

  // glmps-8b: an internal session should not read as "live" here
  // either (the pulsing dot + "live" label + Live group, same as the topstats
  // header and the Live/Ended split in buildTable below).
  const isLive = sessions.some(s => s.id === entry.id && countsAsLive(s));
  if (isLive) row.classList.add('hist-row-live');

  // Title
  const titleEl = document.createElement('div');
  titleEl.className = 'hist-col hist-col-title';
  setText(titleEl, entry.title ?? entry.id.slice(0, 8));

  // Project
  const projectEl = document.createElement('div');
  projectEl.className = 'hist-col';
  const seg = projectOf(entry);
  setText(projectEl, seg);
  if (entry.cwd) projectEl.title = entry.cwd;

  // Tool badge
  const toolEl = document.createElement('div');
  toolEl.className = 'hist-col';
  const badge = document.createElement('span');
  const badgeColor = toolColorClass(entry.tool);
  badge.className = 'tool-badge' + (badgeColor !== 'muted' ? ' tool-badge-' + badgeColor : '');
  setText(badge, badgeText(entry.tool));
  toolEl.appendChild(badge);

  // Last activity
  const timeEl = document.createElement('div');
  timeEl.className = 'hist-col hist-col-time';
  if (isLive) {
    const dot = document.createElement('span');
    dot.className = 'status-dot working';
    dot.title = 'live';
    timeEl.appendChild(dot);
    const liveLabel = document.createElement('span');
    setText(liveLabel, ' live');
    timeEl.appendChild(liveLabel);
  } else {
    setText(timeEl, relTime(entry.lastTs));
  }

  // Skills
  const skillsEl = document.createElement('div');
  skillsEl.className = 'hist-col hist-col-skills';
  skillsEl.appendChild(buildSkillChips(entry.skillsUsed));

  // Actions: only controls whose action differs from "open the session" -
  // opening it is now the row's own click (bindItem below), so a plain
  // "Open" button here would be a second control that does the same thing.
  const actionsEl = document.createElement('div');
  actionsEl.className = 'hist-col hist-col-actions';

  if (entry.tool === 'claude-code') {
    const { wrap } = buildResumeMenu(entry, handlers, menuCleanups);
    actionsEl.appendChild(wrap);
  } else if (entry.tool === 'antigravity') {
    const wsBtn = document.createElement('button');
    wsBtn.className = 'hist-action-btn';
    setText(wsBtn, 'Open workspace');
    wsBtn.addEventListener('click', async (e) => {
      e.stopPropagation(); // a distinct action from opening the session - the row's click must not also fire
      try {
        const result = await resume(entry.id, entry.cwd, 'workspace');
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: workspaceToast(result) }));
      } catch (e) {
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: workspaceToast(null, e) }));
      }
    });
    actionsEl.appendChild(wsBtn);
  }

  row.appendChild(titleEl);
  row.appendChild(projectEl);
  row.appendChild(toolEl);
  row.appendChild(timeEl);
  row.appendChild(skillsEl);
  row.appendChild(actionsEl);

  bindItem(row, {
    type: 'session', id: entry.id,
    link: linkFor({ lens: 'session', sessionId: entry.id }),
    open: () => (handlers.onOpenJob ?? handlers.onOpenSession)?.(entry.id), label: `Session ${entry.id}`,
  });

  return row;
}

function buildTableHeader() {
  const row = document.createElement('div');
  row.className = 'hist-row hist-header';
  for (const label of ['Title', 'Project', 'Tool', 'Last activity', 'Skills', 'Actions']) {
    const cell = document.createElement('div');
    cell.className = 'hist-col hist-col-hd';
    setText(cell, label);
    row.appendChild(cell);
  }
  return row;
}

export const RECORD_PAGE = 50;

export function recordPage(total, shown) {
  const from = Math.min(shown, total);
  const to = Math.min(from + RECORD_PAGE, total);
  return { from, to, rest: total - to };
}

function buildTable(filtered, sessions, handlers, menuCleanups, { recent = 0 } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'hist-table';

  wrap.appendChild(buildTableHeader());

  // glmps-8b: same exclusion as buildTableRow/applyFilters above,
  // so an internal session lands in the Ended group here too, consistently.
  const live = filtered.filter(h => sessions.some(s => s.id === h.id && countsAsLive(s)));
  const ended = filtered.filter(h => !sessions.some(s => s.id === h.id && countsAsLive(s)));

  if (live.length > 0) {
    const liveLabel = document.createElement('div');
    liveLabel.className = 'hist-group-label hist-group-live';
    setText(liveLabel, 'Live');
    wrap.appendChild(liveLabel);
    for (const entry of live) {
      wrap.appendChild(buildTableRow(entry, sessions, handlers, menuCleanups));
    }
  }

  if (ended.length > 0) {
    if (live.length > 0) {
      const endedLabel = document.createElement('div');
      endedLabel.className = 'hist-group-label';
      setText(endedLabel, 'Ended');
      wrap.appendChild(endedLabel);
    }
    // Work > History marks the most recently ended sessions (card
    // glmps-2-0-137 story 30): they lead under their own label, the rest page in below.
    if (recent > 0) {
      const lead = ended.slice(0, recent);
      const label = document.createElement('div');
      label.className = 'hist-group-label hist-group-recent';
      setText(label, `Last ${lead.length} ended`);
      wrap.appendChild(label);
      for (const entry of lead) {
        const row = buildTableRow(entry, sessions, handlers, menuCleanups);
        row.classList.add('hist-row-recent');
        wrap.appendChild(row);
      }
      ended.splice(0, recent);
      if (ended.length > 0) {
        const earlier = document.createElement('div');
        earlier.className = 'hist-group-label';
        setText(earlier, 'Earlier');
        wrap.appendChild(earlier);
      }
    }
  }

  if (ended.length > 0) {
    // The full record runs to thousands of sessions; rendering them all at
    // once is what pushed the page past 16,000 nodes (glmps-2-0-63).
    let shown = 0;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'hist-more';
    const showNext = () => {
      const page = recordPage(ended.length, shown);
      for (const entry of ended.slice(page.from, page.to)) wrap.insertBefore(buildTableRow(entry, sessions, handlers, menuCleanups), more);
      shown = page.to;
      more.hidden = page.rest === 0;
      setText(more, `Show ${Math.min(RECORD_PAGE, page.rest)} more of ${page.rest}`);
    };
    more.addEventListener('click', showNext);
    wrap.appendChild(more);
    showNext();
  }

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hist-empty';
    setText(empty, 'No sessions match the current filters.');
    wrap.appendChild(empty);
  }

  return wrap;
}

function buildSearchResults(searchRes, history, filters, handlers) {
  const section = document.createElement('div');
  section.className = 'search-results';

  if (!searchRes) return section;

  const { results, capped } = searchRes;

  if (capped) {
    const banner = document.createElement('div');
    banner.className = 'capped-banner';
    setText(banner, 'Results capped \u2014 narrow your filters');
    section.appendChild(banner);
  }

  // Group by sessionId
  const bySession = new Map();
  for (const r of results) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r);
  }

  // Client-side filter by project/tool
  let shown = 0;
  for (const [sessionId, snippets] of bySession) {
    const entry = history.find(h => h.id === sessionId);

    // Apply project/tool filters only when entry exists
    if (entry) {
      if (filters.project !== 'all' && projectOf(entry) !== filters.project) continue;
      if (filters.tool !== 'all' && entry.tool !== filters.tool) continue;
    }

    shown++;

    const group = document.createElement('div');
    group.className = 'search-result-group';

    const header = document.createElement('div');
    header.className = 'search-result-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'search-result-title';
    const title = entry ? (entry.title ?? entry.id.slice(0, 8)) : `${sessionId.slice(0, 8)} (no metadata)`;
    setText(titleEl, title);

    const projEl = document.createElement('span');
    projEl.className = 'search-result-proj';
    setText(projEl, entry ? (projectOf(entry) || '') : '');

    const openBtn = document.createElement('button');
    openBtn.className = 'hist-action-btn';
    setText(openBtn, 'Open');
    openBtn.addEventListener('click', () => handlers.onOpenSession(sessionId));

    header.appendChild(titleEl);
    header.appendChild(projEl);
    header.appendChild(openBtn);
    group.appendChild(header);

    for (const r of snippets) {
      const snip = document.createElement('div');
      snip.className = 'search-snippet';
      setText(snip, `L${r.lineNo}: ${r.snippet}`);
      group.appendChild(snip);
    }

    section.appendChild(group);
  }

  if (results.length > 0 && shown === 0) {
    const noMatch = document.createElement('div');
    noMatch.className = 'search-no-match';
    setText(noMatch, 'No search results match current project/tool filters.');
    section.appendChild(noMatch);
  }

  return section;
}

// `endedOnly` (Work > History) drops live sessions, which the Fleet board
// already shows; `recent` marks that many of the newest ended sessions.
export async function renderHistory(container, handlers, initialFilters = {}, { endedOnly = false, recent = 0 } = {}) {
  clear(container);

  const windowCleanups = [];

  // State
  let state = null;
  let searchRes = null;
  let filtersState = {
    project: initialFilters.project ?? 'all',
    tool: initialFilters.tool ?? 'all',
    dateRange: initialFilters.dateRange ?? '7',
    skillQ: initialFilters.skillQ ?? '',
  };

  // Try to load initial state
  try { state = await getStateFields(['sessions', 'history', 'tools']); } catch { state = { sessions: [], history: [] }; }

  const history = state.history ?? [];
  const sessions = state.sessions ?? [];

  // Build a displayName map from state.tools (populated if server provides tools array)
  const toolDisplayNames = {};
  for (const t of (state.tools ?? [])) {
    if (t.id) toolDisplayNames[t.id] = t.displayName ?? t.id;
  }

  const { bar, projectSel, toolSel, dateSel, skillInput, searchInput } =
    buildFilters(history, filtersState, toolDisplayNames);

  if (initialFilters.tool) toolSel.value = initialFilters.tool;
  container.appendChild(bar);

  let searchSection = document.createElement('div');
  searchSection.className = 'search-results';
  container.appendChild(searchSection);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'hist-table-wrap';
  container.appendChild(tableWrap);

  // Menu cleanup refs (resume popups)
  const menuCleanups = [];

  function renderTable() {
    // Close any open resume menus before replacing DOM
    for (const fn of menuCleanups) fn();
    menuCleanups.length = 0;

    let filtered = applyFilters(history, sessions, filtersState);
    if (endedOnly) filtered = filtered.filter((h) => !sessions.some((s) => s.id === h.id && countsAsLive(s)));
    clear(tableWrap);
    tableWrap.appendChild(buildTable(filtered, sessions, handlers, menuCleanups, { recent }));
  }

  function renderSearchResults() {
    const newSection = buildSearchResults(searchRes, history, filtersState, handlers);
    container.replaceChild(newSection, searchSection);
    searchSection = newSection;
  }

  renderTable();

  projectSel.addEventListener('change', () => {
    filtersState.project = projectSel.value;
    renderTable();
    renderSearchResults();
  });

  toolSel.addEventListener('change', () => {
    filtersState.tool = toolSel.value;
    renderTable();
    renderSearchResults();
  });

  dateSel.addEventListener('change', () => {
    filtersState.dateRange = dateSel.value;
    renderTable();
  });

  skillInput.addEventListener('input', () => {
    filtersState.skillQ = skillInput.value;
    renderTable();
  });

  searchInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = searchInput.value.trim();
    if (!q) {
      searchRes = null;
      renderSearchResults();
      return;
    }
    try {
      searchRes = await search(q);
    } catch {
      searchRes = null;
    }
    renderSearchResults();
  });

  function onDocClick() {
    for (const fn of menuCleanups) fn();
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') {
      for (const fn of menuCleanups) fn();
    }
  }

  window.addEventListener('click', onDocClick);
  window.addEventListener('keydown', onDocKeydown);
  windowCleanups.push(
    () => window.removeEventListener('click', onDocClick),
    () => window.removeEventListener('keydown', onDocKeydown),
  );

  // Return cleanup
  return function cleanup() {
    for (const fn of windowCleanups) fn();
    for (const fn of menuCleanups) fn();
    menuCleanups.length = 0;
  };
}

