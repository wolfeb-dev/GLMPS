// server/test/lesson-invalidate.test.js
//
// A0.3: invalidation on revert. sweepInvalidations is IMMEDIATE - no decay
// grace - because a lesson derived from a reverted ref is not stale, it is
// wrong, and a wrong guard must stop firing the instant its origin is
// reverted, not 70 days later. recordIntentionalBreak follows the byte-
// identical sweep path a revert does: deliberate demolition of the code a
// lesson was derived from must clean up after itself exactly like an
// accidental revert does, so the two are tested against the same assertions
// below rather than two divergent code paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLesson, readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';
import { activeLessons } from '../lib/evaluation/lesson-decay.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';
import { sweepInvalidations, recordIntentionalBreak, orphanScan, invalidateLessons } from '../lib/evaluation/lesson-invalidate.js';
import { writeLesson } from '../lib/evaluation/lesson-write.js';
import { a0AcceptanceStatus } from '../lib/evaluation/learning-integrity-config.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lesson-invalidate-')); }

test('reverting a seeded ref invalidates the lesson derived from it, with no decay grace', () => {
  const dir = tmp();
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['1a2b3c4d'] },
  });
  const out = sweepInvalidations(dir, { refs: ['1a2b3c4d'], reason: 'revert' });
  assert.deepEqual(out.invalidated, ['l1']);
  assert.equal(activeLessons(dir, {}).length, 0);
  const cur = lessonsCurrent(readLessonRows(dir, {}));
  assert.equal(cur.get('l1').status, 'invalidated');
  assert.equal(cur.get('l1').strength, 0);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_INVALIDATED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.lessonId, 'l1');
  assert.equal(ev[0].payload.reason, 'revert');
});

test('a ref match is case-insensitive (git shas are lowercased on the way in)', () => {
  const dir = tmp();
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['1A2B3C4D'] },
  });
  const out = sweepInvalidations(dir, { refs: ['1a2b3c4d'], reason: 'revert' });
  assert.deepEqual(out.invalidated, ['l1']);
});

test('a lesson with no matching ref is left active', () => {
  const dir = tmp();
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['deadbeef'] },
  });
  const out = sweepInvalidations(dir, { refs: ['1a2b3c4d'], reason: 'revert' });
  assert.deepEqual(out.invalidated, []);
  assert.equal(activeLessons(dir, {}).length, 1);
});

test('an already-invalidated lesson is not re-invalidated (no duplicate event)', () => {
  const dir = tmp();
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['1a2b3c4d'] },
  });
  sweepInvalidations(dir, { refs: ['1a2b3c4d'], reason: 'revert' });
  const out2 = sweepInvalidations(dir, { refs: ['1a2b3c4d'], reason: 'revert' });
  assert.deepEqual(out2.invalidated, []);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_INVALIDATED });
  assert.equal(ev.length, 1);
});

test('sweepInvalidations invalidates every lesson whose derivedFromRefs intersects the ref set', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['a1'] } });
  createLesson(dir, { lessonId: 'l2', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['b2'] } });
  createLesson(dir, { lessonId: 'l3', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['c3'] } });
  const out = sweepInvalidations(dir, { refs: ['a1', 'c3'], reason: 'revert' });
  assert.deepEqual(out.invalidated.sort(), ['l1', 'l3']);
  assert.equal(activeLessons(dir, {}).length, 1);
});

test('an intentional break follows the identical sweep path and invalidates the lesson', () => {
  const dir = tmp();
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['dead'] },
  });
  recordIntentionalBreak(dir, { refs: ['dead'], actor: 'operator', note: 'removing the old path on purpose' });
  assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.DECISION_RECORDED }).length, 1);
  assert.equal(activeLessons(dir, {}).length, 0);
  const cur = lessonsCurrent(readLessonRows(dir, {}));
  assert.equal(cur.get('l1').status, 'invalidated');
  const invEv = readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_INVALIDATED });
  assert.equal(invEv.length, 1);
  assert.equal(invEv[0].payload.reason, 'intentional_break');
});

test('recordIntentionalBreak records the decision with the note and refs before sweeping', () => {
  const dir = tmp();
  recordIntentionalBreak(dir, { refs: ['dead'], actor: 'operator', note: 'demolition, not an accident' });
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.DECISION_RECORDED });
  assert.equal(ev[0].payload.kind, 'intentional_break');
  assert.deepEqual(ev[0].payload.refs, ['dead']);
  assert.equal(ev[0].payload.note, 'demolition, not an accident');
});

