// server/lib/evaluation/lesson-invalidate.js
//
// Invalidation on revert (A0.3) plus orphaned-artifact detection. A lesson
// whose origin was reverted is not stale, it is wrong - sweepInvalidations
// moves it to 'invalidated' IMMEDIATELY, with no decay grace, so a wrong
// guard cannot keep firing for weeks under the strength floor lesson-decay.js
// gives an honestly-aging lesson.
//
// recordIntentionalBreak runs the byte-identical sweep (sweepInvalidations
// itself, not a parallel copy) that a real revert triggers: deliberate
// demolition of the code a lesson was derived from must clean up after
// itself exactly like an accident does. That symmetry is the point - a
// human choosing to break something on purpose gets no special exemption
// from the cleanup an accidental revert would trigger.
//
// Zero runtime dependencies.
import { readLessonRows, lessonsCurrent, appendLessonRow } from './lesson-ledger.js';
import { emitSpineEvent, SPINE_KINDS } from '../observability/spine.js';
import { autoRevoke } from './reflex-gate.js';

function stampTs(now) {
  return typeof now === 'number' ? new Date(now).toISOString() : (now ?? new Date().toISOString());
}

/**
 * sweepInvalidations(stateDir, { refs, reason, actor, now }) -> { invalidated: lessonId[] }
 *
 * Any active (not-already-invalidated) lesson whose provenance.derivedFromRefs
 * intersects `refs` is moved to 'invalidated' immediately, emitting one
 * lesson.invalidated per lesson. `reason` is 'revert' or 'intentional_break'.
 * Idempotent: a lesson already invalidated is skipped, so re-running the same
 * sweep (e.g. a watermark replay) never emits a duplicate event.
 */
export function sweepInvalidations(stateDir, { refs = [], reason = 'revert', actor = 'nightly-runner', now } = {}) {
  const refSet = new Set((refs ?? []).map((r) => String(r).toLowerCase()));
  const ts = stampTs(now);
  const current = lessonsCurrent(readLessonRows(stateDir, {}));
  const invalidated = [];

  for (const lesson of current.values()) {
    if (lesson.status === 'invalidated') continue;
    const derived = lesson.provenance?.derivedFromRefs ?? [];
    const hit = derived.some((r) => refSet.has(String(r).toLowerCase()));
    if (!hit) continue;

    appendLessonRow(stateDir, { type: 'invalidated', lessonId: lesson.lessonId, ts, reason });
    emitSpineEvent(stateDir, {
      kind: SPINE_KINDS.LESSON_INVALIDATED,
      actor,
      ts,
      payload: { lessonId: lesson.lessonId, reason, refs: [...refSet] },
    });
    invalidated.push(lesson.lessonId);

    // A0.4: demotion is automatic. An invalidated lesson that keeps its reflex
    // promotion is the exact failure this layer exists to prevent - you revert
    // the commit a guard was learned from, the system records the lesson as
    // invalid, and the guard goes on shaping every future session anyway.
    //
    // autoRevoke is a no-op for a lesson that was never promoted, so this
    // cannot emit a spurious promotion.revoked.
    try {
      autoRevoke(stateDir, { lessonId: lesson.lessonId, invalidated: true, actor, now: ts });
    } catch { /* the invalidation itself must stand even if revocation fails */ }
  }

  return { invalidated };
}

/**
 * recordIntentionalBreak(stateDir, { refs, actor, note, now })
 *
 * Records a decision.recorded(kind:'intentional_break') event, then runs the
 * SAME sweepInvalidations a revert would - not a parallel code path.
 */
export function recordIntentionalBreak(stateDir, { refs = [], actor = 'operator', note = '', now } = {}) {
  const ts = stampTs(now);
  emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.DECISION_RECORDED,
    actor,
    ts,
    payload: { kind: 'intentional_break', refs: [...refs], note },
  });
  return sweepInvalidations(stateDir, { refs, reason: 'intentional_break', actor, now: ts });
}

/**
 * orphanScan(stateDir, { refs, worktrees, docs, fileTicket, actor, now })
 *   -> { orphaned: [{ type:'worktree'|'doc', ref, path }] }
 *
 * worktrees/docs are caller-supplied candidate lists, each item carrying the
 * ref it was built from ({ path, ref }). Any candidate whose ref is in the
 * reverted/broken set is orphaned: it references code that no longer exists
 * on the branch it was built for. Emits one artifact.orphaned per finding,
 * but files at most ONE cleanup ticket for the whole sweep (never one per
 * finding - a nightly sweep that found five orphans should not open five
 * duplicate tickets).
 */
export function orphanScan(stateDir, { refs = [], worktrees = [], docs = [], fileTicket, actor = 'nightly-runner', now } = {}) {
  const refSet = new Set((refs ?? []).map((r) => String(r).toLowerCase()));
  const ts = stampTs(now);
  const orphaned = [];

  for (const w of worktrees ?? []) {
    if (w?.ref && refSet.has(String(w.ref).toLowerCase())) {
      orphaned.push({ type: 'worktree', ref: w.ref, path: w.path });
    }
  }
  for (const d of docs ?? []) {
    if (d?.ref && refSet.has(String(d.ref).toLowerCase())) {
      orphaned.push({ type: 'doc', ref: d.ref, path: d.path });
    }
  }

  for (const finding of orphaned) {
    emitSpineEvent(stateDir, {
      kind: SPINE_KINDS.ARTIFACT_ORPHANED,
      actor,
      ts,
      payload: { type: finding.type, ref: finding.ref, path: finding.path },
    });
  }

  if (orphaned.length > 0 && typeof fileTicket === 'function') {
    fileTicket({ orphaned, refs: [...refSet] });
  }

  return { orphaned };
}

/**
 * invalidateLessons(stateDir, { lessonIds, reason, actor, now }) -> { invalidated }
 *
 * Retire specific lessons BY ID with a stated reason. Deliberately separate
 * from sweepInvalidations, which answers a different question: that one asks
 * "what did this revert break" and matches on provenance refs. This one is for
 * "these records are the same rule" (the duplicate cleanup) and similar
 * id-addressed cleanups.
 *
 * Idempotent: a lesson already invalidated is skipped, so re-running appends
 * nothing and the ledger does not grow on every pass.
 *
 * `reason` is never 'revert' from this path in practice, and must not be: the
 * A0.6 acceptance flag keys on that exact string, and a cleanup must not be
 * mistakable for the revert mechanism having been genuinely exercised.
 */
export function invalidateLessons(stateDir, { lessonIds = [], reason = 'duplicate', actor = 'operator', now } = {}) {
  const ts = stampTs(now);
  const current = lessonsCurrent(readLessonRows(stateDir, {}));
  const invalidated = [];

  for (const lessonId of Array.isArray(lessonIds) ? lessonIds : []) {
    const lesson = current.get(lessonId);
    if (!lesson || lesson.status === 'invalidated') continue;

    appendLessonRow(stateDir, { type: 'invalidated', lessonId, ts, reason });
    emitSpineEvent(stateDir, {
      kind: SPINE_KINDS.LESSON_INVALIDATED,
      actor,
      ts,
      payload: { lessonId, reason },
    });
    invalidated.push(lessonId);

    // Same demotion rule as the revert sweep: an invalidated lesson must not
    // keep a reflex promotion. No-op when it was never promoted.
    try { autoRevoke(stateDir, { lessonId, invalidated: true, actor, now: ts }); } catch { /* the invalidation stands */ }
  }

  return { invalidated };
}
