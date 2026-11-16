// web/orchestration/board.js - /backlog Kanban board (Tasks 5, 6, 7)
// XSS discipline: textContent/createElement only; clear() empties containers.
import {
  getBacklog, getBacklogCards, addBacklogItem, updateBacklogItem, setBacklogPaused,
  reorderBacklog, getRunner, setRunnerConfig, approveBacklogItem,
} from '../shared/api.js';
import {
  boardColumns, columnItems, filterItems, groupByLane, groupByColumn, joinRunner,
  dueStatus, isBlocked, gateClass, archiveEta,
  COLUMN_LABELS, COLUMN_PAGE, emptyText, stateSinceMs, fmtAge, splitDone, pausedItems, projectScopes, mergePauseText,
} from './board-model.js';
import { createBoardDelta } from './board-delta.js';
import { enableColumnDnd } from './board-dnd.js';
import { openCardDrawer } from './board-drawer.js';
import { sessionColor } from '../shared/session-color.js';
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';

import { clear } from '../shared/dom-util.js';
const WIP_KEY = 'glmps.board.wip';
function wipLimits() { try { return JSON.parse(localStorage.getItem(WIP_KEY)) || {}; } catch { return {}; } }
function setWip(col, n) {
  const w = wipLimits();
  if (n) w[col] = n; else delete w[col];
  localStorage.setItem(WIP_KEY, JSON.stringify(w));
}

// itemsById: full (unfiltered) lookup so isBlocked() can resolve blockedBy ids
// even when the blocker isn't in the current filtered/visible set.
// archiveDays: mirrors the runner's auto-archive window, cosmetic only (drives
// the "archives in Nd" pill) - hardcoded until GET /api/runner exposes it.
const state = {
  project: 'all', query: '', groupBy: null, showArchived: false, minPriority: null,
  itemsById: new Map(), archiveDays: 7,
};

// The cards with just enough of the globe to place them (players, grid, labels).
const SURFACE_CARD_LAYERS = ['players', 'cards', 'graticule', 'labels'];

let host = null;
let kanbanRail = null;      // the project scope chip strip (div.board-scope) in the board toolbar
// Columns whose "Show N more" is open. Module-level so a refresh (SSE, drag,
// quick add) does not collapse a column the operator just expanded.
const expandedCols = new Set();

const PRIORITY_LABELS = { 0: 'low', 1: 'normal', 2: 'high', 3: 'urgent' };
const PRIORITY_CLASSES = { 0: 'pill-low', 1: 'pill-normal', 2: 'pill-high', 3: 'pill-urgent' };

// Only high and urgent are worth a chip; "normal" on most cards is noise.
function priorityPill(priority) {
  if (priority == null || Number(priority) < 2) return null;
  const n = Number(priority);
  const pill = document.createElement('span');
  pill.className = `board-priority-pill ${PRIORITY_CLASSES[n] ?? ''}`;
  pill.textContent = PRIORITY_LABELS[n] ?? String(priority);
  return pill;
}

