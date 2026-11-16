// server/test/nightly-exec.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionSpend, gateResultsFromCard, makeHttpExecItem, DECLARED_GATES } from '../lib/orchestration/nightly-exec.js';

// sessionSpend

test('sessionSpend reads the real per-session cost row', () => {
  const readUsageFn = () => ({ perSession: [{ sid: 's1', costUsd: 2.5, input: 100, output: 50 }] });
  assert.deepEqual(sessionSpend('/state', 's1', { readUsageFn }), { usd: 2.5, tokens: 150 });
});

test('sessionSpend reports zero for an unknown session rather than throwing', () => {
  const readUsageFn = () => ({ perSession: [] });
  assert.deepEqual(sessionSpend('/state', 'nope', { readUsageFn }), { usd: 0, tokens: 0 });
});

test('sessionSpend survives an unreadable usage store', () => {
  const readUsageFn = () => { throw new Error('no usage dir'); };
  assert.deepEqual(sessionSpend('/state', 's1', { readUsageFn }), { usd: 0, tokens: 0 });
});

// gateResultsFromCard

test('a PASS acceptance gate is a passed gate', () => {
  const g = gateResultsFromCard({ gate: { status: 'PASS', evidence: ['npm test: 3868 pass'] } });
  const acceptance = g.find((x) => x.gateName === 'acceptance');
  assert.equal(acceptance.status, 'pass');
});

test('a FAIL acceptance gate is a failed gate', () => {
  const g = gateResultsFromCard({ gate: { status: 'FAIL' } });
  assert.equal(g.find((x) => x.gateName === 'acceptance').status, 'fail');
});

test('a WAIVED gate is recorded as SKIPPED, not as a pass', () => {
  // A waiver means the gate did not actually evaluate anything. Recording it
  // as a pass would let repeated waivers look like a clean record; recording
  // it as skipped feeds the skipped_gates drift check, which is the point.
  const g = gateResultsFromCard({ gate: { status: 'WAIVED', evidence: ['operator waived'] } });
  assert.equal(g.find((x) => x.gateName === 'acceptance').status, 'skipped');
});

test('a CONCERNS gate passes but carries the concern in its details', () => {
  const g = gateResultsFromCard({ gate: { status: 'CONCERNS', evidence: ['flaky test'] } });
  const a = g.find((x) => x.gateName === 'acceptance');
  assert.equal(a.status, 'pass');
  assert.match(a.details, /concerns/i);
});

test('a card with no gate at all records acceptance as skipped, never omitted', () => {
  const g = gateResultsFromCard({});
  const a = g.find((x) => x.gateName === 'acceptance');
  assert.equal(a.status, 'skipped');
  assert.match(a.details, /no gate/i);
});

test('every gate the verifier stack does not have yet is recorded as skipped', () => {
  // a gate that does not exist is skipped and LOGGED as skipped.
  // Silence would make the verifier stack look complete before it is.
  const g = gateResultsFromCard({ gate: { status: 'PASS' } });
  for (const name of DECLARED_GATES) {
    assert.ok(g.some((x) => x.gateName === name), `${name} must appear in every run's gate results`);
  }
  assert.equal(g.filter((x) => x.status === 'skipped').length, DECLARED_GATES.length - 1);
});

// makeHttpExecItem

