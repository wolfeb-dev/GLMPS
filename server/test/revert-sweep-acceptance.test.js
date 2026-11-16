// server/test/revert-sweep-acceptance.test.js
//
// A0.6's revertSweep flag, exercised end to end through the real modules.
//
// This is the test that matters for the glmps-74 finding. Before the
// sweep had a caller, `revertSweep` could only ever be satisfied by a
// hand-crafted event, which defeats the point of an acceptance gate: it is
// supposed to prove the mechanism was exercised, not that somebody knows how
// to forge its output. The precondition assertion below is deliberate - it
// pins that the flag starts false, so a future refactor that accidentally
// makes it default true would fail here rather than quietly unlock the freeze.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLesson } from '../lib/evaluation/lesson-write.js';
import { lessonsCurrent, readLessonRows } from '../lib/evaluation/lesson-ledger.js';
import { a0AcceptanceStatus } from '../lib/evaluation/learning-integrity-config.js';
import { runRevertSweep } from '../lib/evaluation/revert-sweep-run.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-revsweep-')); }

const SHA = 'abc1234abc1234abc1234abc1234abc1234abc12';

test('a reverted commit invalidates its lesson AND satisfies the A0.6 revertSweep flag', async () => {
  const dir = tmp();
  assert.equal(a0AcceptanceStatus(dir).revertSweep, false, 'precondition: nothing has exercised the sweep yet');

  writeLesson(dir, {
    lessonId: 'L1',
    kind: 'guard',
    title: 'a guard learned from the work that got reverted',
    provenance: { scope: 'repo', derivedFromRefs: [SHA] },
    actor: 'operator',
  });
  assert.equal(lessonsCurrent(readLessonRows(dir, {})).get('L1').status, 'active');

  const out = await runRevertSweep(dir, {
    repos: ['C:/repo'],
    scan: () => ({ refs: [SHA], head: 'head1' }),
    now: Date.now(),
  });

  assert.deepEqual(out.repos[0].invalidated, ['L1']);
  assert.equal(lessonsCurrent(readLessonRows(dir, {})).get('L1').status, 'invalidated');
  assert.equal(a0AcceptanceStatus(dir).revertSweep, true, 'the freeze-lift gate is now reachable by a real path');
});

test('a lesson derived from a DIFFERENT commit is left alone', async () => {
  // The sweep must be narrow. A lesson wrongly invalidated is silently lost
  // knowledge, which is a worse failure than one that survives too long.
  const dir = tmp();
  writeLesson(dir, {
    lessonId: 'L2', kind: 'guard', title: 'unrelated',
    provenance: { scope: 'repo', derivedFromRefs: ['dddd444dddd444dddd444dddd444dddd444dddd4'] },
    actor: 'operator',
  });
  await runRevertSweep(dir, { repos: ['C:/repo'], scan: () => ({ refs: [SHA], head: 'h' }), now: Date.now() });
  assert.equal(lessonsCurrent(readLessonRows(dir, {})).get('L2').status, 'active');
});

test('re-running the sweep over the same ref emits no duplicate invalidation', async () => {
  const dir = tmp();
  writeLesson(dir, {
    lessonId: 'L3', kind: 'guard', title: 'idempotency',
    provenance: { scope: 'repo', derivedFromRefs: [SHA] },
    actor: 'operator',
  });
  const args = { repos: ['C:/repo'], scan: () => ({ refs: [SHA], head: 'h' }), now: Date.now() };
  await runRevertSweep(dir, args);
  const after1 = readLessonRows(dir, {}).filter(r => r.type === 'invalidated').length;
  await runRevertSweep(dir, args);
  const after2 = readLessonRows(dir, {}).filter(r => r.type === 'invalidated').length;
  assert.equal(after1, 1);
  assert.equal(after2, 1, 'a watermark replay must not double-write');
});
