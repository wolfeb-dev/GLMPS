import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { upsertMeasurable, getMeasurable, listMeasurables, addLabel } from '../lib/evaluation/measurables-store.js';

function tmpState() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-meas-')); }

test('unknown id reads null', () => {
  const sd = tmpState();
  assert.equal(getMeasurable(sd, 'nope'), null);
});

test('upsertMeasurable creates then re-upsert preserves labels/createdTs and refreshes the rest', () => {
  const sd = tmpState();
  const first = upsertMeasurable(sd, { id: 'guard-retire:x', kind: 'guard-retire', title: 'x', detail: 'first', ts: 100 });
  assert.equal(first.createdTs, 100);
  assert.deepEqual(first.labels, []);
  addLabel(sd, 'guard-retire:x', { decision: 'approve', by: 'op', note: null, ts: 150 });
  const second = upsertMeasurable(sd, { id: 'guard-retire:x', kind: 'guard-retire', title: 'x', detail: 'second', ts: 200 });
  assert.equal(second.createdTs, 100);           // preserved
  assert.equal(second.detail, 'second');          // refreshed
  assert.equal(second.updatedTs, 200);
  assert.equal(second.labels.length, 1);          // preserved across the second upsert
});

test('listMeasurables sorts newest-first and filters by kind', () => {
  const sd = tmpState();
  upsertMeasurable(sd, { id: 'a', kind: 'guard-retire', title: 'a', ts: 100 });
  upsertMeasurable(sd, { id: 'b', kind: 'skill-retire', title: 'b', ts: 200 });
  const all = listMeasurables(sd);
  assert.deepEqual(all.map(m => m.id), ['b', 'a']);
  const guardOnly = listMeasurables(sd, { kind: 'guard-retire' });
  assert.deepEqual(guardOnly.map(m => m.id), ['a']);
});

test('addLabel on an unknown id returns null', () => {
  const sd = tmpState();
  assert.equal(addLabel(sd, 'nope', { decision: 'approve', ts: 1 }), null);
});

test('addLabel rejects an invalid decision', () => {
  const sd = tmpState();
  upsertMeasurable(sd, { id: 'a', kind: 'guard-retire', title: 'a', ts: 1 });
  assert.throws(() => addLabel(sd, 'a', { decision: 'bogus', ts: 2 }), /invalid decision/);
});

// glmps-102: existence is checked BEFORE decision validity - an unknown id +
// a bogus decision must return null (404 at the route layer), not throw
// (400 at the route layer). Previously the order was reversed, so this exact
// combination masked the 404 behind a 400.
test('addLabel on an unknown id with an ALSO-invalid decision still returns null, not throw', () => {
  const sd = tmpState();
  assert.equal(addLabel(sd, 'nope', { decision: 'bogus', ts: 1 }), null);
});

test('persists to disk: a second read sees the same data', () => {
  const sd = tmpState();
  upsertMeasurable(sd, { id: 'a', kind: 'guard-retire', title: 'a', ts: 1 });
  assert.equal(getMeasurable(sd, 'a').title, 'a');
});

test('upsertMeasurable requires a string id', () => {
  const sd = tmpState();
  assert.throws(() => upsertMeasurable(sd, { kind: 'guard-retire', title: 'x', ts: 1 }), /requires a string id/);
});
