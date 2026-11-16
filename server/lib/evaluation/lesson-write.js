// server/lib/evaluation/lesson-write.js
//
// writeLesson is THE chokepoint for landing a lesson: every path that wants
// to write a lesson (the approve/promote routes, the gate route, gap-
// pipeline auto-apply) goes through here instead of calling createLesson
// directly, so provenance enforcement, the learning-write freeze and the
// reflex gate cannot be bypassed by a new caller that forgets to check
// them. Order matters and is fixed: assert provenance, then the freeze
// check, then the reflex check, then createLesson, then the write() thunk.
// The write thunk never runs if any earlier check fails.
//
// Zero runtime dependencies.
import { createLesson, appendLessonRow } from './lesson-ledger.js';
import { emitSpineEvent, SPINE_KINDS } from '../observability/spine.js';
import { assertProvenance, normalizeProvenance } from './lesson-provenance.js';
import { learningIntegrityConfig } from './learning-integrity-config.js';
import { isPromoted as isPromotedDefault } from './reflex-gate.js';

export class LearningWriteFrozenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LearningWriteFrozenError';
  }
}

export class ReflexNotPromotedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReflexNotPromotedError';
  }
}

/**
 * assertReflexWritable(stateDir, { lessonId, actor, reflex, config, isPromoted })
 *
 * The freeze + reflex-gate half of writeLesson, extracted so a caller can fail
 * BEFORE it appends anything. guard-lesson.js's landGuard calls it for exactly
 * that reason: a guard the gate refuses must leave the ledger byte-identical,
 * and writeLesson alone cannot promise that to a caller that has other rows to
 * append first. Appends nothing, emits nothing, returns nothing - it only
 * throws, and writeLesson calls it internally so there is exactly one place
 * these two checks are decided.
 */
export function assertReflexWritable(stateDir, {
  lessonId,
  actor = 'operator',
  reflex = false,
  config,
  isPromoted = isPromotedDefault,
} = {}) {
  const cfg = config ?? learningIntegrityConfig();

  if (cfg.freeze && cfg.frozenActors.includes(actor)) {
    throw new LearningWriteFrozenError(
      `learning-write freeze is active for actor ${actor}; lesson ${lessonId} was not written`,
    );
  }

  if (reflex && !isPromoted(stateDir, lessonId)) {
    throw new ReflexNotPromotedError(
      `lesson ${lessonId} has no approved promotion to the reflex layer`,
    );
  }
}

// Task 6: writeLesson defaults `isPromoted` to reflex-gate.js's real
// isPromoted(stateDir, lessonId) -> boolean (approved and not since
// revoked), so a `reflex: true` write is gated on an actual approved
// promotion by default. A caller can still inject its own `isPromoted` (a
// test stub, or a future caller with a different attribution rule); the
// writeLesson signature itself does not change.
export function writeLesson(stateDir, {
  lessonId,
  kind,
  title,
  provenance,
  actor = 'operator',
  reflex = false,
  config,
  isPromoted = isPromotedDefault,
  now,
  write = () => undefined,
} = {}) {
  const cfg = config ?? learningIntegrityConfig();

  const p = normalizeProvenance(provenance);
  assertProvenance(p);

  assertReflexWritable(stateDir, { lessonId, actor, reflex, config: cfg, isPromoted });

  // The ledger row is appended BEFORE the write runs, deliberately: if the
  // order were reversed, a successful write followed by a failed append would
  // leave a live guard on disk with no provenance and no gate record, which is
  // exactly the state A0 exists to make impossible.
  //
  // The cost of that ordering is the opposite failure: the write throws (a git
  // commit with no identity set, a read-only file) and the ledger is left
  // claiming a lesson that never actually landed. So a failed write is
  // immediately invalidated. The `created` row stays - the ledger is
  // append-only and the attempt itself is audit-relevant - but the projection
  // reports the lesson as `invalidated`, so it is excluded from retrieval and
  // cannot satisfy the provenance acceptance check or masquerade as an active
  // guard.
  const lesson = createLesson(stateDir, { lessonId, kind, title, provenance: p, actor, now });
  let result;
  try {
    result = write();
  } catch (e) {
    invalidateFailedWrite(stateDir, { lessonId, actor, now, error: e?.message ?? String(e) });
    throw e;
  }
  return { lesson, result };
}

function invalidateFailedWrite(stateDir, { lessonId, actor, now, error }) {
  const ts = now === undefined ? new Date().toISOString() : new Date(now).toISOString();
  try {
    appendLessonRow(stateDir, {
      type: 'invalidated',
      lessonId,
      reason: 'write-failed',
      error,
      actor,
      ts,
    });
    emitSpineEvent(stateDir, {
      kind: SPINE_KINDS.LESSON_INVALIDATED,
      actor,
      ts,
      payload: { lessonId, reason: 'write-failed', error },
    });
  } catch {
    // Best effort. The original write error is what the caller needs to see;
    // failing to record the invalidation must not replace it with a less
    // useful one.
  }
}
