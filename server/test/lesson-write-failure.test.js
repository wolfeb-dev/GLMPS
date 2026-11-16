// server/test/lesson-write-failure.test.js
//
// What happens to the ledger when the write thunk itself fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLesson } from '../lib/evaluation/lesson-write.js';
import { readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';
import { learningIntegrityConfig } from '../lib/evaluation/learning-integrity-config.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lesson-fail-')); }

const unfrozen = learningIntegrityConfig({ learningIntegrity: { freeze: false } });
const prov = { scope: 'repo', derivedFromRefs: ['abc1234'] };

test('a write thunk that throws propagates the error to the caller', () => {
  const dir = tmp();
  assert.throws(
    () => writeLesson(dir, {
      lessonId: 'l1', kind: 'guard', title: 't', provenance: prov, config: unfrozen,
      write: () => { throw new Error('git commit failed: identity unset'); },
    }),
    /identity unset/,
  );
});

test('a failed write does not leave the lesson looking active', () => {
  // The failure this pins: createLesson appends before the thunk runs (it must,
  // or a successful write could land with no provenance recorded). If the
  // thunk then fails, the ledger would otherwise claim a lesson exists whose
  // guard was never actually written - and the ungated_reflex and provenance
  // acceptance checks would both be reading a fiction.
  const dir = tmp();
  try {
    writeLesson(dir, {
      lessonId: 'l1', kind: 'guard', title: 't', provenance: prov, config: unfrozen,
      write: () => { throw new Error('git commit failed'); },
    });
  } catch { /* expected */ }

  const cur = lessonsCurrent(readLessonRows(dir, {}));
  assert.equal(cur.get('l1').status, 'invalidated');
});

test('a failed write records WHY it was invalidated', () => {
  const dir = tmp();
  try {
    writeLesson(dir, {
      lessonId: 'l1', kind: 'guard', title: 't', provenance: prov, config: unfrozen,
      write: () => { throw new Error('git commit failed'); },
    });
  } catch { /* expected */ }

  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_INVALIDATED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.reason, 'write-failed');
  assert.match(ev[0].payload.error, /git commit failed/);
});

test('the attempt is still auditable: the created row is not erased', () => {
  // Append-only means the failed attempt stays visible. Deleting the created
  // row would hide that a write was attempted at all.
  const dir = tmp();
  try {
    writeLesson(dir, {
      lessonId: 'l1', kind: 'guard', title: 't', provenance: prov, config: unfrozen,
      write: () => { throw new Error('nope'); },
    });
  } catch { /* expected */ }
  const rows = readLessonRows(dir, { lessonId: 'l1' });
  assert.ok(rows.some((r) => r.type === 'created'));
  assert.ok(rows.some((r) => r.type === 'invalidated'));
});

test('a successful write leaves the lesson active, with no invalidation', () => {
  const dir = tmp();
  const out = writeLesson(dir, {
    lessonId: 'l2', kind: 'guard', title: 't', provenance: prov, config: unfrozen,
    write: () => 'ok',
  });
  assert.equal(out.result, 'ok');
  assert.equal(lessonsCurrent(readLessonRows(dir, {})).get('l2').status, 'active');
  assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_INVALIDATED }).length, 0);
});
