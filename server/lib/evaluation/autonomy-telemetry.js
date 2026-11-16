// server/lib/evaluation/autonomy-telemetry.js
//
// Autonomy telemetry (handoff Part C): instrument before improving.
//
// The question this answers is "how much human hand-holding does a merged
// agent-authored change actually cost, per task class, per week" - and then,
// only once that is measured, whether a task class has earned one more notch of
// autonomy.
//
// Three ideas, kept deliberately small:
//
//   1. human.touch - every time a person has to intervene on agent-authored
//      work (a review comment demanding changes, a manual edit to an
//      agent-authored diff, a manual revert, a manual re-run). Some of these
//      are auto-capturable later; the rest come from `scripts/touch.mjs`
//      (the `glmps touch <type> <ref>` CLI).
//
//   2. Derived metrics - zero-edit merge rate, human touches per merged
//      change, revert rate. These are VIEWS over the log, computed on demand;
//      nothing is precomputed and stored, so a corrected touch log corrects
//      the metrics retroactively.
//
//   3. The graduation rule - a task class may graduate one autonomy tier after
//      N consecutive zero-edit merges; ANY revert demotes it one tier. The
//      config is human-changeable only: it lives in config.json and is
//      deliberately given no mutation route, so an autonomous runner cannot
//      lower its own bar.
//
// Every metric is reported PER TASK CLASS and never blended, for the same
// reason the reconciliation checks are individually toggleable: a single
// blended number hides which mechanism actually moved.
//
// Graduations and demotions are recorded as events (decision.recorded with
// kind 'autonomy_graduation') rather than as a silent config write. The spec's
// standing rule is that a deferral or a policy change is a written decision,
// never silence; a tier change is exactly that kind of policy change. Reusing
// decision.recorded rather than minting two more event kinds keeps the typed
// kind set closed and small.
//
// Zero runtime dependencies. Every function that needs "now" takes it as an
// argument: nothing here reads the clock on its own.
import { emitSpineEvent, readSpineEvents, SPINE_KINDS } from '../observability/spine.js';

export const TOUCH_TYPES = Object.freeze([
  'review-comment',   // a PR review comment that required changes
  'manual-edit',      // a human edited an agent-authored diff
  'manual-revert',    // a human reverted agent-authored work
  'manual-rerun',     // a human had to re-run the job
]);

// A touch of one of these types means the merge was NOT zero-edit. A rerun is
// deliberately excluded: re-running a job costs operator attention (so it
// counts in touchesPerMerge) but it does not mean the produced diff was wrong.
const EDIT_TYPES = new Set(['review-comment', 'manual-edit', 'manual-revert']);

export const DEFAULT_GRADUATION_CONFIG = Object.freeze({
  graduateAfter: 10,  // consecutive zero-edit merges to earn one tier
  maxTier: 2,
});

function toMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (typeof ts === 'string') { const n = Date.parse(ts); return Number.isNaN(n) ? null : n; }
  return null;
}

// recordTouch / readTouches

// Record one human intervention. Throws TypeError on an unknown type so a
// typo cannot quietly create a category nothing aggregates.
export function recordTouch(stateDir, { type, ref, taskClass = 'other', actor = 'operator', ts, note = null } = {}) {
  if (!TOUCH_TYPES.includes(type)) {
    throw new TypeError(`unknown human touch type: ${String(type)} (expected one of ${TOUCH_TYPES.join(', ')})`);
  }
  return emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.HUMAN_TOUCH,
    label: `human.touch ${type}`,
    actor,
    ts,
    payload: { type, ref: ref ?? null, taskClass, note },
  });
}

// Read the touch log back as flat rows: { type, ref, taskClass, note, ts, actor }.
export function readTouches(stateDir, { since } = {}) {
  return readSpineEvents(stateDir, { kind: SPINE_KINDS.HUMAN_TOUCH, since })
    .map((e) => ({ ...e.payload, ts: e.ts, actor: e.actor }));
}

// autonomyMetrics

/**
 * Derived autonomy metrics, per task class, over a trailing window.
 *
 * @param touches  [{ type, ref, taskClass, ts }]
 * @param merges   [{ ref, taskClass, ts }] - merged agent-authored changes
 * @param opts     { windowDays, now }
 * @returns { windowDays, from, byTaskClass: { [cls]: {
 *            merges, touches, zeroEditMerges, reverts,
 *            zeroEditMergeRate, touchesPerMerge, revertRate,
 *            consecutiveZeroEdit } } }
 *
 * Rates are null (not 0, and not NaN) when the class has no merges in the
 * window: "no data" and "zero percent" are different claims and the caller
 * must not be able to confuse them.
 */
