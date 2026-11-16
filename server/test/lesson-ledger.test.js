// server/test/lesson-ledger.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendLessonRow,
  readLessonRows,
  lessonsCurrent,
  reflexApproved,
  createLesson,
  lessonLedgerFile,
} from '../lib/evaluation/lesson-ledger.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lesson-ledger-')); }

test('createLesson refuses a provenance-free write and appends nothing', () => {
  const dir = tmp();
  assert.throws(() => createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo' } }));
  assert.equal(readLessonRows(dir, {}).length, 0);
});

test('a rejected write leaves the ledger byte-identical', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
  const before = fs.readFileSync(lessonLedgerFile(dir), 'utf8');
  assert.throws(() => createLesson(dir, { lessonId: 'l2', kind: 'guard', title: 't', provenance: { scope: 'repo' } }));
  const after = fs.readFileSync(lessonLedgerFile(dir), 'utf8');
  assert.equal(after, before);
});

test('createLesson appends a row and emits lesson.created', () => {
  const dir = tmp();
  const row = createLesson(dir, {
    lessonId: 'l1',
    kind: 'guard',
    title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['abc'] },
    actor: 'operator',
  });
  assert.equal(row.type, 'created');
  assert.equal(row.lessonId, 'l1');
  const rows = readLessonRows(dir, {});
  assert.equal(rows.length, 1);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_CREATED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.lessonId, 'l1');
  assert.equal(ev[0].actor, 'operator');
});

test('readLessonRows filters by lessonId', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
  createLesson(dir, { lessonId: 'l2', kind: 'guard', title: 't2', provenance: { scope: 'repo', derivedFromRefs: ['def'] } });
  assert.equal(readLessonRows(dir, { lessonId: 'l1' }).length, 1);
  assert.equal(readLessonRows(dir, {}).length, 2);
});

test('lessonsCurrent folds rows into one projection row per lesson', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
  const cur = lessonsCurrent(readLessonRows(dir, {}));
  assert.equal(cur.get('l1').status, 'active');
  assert.equal(cur.get('l1').strength, 1);
  assert.equal(cur.get('l1').kind, 'guard');
  assert.equal(cur.get('l1').title, 't');
  assert.equal(cur.get('l1').scope, 'repo');
});

test('lessonsCurrent returns one entry per lessonId even with multiple rows', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
  createLesson(dir, { lessonId: 'l2', kind: 'guard', title: 't2', provenance: { scope: 'desk', sourceEventIds: ['e1'] } });
  const cur = lessonsCurrent(readLessonRows(dir, {}));
  assert.equal(cur.size, 2);
});

test('appendLessonRow / readLessonRows round-trip an arbitrary row', () => {
  const dir = tmp();
  appendLessonRow(dir, { type: 'created', lessonId: 'x1', kind: 'guard', title: 'x' });
  assert.equal(readLessonRows(dir, {}).length, 1);
});

test('readLessonRows on a missing ledger returns an empty list', () => {
  assert.deepEqual(readLessonRows(tmp(), {}), []);
});

// An operator may pre-approve a guard the loop has PROPOSED but not yet
// landed, so a promoted/revoked row can legally precede its created row.
// Before this, a lesson could not be created without a promotion (writeLesson
// checks the gate first) and could not be promoted without being created
// (this fold dropped the row), which made the automatic apply path a deadlock.

const PROV = { scope: 'global', sourceEventIds: ['x'], derivedFromRefs: [] };
function createdRow(lessonId, createdAt = '2026-08-02T00:00:00.000Z') {
  return { type: 'created', lessonId, kind: 'guard', title: 'g', provenance: PROV, createdAt };
}

test('a promotion recorded before the created row survives into the projection', () => {
  const rows = [
    { type: 'promoted', lessonId: 'legacy:a', ts: '2026-08-01T00:00:00.000Z' },
    createdRow('legacy:a'),
  ];
  assert.equal(lessonsCurrent(rows).get('legacy:a').reflex, true);
});

test('a revoke recorded after an early promotion leaves the lesson un-promoted', () => {
  const rows = [
    { type: 'promoted', lessonId: 'legacy:b', ts: '2026-08-01T00:00:00.000Z' },
    { type: 'revoked', lessonId: 'legacy:b', ts: '2026-08-01T01:00:00.000Z' },
    createdRow('legacy:b'),
  ];
  assert.equal(lessonsCurrent(rows).get('legacy:b').reflex, false);
});

test('a repeat created row does not clear an existing promotion', () => {
  const rows = [
    createdRow('legacy:c'),
    { type: 'promoted', lessonId: 'legacy:c', ts: '2026-08-03T00:00:00.000Z' },
    createdRow('legacy:c'),
  ];
  assert.equal(lessonsCurrent(rows).get('legacy:c').reflex, true);
});

test('a promotion for a lessonId that never gets created yields no projection row', () => {
  const rows = [{ type: 'promoted', lessonId: 'legacy:ghost', ts: '2026-08-01T00:00:00.000Z' }];
  const cur = lessonsCurrent(rows);
  assert.equal(cur.size, 0, 'a dangling approval must not conjure a lesson');
});

test('reflexApproved answers for an id whose lesson does not exist yet', () => {
  const rows = [{ type: 'promoted', lessonId: 'legacy:pre', ts: '2026-08-01T00:00:00.000Z' }];
  assert.equal(reflexApproved(rows, 'legacy:pre'), true);
  assert.equal(lessonsCurrent(rows).size, 0, 'and still conjures no lesson');
});

test('reflexApproved is last-write-wins across promoted/revoked rows', () => {
  const rows = [
    { type: 'promoted', lessonId: 'legacy:p', ts: '2026-08-01T00:00:00.000Z' },
    { type: 'revoked', lessonId: 'legacy:p', ts: '2026-08-02T00:00:00.000Z' },
    { type: 'promoted', lessonId: 'legacy:p', ts: '2026-08-03T00:00:00.000Z' },
  ];
  assert.equal(reflexApproved(rows, 'legacy:p'), true);
  assert.equal(reflexApproved(rows.slice(0, 2), 'legacy:p'), false);
});

test('reflexApproved ignores rows belonging to another lesson', () => {
  const rows = [{ type: 'promoted', lessonId: 'legacy:other', ts: '2026-08-01T00:00:00.000Z' }];
  assert.equal(reflexApproved(rows, 'legacy:mine'), false);
});
