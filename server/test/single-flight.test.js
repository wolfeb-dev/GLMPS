// server/test/single-flight.test.js
//
// POST /api/memory/migrate-distilled must reject a
// second overlapping call (409) rather than racing the same ledger file.
// A true HTTP-level concurrency test is unreliable (Node's fetch/undici and
// the server's own microtask-only work for an unconfigured Mem0 stub can
// both complete a "concurrent" call before the second request is even
// dispatched - confirmed flaky against a real startServer() in this branch's
// history). This tests the exact guard mechanism the route uses
// deterministically instead, by controlling when the in-flight call
// resolves ourselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlight } from '../lib/plugins/single-flight.js';

test('a second call while the first is in-flight reports busy, and never runs its own work', async () => {
  const single = createSingleFlight();
  let resolveFirst;
  const firstDone = single(() => new Promise((r) => { resolveFirst = r; }));

  let secondRan = false;
  const second = await single(() => { secondRan = true; return Promise.resolve('never'); });
  assert.equal(second.busy, true);
  assert.equal(secondRan, false, 'the second call\'s work never runs while the first is still in-flight');

  resolveFirst('done');
  const first = await firstDone;
  assert.equal(first.busy, false);
  assert.equal(first.result, 'done');
});

test('a call after the first has completed runs normally (not stuck busy forever)', async () => {
  const single = createSingleFlight();
  await single(() => Promise.resolve('a'));
  const r = await single(() => Promise.resolve('b'));
  assert.equal(r.busy, false);
  assert.equal(r.result, 'b');
});

test('a call that throws still releases the guard for the next call', async () => {
  const single = createSingleFlight();
  const r1 = await single(() => { throw new Error('boom'); }).catch((e) => ({ threw: e.message }));
  assert.equal(r1.threw, 'boom');
  const r2 = await single(() => Promise.resolve('ok'));
  assert.equal(r2.busy, false);
  assert.equal(r2.result, 'ok');
});
