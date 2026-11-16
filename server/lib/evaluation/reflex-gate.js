// server/lib/evaluation/reflex-gate.js
//
// A0.4: gated reflex promotion. The "reflex layer" this gate protects is
// concretely the '## Learned guards' section of <assetsDir>/CLAUDE.global.md
// - the one file whose content auto-changes every future agent's behavior
// without a human in the loop at read time. Writing there is the single
// highest-leverage (and highest-risk) action this codebase's learning loop
// can take, so it is the one write this phase requires an explicit human
// confirmation for: approvePromotion throws unless humanApproved===true,
// with no config escape hatch (unlike the learning-write freeze in
// lesson-write.js, which IS configurable).
//
// Promotion state (requested/approved/denied/revoked) is recorded two ways,
// deliberately overlapping rather than duplicating:
//   - promotion.* spine events are the full audit trail (who, when, why).
//   - a 'promoted' / 'revoked' row appended to the SAME lesson-ledger
//     (lesson-ledger.js) that createLesson/lesson-decay.js/lesson-invalidate.js
//     already write to, so lessonsCurrent's existing (already-shipped, until
//     now unused) 'promoted'/'revoked' fold cases become the single source
//     of truth for a lesson's `reflex` flag. isPromoted reads THOSE ROWS
//     (lesson-ledger.js's reflexApproved) rather than re-deriving its own
//     view from the spine, so there is exactly one place "is this lesson
//     currently promoted" is computed - and one that also answers for an
//     approval recorded before the lesson's first landing (ADR-0001 s5).
//
// Zero runtime dependencies.
import { readLessonRows, lessonsCurrent, appendLessonRow, reflexApproved } from './lesson-ledger.js';
import { emitSpineEvent, SPINE_KINDS } from '../observability/spine.js';
import { evaluatePromotion } from './promotion.js';
import { scoreReplay } from './replay-score.js';

export class PromotionApprovalRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromotionApprovalRequiredError';
  }
}

function stampTs(now) {
  return typeof now === 'number' ? new Date(now).toISOString() : (now ?? new Date().toISOString());
}

/**
 * requestPromotion(stateDir, { lessonId, targetLayer, evidence, actor, now }) -> event
 * Emits promotion.requested. Does not itself change any lesson's reflex flag.
 */
export function requestPromotion(stateDir, { lessonId, targetLayer = 'reflex', evidence = {}, actor = 'operator', now } = {}) {
  const ts = stampTs(now);
  return emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.PROMOTION_REQUESTED,
    actor,
    ts,
    payload: { lessonId, targetLayer, evidence },
  });
}

/**
 * evaluateReflexPromotion({ evidence, baseline, directions }) -> { verdict, reasons }
 *
 * Two modes, both delegating the actual metric comparison rather than
 * reimplementing it:
 *   - `directions` supplied: flat-keyed evidence/baseline, delegated straight
 *     to promotion.js's evaluatePromotion (the same comparator every other
 *     champion/challenger call site in this codebase uses).
 *   - `directions` omitted: evidence/baseline are treated as OutcomeRow-
 *     shaped replay scorecards (this codebase's other convention) and scored
 *     via replay-score.js's scoreReplay against the frozen replay-task
 *     baseline, which is dot-path aware over a fixed, already-vetted metric
 *     list instead of requiring a caller to spell out directions for fields
 *     it does not know the shape of.
 */
export function evaluateReflexPromotion({ evidence = {}, baseline = {}, directions } = {}) {
  if (directions) {
    const { verdict, perMetric } = evaluatePromotion({ champion: baseline, challenger: evidence, directions });
    const reasons = Object.entries(perMetric)
      .filter(([, r]) => r === 'worse' || r === 'better')
      .map(([field, r]) => (r === 'worse' ? `regression on ${field}` : `improvement on ${field}`));
    return { verdict, reasons: reasons.length ? reasons : ['no measurable improvement'] };
  }

  const { regressed, improved } = scoreReplay(baseline, evidence);
  if (regressed.length > 0) {
    return { verdict: 'reject', reasons: regressed.map((f) => `regression on ${f}`) };
  }
  if (improved.length > 0) {
    return { verdict: 'promote', reasons: improved.map((f) => `improvement on ${f}`) };
  }
  return { verdict: 'hold', reasons: ['no measurable improvement'] };
}

/**
 * approvePromotion(stateDir, { lessonId, actor, humanApproved, now }) -> event
 *
 * A0.4, non-negotiable: throws PromotionApprovalRequiredError unless
 * humanApproved === true. No config lifts this - unlike the learning-write
 * freeze, this gate has no escape hatch in this phase.
 */
export function approvePromotion(stateDir, { lessonId, actor = 'operator', humanApproved, now } = {}) {
  if (humanApproved !== true) {
    throw new PromotionApprovalRequiredError(
      `promotion of lesson ${lessonId} to the reflex layer requires explicit human approval (humanApproved: true)`,
    );
  }
  const ts = stampTs(now);
  appendLessonRow(stateDir, { type: 'promoted', lessonId, ts });
  return emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.PROMOTION_APPROVED,
    actor,
    ts,
    payload: { lessonId },
  });
}