function card(it) {
  const el = document.createElement('div');
  el.className = 'backlog-card' + (it.live ? ' live' : '') + (it.quarantined ? ' quarantined' : '');
  el.dataset.id = it.id;

  // Title row
  const titleRow = document.createElement('div');
  titleRow.className = 'backlog-card-title-row';

  const title = document.createElement('div');
  title.className = 'backlog-card-title';
  title.textContent = it.title;
  titleRow.appendChild(title);

  // Poison-quarantine flag: the ticket was held by the intake poison-scanner.
  if (it.quarantined) {
    const flag = document.createElement('span');
    flag.className = 'backlog-card-flag';
    flag.textContent = 'quarantined';
    const flags = it.provenance && Array.isArray(it.provenance.flags) ? it.provenance.flags : [];
    const reason = flags.length ? `Poison-scanner flagged: ${flags.join(', ')}. Review before approving.`
                               : 'Held by the poison-scanner. Review before approving.';
    flag.title = reason;
    flag.setAttribute('aria-label', reason);
    titleRow.appendChild(flag);
  }
  el.appendChild(titleRow);

  // Pill row: id - state - priority - assignee - due - blocked - gate - aging.
  // Kept visually quiet (small, low-alpha) so the title stays dominant; a pill
  // only appears when its data is present.
  const pills = document.createElement('div');
  pills.className = 'backlog-card-pills';

  const idChip = document.createElement('button');
  idChip.className = 'board-id-chip';
  idChip.textContent = it.id;
  idChip.title = 'Copy ticket id';
  let copyResetTimer = null;
  idChip.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(it.id).then(() => {
      clearTimeout(copyResetTimer);
      idChip.classList.add('copied');
      idChip.textContent = 'copied';
      idChip.title = 'Copied to clipboard';
      copyResetTimer = setTimeout(() => {
        idChip.classList.remove('copied');
        idChip.textContent = it.id;
        idChip.title = 'Copy ticket id';
      }, 1100);
    }).catch(() => {});
  });
  idChip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  });
  pills.appendChild(idChip);

  // Time in the current state. The state itself is the column the card sits
  // in, so it is never repeated as a pill inside that column.
  const age = fmtAge(stateSinceMs(it));
  if (age) {
    const ageChip = document.createElement('span');
    ageChip.className = 'board-pill board-age-pill';
    ageChip.textContent = age;
    ageChip.title = 'Time in the current state';
    pills.appendChild(ageChip);
  }

  // Gate right after the age so the two facts a reviewer scans for sit
  // together; PASS/CONCERNS read as the word, colour is only reinforcement.
  const gc = gateClass(it.gate);
  if (gc) {
    const g = document.createElement('span');
    g.className = `board-pill board-gate-pill ${gc}`;
    g.textContent = it.gate.status;
    const ev = Array.isArray(it.gate.evidence) ? it.gate.evidence : [];
    g.title = [`Gate ${it.gate.status}`, ...ev].join(String.fromCharCode(10));
    pills.appendChild(g);
  }

  const prio = priorityPill(it.priority);
  if (prio) pills.appendChild(prio);

  // Which agent holds a live card; the project is the sidebar's job.
  if (it.live && it.agent) {
    const ag = document.createElement('span');
    ag.className = 'board-pill board-agent-pill';
    ag.textContent = it.agent;
    pills.appendChild(ag);
  }

  if (it.assignee) {
    const a = document.createElement('span');
    a.className = 'board-pill board-assignee-pill';
    a.textContent = it.assignee;
    pills.appendChild(a);
  }

  const due = dueStatus(it);
  if (due) {
    const d = document.createElement('span');
    d.className = `board-pill board-due-pill due-${due}`;
    d.textContent = `due ${it.dueDate}`;
    pills.appendChild(d);
  }

  if (isBlocked(it, state.itemsById)) {
    const b = document.createElement('span');
    b.className = 'board-pill board-blocked-pill';
    b.textContent = `blocked: ${(it.blockedBy ?? []).join(', ')}`;
    pills.appendChild(b);
  }

  const mergePause = mergePauseText(it);
  if (mergePause) {
    const mp = document.createElement('span');
    mp.className = 'board-pill gate-concerns';
    mp.textContent = mergePause;
    mp.title = 'The merge queue merges nothing into this branch while its last full-suite run is red, except a PR whose tests show the failing files green. This request is tested again once the red changes.';
    pills.appendChild(mp);
  }

  const eta = archiveEta(it, state.archiveDays);
  if (eta != null) {
    const e2 = document.createElement('span');
    e2.className = 'board-pill board-aging-pill';
    e2.textContent = `archives in ${eta}d`;
    pills.appendChild(e2);
  }

  el.appendChild(pills);

  // Release chip: why an idle card got parked, in the operator's own words
  // (D27). Only an idle card with a recorded reason gets one; a missing
  // release or why renders nothing rather than an empty or "undefined" chip.
  const releaseWhy = it.state === 'idle' ? it.release?.why : null;
  if (releaseWhy) {
    const chip = document.createElement('span');
    chip.className = 'board-release-chip';
    chip.textContent = `paused: ${releaseWhy}`;
    chip.title = `Released ${it.release?.kind ?? 'unknown'} at ${it.release?.ts ?? 'an unknown time'}. A reply in its Slack channel resumes the same session.`;
    el.appendChild(chip);
  }

  // Quick-action triage buttons (state-dependent)
  if (it.state === 'queued' || it.state === 'held') {
    const actions = document.createElement('div');
    actions.className = 'backlog-card-actions';

    if (it.state === 'queued') {
      const hold = document.createElement('button');
      hold.className = 'backlog-card-action hold';
      hold.textContent = 'To backlog';
      hold.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await updateBacklogItem(it.id, { state: 'held' }); }
        catch { emit('Failed to hold item'); }
        await refreshBacklog();
      });
      actions.appendChild(hold);
    }

    if (it.state === 'held') {
      const queue = document.createElement('button');
      queue.className = 'backlog-card-action queue';
      queue.textContent = 'Queue';
      queue.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await updateBacklogItem(it.id, { state: 'queued' }); }
        catch { emit('Failed to queue item'); }
        await refreshBacklog();
      });
      actions.appendChild(queue);
    }

    // Approve releases a poison-quarantined ticket (operator-only gate).
    if (it.quarantined) {
      const approve = document.createElement('button');
      approve.className = 'backlog-card-action approve';
      approve.textContent = 'Approve';
      approve.title = 'Release this quarantined ticket so the runner can launch it';
      approve.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await approveBacklogItem(it.id); }
        catch { emit('Failed to approve item'); }
        await refreshBacklog();
      });
      actions.appendChild(approve);
    }

    el.appendChild(actions);
  }

  // Click-to-open drawer, keyboard activation and a deep link (D17). A drag
  // is not a click - Sortable suppresses the click it would otherwise fire
  // after a drop, so no extra guard is needed here for that (board-dnd.js).
  // aria-label overrides all descendant text for the accessible name, so the
  // release chip's own text (visible to sighted users) would otherwise never
  // reach a screen reader on this card; fold it into bindItem's label instead
  // of a separate interactive() call (trunk's idle/release carry, D27).
  const cardLabel = releaseWhy
    ? `Card ${it.id}: ${it.title}, paused: ${releaseWhy}`
    : `Card ${it.id}: ${it.title}`;
  bindItem(el, {
    type: 'card', id: it.id,
    link: linkFor({ lens: 'work', band: 'board', sel: { type: 'card', id: it.id } }),
    open: () => openCardDrawer(it, { onChange: refreshBacklog }), label: cardLabel,
  });

  return el;
}

