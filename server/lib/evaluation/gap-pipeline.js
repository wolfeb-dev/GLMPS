// server/lib/evaluation/gap-pipeline.js
// Shared "upsert a gap into the learning queue, then shadow-record the
// counterfactual" pipeline. Factored out of server.js's /api/state gap loop
// (previously inline) so a SECOND gap producer, the alert-derived
// learnable-alert adapter (alert-learn.js), can drive the exact same
// learning-store + shadow-arm wiring instead of forking it.
//
// Guard proposer cutover: the auto-apply-with-template branch is
// DELETED. It used to check the gap item's proposedGuard (seeded from
// learning-templates.js's now-deleted TEMPLATES map) and, when
// autoApplyGaps was on and a promotion had been approved for the lessonId,
// land the guard through landGuard with no human in THIS turn's loop. A gap
// item's proposedGuard is now always null (learning-store.js's
// upsertGapInto), so that branch could never fire again anyway; proposing
// the rule text is the GEPA plugin's job, and every guard lands only when
// the operator approves a proposal (a GEPA one, or a gap item they set an
// alternative rule on by hand) through /api/learning/item/:id/approve.
//
// Injectable recordShadowFn defaults to the real shadow-arm.js writer, so
// production call sites get real behavior for free and tests can inject a
// stub.
import * as learningStore from './learning-store.js';
import { recordShadow as recordShadowDefault } from './shadow-arm.js';

/**
 * @param lq    current learning-store state (learningStore.load()'s return shape)
 * @param gap   { code, severity, message }
 * @param ctx   { project, sessionId }
 * @param opts  {
 *   stateDir,
 *   recordShadowForNew=true - when false, this function performs NO shadow
 *     bookkeeping of its own. Set this to false when the CALLER measures
 *     shadow occurrences itself on a different cadence - e.g. the alert
 *     pipeline, which records one shadow entry per distinct alert id via a
 *     persisted seen-set (server/lib/observability/alert-seen.js), not per
 *     learning-store upsert, since most alert occurrences map to an
 *     already-existing (not "new") item.
 *   recordShadowFn - injectable, defaults to the real shadow-arm.js writer.
 * }
 * @returns { lq, dirty, item } - item is the (possibly updated) queue item.
 */
export function upsertGapAndApply(lq, gap, ctx, {
  stateDir,
  recordShadowForNew = true,
  recordShadowFn = recordShadowDefault,
} = {}) {
  const up = learningStore.upsertGapInto(lq, gap, ctx);
  const next = up.state;
  const dirty = up.changed;
  const item = up.item;

  // A new gap that goes unactioned is exactly what the counterfactual arm
  // measures: this recurring failure happened and no guard fired for it.
  // Recording nothing here would be a silent measurement loss - guard-retire
  // needs 20 observations before it will propose retiring anything, and the
  // Loop's guardHits reads the same log.
  // A new row filed as 'covered' already has its guard line, so it records as
  // fired, the same as a recurring applied guard.
  if (up.isNew && recordShadowForNew) {
    try {
      recordShadowFn(stateDir, { taskClass: gap.code, fired: item.status === 'covered', sid: ctx?.sessionId || null });
    } catch { /* measurement must never break the upsert */ }
  }

  return { lq: next, dirty, item };
}
