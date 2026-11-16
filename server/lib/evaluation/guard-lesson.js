// server/lib/evaluation/guard-lesson.js
//
// landGuard is THE only way a guard may reach a governed instruction file.
// Both routes that used to call applyGuard directly (POST /api/learning/item/
// :id/promote and .../approve) and the automatic gap-pipeline path go through
// here, so a guard can never land without a provenance-carrying ledger row and
// a recorded gate decision. See
// docs/adr/0001-learning-store-lesson-ledger-boundary.md.
//
// Why this module exists at all: glmps-74 found guards being written
// into CLAUDE.global.md's '## Learned guards' by two HTTP routes with no ledger
// row, no provenance and no gate. A guard applied that way is invisible to the
// ungated_reflex drift check, because that check reads the ledger. The fix is
// not "remember to call writeLesson too" - it is one function nothing may go
// around, backed by a static source test (guard-apply-boundary.test.js) that
// fails the build if any other file calls applyGuard.
//
// Order matters and is fixed:
//   1. resolve the canonical lesson id (one scheme, all routes)
//   2. record the operator's approval as a REAL promotion when a human asked
//      for this write. The operator's click IS the human confirmation A0.4
//      requires; recording it is honest, and it stays revocable. Writing into
//      the reflex layer with reflex:false would have been the bypass.
//   3. assert the freeze and the gate BEFORE appending anything, so a refused
//      guard leaves the ledger byte-identical
//   4. create the lesson through writeLesson when it has none - writeLesson
//      stays the only way a created row lands, and it invalidates that row
//      itself if the write then fails
//   5. otherwise perform the write alone: the lesson predates this call, so a
//      failure here must not invalidate a guard that already landed.
//
// Zero runtime dependencies.
import { applyGuard as applyGuardDefault } from './learning-apply.js';
import {
  writeLesson as writeLessonDefault,
  assertReflexWritable as assertReflexWritableDefault,
} from './lesson-write.js';
import {
  isPromoted as isPromotedDefault,
  requestPromotion as requestPromotionDefault,
  approvePromotion as approvePromotionDefault,
  autoApprovePromotion as autoApprovePromotionDefault,
  revokePromotion as revokePromotionDefault,
  AUTO_APPROVER,
} from './reflex-gate.js';
import { removeGuard as removeGuardDefault } from './learning-apply.js';
import { assertProvenance, normalizeProvenance } from './lesson-provenance.js';
import { readLessonRows as readLessonRowsDefault } from './lesson-ledger.js';

/**
 * lessonIdForLearningItem(itemId) -> 'legacy:<itemId>' | null
 *
 * The one lesson-id scheme for a guard derived from a learning-store item.
 * The prefix names the SOURCE STORE, not the age of the row: the id after the
 * colon is the legacy store's own stable dedup key (sha1 of code|project), so
 * an item the 2026-08-21 migration recorded and the same item landed by a
 * route today resolve to ONE lesson. Before this, the migration wrote
 * 'legacy:<id>' and gap-pipeline wrote the bare id, which would have made the
 * same guard two unrelated lessons and broken every join between the stores.
 */
export function lessonIdForLearningItem(itemId) {
  const id = typeof itemId === 'string' ? itemId.trim() : '';
  return id ? `legacy:${id}` : null;
}

/**
 * landGuard(stateDir, {
 *   itemId, kind, title, provenance, actor, humanApproval, config, now,
 *   guard: { assetsDir, file, section, rule, message, simThreshold,
 *            stateDir, taskClass, sid },   // forwarded verbatim to applyGuard
 *   applyGuardFn, writeLessonFn, assertReflexWritableFn, isPromotedFn,
 *   requestPromotionFn, approvePromotionFn, readLessonRowsFn,  // injectable
 * }) -> { lessonId, created, result }
 *
 * `result` is applyGuard's { commit, changed }. `created` says whether THIS
 * call appended the lesson's created row, which is what decides whether a
 * failed write invalidates it.
 *
 * `humanApproval: true` means a human POSTed this write right now. It is the
 * only thing that records a promotion, and no automatic caller may pass it.
 * Throws ReflexNotPromotedError when an automatic caller targets a lesson no
 * human has approved, LearningWriteFrozenError under the freeze, and
 * LessonProvenanceError for an untraceable origin - in every case before the
 * guard reaches the file.
 */
