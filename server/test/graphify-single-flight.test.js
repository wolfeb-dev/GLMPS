// server/test/graphify-single-flight.test.js
// one per-root in-flight guard shared by every
// `graphify update <root>` caller (graphRebuildTick, the wiki loop maker's
// refreshGraph, POST /api/graph/rebuild). Two writers racing on the same
// root's graph.json is the 2026-07-28 collapse-incident class; a second
// caller for the SAME root while the first is still running must be
// refused with a named reason, never allowed to run as a second writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphifySingleFlight, GraphifyBusyError, waitForGraphifyUpdate } from '../lib/observability/graphify-single-flight.js';

test('a second run() for the SAME root while the first is in flight is refused with a named reason, not a second writer', async () => {
  const sf = createGraphifySingleFlight();
  let release;
  const gate = new Promise((r) => { release = r; });
  let started = 0;
  const first = sf.run('/d/repo', async () => { started += 1; await gate; return 'first-done'; });
  assert.equal(sf.isRunning('/d/repo'), true);
  await assert.rejects(
    sf.run('/d/repo', async () => { started += 1; return 'second-done'; }),
    (e) => e instanceof GraphifyBusyError && e.code === 'graphify-busy' && /repo/.test(e.message),
  );
  assert.equal(started, 1, 'the second caller never actually ran: no second writer');
  release();
  assert.equal(await first, 'first-done');
  assert.equal(sf.isRunning('/d/repo'), false, 'released once the first call settles');
});

test('a DIFFERENT root runs concurrently, unaffected by another root\'s in-flight update', async () => {
  const sf = createGraphifySingleFlight();
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  const a = sf.run('/d/repo-a', async () => { await gateA; return 'a-done'; });
  assert.equal(sf.isRunning('/d/repo-a'), true);
  assert.equal(sf.isRunning('/d/repo-b'), false);
  const b = await sf.run('/d/repo-b', async () => 'b-done');
  assert.equal(b, 'b-done', 'a different root is never blocked by another root\'s in-flight update');
  releaseA();
  assert.equal(await a, 'a-done');
});

test('the same root under a different path spelling (separators, trailing slash, case) still collides', async () => {
  const sf = createGraphifySingleFlight();
  let release;
  const gate = new Promise((r) => { release = r; });
  // Separators only fold on win32 (a backslash is an ordinary character on
  // posix); case and a trailing slash fold everywhere.
  const [one, two] = process.platform === 'win32' ? ['D:/Repo', 'd:\\repo\\'] : ['/d/Repo', '/d/repo/'];
  const first = sf.run(one, async () => { await gate; return 'done'; });
  await assert.rejects(sf.run(two, async () => 'second'), GraphifyBusyError);
  release();
  await first;
});

test('a root is released even when the wrapped call throws, never left stuck busy', async () => {
  const sf = createGraphifySingleFlight();
  await assert.rejects(sf.run('/d/repo', async () => { throw new Error('graphify exited 1'); }), /graphify exited 1/);
  assert.equal(sf.isRunning('/d/repo'), false);
  const after = await sf.run('/d/repo', async () => 'ok-again');
  assert.equal(after, 'ok-again');
});

test('isRunning is false for a root that was never started, never a throw', () => {
  const sf = createGraphifySingleFlight();
  assert.equal(sf.isRunning('/d/never-touched'), false);
});

