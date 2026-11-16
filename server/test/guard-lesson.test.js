// server/test/guard-lesson.test.js
// landGuard is the ONLY way a guard may reach a governed instruction file
// (ADR-0001). These tests pin the five properties the ADR argues for:
//   1. one canonical lesson id, whatever route lands the guard
//   2. an operator route records its click as a REAL, revocable promotion
//   3. the automatic route never self-approves, and a refusal appends nothing
//   4. an operator pre-approval unblocks the automatic route later
//   5. a failed write invalidates the lesson this call created, and only that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { landGuard, lessonIdForLearningItem } from '../lib/evaluation/guard-lesson.js';
import { readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';
import { ReflexNotPromotedError, LearningWriteFrozenError } from '../lib/evaluation/lesson-write.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-guard-lesson-')); }

const CFG = { freeze: false, frozenActors: [] };
const PROV = { scope: 'global', sourceEventIds: ['learning-store:abc'], derivedFromRefs: [] };
const GUARD = { assetsDir: '/assets', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm' };

function current(stateDir, lessonId) {
  return lessonsCurrent(readLessonRows(stateDir, {})).get(lessonId) ?? null;
}

test('lessonIdForLearningItem uses the one canonical scheme', () => {
  assert.equal(lessonIdForLearningItem('abc'), 'legacy:abc');
  assert.equal(lessonIdForLearningItem('  abc  '), 'legacy:abc');
  assert.equal(lessonIdForLearningItem('   '), null);
  assert.equal(lessonIdForLearningItem(null), null);
  assert.equal(lessonIdForLearningItem(42), null);
});

test('landGuard refuses an item with no usable id', () => {
  assert.throws(() => landGuard(tmp(), { itemId: '', provenance: PROV, config: CFG, guard: GUARD }), /itemId/);
});

test('an operator apply records the approval, creates the lesson, and lands the guard', () => {
  const dir = tmp();
  const calls = [];
  const out = landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, actor: 'operator', humanApproval: true,
    config: CFG, guard: GUARD,
    applyGuardFn: (o) => { calls.push(o); return { commit: 'sha1', changed: true }; },
  });

  assert.equal(out.lessonId, 'legacy:abc');
  assert.equal(out.created, true);
  assert.deepEqual(out.result, { commit: 'sha1', changed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'CLAUDE.global.md');
  assert.equal(calls[0].rule, '- r');

  const cur = current(dir, 'legacy:abc');
  assert.equal(cur.status, 'active');
  assert.equal(cur.reflex, true, 'the operator click is recorded as a real promotion');
  assert.deepEqual(cur.provenance.sourceEventIds, ['learning-store:abc']);

  const approved = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_APPROVED });
  assert.equal(approved.length, 1, 'the approval is auditable, not implicit');
  assert.equal(approved[0].payload.lessonId, 'legacy:abc');
  assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_REQUESTED }).length, 1);
});

test('the automatic path is refused with no approval, and appends nothing', () => {
  const dir = tmp();
  let applied = 0;
  assert.throws(() => landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, config: CFG, guard: GUARD,
    applyGuardFn: () => { applied++; return { commit: 'x', changed: true }; },
  }), ReflexNotPromotedError);
  assert.equal(applied, 0, 'the guard must not reach the file');
  assert.deepEqual(readLessonRows(dir, {}), [], 'a refused guard leaves the ledger byte-identical');
});

test('the automatic path lands once a human has approved that lesson id', () => {
  const dir = tmp();
  landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, humanApproval: true, config: CFG, guard: GUARD,
    applyGuardFn: () => ({ commit: 'sha1', changed: true }),
  });
  const out = landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, config: CFG, guard: GUARD,
    applyGuardFn: () => ({ commit: 'sha2', changed: false }),
  });
  assert.equal(out.created, false, 'the second landing reuses the existing lesson');
  assert.equal(out.result.commit, 'sha2');
  assert.equal(readLessonRows(dir, {}).filter((r) => r.type === 'created').length, 1);
  assert.equal(current(dir, 'legacy:abc').reflex, true);
});

test('a second operator apply does not stack a second approval', () => {
  const dir = tmp();
  const opts = {
    itemId: 'abc', title: 'g', provenance: PROV, humanApproval: true, config: CFG, guard: GUARD,
    applyGuardFn: () => ({ commit: 'sha', changed: false }),
  };
  landGuard(dir, opts);
  landGuard(dir, opts);
  assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_APPROVED }).length, 1);
});

test('a failed guard write invalidates the lesson it just created', () => {
  const dir = tmp();
  assert.throws(() => landGuard(dir, {
    itemId: 'zzz', title: 'g', provenance: PROV, humanApproval: true, config: CFG, guard: GUARD,
    applyGuardFn: () => { throw new Error('git commit failed'); },
  }), /git commit failed/);
  assert.equal(current(dir, 'legacy:zzz').status, 'invalidated');
});

test('a failed re-apply does not invalidate a lesson that landed earlier', () => {
  const dir = tmp();
  landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, humanApproval: true, config: CFG, guard: GUARD,
    applyGuardFn: () => ({ commit: 'sha1', changed: true }),
  });
  assert.throws(() => landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, config: CFG, guard: GUARD,
    applyGuardFn: () => { throw new Error('git commit failed'); },
  }), /git commit failed/);
  assert.equal(current(dir, 'legacy:abc').status, 'active',
    'a guard that landed before must not be invalidated by a later failed attempt');
});

test('the learning-write freeze refuses a frozen actor before anything is appended', () => {
  const dir = tmp();
  assert.throws(() => landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, actor: 'nightly-runner', humanApproval: true,
    config: { freeze: true, frozenActors: ['nightly-runner'] }, guard: GUARD,
    applyGuardFn: () => ({ commit: 'sha', changed: true }),
  }), LearningWriteFrozenError);
  assert.equal(readLessonRows(dir, {}).filter((r) => r.type === 'created').length, 0);
});

test('provenance is still enforced: a guard with no traceable origin never lands', () => {
  const dir = tmp();
  let applied = 0;
  assert.throws(() => landGuard(dir, {
    itemId: 'abc', title: 'g',
    provenance: { scope: 'global', sourceEventIds: [], derivedFromRefs: [] },
    humanApproval: true, config: CFG, guard: GUARD,
    applyGuardFn: () => { applied++; return { commit: 'sha', changed: true }; },
  }));
  assert.equal(applied, 0);
  assert.equal(readLessonRows(dir, {}).filter((r) => r.type === 'created').length, 0);
});
