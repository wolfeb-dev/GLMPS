// server/test/lesson-dedupe.test.js
//
// Collapsing duplicate lesson records to one per distinct rule.
//
// The 52 rows migrated from the legacy store on 2026-08-21 contained 47 guard
// lessons that are really only TEN distinct rules: the same lesson learned over
// and over from separate sessions (8x ui-without-frontend-design, 8x
// done-without-verification, and so on). The legacy store's own semantic dedup
// landed 2026-07-09 and works - 43 of 44 duplicates predate it - but the
// migration copied the historical residue across without deduping it.
//
// Why duplicates are not merely untidy: eight records for ONE behaviour
// fragment invalidation. Revert the commit behind one and the other seven
// survive, still asserting the guard is justified. Decay acts on each
// independently too. The integrity layer would be reasoning about eight
// shadows of one fact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDedupe } from '../lib/evaluation/lesson-dedupe.js';

const row = (lessonId, kind, createdAt, over = {}) => ({
  lessonId, kind, status: 'active', createdAt,
  provenance: { scope: 'global', sourceEventIds: [`learning-store:${lessonId}`], derivedFromRefs: [] },
  ...over,
});

test('duplicates collapse to one keeper per group, the earliest', () => {
  const lessons = [
    row('legacy:c', 'guard', '2026-07-06T00:00:00.000Z', { dedupeKey: 'ui-without-frontend-design' }),
    row('legacy:a', 'guard', '2026-06-10T00:00:00.000Z', { dedupeKey: 'ui-without-frontend-design' }),
    row('legacy:b', 'guard', '2026-06-22T00:00:00.000Z', { dedupeKey: 'ui-without-frontend-design' }),
  ];
  const { keep, retire } = planDedupe(lessons);
  assert.deepEqual(keep.map(k => k.lessonId), ['legacy:a'], 'the earliest is the origin and keeps the real provenance');
  assert.deepEqual(retire.map(r => r.lessonId).sort(), ['legacy:b', 'legacy:c']);
});

test('a single-instance rule is kept and never retired', () => {
  const lessons = [row('legacy:solo', 'guard', '2026-06-22T00:00:00.000Z', { dedupeKey: 'egress' })];
  const { keep, retire } = planDedupe(lessons);
  assert.deepEqual(keep.map(k => k.lessonId), ['legacy:solo']);
  assert.deepEqual(retire, []);
});

test('distinct rules are never merged, however similar their wording', () => {
  const lessons = [
    row('legacy:1', 'guard', '2026-06-10T00:00:00.000Z', { dedupeKey: 'sleep-poll' }),
    row('legacy:2', 'guard', '2026-06-10T00:00:00.000Z', { dedupeKey: 'reread-loop' }),
  ];
  const { keep, retire } = planDedupe(lessons);
  assert.equal(keep.length, 2);
  assert.deepEqual(retire, []);
});

test('an already-invalidated row is never retired again', () => {
  // Idempotency: re-running the dedupe must not append a second invalidated row
  // for something already retired, or the ledger grows on every run.
  const lessons = [
    row('legacy:a', 'guard', '2026-06-10T00:00:00.000Z', { dedupeKey: 'k' }),
    row('legacy:b', 'guard', '2026-06-22T00:00:00.000Z', { dedupeKey: 'k', status: 'invalidated' }),
  ];
  const { keep, retire } = planDedupe(lessons);
  assert.deepEqual(keep.map(k => k.lessonId), ['legacy:a']);
  assert.deepEqual(retire, [], 'already invalidated, nothing to do');
});

test('a group whose every row is already invalidated keeps nothing and retires nothing', () => {
  const lessons = [
    row('legacy:a', 'guard', '2026-06-10T00:00:00.000Z', { dedupeKey: 'k', status: 'invalidated' }),
    row('legacy:b', 'guard', '2026-06-22T00:00:00.000Z', { dedupeKey: 'k', status: 'invalidated' }),
  ];
  const { keep, retire } = planDedupe(lessons);
  assert.deepEqual(keep, []);
  assert.deepEqual(retire, []);
});

test('rows with no dedupe key are left strictly alone', () => {
  // No key means we cannot prove two rows are the same rule, and a wrong merge
  // silently destroys a distinct lesson. Absence of evidence is not a match.
  const lessons = [
    row('legacy:x', 'guard', '2026-06-10T00:00:00.000Z'),
    row('legacy:y', 'guard', '2026-06-11T00:00:00.000Z'),
  ];
  const { keep, retire } = planDedupe(lessons);
  assert.equal(keep.length, 2);
  assert.deepEqual(retire, []);
});

test('junk input does not throw', () => {
  assert.deepEqual(planDedupe(null), { keep: [], retire: [] });
  assert.deepEqual(planDedupe([null, 5, 'x']), { keep: [], retire: [] });
});