function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const key = `${opts.method ?? 'GET'} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    return handler();
  };
}

test('the executor drives the existing runner launch endpoint, not a second launcher', async () => {
  let launched = null;
  const exec = makeHttpExecItem({
    port: '8123',
    stateDir: '/state',
    readUsageFn: () => ({ perSession: [] }),
    sleepFn: async () => {},
    fetchFn: fakeFetch({
      'POST /api/runner/run/a': () => { launched = 'a'; return { ok: true, status: 200, json: async () => ({}) }; },
      'GET /api/backlog': () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'a', state: 'done', branch: 'b1', sessionId: 's1', gate: { status: 'PASS' } }] }) }),
    }),
  });
  const res = await exec({ id: 'a', project: 'glmps' });
  assert.equal(launched, 'a');
  assert.equal(res.ok, true);
  assert.equal(res.branch, 'b1');
});

test('a launch the server refuses is reported, not retried forever', async () => {
  const exec = makeHttpExecItem({
    port: '8123', stateDir: '/state', readUsageFn: () => ({ perSession: [] }), sleepFn: async () => {},
    fetchFn: fakeFetch({ 'POST /api/runner/run/a': () => ({ ok: false, status: 409, json: async () => ({ error: 'observe-only' }) }) }),
  });
  const res = await exec({ id: 'a' });
  assert.equal(res.ok, false);
  assert.match(res.error, /observe-only|409/);
});

test('a card that never finishes times out and is reported blocked', async () => {
  let polls = 0;
  const exec = makeHttpExecItem({
    port: '8123', stateDir: '/state', timeoutMs: 30, pollMs: 10,
    readUsageFn: () => ({ perSession: [] }),
    sleepFn: async () => {},
    now: (() => { let t = 0; return () => (t += 20); })(),
    fetchFn: fakeFetch({
      'POST /api/runner/run/a': () => ({ ok: true, status: 200, json: async () => ({}) }),
      'GET /api/backlog': () => { polls++; return { ok: true, status: 200, json: async () => ({ items: [{ id: 'a', state: 'in_progress' }] }) }; },
    }),
  });
  const res = await exec({ id: 'a' });
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out/i);
  assert.ok(polls > 0 && polls < 100, `expected a bounded number of polls, got ${polls}`);
});

test('a cancelled card is not a success', async () => {
  const exec = makeHttpExecItem({
    port: '8123', stateDir: '/state', readUsageFn: () => ({ perSession: [] }), sleepFn: async () => {},
    fetchFn: fakeFetch({
      'POST /api/runner/run/a': () => ({ ok: true, status: 200, json: async () => ({}) }),
      'GET /api/backlog': () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'a', state: 'cancelled' }] }) }),
    }),
  });
  assert.equal((await exec({ id: 'a' })).ok, false);
});

// D27: a card released mid-run (stale/TTL/eviction/stop) goes to 'idle', not
// 'done'/'cancelled'. That is terminal (the session is gone), so polling must
// stop the moment it is observed, exactly like queue-runner.js's own FINISHED
// set already does for its ledger -- if the two sets drift, an idle card here
// is misread as still in flight and burns the full timeout instead of
// reporting the real outcome immediately.
test('an idle card (D27 release) stops polling immediately and is reported not-success, not a timeout', async () => {
  let polls = 0;
  const exec = makeHttpExecItem({
    port: '8123', stateDir: '/state', timeoutMs: 1000, pollMs: 10,
    readUsageFn: () => ({ perSession: [] }),
    sleepFn: async () => {},
    now: (() => { let t = 0; return () => (t += 10); })(),
    fetchFn: fakeFetch({
      'POST /api/runner/run/a': () => ({ ok: true, status: 200, json: async () => ({}) }),
      'GET /api/backlog': () => { polls++; return { ok: true, status: 200, json: async () => ({ items: [{ id: 'a', state: 'idle' }] }) }; },
    }),
  });
  const res = await exec({ id: 'a' });
  assert.equal(res.ok, false);
  assert.match(res.error, /item ended in state idle/);
  assert.equal(polls, 1, 'polling must stop on the first idle observation, not run to the timeout');
});

test('the executor reports the real spend of the session the card ran in', async () => {
  const exec = makeHttpExecItem({
    port: '8123', stateDir: '/state', sleepFn: async () => {},
    readUsageFn: () => ({ perSession: [{ sid: 's9', costUsd: 4, input: 10, output: 5 }] }),
    fetchFn: fakeFetch({
      'POST /api/runner/run/a': () => ({ ok: true, status: 200, json: async () => ({}) }),
      'GET /api/backlog': () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'a', state: 'done', sessionId: 's9', gate: { status: 'PASS' } }] }) }),
    }),
  });
  const res = await exec({ id: 'a' });
  assert.equal(res.spend.usd, 4);
  assert.equal(res.spend.tokens, 15);
});
