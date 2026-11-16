import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendOutcome, readOutcomes, updateOutcome, outcomeFile } from '../lib/evaluation/outcome-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outcome-')); }

test('append then read round-trips', () => {
  const d = tmp();
  appendOutcome(d, { id: 'session-a', unit: 'session', taskClass: 'feature', turns: 3 });
  const rows = readOutcomes(d);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'session-a');
  assert.equal(rows[0].turns, 3);
});

test('readOutcomes filters by unit and taskClass', () => {
  const d = tmp();
  appendOutcome(d, { id: 's1', unit: 'session', taskClass: 'debug' });
  appendOutcome(d, { id: 't1', unit: 'trade', taskClass: 'other' });
  assert.equal(readOutcomes(d, { unit: 'trade' }).length, 1);
  assert.equal(readOutcomes(d, { taskClass: 'debug' })[0].id, 's1');
});

test('updateOutcome patches in place by id', () => {
  const d = tmp();
  appendOutcome(d, { id: 's1', unit: 'session', revertedLater: null });
  const r = updateOutcome(d, 's1', { revertedLater: true });
  assert.equal(r.row.revertedLater, true);
  assert.equal(readOutcomes(d)[0].revertedLater, true);
});

// a shallow `{...row, ...patch}` merge
// let a judge update's `extra` patch (e.g. { outcomeClass, judge }) wipe
// every OTHER field already recorded under row.extra (e.g. readEditRatio,
// written earlier by a completely different code path) instead of adding to
// it. extra is now deep-merged: only its own keys are patched.
test('updateOutcome deep-merges extra, so an unrelated patch does not wipe fields already recorded there (readEditRatio survives a judged update)', () => {
  const d = tmp();
  appendOutcome(d, { id: 's1', unit: 'session', extra: { readEditRatio: 0.42 } });
  const r = updateOutcome(d, 's1', { taskClass: 'debug', extra: { outcomeClass: 'succeeded', judge: { pass: true } } });
  assert.equal(r.row.extra.readEditRatio, 0.42, 'pre-existing extra field survives');
  assert.equal(r.row.extra.outcomeClass, 'succeeded');
  assert.deepEqual(r.row.extra.judge, { pass: true });
  const onDisk = readOutcomes(d)[0];
  assert.equal(onDisk.extra.readEditRatio, 0.42);
});

test('updateOutcome with no extra in the patch leaves the existing extra untouched', () => {
  const d = tmp();
  appendOutcome(d, { id: 's1', unit: 'session', extra: { readEditRatio: 0.7 } });
  const r = updateOutcome(d, 's1', { revertedLater: true });
  assert.deepEqual(r.row.extra, { readEditRatio: 0.7 });
});

test('updateOutcome on missing id returns null row', () => {
  const d = tmp();
  appendOutcome(d, { id: 's1', unit: 'session' });
  assert.equal(updateOutcome(d, 'nope', { x: 1 }).row, null);
});

test('missing dir reads empty; malformed lines skipped', () => {
  const d = tmp();
  assert.deepEqual(readOutcomes(d), []);
  fs.mkdirSync(path.join(d, 'outcomes'), { recursive: true });
  fs.writeFileSync(outcomeFile(d), '{bad\n{"id":"ok","unit":"session"}\n');
  assert.equal(readOutcomes(d).length, 1);
});
