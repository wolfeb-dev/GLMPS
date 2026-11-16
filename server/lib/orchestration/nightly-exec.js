// server/lib/orchestration/nightly-exec.js
//
// How the nightly run actually executes a backlog item.
//
// The important decision here is what this module does NOT do: it does not
// spawn an agent. GLMPS already has one launcher - the queue
// runner's `launchJob` in server.js, with worktree isolation, prompt-file
// seeding, the Windows cmd recipe, liveness reconciliation, retry and
// gate-wait accounting. Re-implementing any of that in a nightly script would
// create a second, divergent launcher, and the two would drift the first time
// one of them was fixed.
//
// So the executor drives the EXISTING path over HTTP: POST /api/runner/run/:id
// launches the card exactly the way an operator's "Run now" does, and then this
// polls the card until it reaches a terminal state. One launcher, one set of
// semantics, and the nightly run inherits every guard the queue runner already
// has (poison quarantine, act-gate, blocked-by, worktree isolation).
//
// Zero runtime dependencies. Every effect (fetch, clock, sleep, usage read) is
// injectable so the whole flow tests offline.
import { readUsage } from '../observability/usage-store.js';
import { FINISHED } from './queue-runner.js';

// The gates the verifier stack is SUPPOSED to have (handoff A3/Q5). Any of
// these that has no result for a run is recorded as 'skipped' rather than
// omitted: A1 step 4 makes a missing gate a monitored metric, and silence
// would let an incomplete verifier stack look finished.
export const DECLARED_GATES = Object.freeze([
  'acceptance',           // npm test / acceptance.md, the one that exists today
  'test-before-code',     // Q5, not built
  'adversarial-review',   // Q5, not built
  'cross-model-critic',   // A3, exists as cross-model-eval.js but is not wired into a run
]);

// Terminal card states: the SAME Set queue-runner.js's reconcileLedger uses to
// decide a ledger entry can depart, imported rather than duplicated so the two
// questions ("is this card's session over") can never drift apart again.
const SUCCESS = new Set(['done', 'in_review']);

/**
 * The real cost of the session a card ran in.
 *
 * Read straight from the usage ledger rather than from a quota percentage:
 * server/lib/observability/budget.js reports plan utilization, which cannot
 * answer "what did tonight cost". Without this the budget guardrail would have
 * nothing real to bind against.
 */
export function sessionSpend(stateDir, sessionId, { readUsageFn = readUsage } = {}) {
  if (!sessionId) return { usd: 0, tokens: 0 };
  try {
    const row = (readUsageFn(stateDir)?.perSession ?? []).find((s) => s.sid === sessionId);
    if (!row) return { usd: 0, tokens: 0 };
    return {
      usd: Number(row.costUsd) || 0,
      tokens: (Number(row.input) || 0) + (Number(row.output) || 0),
    };
  } catch {
    return { usd: 0, tokens: 0 };
  }
}

/**
 * Turn a finished card into this run's gate results.
 *
 * The WAIVED mapping is the one worth reading twice: a waiver means the gate
 * did not evaluate anything, so it is recorded as 'skipped', not 'pass'.
 * Recording waivers as passes would let a run that waived its way through look
 * identical to one that earned its way through, and would starve the
 * skipped_gates drift check of exactly the signal it exists to catch.
 */
export function gateResultsFromCard(card = {}) {
  const gate = card.gate ?? null;
  const evidence = Array.isArray(gate?.evidence) ? gate.evidence.join('; ') : null;

  let acceptance;
  if (!gate || !gate.status) {
    acceptance = { gateName: 'acceptance', status: 'skipped', details: 'no gate recorded on the card' };
  } else {
    const s = String(gate.status).toUpperCase();
    if (s === 'PASS') acceptance = { gateName: 'acceptance', status: 'pass', details: evidence };
    else if (s === 'FAIL') acceptance = { gateName: 'acceptance', status: 'fail', details: evidence };
    else if (s === 'WAIVED') acceptance = { gateName: 'acceptance', status: 'skipped', details: `waived: ${evidence ?? 'no reason given'}` };
    else acceptance = { gateName: 'acceptance', status: 'pass', details: `concerns: ${evidence ?? 'none recorded'}` };
  }

  return [
    acceptance,
    ...DECLARED_GATES.filter((g) => g !== 'acceptance').map((gateName) => ({
      gateName, status: 'skipped', details: 'gate not implemented yet',
    })),
  ];
}

/**
 * Build the execItem function the nightly driver calls per backlog item.
 *
 * @returns async (item) -> { ok, branch, gateResults, spend, error? }
 */
export function makeHttpExecItem({
  port = '8123',
  stateDir,
  timeoutMs = 60 * 60 * 1000,
  pollMs = 15000,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  readUsageFn = readUsage,
} = {}) {
  const base = `http://127.0.0.1:${port}`;

  return async function execItem(item) {
    // 1. Launch through the existing runner path.
    try {
      const res = await fetchFn(`${base}/api/runner/run/${encodeURIComponent(item.id)}`, { method: 'POST' });
      if (!res.ok) {
        let why = `HTTP ${res.status}`;
        try { why = (await res.json())?.error ?? why; } catch { /* keep the status */ }
        return { ok: false, branch: null, gateResults: [], spend: { usd: 0, tokens: 0 }, error: `launch refused: ${why} (${res.status})` };
      }
    } catch (e) {
      return { ok: false, branch: null, gateResults: [], spend: { usd: 0, tokens: 0 }, error: `launch failed: ${e?.message ?? e}` };
    }

    // 2. Poll the card until it reaches a terminal state or the deadline.
    const deadline = now() + timeoutMs;
    let card = null;
    while (now() < deadline) {
      await sleepFn(pollMs);
      try {
        const res = await fetchFn(`${base}/api/backlog?project=${encodeURIComponent(item.project ?? '')}`);
        if (res.ok) {
          const found = ((await res.json())?.items ?? []).find((c) => c.id === item.id);
          if (found) {
            card = found;
            if (FINISHED.has(found.state)) break;
          }
        }
      } catch { /* a transient dashboard blip is not a failed item; keep polling */ }
    }

    if (!card || !FINISHED.has(card.state)) {
      return {
        ok: false, branch: card?.branch ?? null, gateResults: [],
        spend: sessionSpend(stateDir, card?.sessionId, { readUsageFn }),
        error: `item timed out after ${Math.round(timeoutMs / 60000)}m in state ${card?.state ?? 'unknown'}`,
      };
    }

    const spend = sessionSpend(stateDir, card.sessionId, { readUsageFn });
    const gateResults = gateResultsFromCard(card);

    // A cancelled or archived card is a terminal state, but not a success.
    // Calling it done would let the autonomy metrics count an abandoned item
    // as a clean merge.
    if (!SUCCESS.has(card.state)) {
      return { ok: false, branch: card.branch ?? null, gateResults, spend, error: `item ended in state ${card.state}` };
    }

    return { ok: true, branch: card.branch ?? null, gateResults, spend };
  };
}
