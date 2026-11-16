// server/lib/evaluation/lesson-migrate.js
//
// Maps the legacy learning store (<stateDir>/learning/store.json, the store the
// live gap/guard loop has been writing since long before A0) into the A0 lesson
// ledger.
//
// Why this exists: glmps-74 found two lesson stores. The legacy one
// holds every real lesson this system has ever learned; the A0 ledger, which
// owns provenance, decay, invalidation and the reflex gate, was empty, because
// gap-pipeline is its only writer and autoApplyGaps is false. So the integrity
// layer governed nothing while the store with the actual lessons predated all
// of it.
//
// This module is the PURE planner. All I/O lives in scripts/migrate-lessons.mjs
// so the policy below is unit-tested rather than buried in a script somebody
// runs once.
//
// THE POLICY, and it is the whole design:
//
//   applied   -> migrate. A human accepted it and it landed in a file.
//   pending   -> skip. A proposal nobody accepted is not a lesson, and
//                migrating it would make it retrievable as one.
//   discarded -> skip. A decision was made AGAINST it. Migrating it would
//                quietly resurrect the thing that was rejected, which is the
//                single most damaging thing a migration could do here.
//
// Provenance is real or the item is skipped. Nothing is invented:
//   derivedFromRefs = [applyCommit] when present - a genuine commit, so the
//                     lesson is honestly inside the revert sweep's reach.
//   sourceEventIds  = the legacy store id, plus the session it came from.
//   scope           = 'global' when the guard landed in CLAUDE.global.md,
//                     otherwise 'repo'.
//
// Migrated guards are NOT marked reflex, even though 47 of them are live in
// CLAUDE.global.md's Learned guards section right now. None carries a
// promotion.approved, so marking them reflex:true would launder ungated guards
// into gated ones (and writeLesson would refuse it anyway). `landedInReflexLayer`
// records the truth instead, so the migration can report it rather than hide it.
//
// Zero runtime dependencies.

const GLOBAL_GUARD_FILE = 'claude.global.md';

/**
 * planMigration({ items, existingIds }) -> { plan, skipped }
 *
 * plan:    [{ lessonId, kind, title, provenance, reflex, landedInReflexLayer }]
 * skipped: [{ lessonId, reason }] where reason is one of
 *          'pending' | 'discarded' | 'already-migrated' | 'no-id' | 'unknown-status'
 *
 * Pure. Deterministic. Safe to run twice: `existingIds` is what makes it
 * idempotent, and the caller builds it from the ledger itself.
 */
export function planMigration({ items, existingIds } = {}) {
  const have = existingIds instanceof Set ? existingIds : new Set();
  const plan = [];
  const skipped = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;

    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
    if (!id) {
      // No stable identity means no idempotency key and no traceable origin.
      // Minting one would make a re-run duplicate it forever.
      skipped.push({ lessonId: null, reason: 'no-id' });
      continue;
    }
    const lessonId = `legacy:${id}`;

    if (have.has(lessonId)) { skipped.push({ lessonId, reason: 'already-migrated' }); continue; }

    if (item.status === 'pending' || item.status === 'discarded') {
      skipped.push({ lessonId, reason: item.status });
      continue;
    }
    if (item.status !== 'applied') {
      skipped.push({ lessonId, reason: 'unknown-status' });
      continue;
    }

    const guardFile = item.proposedGuard && typeof item.proposedGuard.file === 'string'
      ? item.proposedGuard.file.toLowerCase()
      : null;
    const landedInReflexLayer = guardFile === GLOBAL_GUARD_FILE
      && !!(item.proposedGuard && item.proposedGuard.rule);

    const sourceEventIds = [`learning-store:${id}`];
    if (typeof item.sessionId === 'string' && item.sessionId.trim()) {
      sourceEventIds.push(`session:${item.sessionId.trim()}`);
    }
    const derivedFromRefs = typeof item.applyCommit === 'string' && item.applyCommit.trim()
      ? [item.applyCommit.trim()]
      : [];

    plan.push({
      lessonId,
      kind: item.source === 'gap' ? 'guard' : (item.source ?? 'guard'),
      title: item.title ?? item.code ?? lessonId,
      provenance: {
        sourceEventIds,
        derivedFromRefs,
        scope: guardFile === GLOBAL_GUARD_FILE ? 'global' : 'repo',
        createdAt: Number.isFinite(item.createdTs) ? new Date(item.createdTs).toISOString() : undefined,
      },
      // Always false: see the header. The ledger records what passed the gate,
      // and none of these did.
      reflex: false,
      landedInReflexLayer,
    });
  }

  return { plan, skipped };
}
