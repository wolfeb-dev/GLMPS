// server/lib/orchestration/verify.js
// Phase 3 (glmps-81) -- layered verification: execution-first, independent
// critic second, an optional panel layer third. PURE: no I/O, no async, no
// network, no filesystem. This module only ORDERS and SHORT-CIRCUITS
// already-computed check results; it never decides whether to run a check,
// let alone runs one itself. The one I/O boundary in this phase (dispatching
// the cross-model critic via cross-model-eval.js) lives in server.js's /gate
// handler, which is the only place in this codebase's orchestration layer
// allowed to make a network call.
//
// Why this shape (see docs/superpowers/plans/2026-07-09-glmps-substrate-refactor.md,
// Phase 3): the harness literature (Anthropic's own guidance, SWE-bench/
// OpenHands, "Beyond Consensus") pushed back on "concurrent LLM critic panel
// + majority veto" as a PRIMARY gate -- LLM-as-judge is "generally not a very
// robust method" and naive majority-vote under-catches true negatives via
// shared agreeableness bias. What validated: deterministic execution checks
// first (ground truth, never overturned by a judge), then exactly one
// independent cross-model critic for the residual oracle-free judgement, with
// an optional ensemble-mean/severity panel layer only where the single critic
// is itself measured-unreliable.
//
// Check shape: { gate: 'exec' | 'critic' | 'panel', status: 'pass' | 'concerns' | 'fail', name? }
// Checks with an unrecognized `gate` value are ignored (forward-compatible,
// fail-open) rather than throwing.

// skipped sits between pass and concerns: nothing was evaluated, so it is not
// a clean pass, but it is not a failure either and never vetoes.
const RANK = { pass: 0, skipped: 0.5, concerns: 1, fail: 2 };

// An unrecognised status is treated as skipped so it can neither pass silently
// nor veto.
function statusOf(c) {
  return Object.hasOwn(RANK, c.status) ? c.status : 'skipped';
}

function worstStatus(checks) {
  return checks.reduce((worst, c) => (RANK[statusOf(c)] > RANK[worst] ? statusOf(c) : worst), 'pass');
}

// Would the execution layer allow a critic to be dispatched at all? Exposed
// so a CALLER (server.js's /gate handler, or any future dispatcher) can
// decide not to even make the network call -- the strongest form of "a
// failed execution check vetoes before any LLM critic runs": the critic is
// never invoked, not merely ignored after the fact.
export function execGatePassed(execChecks = []) {
  const list = Array.isArray(execChecks) ? execChecks : [];
  return !list.some(c => c.status === 'fail');
}

// Maps the ticket-level gate vocabulary (backlog-store.js's GATE_STATUSES:
// PASS|CONCERNS|FAIL|WAIVED) onto this module's pass|concerns|fail|skipped
// scale. WAIVED means nothing was evaluated, so it is skipped, not a pass
// (CLAUDE.md, docs/platform-autonomy.md rule 4). Unknown statuses are skipped.
export function fromGateStatus(status) {
  if (status === 'FAIL') return 'fail';
  if (status === 'CONCERNS') return 'concerns';
  if (status === 'PASS') return 'pass';
  return 'skipped';
}

// The core primitive. `checks` is an array of already-computed check results
// (see shape above). Returns { verdict, gate, failedBy }:
//   verdict  -- 'pass' | 'concerns' | 'fail', the aggregate outcome.
//   gate     -- which layer produced/decided the verdict ('exec'|'critic'|
//               'panel'), or null when no checks were supplied at all.
//   failedBy -- names of the checks responsible for a non-pass verdict ([]
//               when verdict is 'pass').
export function verdict(checks = []) {
  const list = Array.isArray(checks) ? checks : [];
  const execChecks = list.filter(c => c.gate === 'exec');
  const criticChecks = list.filter(c => c.gate === 'critic');
  const panelChecks = list.filter(c => c.gate === 'panel');

  // 1. Execution veto -- absolute and terminal. A failed execution check IS
  // the verdict, full stop: nothing below this line is even consulted, no
  // matter what a critic or panel check says (even a 'pass'). This is what
  // makes the veto un-overturnable, not just "usually respected."
  const failedExec = execChecks.filter(c => c.status === 'fail');
  if (failedExec.length) {
    return { verdict: 'fail', gate: 'exec', failedBy: failedExec.map(c => c.name ?? 'execution check') };
  }

  // Running "worst so far". Exec's own non-fail status (e.g. a declared
  // check that came back 'concerns') still counts toward the final verdict;
  // it just isn't severe enough to block the critic layer from running.
  let current = execChecks.length ? worstStatus(execChecks) : 'pass';
  let gate = execChecks.length ? 'exec' : null;
  let failedBy = execChecks.filter(c => statusOf(c) !== 'pass').map(c => c.name ?? 'execution check');

  // 2. Independent critic -- can only DOWNGRADE (concerns/fail), never raise
  // the verdict back toward pass and never overturn what exec established.
  if (criticChecks.length) {
    gate = 'critic';
    const criticWorst = worstStatus(criticChecks);
    if (RANK[criticWorst] > RANK[current]) {
      current = criticWorst;
      failedBy = criticChecks.filter(c => statusOf(c) !== 'pass').map(c => c.name ?? 'critic');
    }
  }

  // 3. Optional panel layer -- aggregated by ensemble-mean/severity, NEVER
  // naive majority-count. A naive majority-count over e.g. 3-pass/2-fail
  // reads as a clean pass (3 beats 2); mean-severity surfaces the 2 real
  // negatives instead of averaging them away (the "Beyond Consensus"
  // agreeableness-bias finding this guards against).
  if (panelChecks.length) {
    gate = 'panel';
    // Skipped members evaluated nothing, so they stay out of the mean; a panel
    // of only skipped members is itself skipped.
    const judged = panelChecks.filter(c => statusOf(c) !== 'skipped');
    const mean = judged.reduce((sum, c) => sum + RANK[statusOf(c)], 0) / (judged.length || 1);
    const panelStatus = !judged.length ? 'skipped' : mean >= 1.5 ? 'fail' : mean >= 0.5 ? 'concerns' : 'pass';
    if (RANK[panelStatus] > RANK[current]) {
      current = panelStatus;
      failedBy = panelChecks.filter(c => statusOf(c) !== 'pass').map(c => c.name ?? 'panel member');
    }
  }

  return { verdict: current, gate, failedBy: current === 'pass' ? [] : failedBy };
}

// The spec names either `verify(checks)` or `verdict(checks)` -- export both
// so either import name resolves to the same pure function.
export { verdict as verify };
