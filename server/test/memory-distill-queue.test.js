import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import * as q from '../lib/evaluation/memory-distill-queue.js';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mdq-'));

test('enqueue dedups by sessionId', () => {
  const d = tmp();
  q.enqueue(d, { sessionId:'s1', transcriptPath:'/t', cwd:'/c' });
  q.enqueue(d, { sessionId:'s1', transcriptPath:'/t', cwd:'/c' });
  assert.equal(q.isQueued(d, 's1'), true);
  const r = q.claimNext(d);
  assert.equal(r.sessionId, 's1');
  assert.equal(q.claimNext(d), null);
});
test('watermark set on markDone', () => {
  const d = tmp();
  q.markDone(d, 's2', 42);
  assert.equal(q.getWatermark(d).s2, 42);
});
test('markFailed drops after 2 retries', () => {
  const d = tmp();
  let r = { sessionId:'s3', transcriptPath:'/t', cwd:'/c', attempts:0 };
  q.markFailed(d, r); assert.equal(q.isQueued(d,'s3'), true);
  r = q.claimNext(d); q.markFailed(d, r);
  r = q.claimNext(d); q.markFailed(d, r); // attempts now >2
  assert.equal(q.isQueued(d,'s3'), false);
});

test('readDistillStatus defaults to no error before any run', () => {
  const d = tmp();
  assert.deepEqual(q.readDistillStatus(d), { lastError: null, recentErrors: [] });
});

test('recordDistillError persists lastError and a capped ring of recentErrors', () => {
  const d = tmp();
  q.recordDistillError(d, { sessionId: 's1', reason: 'timeout', detail: 'boom', ts: 1 });
  let status = q.readDistillStatus(d);
  assert.equal(status.lastError.reason, 'timeout');
  assert.equal(status.lastError.sessionId, 's1');
  assert.equal(status.recentErrors.length, 1);

  for (let i = 0; i < 15; i++) {
    q.recordDistillError(d, { sessionId: `s${i}`, reason: 'nonzero-exit', detail: null, ts: i });
  }
  status = q.readDistillStatus(d);
  assert.ok(status.recentErrors.length <= 10, 'the ring buffer stays capped');
  assert.equal(status.lastError.sessionId, 's14', 'lastError is always the most recent one');
  assert.equal(status.recentErrors[0].sessionId, 's14', 'recentErrors is newest-first');
});

test('recordDistillError survives a corrupt status.json (fail-open, never throws)', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'memory-distill'), { recursive: true });
  fs.writeFileSync(path.join(d, 'memory-distill', 'status.json'), 'not json');
  assert.deepEqual(q.readDistillStatus(d), { lastError: null, recentErrors: [] });
  q.recordDistillError(d, { sessionId: 's1', reason: 'timeout', ts: 1 });
  assert.equal(q.readDistillStatus(d).lastError.reason, 'timeout');
});
