// server/lib/orchestration/nightly-run.js
//
// Pure decision core for the nightly autonomous run (handoff Part A). Nothing
// here spawns a process, files a PR, or writes to a real repo: scripts/
// nightly-run.mjs is the injected-effects driver that calls into
// this module. Kept pure so the guardrails, the run planner and the gate
// bookkeeping can all be tested without a real clock, a real backlog file or
// a real git checkout.
import { killSwitchEngaged } from './nightly-config.js';
import { unresolvedBlockers } from './queue-runner.js';
import { emitSpineEvent, SPINE_KINDS } from '../observability/spine.js';

const GATE_STATUSES = new Set(['pass', 'fail', 'skipped']);

/**
 * The three non-negotiable guardrails, evaluated in this exact order because
 * each is a strictly more absolute, strictly cheaper-to-check stop than the
 * next one:
 *
 *   1. kill switch - an operator's explicit "stop", checked first so nothing
 *      else (an allowlist edit, a budget recompute) can race past it.
 *   2. repo allowlist - WHERE the run may write. An empty allowlist denies
 *      every repo: fail closed. This matters because `repoForProject` in
 *      server.js resolves any repo the server has ever seen a session cwd
 *      for, so an autonomous writer with an unset allowlist would otherwise
 *      have machine-wide write reach the moment `nightly.enabled` flips
 *      true. Requiring an explicit, non-empty allowlist is the only guard
 *      that survives an operator who forgets to configure one.
 *   3. budget - HOW MUCH the run may spend, checked last because it is the
 *      only one of the three that varies run to run rather than being a
 *      fixed operator decision.
 *
 * Returns `{ ok:true }` when every guardrail passes, otherwise
 * `{ ok:false, stop, reason }` where `stop` is one of 'kill-switch',
 * 'allowlist' or 'budget', naming which guardrail stopped the run.
 */
export function checkGuardrails({ config, stateDir, repo, project, spendUsd, tokens } = {}) {
  const cfg = config ?? {};

  if (killSwitchEngaged(stateDir, cfg)) {
    return { ok: false, stop: 'kill-switch', reason: 'nightly run disabled or kill file present' };
  }

  const target = project ?? repo ?? null;
  const allowlist = Array.isArray(cfg.repoAllowlist) ? cfg.repoAllowlist : [];
  if (allowlist.length === 0 || !target || !allowlist.includes(target)) {
    return { ok: false, stop: 'allowlist', reason: `"${target ?? ''}" is not on the nightly repoAllowlist` };
  }

  const budget = cfg.budget ?? {};
  if (Number.isFinite(budget.maxUsd) && Number.isFinite(spendUsd) && spendUsd > budget.maxUsd) {
    return { ok: false, stop: 'budget', reason: `spend $${spendUsd} exceeds the $${budget.maxUsd} nightly cap` };
  }
  if (Number.isFinite(budget.maxTokens) && Number.isFinite(tokens) && tokens > budget.maxTokens) {
    return { ok: false, stop: 'budget', reason: `token spend ${tokens} exceeds the ${budget.maxTokens} nightly cap` };
  }

  return { ok: true };
}

function pad2(n) { return String(n).padStart(2, '0'); }