// waitForGraphifyUpdate retries on
// GraphifyBusyError (a waiting acquire with a bounded timeout) instead of
// letting a single busy-collision escape as an unrecoverable failure.
test('waitForGraphifyUpdate retries on GraphifyBusyError and succeeds once the root frees up', async () => {
  let calls = 0;
  const graphifyUpdate = async (root) => {
    calls += 1;
    if (calls < 3) throw new GraphifyBusyError(root);
    return { code: 0, stdout: 'No code-graph topology changes detected', stderr: '' };
  };
  const sleeps = [];
  const result = await waitForGraphifyUpdate('/d/repo', graphifyUpdate, {
    timeout: 1000, maxWaitMs: 60_000, pollMs: 500,
    now: () => 1_000_000, // never advances: the deadline never elapses on its own in this test
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(calls, 3, 'retried exactly until the root freed up, no more');
  assert.deepEqual(sleeps, [500, 500], 'slept between the two busy attempts, not before the first or after the last');
  assert.equal(result.code, 0);
});

test('waitForGraphifyUpdate rethrows GraphifyBusyError once the bounded wait elapses, never loops forever', async () => {
  let calls = 0;
  const graphifyUpdate = async (root) => { calls += 1; throw new GraphifyBusyError(root); };
  let sleepCalls = 0;
  // now() reports the deadline as already passed on the very first check,
  // so this must give up after exactly one attempt -- not spin, not wait.
  let nowCalls = 0;
  const now = () => { nowCalls += 1; return nowCalls === 1 ? 0 : 60_001; };
  await assert.rejects(
    waitForGraphifyUpdate('/d/repo', graphifyUpdate, { timeout: 1000, maxWaitMs: 60_000, now, sleep: async () => { sleepCalls += 1; } }),
    GraphifyBusyError,
  );
  assert.equal(calls, 1, 'exactly one attempt once the deadline has already elapsed');
  assert.equal(sleepCalls, 0, 'never sleeps once the deadline check itself fails');
});

test('waitForGraphifyUpdate propagates a non-busy error immediately, never retried', async () => {
  let calls = 0;
  const graphifyUpdate = async () => { calls += 1; throw new Error('graphify exited 1: some other failure'); };
  await assert.rejects(waitForGraphifyUpdate('/d/repo', graphifyUpdate, { timeout: 1000 }), /some other failure/);
  assert.equal(calls, 1);
});

// the default sleep's timer was never
// unref'd. graphifyVersionTick has no shutdown tie-in of its own (the
// registry's loop timers are stop()'d/cleared, but this is a plain
// function call, not a registered loop), so a pending busy-wait could keep
// the whole process alive past close() and go on to run a real uv rollback
// after shutdown had already "completed" from the operator's perspective.
test('the default sleep unrefs its timer, so a pending wait never keeps the process alive (N4)', async () => {
  const realSetTimeout = global.setTimeout;
  let unrefCalled = false;
  global.setTimeout = (fn, ms) => {
    const t = realSetTimeout(fn, ms);
    const realUnref = t.unref.bind(t);
    t.unref = (...args) => { unrefCalled = true; return realUnref(...args); };
    return t;
  };
  // The unref'd sleep is the ONLY pending timer during the wait, so without a
  // ref'd keepalive the event loop empties and node --test reports the test's
  // promise as never settled (seen on Linux CI).
  const keepAlive = setInterval(() => {}, 1000);
  try {
    let calls = 0;
    const graphifyUpdate = async (root) => { calls += 1; if (calls < 2) throw new GraphifyBusyError(root); return 'done'; };
    // The default sleep (no override) is exercised deliberately: pollMs
    // kept small so this test does not actually wait a long time.
    const result = await waitForGraphifyUpdate('/d/repo', graphifyUpdate, { timeout: 1000, maxWaitMs: 60_000, pollMs: 5 });
    assert.equal(result, 'done');
    assert.equal(unrefCalled, true, 'the default sleep must unref its own timer');
  } finally { global.setTimeout = realSetTimeout; clearInterval(keepAlive); }
});

test('a reserved root refuses callers without the reservation, admits its holder, and frees on release', async () => {
  const sf = createGraphifySingleFlight();
  const r = sf.reserve(['D:/repo', 'D:/other']);
  await assert.rejects(sf.run('d:/REPO/', async () => 'x'), (e) => e instanceof GraphifyBusyError);
  assert.equal(await sf.run('D:/repo', async () => 'mine', { reservation: r.token }), 'mine');
  assert.equal(await sf.run('D:/elsewhere', async () => 'free'), 'free');
  r.release();
  assert.equal(await sf.run('D:/repo', async () => 'after'), 'after');
});

test('a second reservation leaves a root already reserved to its first holder', async () => {
  const sf = createGraphifySingleFlight();
  const a = sf.reserve(['D:/repo']);
  const b = sf.reserve(['D:/repo']);
  b.release();
  await assert.rejects(sf.run('D:/repo', async () => 'x', { reservation: b.token }), (e) => e instanceof GraphifyBusyError);
  assert.equal(await sf.run('D:/repo', async () => 'a', { reservation: a.token }), 'a');
  a.release();
});

test('waitIdle returns once the roots are free, and reports the busy ones at the deadline', async () => {
  const sf = createGraphifySingleFlight();
  let release;
  const running = sf.run('D:/repo', () => new Promise((r) => { release = r; }));
  let clock = 0;
  const sleep = async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); };
  assert.deepEqual(await sf.waitIdle(['D:/repo', 'D:/other'], { now: () => clock, sleep, pollMs: 10, maxWaitMs: 50 }), { idle: false, busy: ['D:/repo'] });
  const waiting = sf.waitIdle(['D:/repo'], { now: () => clock, sleep, pollMs: 10, maxWaitMs: 1e9 });
  release(); await running;
  assert.deepEqual(await waiting, { idle: true, busy: [] });
});