// Every card of a column is in the DOM (the drop handler reads the column's
// full order from it), but only the first COLUMN_PAGE are visible until
// "Show N more" is pressed; the rest carry `hidden`.
function applyCollapse(cardsWrap, more, key, total, label) {
  const open = expandedCols.has(key);
  const cards = [...cardsWrap.querySelectorAll('.backlog-card')];
  cards.forEach((c, i) => { c.hidden = !open && i >= COLUMN_PAGE; });
  const extra = total - COLUMN_PAGE;
  more.hidden = extra <= 0;
  more.textContent = open ? 'Show fewer' : `Show ${extra} more`;
  more.setAttribute('aria-expanded', String(open));
  // Name carries the column: six identical "Show N more" buttons are not
  // distinguishable in a screen reader's control list otherwise.
  more.setAttribute('aria-label', `${more.textContent} cards in ${label}`);
}

function buildCardsWrap(colItems, key, dndGroup, emptyMsg) {
  const cardsWrap = document.createElement('div');
  cardsWrap.className = 'backlog-col-cards';
  if (colItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'backlog-col-empty';
    empty.textContent = emptyMsg;
    cardsWrap.appendChild(empty);
  } else {
    for (const it of colItems) cardsWrap.appendChild(card(it));
  }
  // Wire drag-and-drop. The status comes from the nearest [data-col], which is
  // the column, or the Paused footer inside the Done column.
  enableColumnDnd(cardsWrap, dndGroup, async (wrap) => {
    const ids = [...wrap.querySelectorAll('.backlog-card')].map(c => c.dataset.id);
    const status = wrap.closest('[data-col]').dataset.col;
    try { await reorderBacklog({ status, ids }); }
    catch { emit('Reorder failed'); }
    await refreshBacklog();
  });
  return cardsWrap;
}

function buildMoreButton(cardsWrap, key, total, label) {
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'backlog-col-more';
  more.addEventListener('click', () => {
    if (expandedCols.has(key)) expandedCols.delete(key); else expandedCols.add(key);
    applyCollapse(cardsWrap, more, key, total, label);
  });
  applyCollapse(cardsWrap, more, key, total, label);
  return more;
}