export function landGuard(stateDir, {
  itemId,
  kind = 'guard',
  title,
  provenance,
  actor = 'operator',
  humanApproval = false,
  autoApproval = null,
  config,
  now,
  guard = {},
  applyGuardFn = applyGuardDefault,
  writeLessonFn = writeLessonDefault,
  assertReflexWritableFn = assertReflexWritableDefault,
  isPromotedFn = isPromotedDefault,
  requestPromotionFn = requestPromotionDefault,
  approvePromotionFn = approvePromotionDefault,
  autoApprovePromotionFn = autoApprovePromotionDefault,
  readLessonRowsFn = readLessonRowsDefault,
} = {}) {
  const lessonId = lessonIdForLearningItem(itemId);
  if (!lessonId) throw new Error('landGuard requires a non-empty string itemId');
  if (humanApproval === true && autoApproval) throw new Error('landGuard: humanApproval and autoApproval are exclusive');

  // Every refusal that does not depend on the promotion runs before a
  // promotion row is appended (card glmps-2-0-205). A frozen or untraceable
  // landing that left its promotion behind made the lesson read as promoted
  // with no guard in the file, so a later operator approve recorded nothing.
  assertReflexWritableFn(stateDir, { lessonId, actor, reflex: false, config, isPromoted: isPromotedFn });
  const alreadyRecorded = readLessonRowsFn(stateDir, { lessonId })
    .some((r) => r?.type === 'created');
  if (!alreadyRecorded) assertProvenance(normalizeProvenance(provenance));

  // Card glmps-2-0-201: the auto-approve loop's landing. Recorded as the
  // auto-approver, never as the operator, then held to the same freeze and
  // gate checks below as a human approval.
  if (autoApproval && !isPromotedFn(stateDir, lessonId)) {
    requestPromotionFn(stateDir, {
      lessonId, targetLayer: 'reflex', evidence: { via: 'auto-approve', ...autoApproval.evidence }, actor: AUTO_APPROVER, now,
    });
    autoApprovePromotionFn(stateDir, { lessonId, policy: autoApproval.policy, evidence: autoApproval.evidence, now });
  }

  // Idempotent: a second operator apply of the same guard must not stack a
  // second approval, and a lesson an operator already promoted (or the loop
  // pre-approved) needs no new one.
  if (humanApproval === true && !isPromotedFn(stateDir, lessonId)) {
    requestPromotionFn(stateDir, {
      lessonId, targetLayer: 'reflex', evidence: { via: 'operator-route' }, actor, now,
    });
    approvePromotionFn(stateDir, { lessonId, actor, humanApproved: true, now });
  }

  // Fail before anything is appended. writeLesson re-checks the same two
  // conditions on the create path; the duplication is deliberate and cheap,
  // because it is what lets this function promise that a refusal leaves the
  // ledger untouched even though it has rows of its own to append.
  assertReflexWritableFn(stateDir, {
    lessonId, actor, reflex: true, config, isPromoted: isPromotedFn,
  });

  const write = () => applyGuardFn({ ...guard });

  if (alreadyRecorded) {
    // The lesson predates this call. writeLesson's invalidate-on-failed-write
    // is right for a row this call just minted and wrong here: the earlier
    // guard is still in the file, so a failure now says nothing about it.
    return { lessonId, created: false, result: write() };
  }

  const { result } = writeLessonFn(stateDir, {
    lessonId, kind, title, provenance, actor,
    reflex: true, isPromoted: isPromotedFn, config, now, write,
  });
  return { lessonId, created: true, result };
}

/**
 * unlandGuard(stateDir, { itemId, reason, actor, now, guard, removeGuardFn,
 *   isPromotedFn, revokePromotionFn }) -> { lessonId, result, revoked }
 *
 * The revert path (card glmps-2-0-201): takes the rule line out of the file,
 * then revokes the lesson's promotion. In that order, so a failed removal
 * leaves the ledger still saying promoted, which is then still true.
 */
export function unlandGuard(stateDir, {
  itemId,
  reason = null,
  actor = AUTO_APPROVER,
  now,
  guard = {},
  removeGuardFn = removeGuardDefault,
  isPromotedFn = isPromotedDefault,
  revokePromotionFn = revokePromotionDefault,
} = {}) {
  const lessonId = lessonIdForLearningItem(itemId);
  if (!lessonId) throw new Error('unlandGuard requires a non-empty string itemId');
  const result = removeGuardFn({ ...guard });
  const revoked = isPromotedFn(stateDir, lessonId);
  if (revoked) revokePromotionFn(stateDir, { lessonId, reason, actor, now });
  return { lessonId, result, revoked };
}
