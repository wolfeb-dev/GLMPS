// server/test/lesson-decay.test.js
//
// Half-life arithmetic reference (see the plan's implementer note): with
// strengthFloor 0.2 and a 30-day half-life, strength = 0.5 ** (t/30) crosses
// below 0.2 at t = 30 * log2(5), about 69.66 days. So:
//   60 days -> 0.5 ** 2      = 0.25   (above floor, still active)
//   75 days -> 0.5 ** 2.5    = 0.1768 (below floor, decays)
// For the 90-day (desk) half-life, 75 days -> 0.5 ** (75/90) = 0.5613,
// comfortably above the floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLesson, readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';
import { strengthAt, reconfirmLesson, runDecaySweep, activeLessons } from '../lib/evaluation/lesson-decay.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lesson-decay-')); }

const DAY = 86400000;

test('strengthAt computes exponential decay clamped to [0,1]', () => {
  const lesson = { lastReconfirmedAt: 0 };
  assert.equal(strengthAt(lesson, 0, 30), 1);
  assert.equal(strengthAt(lesson, 30 * DAY, 30), 0.5);
  assert.ok(Math.abs(strengthAt(lesson, 60 * DAY, 30) - 0.25) < 1e-9);
});

test('strengthAt never goes negative or above 1', () => {
  const lesson = { lastReconfirmedAt: 100 * DAY };
  // "now" before lastReconfirmedAt (clock skew) should clamp to 1, not blow up.
  assert.equal(strengthAt(lesson, 0, 30), 1);
});

test('a repo-scoped lesson decays to dormant across a simulated clock', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    now: t0,
  });
  assert.equal(runDecaySweep(dir, { now: t0 + 60 * DAY }).decayed.length, 0, 'strength 0.25 at 60d is still above the 0.2 floor');
  assert.deepEqual(runDecaySweep(dir, { now: t0 + 75 * DAY }).decayed, ['l1']);
  assert.equal(runDecaySweep(dir, { now: t0 + 76 * DAY }).decayed.length, 0, 'idempotent');
  assert.equal(activeLessons(dir, { now: t0 + 76 * DAY }).length, 0);
});

test('reconfirmation resets the decay clock', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    now: t0,
  });
  reconfirmLesson(dir, 'l1', { ts: t0 + 50 * DAY });
  assert.equal(runDecaySweep(dir, { now: t0 + 75 * DAY }).decayed.length, 0);
});

test('a desk-scoped lesson uses the 90-day half-life and survives 75 days', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'desk', derivedFromRefs: ['abc'] },
    now: t0,
  });
  assert.equal(runDecaySweep(dir, { now: t0 + 75 * DAY }).decayed.length, 0);
  assert.equal(activeLessons(dir, { now: t0 + 75 * DAY }).length, 1);
});

test('runDecaySweep emits one lesson.decayed per decayed lesson', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, {
    lessonId: 'l1', kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    now: t0,
  });
  runDecaySweep(dir, { now: t0 + 75 * DAY });
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_DECAYED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.lessonId, 'l1');
});

test('runDecaySweep reports how many active lessons it evaluated', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['a'] }, now: t0 });
  createLesson(dir, { lessonId: 'l2', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['b'] }, now: t0 });
  const r = runDecaySweep(dir, { now: t0 + 10 * DAY });
  assert.equal(r.evaluated, 2);
  assert.equal(r.decayed.length, 0);
});

test('a decayed lesson reads as dormant in the projection with its crossing strength', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] }, now: t0 });
  runDecaySweep(dir, { now: t0 + 75 * DAY });
  const cur = lessonsCurrent(readLessonRows(dir, {}));
  assert.equal(cur.get('l1').status, 'dormant');
  assert.ok(cur.get('l1').strength < 0.2);
});

test('reconfirmLesson appends a reconfirmed row and emits lesson.reconfirmed', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] }, now: t0 });
  reconfirmLesson(dir, 'l1', { ts: t0 + 10 * DAY, actor: 'operator', runId: 'nightly-1' });
  const rows = readLessonRows(dir, { lessonId: 'l1' });
  assert.equal(rows.some((r) => r.type === 'reconfirmed'), true);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_RECONFIRMED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.lessonId, 'l1');
});

test('activeLessons excludes a dormant lesson but readLessonRows still returns its history', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] }, now: t0 });
  runDecaySweep(dir, { now: t0 + 75 * DAY });
  assert.equal(activeLessons(dir, { now: t0 + 75 * DAY }).length, 0);
  assert.ok(readLessonRows(dir, { lessonId: 'l1' }).length > 0);
});