// runId date suffix, UTC, from a Date/number/ISO-string `now` (defaults to
// the real clock). YYYYMMDD, matching the `nightly-<YYYYMMDD>` runId shape.
function runDateStamp(now) {
  const d = now === undefined ? new Date() : new Date(now);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/**
 * Choose tonight's work. Reuses queue-runner.js's own `unresolvedBlockers`
 * rather than re-deriving blocked-card semantics, so a card the interactive
 * queue runner treats as blocked is blocked here too, with one selection
 * rule instead of two that can drift apart.
 *
 * Every rejected candidate is reported with WHY it was skipped
 * (`quarantined`, `blocked`, `not-allowlisted`, `over-maxItems`), never
 * silently dropped: a nightly run nobody is watching live must leave a
 * legible trail of what it chose not to touch and why.
 *
 * A card that is not queued at all is not a "skip" in that sense (it was
 * never a candidate this run could have picked), so it produces no entry in
 * `skipped`, matching pickNextJob's own queued-only filter.
 */
export function planRun({ backlog = [], config, now, priorRuns = [] } = {}) {
  const cfg = config ?? {};
  const runId = `nightly-${runDateStamp(now)}`;
  const byId = new Map(backlog.map((i) => [i.id, i]));
  const allowlist = Array.isArray(cfg.repoAllowlist) ? cfg.repoAllowlist : [];
  const maxItems = Number.isFinite(cfg.maxItems) && cfg.maxItems > 0 ? cfg.maxItems : 1;

  const skipped = [];
  const candidates = [];
  for (const item of backlog) {
    if (item.state !== 'queued') continue;
    if (item.quarantined) { skipped.push({ id: item.id, reason: 'quarantined' }); continue; }
    if (unresolvedBlockers(item, byId).length) { skipped.push({ id: item.id, reason: 'blocked' }); continue; }
    if (!allowlist.includes(item.project)) { skipped.push({ id: item.id, reason: 'not-allowlisted' }); continue; }
    candidates.push(item);
  }
  candidates.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const items = candidates.slice(0, maxItems);
  for (const item of candidates.slice(maxItems)) {
    skipped.push({ id: item.id, reason: 'over-maxItems' });
  }

  // Nothing on a backlog card prices a run, so the only honest estimate is
  // what past nightly runs actually cost. With no history that is null, NOT
  // zero: zero is a claim ("this run is free") that a budget guardrail would
  // act on, and acting on a fabricated number is worse than acting on none.
  return { runId, items, skipped, estCost: estimateRunCost(priorRuns) };
}

/**
 * Estimate what tonight will cost from what previous nights actually cost.
 *
 * Median rather than mean: one pathological run (a retry storm, a budget
 * overrun) should not drag the estimate for every night after it. Runs with
 * no recorded cost are ignored rather than counted as zero, for the same
 * reason the no-history case returns null.
 *
 * @param priorRuns run.completed spine events, any order
 * @returns number|null (USD)
 */
export function estimateRunCost(priorRuns = []) {
  const costs = (priorRuns ?? [])
    .map((e) => e?.payload?.costActual?.usd)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (costs.length === 0) return null;
  const mid = Math.floor(costs.length / 2);
  return costs.length % 2 === 1 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2;
}

/**
 * Propose tomorrow night's backlog (handoff A1 step 5).
 *
 * Built from what tonight could not reach, which is the only proposal the run
 * has evidence for. Two exclusions are deliberate:
 *
 *   * `quarantined` is never proposed. Proposing a poison-quarantined card
 *     would launder the intake gate through the runner's own suggestion, which
 *     is exactly the path the poisoning safeguards exist to close.
 *   * `not-allowlisted` is never proposed. It is out of the runner's reach by
 *     operator decision; suggesting it every night is noise, not a proposal.
 *
 * `blocked` IS proposed, because a blocker can clear overnight and the whole
 * point of a proposal is to be re-evaluated at the next run.
 */
export function proposeNextBacklog({ skipped = [], max = 10 } = {}) {
  const PROPOSABLE = new Set(['over-maxItems', 'blocked']);
  return skipped
    .filter((s) => PROPOSABLE.has(s.reason))
    .map((s) => s.id)
    .slice(0, max);
}

/**
 * Record one gate's outcome onto the spine. `status` is one of
 * pass|fail|skipped. A gate that does not exist yet for this run (missing
 * config, an unavailable dependency, whatever the reason) MUST still be
 * recorded here by the caller with status:'skipped' - never omitted, because
 * a skipped gate is a monitored metric (A1 step 4), not silence.
 */
export function recordGateResult(stateDir, { runId, gateName, status, details = null, lessonIds = [] } = {}) {
  if (!GATE_STATUSES.has(status)) {
    throw new TypeError(`invalid gate status: ${String(status)} (expected pass, fail or skipped)`);
  }
  return emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.RUN_GATE_RESULT,
    actor: 'nightly-runner',
    payload: { runId, gateName, status, details, lessonIds },
  });
}

/**
 * The review.completed(cadence:'nightly') payload (handoff A1): what tonight
 * attempted, what shipped, which gates passed, were skipped or failed, what
 * is blocking, and the spend. Pure, like the rest of this module: emitting
 * it onto the spine is the Task 10 driver's job, not this function's.
 */
export function summarizeRun({ runId, items = [], prs = [], gateResults = [], spend, blockers = [], skipped = [], nextBacklogProposal } = {}) {
  const byStatus = (status) => gateResults.filter((g) => g.status === status).map((g) => g.gateName);
  const s = spend ?? {};
  return {
    cadence: 'nightly',
    runId,
    itemsAttempted: items.map((i) => i.id),
    prsFiled: prs.map((p) => p.url).filter(Boolean),
    gatesPassed: byStatus('pass'),
    gatesSkipped: byStatus('skipped'),
    gatesFailed: byStatus('fail'),
    blockers,
    spend: {
      usd: Number.isFinite(s.usd) ? s.usd : 0,
      tokens: Number.isFinite(s.tokens) ? s.tokens : 0,
    },
    nextBacklogProposal: nextBacklogProposal ?? proposeNextBacklog({ skipped }),
  };
}

/**
 * The `run.completed` event payload, using the field names the handoff's A2
 * table specifies: run_id, prs[], items_done[], items_blocked[], cost_actual,
 * next_backlog_proposal (camelCased to match this codebase's record style).
 *
 * This is deliberately a DIFFERENT payload from summarizeRun's. A2 defines
 * `run.completed` and B3 defines `review.completed`; they are two events with
 * two audiences, and collapsing them would force one consumer to understand
 * the other's vocabulary.
 *
 * `gatesSkipped` is included even though A2 does not list it. A2 gives the
 * MINIMUM payload, and the morning brief needs the skipped-gate names to
 * satisfy A1 step 4 (a skipped gate is a monitored metric, not silence)
 * without replaying every run.gate_result event.
 */
export function runCompletedPayload({ runId, prs = [], itemsDone = [], itemsBlocked = [], gateResults = [], spend, nextBacklogProposal = [] } = {}) {
  const byStatus = (status) => gateResults.filter((g) => g.status === status).map((g) => g.gateName);
  const s = spend ?? {};
  return {
    runId,
    prs: prs.map((p) => (typeof p === 'string' ? p : p?.url)).filter(Boolean),
    itemsDone,
    itemsBlocked,
    gatesPassed: byStatus('pass'),
    gatesSkipped: byStatus('skipped'),
    gatesFailed: byStatus('fail'),
    costActual: {
      usd: Number.isFinite(s.usd) ? s.usd : 0,
      tokens: Number.isFinite(s.tokens) ? s.tokens : 0,
    },
    nextBacklogProposal,
  };
}
