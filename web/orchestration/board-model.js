// Pure, testable logic for the backlog board.
export const COLUMNS = ['queued', 'in_progress', 'in_review', 'idle', 'done'];

export function groupByColumn(items) {
  const g = { queued: [], in_progress: [], in_review: [], idle: [], done: [], held: [], archived: [] };
  for (const it of items) (g[it.state] ?? (g[it.state] = [])).push(it);
  for (const k of Object.keys(g)) g[k].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return g;
}

export function nextOrder(items) {
  return items.reduce((m, i) => Math.max(m, i.order ?? 0), 0) + 1;
}

// D27: idle sits between in_review and done - a card that was live and got
// parked (Slack stop/evict/TTL/stale), not a card that never started (held).
export const ORDERED = ['held', 'queued', 'in_progress', 'in_review', 'idle', 'done'];

export function orderedColumns(showArchived) {
  return showArchived ? [...ORDERED, 'archived', 'cancelled'] : [...ORDERED];
}

export function priorityRank(priority) {
  return (priority == null) ? -1 : Number(priority);
}

export function filterItems(items, { project, query, minPriority, showCancelled, showArchived } = {}) {
  const q = (query ?? '').trim().toLowerCase();
  return (items ?? []).filter(it => {
    if (!showCancelled && it.state === 'cancelled') return false;
    if (!showArchived && it.state === 'archived') return false;
    if (project && project !== 'all' && it.project !== project) return false;
    if (minPriority != null && priorityRank(it.priority) < minPriority) return false;
    if (q) {
      const hay = `${it.title ?? ''} ${it.prompt ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const DAY_MS = 86400000;

export function dueStatus(item, nowMs = Date.now()) {
  if (!item?.dueDate) return null;
  const due = Date.parse(item.dueDate);
  if (isNaN(due)) return null;
  // A date-only string parses to midnight UTC; treat the whole due day as on time.
  const endOfDue = due + DAY_MS;
  if (endOfDue < nowMs) return 'overdue';
  if (endOfDue - nowMs <= 2 * DAY_MS) return 'soon';
  return 'ok';
}

const RESOLVED = new Set(['done', 'archived']);
export function isBlocked(item, byId) {
  return (item?.blockedBy ?? []).some(id => { const t = byId?.get(id); return t && !RESOLVED.has(t.state); });
}

const GATE_CLASSES = { PASS: 'gate-pass', CONCERNS: 'gate-concerns', FAIL: 'gate-fail', WAIVED: 'gate-waived' };
export function gateClass(gate) { return gate?.status ? (GATE_CLASSES[gate.status] ?? null) : null; }

export function archiveEta(item, days, nowMs = Date.now()) {
  if (!(days > 0) || item?.state !== 'done' || !item?.doneAt) return null;
  const doneAt = Date.parse(item.doneAt);
  if (isNaN(doneAt)) return null;
  const left = Math.ceil((doneAt + days * DAY_MS - nowMs) / DAY_MS);
  return Math.max(0, left);
}

// Enrich backlog items with live-session info from the queue runner ledger.
// The runner tracks launched jobs in state/runner/launched.json keyed by card id
// (exposed via GET /api/runner as { config, ledger, targets }). A card is "live"
// while a ledger entry exists for it, and the entry's launch target (the editor it
// opened in) surfaces as the agent label. Items without an entry pass through
// untouched. Pure: returns a new array, never mutates the inputs.
export function joinRunner(items, runner) {
  const ledger = (runner && runner.ledger) || {};
  return (items ?? []).map(it => {
    const entry = ledger[it.id];
    if (!entry) return it;
    return { ...it, live: true, agent: entry.target ?? it.agent };
  });
}

export function groupByLane(items, laneKey) {
  if (!laneKey) return [{ lane: 'all', label: '', items: [...(items ?? [])] }];
  const map = new Map();
  for (const it of items ?? []) {
    const key = laneKey === 'priority'
      ? String(priorityRank(it.priority))
      : String(it.project ?? 'default');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return [...map.entries()]
    .sort((a, b) => laneKey === 'priority' ? Number(b[0]) - Number(a[0]) : a[0].localeCompare(b[0]))
    .map(([lane, laneItems]) => ({ lane, label: lane, items: laneItems }));
}

// Phase 2 (Q3): the board's visible columns. Paused (store state `idle`, or
// `paused` where a store names it that way) is not a column of its own; it
// rides in the Done column's footer so the five real work states read as one
// left-to-right flow. ORDERED/orderedColumns above stay for the 1.x callers.
// In review is not a column (glmps-2-0-148): no card on the live board had ever
// entered it and nothing in the server writes it. The state stays valid, and a
// card that does land there rides in In progress so it never drops off the board.
export const BOARD_COLUMNS = ['held', 'queued', 'in_progress', 'done'];
export const PAUSED_STATES = ['idle', 'paused'];
const FOLDED = { in_progress: ['in_review'] };

// The cards a board column shows: its own state plus any state folded into it.
// Done reads as a history, so it is newest-finished first rather than in the
// manual order (glmps-2-0-195); a card with no usable timestamp sinks to the end.
export function columnItems(byCol, col) {
  if (col === 'done') {
    return [...(byCol.done ?? [])].sort((a, b) =>
      (stateSinceMs(b) ?? 0) - (stateSinceMs(a) ?? 0));
  }
  const extra = FOLDED[col];
  if (!extra) return byCol[col] ?? [];
  const out = [...(byCol[col] ?? [])];
  for (const s of extra) out.push(...(byCol[s] ?? []));
  return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
export const DONE_WINDOW_DAYS = 7;
export const COLUMN_PAGE = 5;

export const COLUMN_LABELS = {
  held: 'Backlog',
  queued: 'Queued',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done (last 7 days)',
  idle: 'Paused',
  paused: 'Paused',
  archived: 'Archived (auto)',
  cancelled: 'Cancelled',
};

// What an empty column says: the dry pipe and what to do, never a bare "empty".
// A filtered board says so instead, since the column may hold cards the search
// or project scope is hiding.
const EMPTY_TEXT = {
  held: 'Nothing in the backlog.',
  queued: 'Nothing queued. Add a card above, or release one from Backlog.',
  in_progress: 'No card running.',
  done: 'Nothing finished in the last 7 days.',
  archived: 'Nothing archived yet.',
  cancelled: 'Nothing cancelled.',
};
export function emptyText(col, filtered) {
  if (filtered) return 'No card here matches the search or scope.';
  return EMPTY_TEXT[col] ?? 'Nothing here.';
}

export function boardColumns(showArchived) {
  return showArchived ? [...BOARD_COLUMNS, 'archived', 'cancelled'] : [...BOARD_COLUMNS];
}

// When the card entered its current state. Prefers the store's explicit
// stateEnteredAt, then doneAt for done cards, then the last update.
export function stateSinceMs(item) {
  const raw = item?.stateEnteredAt
    ?? (item?.state === 'done' ? item?.doneAt : null)
    ?? item?.updatedAt ?? item?.createdAt ?? null;
  const t = Date.parse(raw ?? '');
  return Number.isNaN(t) ? null : t;
}

// Compact age: 5m, 3h, 2d. Null when the card has no usable timestamp.
export function fmtAge(sinceMs, nowMs = Date.now()) {
  if (sinceMs == null) return null;
  const min = Math.max(0, Math.floor((nowMs - sinceMs) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Done cards older than the window are dropped from the Done column (the
// runner auto-archives them anyway); the count is returned so the column can
// say how many it is not showing instead of silently hiding them.
export function splitDone(doneItems, nowMs = Date.now(), days = DONE_WINDOW_DAYS) {
  const cutoff = nowMs - days * DAY_MS;
  const recent = [];
  let older = 0;
  for (const it of doneItems ?? []) {
    const t = stateSinceMs(it);
    if (t == null || t >= cutoff) recent.push(it); else older += 1;
  }
  return { recent, older };
}

export function pausedItems(byCol) {
  const out = [];
  for (const s of PAUSED_STATES) out.push(...(byCol[s] ?? []));
  return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Open cards per project for the scope sidebar, busiest first. A project that
// is currently selected stays listed even at zero so the filter can be undone.
export function projectScopes(items, selected = 'all') {
  const open = new Set(['held', 'queued', 'in_progress', 'in_review', ...PAUSED_STATES]);
  const map = new Map();
  for (const it of items ?? []) {
    if (it.state === 'archived' || it.state === 'cancelled') continue;
    const key = it.project ?? 'default';
    if (!map.has(key)) map.set(key, 0);
    if (open.has(it.state)) map.set(key, map.get(key) + 1);
  }
  if (selected && selected !== 'all' && !map.has(selected)) map.set(selected, 0);
  return [...map.entries()]
    .map(([project, count]) => ({ project, count }))
    .filter((s) => s.count > 0 || s.project === selected)
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
}

// glmps-2-0-runtime-125: the merge queue holds a request while its base's
// last full-suite run is red; the card says so until the pause lifts.
export function mergePauseText(it) {
  const m = it?.mergeRequest;
  if (!m || m.stage !== 'requested' || !m.redHold) return null;
  return `merge paused: ${m.base} red at ${String(m.redHold).slice(0, 7)}`;
}