/**
 * autoApprovePromotion(stateDir, { lessonId, policy, evidence, now }) -> event
 *
 * Card glmps-2-0-201, ADR 0003: the one promotion no human clicked. It never
 * borrows approvePromotion's humanApproved flag; it records actor
 * 'auto-approver' and auto:true with the evidence that met the policy, so the
 * ledger cannot be read as the operator having approved it. Only landGuard
 * may call this (guard-apply-boundary.test.js), and only the auto-approve
 * loop passes landGuard an autoApproval.
 */
export const AUTO_APPROVER = 'auto-approver';
export function autoApprovePromotion(stateDir, { lessonId, policy, evidence, now } = {}) {
  if (typeof policy !== 'string' || !policy || !evidence || typeof evidence !== 'object') {
    throw new PromotionApprovalRequiredError(`auto-approval of lesson ${lessonId} needs a named policy and its evidence`);
  }
  const ts = stampTs(now);
  appendLessonRow(stateDir, { type: 'promoted', lessonId, ts, by: AUTO_APPROVER, auto: true });
  return emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.PROMOTION_APPROVED,
    actor: AUTO_APPROVER,
    ts,
    payload: { lessonId, auto: true, policy, evidence },
  });
}

/**
 * denyPromotion(stateDir, { lessonId, reason, actor, now }) -> event
 * Emits promotion.denied. Never touches the lesson-ledger's reflex flag.
 */
export function denyPromotion(stateDir, { lessonId, reason = null, actor = 'operator', now } = {}) {
  const ts = stampTs(now);
  return emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.PROMOTION_DENIED,
    actor,
    ts,
    payload: { lessonId, reason },
  });
}

/**
 * revokePromotion(stateDir, { lessonId, reason, actor, now }) -> event
 * Returns the lesson to session scope: appends a lesson-ledger 'revoked' row
 * (lessonsCurrent's existing fold sets reflex:false) and emits promotion.revoked.
 */
export function revokePromotion(stateDir, { lessonId, reason = null, actor = 'operator', now } = {}) {
  const ts = stampTs(now);
  appendLessonRow(stateDir, { type: 'revoked', lessonId, ts });
  return emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.PROMOTION_REVOKED,
    actor,
    ts,
    payload: { lessonId, reason },
  });
}

/**
 * isPromoted(stateDir, lessonId) -> boolean
 * Approved and not since revoked, folded from the SAME lesson-ledger rows the
 * projection reads (the single source of truth for a lesson's reflex flag -
 * see module doc).
 *
 * Deliberately reads reflexApproved rather than the projection's `reflex`
 * flag: an operator may approve a guard the loop has proposed but not yet
 * landed, and that approval has to be visible to the gate BEFORE the lesson's
 * created row exists or nothing could ever be both created and promoted
 * (ADR-0001 s5). For a lesson that does exist the two are the same answer.
 */
export function isPromoted(stateDir, lessonId) {
  return reflexApproved(readLessonRows(stateDir, { lessonId }), lessonId);
}

/**
 * autoRevoke(stateDir, { lessonId, gateFailures, invalidated, actor, now }) -> boolean
 *
 * Revokes a CURRENTLY-promoted lesson on an invalidation, or on
 * gateFailures >= 2 attributable failures. A no-op (returns false, emits
 * nothing) when the lesson is not currently promoted, so a lesson that was
 * never promoted (or already revoked) cannot generate a spurious
 * promotion.revoked event.
 */
export function autoRevoke(stateDir, { lessonId, gateFailures = 0, invalidated = false, actor = 'reflex-gate', now } = {}) {
  const shouldRevoke = invalidated === true || gateFailures >= 2;
  if (!shouldRevoke) return false;
  if (!isPromoted(stateDir, lessonId)) return false;
  const reason = invalidated ? 'invalidated' : `attributable gate failures (${gateFailures})`;
  revokePromotion(stateDir, { lessonId, reason, actor, now });
  return true;
}

/**
 * activeLessonsForRun(stateDir, runId) -> lessonId[]
 *
 * The per-lesson attribution list a nightly run's gate result is stamped
 * with, so an effect can be attributed to the specific reflex lesson(s) live
 * at that moment instead of blended across everything ever promoted. `runId`
 * is accepted (and stamped by the caller alongside this list onto the gate
 * result) for forward compatibility with a future per-run lesson-activation
 * ledger; this task has no such ledger yet, so the list returned here is
 * every lesson CURRENTLY both reflex-promoted and active (a decayed or
 * invalidated reflex lesson is not firing, so it is not attributable to any
 * run, past or future).
 */
export function activeLessonsForRun(stateDir, runId) {
  void runId;
  const current = lessonsCurrent(readLessonRows(stateDir, {}));
  const ids = [];
  for (const lesson of current.values()) {
    if (lesson.reflex === true && lesson.status === 'active') ids.push(lesson.lessonId);
  }
  return ids;
}
