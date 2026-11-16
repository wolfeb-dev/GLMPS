// server/test/git-limiter.test.js
// The one process-wide cap on concurrent `git` child processes (extracted out
// of server.js so server.js's own git-status scan and the surface routes'
// repoTree/fileDiff share a single pool instead of each keeping an unbounded
// or independently-capped one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, gitLimiter } from '../lib/git-limiter.js';

test('createLimiter caps concurrent execution at max and still runs every queued call', async () => {
  const limiter = createLimiter(2);
  let active = 0, peak = 0;
  const task = () => limiter(() => new Promise((resolve) => {
    active++; peak = Math.max(peak, active);
    setTimeout(() => { active--; resolve('ok'); }, 20);
  }));
  const results = await Promise.all(Array.from({ length: 6 }, task));
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r === 'ok'));
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the cap of 2`);
});

test('createLimiter propagates a rejection without blocking the queue behind it', async () => {
  const limiter = createLimiter(1);
  const bad = limiter(() => Promise.reject(new Error('boom')));
  const good = limiter(() => Promise.resolve('ok'));
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('gitLimiter is a ready-to-use shared limiter instance', async () => {
  assert.equal(typeof gitLimiter, 'function');
  assert.equal(await gitLimiter(() => Promise.resolve(42)), 42);
});
