// server/test/lesson-write.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLesson, assertReflexWritable, LearningWriteFrozenError, ReflexNotPromotedError } from '../lib/evaluation/lesson-write.js';
import { learningIntegrityConfig } from '../lib/evaluation/learning-integrity-config.js';
import { readLessonRows, createLesson } from '../lib/evaluation/lesson-ledger.js';
import { approvePromotion } from '../lib/evaluation/reflex-gate.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lesson-write-')); }

test('writeLesson rejects a provenance-free write and never calls the writer', () => {
  const dir = tmp();
  let called = false;
  assert.throws(() => writeLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo' },
    write: () => { called = true; },
  }));
  assert.equal(called, false);
  assert.equal(readLessonRows(dir, {}).length, 0);
});

test('learning-write freeze rejects a nightly-runner write, allows an operator write', () => {
  const dir = tmp();
  const p = { scope: 'repo', derivedFromRefs: ['abc'] };
  assert.throws(
    () => writeLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: p, actor: 'nightly-runner', write: () => {} }),
    LearningWriteFrozenError,
  );
  assert.doesNotThrow(() => writeLesson(dir, { lessonId: 'l2', kind: 'guard', title: 't', provenance: p, actor: 'operator', write: () => {} }));
});

test('a frozen write never reaches the write thunk', () => {
  const dir = tmp();
  let called = false;
  const p = { scope: 'repo', derivedFromRefs: ['abc'] };
  assert.throws(() => writeLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't', provenance: p, actor: 'nightly-runner',
    write: () => { called = true; },
  }));
  assert.equal(called, false);
  assert.equal(readLessonRows(dir, {}).length, 0);
});

test('freeze can be lifted through config', () => {
  const dir = tmp();
  const config = learningIntegrityConfig({ learningIntegrity: { freeze: false } });
  assert.doesNotThrow(() => writeLesson(dir, {
    lessonId: 'l3', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    actor: 'nightly-runner', config, write: () => {},
  }));
});

test('a reflex write throws ReflexNotPromotedError by default: the real reflex-gate.js isPromoted check reports an unpromoted lesson as not promoted', () => {
  const dir = tmp();
  let called = false;
  assert.throws(() => writeLesson(dir, {
    lessonId: 'l4', kind: 'guard', title: 't', reflex: true,
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    actor: 'operator', write: () => { called = true; },
  }), ReflexNotPromotedError);
  assert.equal(called, false);
  assert.equal(readLessonRows(dir, {}).length, 0);
});

test('an injected isPromoted function overrides the default reflex-gate.js check (still available as a test seam)', () => {
  const dir = tmp();
  const result = writeLesson(dir, {
    lessonId: 'l5', kind: 'guard', title: 't', reflex: true,
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    actor: 'operator', isPromoted: () => true, write: () => 'done',
  });
  assert.equal(result.result, 'done');
  assert.equal(result.lesson.lessonId, 'l5');
});

test('the default gate lets a reflex write through once reflex-gate.js has an approved promotion for that lessonId', () => {
  const dir = tmp();
  // A lesson must already exist in the ledger for approvePromotion's
  // 'promoted' row to take effect (lessonsCurrent's fold requires a prior
  // 'created' row) - realistic, since a lesson is proposed before it is
  // ever considered for reflex promotion.
  createLesson(dir, { lessonId: 'l7', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
  approvePromotion(dir, { lessonId: 'l7', humanApproved: true });

  let called = false;
  const result = writeLesson(dir, {
    lessonId: 'l7', kind: 'guard', title: 't', reflex: true,
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    actor: 'operator', write: () => { called = true; return 'applied'; },
  });
  assert.equal(called, true);
  assert.equal(result.result, 'applied');
});

test('a successful write returns the created lesson row and the writer result', () => {
  const dir = tmp();
  const r = writeLesson(dir, {
    lessonId: 'l6', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    actor: 'operator', write: () => ({ commit: 'c1' }),
  });
  assert.equal(r.lesson.lessonId, 'l6');
  assert.deepEqual(r.result, { commit: 'c1' });
  assert.equal(readLessonRows(dir, {}).length, 1);
});

// landGuard (guard-lesson.js) calls this BEFORE it appends any row, so a guard
// the gate refuses leaves the ledger byte-identical. writeLesson calls the same
// function internally, so there is one place the freeze and the reflex gate are
// decided.
const OPEN_CFG = { freeze: false, frozenActors: [] };

test('assertReflexWritable throws when the lesson has no approved promotion', () => {
  assert.throws(
    () => assertReflexWritable(tmp(), {
      lessonId: 'legacy:x', reflex: true, config: OPEN_CFG, isPromoted: () => false,
    }),
    ReflexNotPromotedError,
  );
});

test('assertReflexWritable throws when the freeze covers the actor', () => {
  assert.throws(
    () => assertReflexWritable(tmp(), {
      lessonId: 'legacy:x', actor: 'nightly-runner',
      config: { freeze: true, frozenActors: ['nightly-runner'] }, isPromoted: () => true,
    }),
    LearningWriteFrozenError,
  );
});

test('assertReflexWritable passes a promoted reflex write and appends nothing', () => {
  const dir = tmp();
  assert.doesNotThrow(() => assertReflexWritable(dir, {
    lessonId: 'legacy:x', reflex: true, config: OPEN_CFG, isPromoted: () => true,
  }));
  assert.deepEqual(readLessonRows(dir, {}), []);
});

test('assertReflexWritable ignores the promotion gate for a non-reflex write', () => {
  assert.doesNotThrow(() => assertReflexWritable(tmp(), {
    lessonId: 'legacy:x', config: OPEN_CFG, isPromoted: () => false,
  }));
});
