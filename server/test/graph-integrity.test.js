import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  graphShape, observeGraphShape, stampVerifiedNoop, verifiedCommitFor,
  graphIntegrity, loadGraphIntegrity, persistGraphIntegrity,
} from '../lib/observability/graph-integrity.js';

const shape = (nodes, edges = nodes * 2, builtAtCommit = 'abc') => ({ nodes, edges, builtAtCommit });

test('graphShape reads node and edge counts and built_at_commit', () => {
  assert.deepEqual(graphShape({ nodes: [1, 2, 3], links: [1], built_at_commit: 'c1' }), { nodes: 3, edges: 1, builtAtCommit: 'c1' });
  assert.deepEqual(graphShape({}), { nodes: 0, edges: 0, builtAtCommit: null });
  assert.equal(graphShape(null), null);
});

test('a collapse from N to under 10 percent of N is flagged', () => {
  let s = observeGraphShape({}, 'D:/a', shape(6140), { now: 1 });
  assert.equal(s['D:/a'].collapsed, false);
  s = observeGraphShape(s, 'D:/a', shape(55), { now: 2 });
  assert.equal(s['D:/a'].collapsed, true);
  assert.equal(s['D:/a'].last.nodes, 55);
  assert.ok(s['D:/a'].dropRatio > 0.99);
});

test('the baseline does not move to a collapsed shape, so the flag survives repeat samples', () => {
  let s = observeGraphShape({}, 'D:/a', shape(1000), { now: 1 });
  s = observeGraphShape(s, 'D:/a', shape(50), { now: 2 });
  s = observeGraphShape(s, 'D:/a', shape(52), { now: 3 });
  assert.equal(s['D:/a'].collapsed, true);
  assert.equal(s['D:/a'].baseline.nodes, 1000);
});

test('normal churn and growth do not flag, and recovery clears the flag', () => {
  let s = observeGraphShape({}, 'D:/a', shape(1000), { now: 1 });
  s = observeGraphShape(s, 'D:/a', shape(900), { now: 2 });
  assert.equal(s['D:/a'].collapsed, false);
  s = observeGraphShape(s, 'D:/a', shape(1200), { now: 3 });
  assert.equal(s['D:/a'].baseline.nodes, 1200);
  s = observeGraphShape(s, 'D:/a', shape(10), { now: 4 });
  assert.equal(s['D:/a'].collapsed, true);
  s = observeGraphShape(s, 'D:/a', shape(1180), { now: 5 });
  assert.equal(s['D:/a'].collapsed, false);
});

test('a verified no-op stamp is recorded, and refused while collapsed', () => {
  let s = observeGraphShape({}, 'D:/a', shape(100), { now: 1 });
  s = stampVerifiedNoop(s, 'D:/a', { commit: 'head2', now: 2 });
  assert.equal(verifiedCommitFor(s, 'D:/a'), 'head2');
  s = observeGraphShape(s, 'D:/a', shape(3), { now: 3 });
  s = stampVerifiedNoop(s, 'D:/a', { commit: 'head3', now: 4 });
  assert.equal(verifiedCommitFor(s, 'D:/a'), 'head2');
  assert.equal(verifiedCommitFor(s, 'D:/missing'), null);
});

test('a root named with backslashes and with slashes is one record', () => {
  let s = observeGraphShape({}, 'C:\\repo\\x', shape(10), { now: 1 });
  s = stampVerifiedNoop(s, 'C:/repo/x', { commit: 'h1', now: 2 });
  assert.equal(verifiedCommitFor(s, 'C:\\repo\\x'), 'h1');
  assert.deepEqual(Object.keys(s), ['C:/repo/x']);
});

test('round-trips through disk and returns {} for a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-'));
  const file = path.join(dir, 'state', 'graph-integrity.json');
  assert.deepEqual(loadGraphIntegrity(file), {});
  const s = observeGraphShape({}, 'D:/a', shape(7), { now: 9 });
  persistGraphIntegrity(file, s);
  assert.deepEqual(graphIntegrity(loadGraphIntegrity(file)), s);
  fs.rmSync(dir, { recursive: true, force: true });
});
