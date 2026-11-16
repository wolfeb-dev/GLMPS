import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryUntilConnected, STOPPED } from '../lib/scut/connect-retry.js';

test('retries a failing attempt until it succeeds and reports each failure', async () => {
  let calls = 0;
  const failures = [];
  const result = await retryUntilConnected({
    attempt: async () => {
      calls += 1;
      if (calls < 3) throw new Error('fetch timeout ' + calls);
      return { user_id: 'U1' };
    },
    isStopped: () => false,
    sleep: async () => {},
    random: () => 0.5,
    onFailure: (f) => failures.push(f),
  });
  assert.deepEqual(result, { user_id: 'U1' });
  assert.equal(calls, 3);
  assert.deepEqual(failures.map((f) => f.attempt), [1, 2]);
  assert.deepEqual(failures.map((f) => f.error.message), ['fetch timeout 1', 'fetch timeout 2']);
});

test('delays grow exponentially and cap at maxDelayMs', async () => {
  const delays = [];
  let calls = 0;
  await retryUntilConnected({
    attempt: async () => { calls += 1; if (calls <= 6) throw new Error('x'); return 'ok'; },
    isStopped: () => false,
    sleep: async (ms) => { delays.push(ms); },
    random: () => 0.5,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
  });
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000, 10000]);
});

test('a stop during a sleep ends the loop without another attempt', async () => {
  let calls = 0;
  let stopped = false;
  const result = await retryUntilConnected({
    attempt: async () => { calls += 1; throw new Error('down'); },
    isStopped: () => stopped,
    sleep: async () => { stopped = true; },
  });
  assert.equal(result, STOPPED);
  assert.equal(calls, 1);
});

test('stopped before the first attempt makes no attempt', async () => {
  let calls = 0;
  const result = await retryUntilConnected({
    attempt: async () => { calls += 1; return 1; },
    isStopped: () => true,
    sleep: async () => {},
  });
  assert.equal(result, STOPPED);
  assert.equal(calls, 0);
});