function renderColumns(board, filtered, dndGroup, laneKey = '') {
  const cols = boardColumns(state.showArchived);
  const byCol = groupByColumn(filtered);
  const wip = wipLimits();
  const filteredView = !!state.query.trim() || state.project !== 'all' || state.minPriority != null;

  for (const col of cols) {
    let colItems = columnItems(byCol, col);
    let olderDone = 0;
    // Done is a rolling window, not an archive; archived/cancelled columns
    // (shown on request) are not windowed.
    if (col === 'done' && !state.showArchived) {
      const split = splitDone(colItems);
      colItems = split.recent;
      olderDone = split.older;
    }
    const paused = col === 'done' ? pausedItems(byCol) : [];
    const key = `${laneKey}${col}`;

    const colEl = document.createElement('div');
    colEl.className = 'backlog-col';
    colEl.dataset.col = col;

    // Column header
    const h = document.createElement('div');
    h.className = 'backlog-col-head';

    const headLabel = document.createElement('span');
    headLabel.className = 'col-head-label';
    headLabel.textContent = COLUMN_LABELS[col] ?? col;
    h.appendChild(headLabel);

    // WIP badge
    const limit = wip[col] ? Number(wip[col]) : null;
    const wipBadge = document.createElement('button');
    wipBadge.className = 'col-wip-badge' + (limit && colItems.length > limit ? ' over' : '');
    wipBadge.title = limit ? `WIP limit: ${limit}. Click to change.` : 'Click to set WIP limit';

    if (limit) {
      wipBadge.textContent = `${colItems.length}/${limit}`;
    } else {
      wipBadge.textContent = String(colItems.length);
    }

    wipBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = limit ? String(limit) : '';
      const raw = window.prompt(`WIP limit for "${COLUMN_LABELS[col] ?? col}" (blank to clear):`, current);
      if (raw === null) return; // cancelled
      const n = raw.trim() === '' ? 0 : parseInt(raw, 10);
      setWip(col, Number.isFinite(n) && n > 0 ? n : 0);
      refreshBacklog();
    });

    h.appendChild(wipBadge);
    colEl.appendChild(h);

    const cardsWrap = buildCardsWrap(colItems, key, dndGroup, emptyText(col, filteredView));
    colEl.appendChild(cardsWrap);
    colEl.appendChild(buildMoreButton(cardsWrap, key, colItems.length, COLUMN_LABELS[col] ?? col));

    if (olderDone > 0) {
      const note = document.createElement('div');
      note.className = 'backlog-col-note';
      note.textContent = `${olderDone} older, auto-archived`;
      colEl.appendChild(note);
    }

    if (col === 'done' && paused.length > 0) {
      const foot = document.createElement('div');
      foot.className = 'backlog-col-foot';
      foot.dataset.col = 'idle';
      const footHead = document.createElement('div');
      footHead.className = 'backlog-col-foot-head';
      const footLabel = document.createElement('span');
      footLabel.textContent = COLUMN_LABELS.idle;
      const footCount = document.createElement('span');
      footCount.className = 'col-wip-badge';
      footCount.textContent = String(paused.length);
      footHead.append(footLabel, footCount);
      foot.appendChild(footHead);
      const pKey = `${laneKey}idle`;
      const pWrap = buildCardsWrap(paused, pKey, dndGroup, '');
      foot.appendChild(pWrap);
      foot.appendChild(buildMoreButton(pWrap, pKey, paused.length, COLUMN_LABELS.idle));
      colEl.appendChild(foot);
    }

    board.appendChild(colEl);
  }
}

const delta = createBoardDelta({
  fetchFull: () => getBacklog(),
  fetchIds: (ids) => getBacklogCards(ids),
  paint: (items) => paintBoard(items),
});

/** A 'backlog' SSE event: fetch only the cards it names, not the whole board. */
export function onBacklogEvent(payload) { if (host) delta.onEvent(payload); }

export async function refreshBacklog() {
  if (!host) return;
  let res = {};
  try { res = await getBacklog(); } catch {}
  delta.seed(res);
  await paintBoard(res.items ?? []);
}

