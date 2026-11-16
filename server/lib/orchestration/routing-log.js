// server/lib/orchestration/routing-log.js
// Durable record of the ROUTING DECISION made for a card, kept after that card
// has left the live runner ledger.
//
// Why this exists: reconcileLedger (queue-runner.js) drops every entry whose
// card reached a FINISHED state, and reconcileNow persists that pruned ledger
// over launched.json. The routing decision lives on the ledger entry, so it was
// erased the moment the card closed. computeRoutingCompliance therefore only
// ever saw IN-FLIGHT jobs: `routed` was structurally capped at maxConcurrent
// (1 by default, 3 on the author's machine), which makes the pre-registered
// n=20 decision point in the design spec unreachable no matter how many cards
// actually run.
//
// The write happens at the exact moment an entry departs the ledger, from the
// same loop reconcileNow already runs over the departed set, so nothing has to
// re-derive which jobs finished.
//
// Storage is a JSON array under <stateDir>/runner/routing-log.json, written
// with the same atomic tmp+rename pattern as runner-store.js (a torn read of a
// half-written measurement file would be worse than a missed append). Entries
// are upserted by card id, latest wins, so a card that is relaunched after a
// requeue replaces its own row instead of accumulating duplicates; that also
// bounds the file by DISTINCT card count rather than by launch count. MAX_ROWS
// is a second, absolute bound: the oldest rows are dropped first.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_ROWS = 500;

const logFile = (stateDir) => path.join(stateDir, 'runner', 'routing-log.json');

/** @returns {Array<{id:string, route:object|null, worktreeDir:string|null, ts:number}>} */
export function loadRoutingLog(stateDir) {
  try {
    const arr = JSON.parse(fs.readFileSync(logFile(stateDir), 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/**
 * Append departed-card routing decisions. Upsert by id (latest wins), capped.
 * Returns the persisted array.
 *
 * Entries with no routed agent are IGNORED: the compliance metric skips them
 * anyway, and keeping them would fill the cap with rows no reader ever looks at.
 */
export function appendRoutingLog(stateDir, entries = []) {
  const rows = Array.isArray(entries) ? entries.filter(e => e && e.id && e.route?.agent) : [];
  const existing = loadRoutingLog(stateDir);
  if (!rows.length) return existing;
  const byId = new Map(existing.filter(e => e?.id).map(e => [e.id, e]));
  for (const e of rows) {
    byId.set(e.id, {
      id: String(e.id),
      route: e.route ?? null,
      worktreeDir: e.worktreeDir ?? null,
      ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
    });
  }
  const next = [...byId.values()].slice(-MAX_ROWS);
  const file = logFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

/**
 * UNION of the live ledger and the durable routing log, keyed by card id, in
 * the shape computeRoutingCompliance already reads ({ route, worktree:{dir} }).
 *
 * De-duplication by id is the whole point: a card is counted once while it is
 * in flight and once more after it closes, and without this it would be counted
 * TWICE, inflating `routed` against the pre-registered n=20 threshold. The LIVE
 * entry wins on a collision: it is the same decision, but the fresher record of
 * it (a requeued job may have been relaunched with a new worktree).
 *
 * Pure: no I/O, so the union rule is testable without a state dir.
 */
export function mergeRoutingLedger(liveLedger = {}, logRows = []) {
  const merged = {};
  for (const row of Array.isArray(logRows) ? logRows : []) {
    if (!row?.id) continue;
    merged[row.id] = {
      route: row.route ?? null,
      worktree: row.worktreeDir ? { dir: row.worktreeDir } : null,
    };
  }
  for (const [id, entry] of Object.entries(liveLedger ?? {})) merged[id] = entry;
  return merged;
}