export function autonomyMetrics(touches = [], merges = [], { windowDays = 7, now = 0 } = {}) {
  const nowMs = toMs(now) ?? 0;
  const from = nowMs - windowDays * 86400000;
  const inWindow = (r) => { const t = toMs(r.ts); return t !== null && t >= from && t <= nowMs; };

  const wTouches = touches.filter(inWindow);
  const wMerges = merges.filter(inWindow);

  const classes = new Set([...wTouches.map((t) => t.taskClass ?? 'other'), ...wMerges.map((m) => m.taskClass ?? 'other')]);

  // ref -> the touch types recorded against it, so a merge can be classified
  // without an O(n*m) rescan per merge.
  const byRef = new Map();
  for (const t of wTouches) {
    if (!t.ref) continue;
    if (!byRef.has(t.ref)) byRef.set(t.ref, new Set());
    byRef.get(t.ref).add(t.type);
  }
  const isZeroEdit = (ref) => {
    const types = byRef.get(ref);
    if (!types) return true;
    for (const ty of types) if (EDIT_TYPES.has(ty)) return false;
    return true;
  };

  const byTaskClass = {};
  for (const cls of classes) {
    const clsMerges = wMerges.filter((m) => (m.taskClass ?? 'other') === cls)
      .slice()
      .sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0));
    const clsTouches = wTouches.filter((t) => (t.taskClass ?? 'other') === cls);

    const zeroEditMerges = clsMerges.filter((m) => isZeroEdit(m.ref)).length;
    const reverts = clsMerges.filter((m) => byRef.get(m.ref)?.has('manual-revert')).length;

    // The trailing streak, not the total: what "10 consecutive" means is the
    // most recent unbroken run, so one bad merge in the middle resets it.
    let consecutiveZeroEdit = 0;
    for (let i = clsMerges.length - 1; i >= 0; i--) {
      if (!isZeroEdit(clsMerges[i].ref)) break;
      consecutiveZeroEdit++;
    }

    const n = clsMerges.length;
    byTaskClass[cls] = {
      merges: n,
      touches: clsTouches.length,
      zeroEditMerges,
      reverts,
      zeroEditMergeRate: n ? zeroEditMerges / n : null,
      touchesPerMerge: n ? clsTouches.length / n : null,
      revertRate: n ? reverts / n : null,
      consecutiveZeroEdit,
    };
  }

  return { windowDays, from, byTaskClass };
}

// graduationDecision

/**
 * The autonomy ladder rule. A revert always wins over a good streak: the
 * spec's wording is "any revert demotes it one tier", with no offsetting
 * clause, and that asymmetry is the point - autonomy is easy to lose and slow
 * to earn.
 *
 * @param opts { metrics, tier, config }
 * @returns { action: 'graduate'|'demote'|'hold', tier, reason }
 */
export function graduationDecision({ metrics, tier = 0, config = {} } = {}) {
  const cfg = { ...DEFAULT_GRADUATION_CONFIG, ...config };
  const m = metrics ?? {};

  if ((m.reverts ?? 0) > 0) {
    if (tier <= 0) {
      return { action: 'hold', tier: 0, reason: 'revert observed but already at the lowest tier' };
    }
    return { action: 'demote', tier: tier - 1, reason: `${m.reverts} revert(s) in window` };
  }

  if ((m.consecutiveZeroEdit ?? 0) >= cfg.graduateAfter) {
    if (tier >= cfg.maxTier) {
      return { action: 'hold', tier, reason: `already at the maximum tier ${cfg.maxTier}` };
    }
    return { action: 'graduate', tier: tier + 1, reason: `${m.consecutiveZeroEdit} consecutive zero-edit merges` };
  }

  return {
    action: 'hold',
    tier,
    reason: `${m.consecutiveZeroEdit ?? 0} of ${cfg.graduateAfter} consecutive zero-edit merges`,
  };
}

// recordGraduation / readGraduations

// Write a tier change to the spine as a decision event. Refuses a 'hold':
// nothing changed, so there is no decision to record, and recording one would
// bury the real transitions in noise.
export function recordGraduation(stateDir, { taskClass, action, from, to, reason = null, actor = 'operator', ts } = {}) {
  if (action !== 'graduate' && action !== 'demote') {
    throw new TypeError(`recordGraduation expects action graduate or demote, got ${String(action)}`);
  }
  return emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.DECISION_RECORDED,
    label: `autonomy ${action} ${taskClass}`,
    actor,
    ts,
    payload: { kind: 'autonomy_graduation', taskClass, action, from, to, reason },
  });
}

export function readGraduations(stateDir, { since } = {}) {
  return readSpineEvents(stateDir, { kind: SPINE_KINDS.DECISION_RECORDED, since })
    .filter((e) => e.payload?.kind === 'autonomy_graduation')
    .map((e) => ({ ...e.payload, ts: e.ts, actor: e.actor }));
}

/**
 * currentTiers(stateDir) -> { [taskClass]: tier }
 *
 * The current autonomy tier of each class, DERIVED from the spine rather than
 * stored anywhere. readGraduations returns events oldest-first, so the last
 * write per class wins. A class that has never graduated is simply absent,
 * which the caller reads as tier 0.
 *
 * Deriving rather than storing is deliberate: a separate tier file would be a
 * second source of truth that could disagree with the event log, and the log
 * is the thing the spec says a tier change must be recorded in.
 */
export function currentTiers(stateDir, { since } = {}) {
  const tiers = {};
  for (const g of readGraduations(stateDir, { since })) {
    if (g && typeof g.taskClass === 'string' && Number.isFinite(g.to)) tiers[g.taskClass] = g.to;
  }
  return tiers;
}

/**
 * runGraduationSweep(stateDir, { metrics, config, actor, now }) -> acted[]
 *
 * The caller Part C shipped without. graduationDecision was pure and correct
 * and nothing ever ran it, so no task class could graduate no matter how long
 * its zero-edit streak got.
 *
 * Evaluates every class present in the metrics window against its current
 * tier, and records ONLY real transitions - recordGraduation refuses a 'hold'
 * by contract, and writing one anyway would bury the real transitions in
 * nightly noise.
 */
export function runGraduationSweep(stateDir, { metrics, config = {}, actor = 'operator', now } = {}) {
  const tiers = currentTiers(stateDir);
  const acted = [];
  for (const [taskClass, m] of Object.entries(metrics?.byTaskClass ?? {})) {
    const from = tiers[taskClass] ?? 0;
    const d = graduationDecision({ metrics: m, tier: from, config });
    if (d.action === 'hold') continue;
    recordGraduation(stateDir, { taskClass, action: d.action, from, to: d.tier, reason: d.reason, actor, now });
    acted.push({ taskClass, action: d.action, from, to: d.tier, reason: d.reason });
  }
  return acted;
}