async function paintBoard(items) {
  if (!host) return;
  const board = host.querySelector('#backlog-columns');
  if (!board) return;

  // Enrich from the runner ledger: cards with a launched session show as live,
  // with their editor target as the agent label. Fail soft if the runner is down.
  let runner = null;
  try { runner = await getRunner(); } catch {}
  items = joinRunner(items, runner);

  // Full (unfiltered) lookup for isBlocked() cross-references, plus the
  // cosmetic auto-archive window used by the aging pill.
  state.itemsById = new Map(items.map(i => [i.id, i]));
  state.archiveDays = 7; // TODO: read from GET /api/runner config once exposed

  const filtered = filterItems(items, {
    project: state.project,
    query: state.query,
    minPriority: state.minPriority,
    showCancelled: state.showArchived,
    showArchived: state.showArchived,
  });

  // Counts follow the search and priority filters but never the project one,
  // so the scope strip always shows every scope the operator could pick.
  paintScope(filterItems(items, {
    project: 'all', query: state.query, minPriority: state.minPriority,
    showCancelled: state.showArchived, showArchived: state.showArchived,
  }));

  clear(board);

  if (state.groupBy) {
    // Swimlane mode: one band per lane
    const lanes = groupByLane(filtered, state.groupBy);
    for (const { lane, label, items: laneItems } of lanes) {
      const band = document.createElement('div');
      band.className = 'backlog-swimlane';

      const laneHeader = document.createElement('div');
      laneHeader.className = 'swimlane-header';

      const laneLabel = document.createElement('span');
      laneLabel.className = 'swimlane-label';
      laneLabel.textContent = label || lane;

      const laneCount = document.createElement('span');
      laneCount.className = 'swimlane-count';
      laneCount.textContent = String(laneItems.length);

      laneHeader.appendChild(laneLabel);
      laneHeader.appendChild(laneCount);
      band.appendChild(laneHeader);

      const laneColumns = document.createElement('div');
      laneColumns.className = 'backlog-columns';
      renderColumns(laneColumns, laneItems, `backlog-${lane}`, `${lane}:`);
      band.appendChild(laneColumns);

      board.appendChild(band);
    }
  } else {
    // Flat mode: single set of columns
    const colsRow = document.createElement('div');
    colsRow.className = 'backlog-columns';
    renderColumns(colsRow, filtered, 'backlog');
    board.appendChild(colsRow);
  }
}

// The one scope control for the board (the toolbar project dropdown it
// replaced is gone). Built from the board's own items so every project that
// has cards is listed with its open count, including ones /api/projects does
// not know about (e.g. "default").
function paintScope(items) {
  if (!kanbanRail) return;
  const list = kanbanRail.querySelector('.board-scope-list');
  if (!list) return;
  list.textContent = '';
  const scopes = projectScopes(items, state.project);
  const total = scopes.reduce((n, s) => n + s.count, 0);
  const row = (key, label, count, color) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'board-scope-row';
    btn.dataset.projKey = key;
    btn.setAttribute('aria-pressed', String(state.project === key));
    btn.addEventListener('click', () => setBoardProject(key));
    const sq = document.createElement('span');
    sq.className = 'board-scope-sq';
    sq.setAttribute('aria-hidden', 'true');
    if (color) sq.style.setProperty('--sq', color);
    const name = document.createElement('span');
    name.className = 'board-scope-name';
    name.textContent = label;
    const n = document.createElement('span');
    n.className = 'board-scope-count';
    n.textContent = String(count);
    n.title = `${count} open`;
    btn.append(sq, name, n);
    li.appendChild(btn);
    return li;
  };
  list.appendChild(row('all', 'All projects', total, null));
  for (const s of scopes) list.appendChild(row(s.project, s.project, s.count, sessionColor(s.project)));
}

function setBoardProject(key) {
  state.project = key; // 'all' or a project key
  if (kanbanRail) {
    for (const b of kanbanRail.querySelectorAll('.board-scope-row')) {
      b.setAttribute('aria-pressed', String(b.dataset.projKey === key));
    }
  }
  refreshBacklog();
}

