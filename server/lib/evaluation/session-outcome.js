/**
 * session-outcome.js
 * Session-outcome orchestrator. Composes outcome-record, task-classify,
 * outcome-metrics, verifier-signals, and outcome-store into a single API.
 * Zero deps, Node 18+ ESM.
 */

import fs from 'node:fs';
import { emptyOutcome, mergeOutcome } from './outcome-record.js';
import { computeMetrics } from './outcome-metrics.js';
import { verifierFromEvents, acceptanceCoverage, verifierFromDoneGate } from './verifier-signals.js';
import { appendOutcome, readOutcomes, updateOutcome, outcomeFile } from './outcome-store.js';

/**
 * @param {{
 *   sessionId: string,
 *   events?: object[],
 *   usage?: object|null,
 *   firstPrompt?: string,
 *   filesTouched?: string[],
 *   acceptanceText?: string,
 *   doneGateRecords?: object[],
 *   unit?: string,
 *   model?: string|null,
 *   actor?: string|null,
 * }} opts
 * @returns {object} OutcomeRow
 */
export function buildSessionOutcome({
  sessionId,
  events = [],
  usage = null,
  // firstPrompt/filesTouched: kept in the signature for callers (server.js's
  // finalize route still computes and passes both, for the judge plugin call
  // that follows finalizeSession) - classifyTask() was their only reader
  // inside this function and is gone (D23/D24 judge cutover, task 8).
  firstPrompt = '',
  filesTouched = [],
  acceptanceText = '',
  doneGateRecords = [],
  unit,
  model,
  actor,
} = {}) {
  const id = `session-${sessionId}`;
  unit = unit ?? 'session';

  // ts = last event ts or null
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const ts = sorted.length > 0 ? sorted[sorted.length - 1].ts : null;

  // model: explicit opt wins; otherwise derive from the LAST event (by ts)
  // that carries a truthy string model field (the shared event shape has an
  // optional model field); null if neither is present.
  let derivedModel = null;
  for (const e of sorted) {
    if (typeof e.model === 'string' && e.model) derivedModel = e.model;
  }

  // actor: same derivation pattern as model - a diagnostics covariate only
  // (glmps-72 Workstream B). Explicit opt wins; otherwise the LAST event (by
  // ts) that carries a truthy string actor field; null if neither is present.
  let derivedActor = null;
  for (const e of sorted) {
    if (typeof e.actor === 'string' && e.actor) derivedActor = e.actor;
  }

  // D23/D24 judge cutover (glmps-159 task 8): classifyTask() is deleted from
  // this path (task-classify.js itself stays - queue-runner.js's
  // resolveRoute is its only remaining caller, never ported). Every row
  // starts 'pending'; the judge plugin fills in the real class from the
  // finalize route (server.js), fire-and-forget, once the session is judged.
  const taskClass = 'pending';

  let row = emptyOutcome({ id, unit, ts, taskClass });
  row = mergeOutcome(row, computeMetrics({ events, usage }));

  const dg = verifierFromDoneGate(doneGateRecords);
  row.verifier = { ...verifierFromEvents(events), exitOk: dg.exitOk, evidence: dg.evidence };
  row.acceptance = acceptanceCoverage(acceptanceText, events);
  row.model = model !== undefined ? model : derivedModel;
  row.actor = actor !== undefined ? actor : derivedActor;

  row.committed = events.some(e =>
    /commit/i.test(String(e.label ?? e.kind ?? ''))
  ) ? true : null;

  return row;
}

/**
 * @param {string} stateDir
 * @param {object} input - same shape as buildSessionOutcome opts
 * @returns {{ row: object, appended: boolean }}
 */
export function finalizeSession(stateDir, input) {
  const row = buildSessionOutcome(input);
  const existing = readOutcomes(stateDir).find(r => r.id === row.id);
  if (existing) {
    // The row is written at the first Stop while the done-gate (a parallel
    // Stop hook) is still running, so its verdict lands later (card
    // glmps-2-0-192). A later finalize carries it in; no verdict keeps the old one.
    const v = row.verifier;
    if (v?.exitOk != null && v.exitOk !== existing.verifier?.exitOk) {
      const { row: updated } = updateOutcome(stateDir, existing.id, { verifier: { ...(existing.verifier || {}), exitOk: v.exitOk, evidence: v.evidence } });
      return { row: updated ?? existing, appended: false };
    }
    return { row: existing, appended: false };
  }
  appendOutcome(stateDir, row);
  return { row, appended: true };
}

/**
 * For each gitEvent that reverts/amends a prior session commit, mark
 * revertedLater:true on the matching session row via updateOutcome.
 *
 * @param {string} stateDir
 * @param {object[]} gitEvents
 * @returns {number} count of rows updated
 */
export function backfillReverts(stateDir, gitEvents = []) {
  let count = 0;
  try {
    for (const ev of gitEvents) {
      try {
        const label = String(ev.label ?? ev.kind ?? '');
        const isRevertOrAmend = /revert|amend/i.test(label);
        if (!isRevertOrAmend) continue;

        // Determine target row id
        let targetId = null;
        if (ev.sessionId) {
          targetId = `session-${ev.sessionId}`;
        } else if (ev.targetId) {
          targetId = ev.targetId;
        }
        if (!targetId) continue;

        const { row } = updateOutcome(stateDir, targetId, { revertedLater: true });
        if (row) count++;
      } catch {
        // defensive: skip malformed events
      }
    }
  } catch {
    // defensive: no throw on outer errors
  }
  return count;
}

// The judge verdict and revert marker for one session's detail page
// (session-detail spec section 8 item 2). A row with no judge record yet is
// 'pending': the judge runs after the session goes idle.
export function sessionOutcomeDetail(row) {
  const j = row.extra?.judge ?? null;
  let judge = { status: 'pending' };
  if (j) {
    judge = {
      status: j.skipped ? 'skipped' : (j.pass ? 'pass' : 'concerns'),
      by: j.by ?? null, pass: j.skipped ? null : !!j.pass, comment: j.comment ?? '', reason: j.reason ?? '',
      ts: j.ts ?? null, skipped: j.skipped ?? null, coerced: !!j.coerced,
    };
  }
  return {
    taskClass: row.taskClass ?? null, outcomeClass: row.extra?.outcomeClass ?? null,
    revertedLater: row.revertedLater ?? null, judge,
  };
}

// The rows file is ~1 MB on a live box, so it is reparsed only when its
// mtime or size moves, not on every detail-page refresh.
export function createSessionOutcomeLookup(stateDir, { read = readOutcomes, stat = fs.statSync } = {}) {
  const file = outcomeFile(stateDir);
  let key = null;
  let byId = new Map();
  return (sid) => {
    if (!sid) return null;
    let k;
    try { const s = stat(file); k = `${s.mtimeMs}:${s.size}`; } catch { k = 'missing'; }
    if (k !== key) { byId = new Map(read(stateDir).map((r) => [r.id, r])); key = k; }
    const row = byId.get(`session-${sid}`);
    return row ? sessionOutcomeDetail(row) : null;
  };
}