test('orphanScan flags a worktree referencing a reverted ref and files exactly one cleanup ticket', () => {
  const dir = tmp();
  let tickets = 0;
  const out = orphanScan(dir, {
    refs: ['1a2b3c4d'],
    worktrees: [{ path: 'w1', ref: '1a2b3c4d' }],
    docs: [],
    fileTicket: () => { tickets++; },
  });
  assert.equal(out.orphaned.length, 1);
  assert.equal(out.orphaned[0].type, 'worktree');
  assert.equal(out.orphaned[0].path, 'w1');
  assert.equal(tickets, 1);
});

test('orphanScan flags a doc referencing a reverted ref', () => {
  const dir = tmp();
  const out = orphanScan(dir, {
    refs: ['1a2b3c4d'],
    worktrees: [],
    docs: [{ path: 'docs/plan.md', ref: '1a2b3c4d' }],
    fileTicket: () => {},
  });
  assert.equal(out.orphaned.length, 1);
  assert.equal(out.orphaned[0].type, 'doc');
});

test('orphanScan files exactly ONE ticket per sweep, not one per finding', () => {
  const dir = tmp();
  let tickets = 0;
  const out = orphanScan(dir, {
    refs: ['1a2b3c4d', 'deadbeef'],
    worktrees: [{ path: 'w1', ref: '1a2b3c4d' }, { path: 'w2', ref: 'deadbeef' }],
    docs: [{ path: 'docs/a.md', ref: '1a2b3c4d' }],
    fileTicket: () => { tickets++; },
  });
  assert.equal(out.orphaned.length, 3);
  assert.equal(tickets, 1, 'one ticket per sweep regardless of how many artifacts were found');
});

test('orphanScan with no findings files no ticket', () => {
  const dir = tmp();
  let tickets = 0;
  const out = orphanScan(dir, {
    refs: ['1a2b3c4d'],
    worktrees: [{ path: 'w1', ref: 'unrelated' }],
    docs: [],
    fileTicket: () => { tickets++; },
  });
  assert.equal(out.orphaned.length, 0);
  assert.equal(tickets, 0);
});

test('orphanScan emits artifact.orphaned per finding', () => {
  const dir = tmp();
  orphanScan(dir, {
    refs: ['1a2b3c4d'],
    worktrees: [{ path: 'w1', ref: '1a2b3c4d' }],
    docs: [{ path: 'docs/a.md', ref: '1a2b3c4d' }],
    fileTicket: () => {},
  });
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.ARTIFACT_ORPHANED });
  assert.equal(ev.length, 2);
});

test('invalidateLessons retires specific ids with a stated reason, idempotently', () => {
  // Used by the duplicate cleanup. Deliberately by ID rather than by ref:
  // sweepInvalidations answers "what did this revert break", which is a
  // different question from "these two records are the same rule".
  const dir = tmp();
  writeLesson(dir, { lessonId: 'L1', kind: 'guard', title: 'keeper', actor: 'operator',
    provenance: { scope: 'global', sourceEventIds: ['x'] } });
  writeLesson(dir, { lessonId: 'L2', kind: 'guard', title: 'dup', actor: 'operator',
    provenance: { scope: 'global', sourceEventIds: ['y'] } });

  const out = invalidateLessons(dir, { lessonIds: ['L2'], reason: 'duplicate', actor: 'operator' });
  assert.deepEqual(out.invalidated, ['L2']);

  const cur = lessonsCurrent(readLessonRows(dir, {}));
  assert.equal(cur.get('L2').status, 'invalidated');
  assert.equal(cur.get('L1').status, 'active', 'the keeper is untouched');

  // Re-running must not append a second row.
  const again = invalidateLessons(dir, { lessonIds: ['L2'], reason: 'duplicate', actor: 'operator' });
  assert.deepEqual(again.invalidated, [], 'already invalidated');
  assert.equal(readLessonRows(dir, {}).filter(r => r.type === 'invalidated').length, 1);
});

test("invalidateLessons with reason 'duplicate' does NOT satisfy the A0.6 revert gate", () => {
  // The acceptance flag requires reason === 'revert' specifically. A cleanup
  // must never be mistakable for the revert path having been exercised.
  const dir = tmp();
  writeLesson(dir, { lessonId: 'L1', kind: 'guard', title: 't', actor: 'operator',
    provenance: { scope: 'global', sourceEventIds: ['x'] } });
  invalidateLessons(dir, { lessonIds: ['L1'], reason: 'duplicate', actor: 'operator' });
  assert.equal(a0AcceptanceStatus(dir).revertSweep, false);
});