// `head` is the lens's own header line (title and chips). The quick-add input,
// search, Auto-run toggle and View menu join it, so the page has one header row
// and no separate bar or toolbar. Without a `head` the board makes its own.
export async function renderBacklog(container, _handlers, { head = null } = {}) {
  host = container;
  clear(container);

  // Project scope is a chip strip leading the board's own toolbar row, not a
  // side rail: it is the board's standing filter, so every scope and its open
  // count stay visible, and the columns keep the width a rail would take
  // (glmps-2-0-148).
  const scope = document.createElement('div');
  scope.className = 'board-scope';
  scope.setAttribute('role', 'group');
  scope.setAttribute('aria-label', 'Project scope');
  const scopeList = document.createElement('ul');
  scopeList.className = 'board-scope-list';
  const toSurface = document.createElement('a');
  toSurface.className = 'board-scope-surface';
  // Lands on Surface with the cards layer named, inside the app: a bare href
  // reloaded the whole page, and ?panel=kanban now redirects back to this board.
  toSurface.href = linkFor({ lens: 'surface', layers: SURFACE_CARD_LAYERS });
  toSurface.textContent = 'On Surface';
  toSurface.title = 'Show these cards on Surface';
  toSurface.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || !_handlers?.onGo) return;
    e.preventDefault(); _handlers.onGo(toSurface.getAttribute('href'));
  });
  scope.append(scopeList, toSurface);
  kanbanRail = scope;

  const main = document.createElement('div');
  main.className = 'kanban-main';
  container.appendChild(main);

  const header = head ?? document.createElement('header');
  if (!head) { header.className = 'work-head'; main.appendChild(header); }
  header.insertBefore(scope, header.firstChild);
  const controls = document.createElement('div');
  controls.className = 'work-controls';
  header.appendChild(controls);

  const input = document.createElement('input');
  input.className = 'backlog-input';
  input.placeholder = 'Add a card, Enter to queue';
  input.setAttribute('aria-label', 'Add a card');
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const lines = input.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    input.value = '';
    const proj = state.project === 'all' ? 'default' : state.project;
    // addBacklogItem rejects on a real server failure (web/shared/api.js), so
    // the catch names which line failed and why.
    for (const title of lines) {
      try { await addBacklogItem({ project: proj, title }); }
      catch (err) { emit(`Failed to add "${title}": ${err.message}`); }
    }
    await refreshBacklog();
  });

  const searchInput = document.createElement('input');
  searchInput.className = 'board-toolbar-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search cards';
  searchInput.setAttribute('aria-label', 'Search backlog');
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    refreshBacklog();
  });

  // The board only tracks cards; the runner is what launches the top queued
  // card as a live editor session. Off by default so nothing starts unexpectedly.
  const RUNNER_LABELS = {
    'vscode': 'VS Code', 'vscode-insiders': 'VS Code Insiders', 'cursor': 'Cursor',
    'windsurf': 'Windsurf', 'antigravity': 'Antigravity', 'native-terminal': 'Native terminal',
  };
  // Auto-run and Pause queue are two different switches, so they sit together
  // under one "Runner" label (card glmps-2-0-137 story 35): Auto-run launches
  // the top queued card, Pause queue holds the queue so nothing launches.
  const runnerGroup = document.createElement('div');
  runnerGroup.className = 'board-runner';
  runnerGroup.setAttribute('role', 'group');
  const runnerLabel = document.createElement('span');
  runnerLabel.className = 'board-runner-label';
  runnerLabel.id = 'board-runner-label';
  runnerLabel.textContent = 'Runner';
  runnerGroup.setAttribute('aria-labelledby', runnerLabel.id);
  const runner = document.createElement('button');
  runner.type = 'button';
  runner.className = 'backlog-runner';
  runner.title = 'When on, the top queued card launches automatically as a live session in your chosen editor.';
  runner.setAttribute('role', 'switch');
  runner.setAttribute('aria-checked', 'false');
  const runnerDot = document.createElement('span');
  runnerDot.className = 'backlog-runner-dot';
  runnerDot.setAttribute('aria-hidden', 'true');
  const runnerText = document.createElement('span');
  runnerText.textContent = 'Auto-run off';
  runner.append(runnerDot, runnerText);

  function paintRunner(on) {
    runner.classList.toggle('on', on);
    runner.setAttribute('aria-checked', String(on));
    runnerText.textContent = on ? 'Auto-run on' : 'Auto-run off';
  }
  runner.addEventListener('click', async () => {
    const on = !runner.classList.contains('on');
    paintRunner(on);
    try { await setRunnerConfig({ enabled: on }); }
    catch { paintRunner(!on); emit('Failed to change the runner'); }
  });

  // Secondary controls fold into one menu so the header stays a single line.
  const more = document.createElement('details');
  more.className = 'board-more';
  const moreSum = document.createElement('summary');
  moreSum.className = 'board-more-summary';
  moreSum.textContent = 'View';
  const pop = document.createElement('div');
  pop.className = 'board-more-pop';
  more.append(moreSum, pop);
  more.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && more.open) { more.open = false; moreSum.focus?.(); }
  });
  const field = (label, control) => {
    const row = document.createElement('label');
    row.className = 'board-more-field';
    const t = document.createElement('span');
    t.textContent = label;
    row.append(t, control);
    return row;
  };

  const groupSel = document.createElement('select');
  groupSel.className = 'board-toolbar-select';
  groupSel.setAttribute('aria-label', 'Group by');
  for (const [val, lbl] of [['', 'No grouping'], ['project', 'By project'], ['priority', 'By priority']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    groupSel.appendChild(opt);
  }
  groupSel.addEventListener('change', () => {
    state.groupBy = groupSel.value || null;
    refreshBacklog();
  });

  const target = document.createElement('select');
  target.className = 'board-toolbar-select';
  target.setAttribute('aria-label', 'Launch sessions in');
  target.title = 'Where the runner opens each session';
  target.addEventListener('change', async () => {
    try { await setRunnerConfig({ lastTarget: target.value || null }); }
    catch { emit('Failed to set the launch target'); }
  });
  // Hydrate from the server (targets + current config); fail soft if unavailable.
  getRunner().then((r) => {
    const ids = Array.isArray(r?.targets) ? r.targets : [];
    // No saved target is a real state (sessions go to a running IDE, else a
    // native terminal), so it gets its own option instead of showing ids[0].
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Automatic';
    target.appendChild(auto);
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = RUNNER_LABELS[id] ?? id;
      target.appendChild(opt);
    }
    if (r?.config?.lastTarget && ids.includes(r.config.lastTarget)) target.value = r.config.lastTarget;
    paintRunner(!!r?.config?.enabled);
  }).catch(() => {});

  const archivedLabel = document.createElement('label');
  archivedLabel.className = 'board-toolbar-checkbox-label';
  const archivedCb = document.createElement('input');
  archivedCb.type = 'checkbox';
  archivedCb.className = 'board-toolbar-checkbox';
  archivedCb.checked = state.showArchived;
  archivedCb.addEventListener('change', () => {
    state.showArchived = archivedCb.checked;
    refreshBacklog();
  });
  archivedLabel.append(archivedCb, document.createTextNode('Show archived'));

  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'backlog-pause';
  pause.title = 'When on, the queue is held: no queued card launches, whatever Auto-run says.';
  pause.setAttribute('role', 'switch');
  pause.setAttribute('aria-checked', 'false');
  const pauseDot = document.createElement('span');
  pauseDot.className = 'backlog-runner-dot';
  pauseDot.setAttribute('aria-hidden', 'true');
  const pauseText = document.createElement('span');
  pauseText.textContent = 'Pause queue';
  pause.append(pauseDot, pauseText);
  pause.addEventListener('click', async () => {
    const paused = pause.classList.toggle('on');
    pause.setAttribute('aria-checked', String(paused));
    pauseText.textContent = paused ? 'Queue paused' : 'Pause queue';
    try { await setBacklogPaused(paused); }
    catch { emit('Failed to set pause state'); }
  });

  pop.append(field('Group', groupSel), field('Launch in', target), archivedLabel);
  runnerGroup.append(runnerLabel, runner, pause);
  controls.append(input, searchInput, runnerGroup, more);

  const boardWrap = document.createElement('div');
  boardWrap.className = 'backlog-board-wrap';
  boardWrap.id = 'backlog-columns';
  main.appendChild(boardWrap);

  await refreshBacklog();

  return function cleanup() {
    host = null;
    kanbanRail = null;
  };
}

function emit(msg) { window.dispatchEvent(new CustomEvent('mc-toast', { detail: msg })); }
