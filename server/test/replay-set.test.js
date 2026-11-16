import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addReplayTask, listReplayTasks, replayFile, refreshReplayBaseline } from '../lib/evaluation/replay-set.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replay-')); }

test('add then list round-trips with baseline', () => {
  const d = tmp();
  const baseline = { id: 'session-a', unit: 'session', taskClass: 'feature', turns: 3 };
  const r = addReplayTask(d, { id: 't1', project: 'mc', promptFile: '/p/t1.txt', baseline });
  assert.equal(r.isNew, true);
  const list = listReplayTasks(d);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 't1');
  assert.equal(list[0].baseline.turns, 3);
});

test('dedup by id', () => {
  const d = tmp();
  addReplayTask(d, { id: 't1' });
  const again = addReplayTask(d, { id: 't1' });
  assert.equal(again.isNew, false);
  assert.equal(listReplayTasks(d).length, 1);
});

test('missing dir lists empty', () => {
  assert.deepEqual(listReplayTasks(tmp()), []);
});

test('replayFile path shape', () => {
  const d = tmp();
  assert.ok(replayFile(d).endsWith(path.join('replay', 'tasks.json')));
});

// glmps-26: addReplayTask only ever sets a baseline ONCE (a no-op
// re-call on an existing id) - refreshReplayBaseline is the missing
// re-freeze path.
test('refreshReplayBaseline overwrites an existing task baseline and stamps baselineRefreshedAt', () => {
  const d = tmp();
  addReplayTask(d, { id: 't1', project: 'mc', baseline: { turns: 5 } });
  const r = refreshReplayBaseline(d, 't1', { turns: 2 });
  assert.equal(r.task.baseline.turns, 2);
  assert.ok(r.task.baselineRefreshedAt);

  const persisted = listReplayTasks(d).find(t => t.id === 't1');
  assert.equal(persisted.baseline.turns, 2);
  assert.ok(persisted.baselineRefreshedAt);
});

test('refreshReplayBaseline preserves the task createdAt (distinct from baselineRefreshedAt)', () => {
  const d = tmp();
  const { task: original } = addReplayTask(d, { id: 't1', project: 'mc', baseline: { turns: 5 } });
  const r = refreshReplayBaseline(d, 't1', { turns: 2 });
  assert.equal(r.task.createdAt, original.createdAt);
});

test('refreshReplayBaseline on an unknown id returns { task: null }, not a throw', () => {
  const d = tmp();
  const r = refreshReplayBaseline(d, 'nope', { turns: 2 });
  assert.equal(r.task, null);
});
