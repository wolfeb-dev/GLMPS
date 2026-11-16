import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepAbandoned, slugMatchesRoot, sanitizeRoot } from '../lib/evaluation/memory-distill-sweeper.js';

const cfg = { sweepIdleMs: 1000 };

function run(over = {}) {
  const enq = [];
  const r = sweepAbandoned({
    sessions: [{ id: 's1', transcriptPath: '/p/D--proj/s1.jsonl', mtimeMs: 0, live: false, cwd: '/c' }],
    watermark: {},
    nowMs: 10_000_000,
    cfg,
    knownRoots: ['D:/proj'],
    enqueueFn: (x) => enq.push(x),
    countLines: () => 50,
    ...over,
  });
  return { r, enq };
}

test('sanitizeRoot matches the Claude project slug scheme', () => {
  assert.equal(sanitizeRoot('D:\\glmps'), 'D--glmps');
  assert.equal(sanitizeRoot('D:/proj'), 'D--proj');
});

test('slugMatchesRoot compares against sanitized roots', () => {
  assert.equal(slugMatchesRoot('D--proj', ['D:/proj']), true);
  assert.equal(slugMatchesRoot('D--other', ['D:/proj']), false);
  assert.equal(slugMatchesRoot('x', null), false);
});

test('idle unprocessed known-root session is enqueued', () => {
  const { r, enq } = run();
  assert.deepEqual(r.enqueued, ['s1']);
  assert.equal(enq[0].sessionId, 's1');
  assert.equal(enq[0].transcriptPath, '/p/D--proj/s1.jsonl');
});

test('live session skipped', () => {
  const { r } = run({ sessions: [{ id: 's1', transcriptPath: '/p/D--proj/s1.jsonl', mtimeMs: 0, live: true, cwd: '/c' }] });
  assert.deepEqual(r.enqueued, []);
});

test('recently-active session skipped', () => {
  const { r } = run({ nowMs: 500 }); // 500 - 0 = 500 <= idle 1000
  assert.deepEqual(r.enqueued, []);
});

test('already-processed session skipped (watermark >= lines)', () => {
  const { r } = run({ watermark: { s1: 50 }, countLines: () => 50 });
  assert.deepEqual(r.enqueued, []);
});

test('unknown-root (throwaway cwd) session skipped', () => {
  const { r } = run({ knownRoots: ['D:/other'] });
  assert.deepEqual(r.enqueued, []);
});
