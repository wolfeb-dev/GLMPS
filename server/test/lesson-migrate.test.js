// server/test/lesson-migrate.test.js
//
// The mapping from the legacy learning store into the A0 lesson ledger.
// Pure, so the policy decisions below are pinned by tests rather than living
// only in a migration script somebody runs once and never reads again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMigration } from '../lib/evaluation/lesson-migrate.js';
import { assertProvenance, normalizeProvenance } from '../lib/evaluation/lesson-provenance.js';

const applied = (over = {}) => ({
  id: 'aaa111',
  source: 'gap',
  code: 'ui-without-frontend-design',
  title: 'ui without frontend design',
  body: 'Edited UI/style files without the frontend-design skill.',
  status: 'applied',
  applyCommit: '580f8e3cb0a00715441eb6483b98acf0979fc79a',
  sessionId: 'agy:ce942667',
  proposedGuard: { file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- Do the thing.' },
  createdTs: 1781126423332,
  ...over,
});

test('an applied item migrates with REAL provenance, not invented provenance', () => {
  const { plan } = planMigration({ items: [applied()], existingIds: new Set() });
  assert.equal(plan.length, 1);
  const row = plan[0];
  assert.equal(row.lessonId, 'legacy:aaa111');
  assert.equal(row.title, 'ui without frontend design');
  // applyCommit is a genuine commit the guard landed in, so the lesson is
  // honestly within the revert sweep's reach: revert that commit and this
  // lesson SHOULD be invalidated.
  assert.deepEqual(row.provenance.derivedFromRefs, ['580f8e3cb0a00715441eb6483b98acf0979fc79a']);
  assert.deepEqual(row.provenance.sourceEventIds, ['learning-store:aaa111', 'session:agy:ce942667']);
  assert.equal(row.provenance.scope, 'global', 'it landed in CLAUDE.global.md, which is the global reflex layer');
  assert.doesNotThrow(() => assertProvenance(normalizeProvenance(row.provenance)));
});

test('a migrated guard is NOT marked reflex, because none of them ever passed the gate', () => {
  // These 47 rules are live in CLAUDE.global.md's Learned guards section and
  // not one carries a promotion.approved. Writing them as reflex:true would
  // launder ungated guards into gated ones, and writeLesson would refuse it
  // anyway. reflex:false is the truthful record; the fact that they are live
  // regardless is reported to the operator, not hidden by the mapping.
  const { plan } = planMigration({ items: [applied()], existingIds: new Set() });
  assert.equal(plan[0].reflex, false);
  assert.equal(plan[0].landedInReflexLayer, true, 'but the migration still says so out loud');
});

test('pending and discarded items are NOT migrated', () => {
  const items = [
    applied({ id: 'p1', status: 'pending', applyCommit: null }),
    applied({ id: 'd1', status: 'discarded', applyCommit: null }),
    applied({ id: 'a1' }),
  ];
  const { plan, skipped } = planMigration({ items, existingIds: new Set() });
  assert.deepEqual(plan.map(p => p.lessonId), ['legacy:a1']);
  // A pending proposal is not a lesson: no human ever accepted it, and
  // migrating it would make it retrievable as one. A discarded proposal is
  // worse - a decision was made AGAINST it, and migrating it would quietly
  // resurrect the thing that was rejected.
  assert.deepEqual(skipped.map(s => [s.lessonId, s.reason]).sort(), [
    ['legacy:d1', 'discarded'],
    ['legacy:p1', 'pending'],
  ]);
});

test('migration is idempotent: an id already in the ledger is skipped, not rewritten', () => {
  const items = [applied({ id: 'a1' }), applied({ id: 'a2' })];
  const { plan, skipped } = planMigration({ items, existingIds: new Set(['legacy:a1']) });
  assert.deepEqual(plan.map(p => p.lessonId), ['legacy:a2']);
  assert.deepEqual(skipped.map(s => s.reason), ['already-migrated']);
});

test('an applied item with no usable origin is skipped rather than given a fabricated one', () => {
  // No applyCommit AND no sessionId would leave only the store id, which is
  // enough for assertProvenance - so this asserts the genuinely empty case.
  const { plan, skipped } = planMigration({
    items: [{ status: 'applied', title: 'no id at all' }],
    existingIds: new Set(),
  });
  assert.deepEqual(plan, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'no-id');
});

test('an applied item with only a store id still migrates, because that IS a traceable origin', () => {
  const { plan } = planMigration({
    items: [{ id: 'x9', status: 'applied', title: 'minimal' }],
    existingIds: new Set(),
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].provenance.sourceEventIds, ['learning-store:x9']);
  assert.deepEqual(plan[0].provenance.derivedFromRefs, []);
  assert.equal(plan[0].provenance.scope, 'repo', 'no global guard file, so it is not a global-scope lesson');
  assert.doesNotThrow(() => assertProvenance(normalizeProvenance(plan[0].provenance)));
});

test('junk input does not throw', () => {
  assert.deepEqual(planMigration({}).plan, []);
  assert.deepEqual(planMigration({ items: null, existingIds: null }).plan, []);
  assert.deepEqual(planMigration({ items: [null, 3, 'x'], existingIds: new Set() }).plan, []);
});
