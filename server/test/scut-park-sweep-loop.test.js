// server/test/scut-park-sweep-loop.test.js
// The park sweep under the loop contract: maker and checker are different
// functions, and the proof-it-closes cases (broken maker, broken checker
// input, then a good run) drive the registry's alert on and off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopRegistry } from '../lib/loops/registry.js';
import { loopAlerts } from '../lib/loops/loop-health.js';
import { createParkSweepLoop, PARK_SWEEP_LOOP } from '../lib/scut/park-sweep-loop.js';
import { STALE_MS } from '../lib/scut/park.js';

const NOW = 50 * 3_600_000;

function world({ activity = null, releaseImpl = null } = {}) {
  const state = {
    ledger: { 'p-1': { parkedSince: NOW - 3_600_000, parkLastPollTs: NOW - STALE_MS - 10 } },
    items: [{ id: 'p-1', state: 'in_progress', gate: null }],
  };
  const deps = {
    loadLedger: () => structuredClone(state.ledger),
    saveLedger: (l) => { state.ledger = structuredClone(l); },
    loadItems: () => structuredClone(state.items),
    // A factory, called once per sweep (maker) / once per check (checker),
    // not once per ledger entry - see the dedicated
    // once-per-sweep test below for the count itself; every other test here
    // only cares about the constant it resolves to.
    activityTs: () => () => activity,
    parkHours: () => 168,
    now: () => NOW,
    release: releaseImpl ?? (async (id, { to }) => {
      delete state.ledger[id];
      state.items = state.items.map((i) => (i.id === id ? { ...i, state: to } : i));
      return { released: true, to, posted: true, error: null };
    }),
    closeIdle: async (id) => {
      state.items = state.items.map((i) => (i.id === id ? { ...i, state: 'done' } : i));
      return { closed: true, posted: true, error: null };
    },
  };
  return { state, deps };
}

function registry() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-park-loop-'));
  return createLoopRegistry({ stateDir, now: () => NOW, setTimer: () => 0, clearTimer: () => {} });
}

test('maker and checker are distinct functions; the spec is the program table row', () => {
  const { deps } = world();
  const loop = createParkSweepLoop(deps);
  assert.notEqual(loop.maker, loop.checker);
  assert.deepEqual(PARK_SWEEP_LOOP.trigger, { everyMs: 60000 });
  assert.equal(PARK_SWEEP_LOOP.ceiling.maxModelCalls, 0);
});

test('proof it closes: failing maker alerts, a release that closes a live card fails the checker, a good run clears', async () => {
  const reg = registry();
  // (a) the maker fails: the ledger cannot be read.
  const broken = world();
  broken.deps.loadLedger = () => { throw new Error('ledger unreadable'); };
  let current = createParkSweepLoop(broken.deps);
  const handle = reg.registerLoop({ ...PARK_SWEEP_LOOP, maker: (ctx) => current.maker(ctx), checker: (r, ctx) => current.checker(r, ctx) });
  await handle.runNow();
  let snap = reg.snapshot()['scut-park-sweep'];
  assert.match(snap.lastOutcome, /^failed:/);
  assert.equal(loopAlerts(reg.snapshot()).filter((a) => a.title === 'Loop failing: scut-park-sweep').length, 1);

  // (b) the maker "succeeds" but released to done, which the checker rejects.
  const wrong = world({ releaseImpl: null });
  wrong.deps.release = async (id) => {
    delete wrong.state.ledger[id];
    wrong.state.items = wrong.state.items.map((i) => (i.id === id ? { ...i, state: 'done' } : i));
    return { released: true, to: 'idle', posted: true, error: null };
  };
  current = createParkSweepLoop(wrong.deps);
  await handle.runNow();
  snap = reg.snapshot()['scut-park-sweep'];
  assert.match(snap.lastReason, /p-1 is done, expected idle/);
  assert.equal(snap.consecutiveFailures, 2);

  // (c) a good run releases to idle and clears the alert.
  const good = world();
  current = createParkSweepLoop(good.deps);
  await handle.runNow();
  snap = reg.snapshot()['scut-park-sweep'];
  assert.equal(snap.lastOutcome, 'done');
  assert.equal(snap.consecutiveFailures, 0);
  assert.equal(loopAlerts(reg.snapshot()).filter((a) => a.title === 'Loop failing: scut-park-sweep').length, 0);
  assert.equal(good.state.items[0].state, 'idle');
});

test('the checker catches a release of a session that was alive', async () => {
  const { deps } = world();
  const loop = createParkSweepLoop({ ...deps, activityTs: () => () => NOW - 1000 });
  const verdict = await loop.checker({ recovered: 0, decisions: [{ id: 'p-1', reason: 'stale', to: 'idle' }], closed: [], postFailures: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /p-1 released as stale but showed activity/);
});

// Fix round 1, M7 (part 2): the same independent re-check the 'stale' case
// gets must also cover 'reopen-unconfirmed' - a relaunched entry released as
// unconfirmed despite fresh activity is exactly the silent-bug shape D27 was
// filed about, and the original ledger entry (with its reopenedTs) is
// already gone by checker time, so activityTs is the only signal left.
test('the checker catches a reopen-unconfirmed release of an entry that showed activity', async () => {
  const { deps } = world();
  const loop = createParkSweepLoop({ ...deps, activityTs: () => () => NOW - 1000 });
  const verdict = await loop.checker({ recovered: 0, decisions: [{ id: 'p-1', reason: 'reopen-unconfirmed', to: 'idle' }], closed: [], postFailures: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /p-1 released as reopen-unconfirmed but showed activity/);
});

test('a failed thread post fails the run', async () => {
  const { deps, state } = world();
  deps.release = async (id, { to }) => {
    delete state.ledger[id];
    state.items = state.items.map((i) => (i.id === id ? { ...i, state: to } : i));
    return { released: true, to, posted: false, error: 'thread post failed: channel_not_found' };
  };
  const loop = createParkSweepLoop(deps);
  const made = await loop.maker({});
  const verdict = await loop.checker(made.result, {});
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /p-1: thread post failed: channel_not_found/);
});

test('nothing parked and nothing idle is nothing-to-do', async () => {
  const { deps } = world();
  deps.loadLedger = () => ({});
  deps.loadItems = () => [];
  const made = await createParkSweepLoop(deps).maker({});
  assert.equal(made.outcome, 'nothing-to-do');
});


test('round1 item1: a reopen mid-sweep means closeIdle declines, and the maker does not claim a close it did not perform', async () => {
  // closeIdle re-reads the card fresh at call time (the real scutCloseIdle's
  // guard, modelled here): even though the maker's own idleClosures()
  // snapshot said this card was idle+PASS, by the time closeIdle actually
  // looks the card has been reopened (an operator reply, or another actor),
  // so it must decline rather than close a card that is no longer eligible.
  const state = { items: [{ id: 'a-1', state: 'idle', gate: { status: 'PASS' }, idleSince: new Date(NOW - 200 * 3_600_000).toISOString() }] };
  const closeIdle = async (id) => {
    // Simulates the reopen landing between the maker's snapshot and this call.
    state.items = state.items.map((i) => (i.id === id ? { ...i, state: 'in_progress' } : i));
    const fresh = state.items.find((i) => i.id === id);
    if (!fresh || fresh.state !== 'idle' || fresh.gate?.status !== 'PASS') return { closed: false, posted: false, error: null };
    state.items = state.items.map((i) => (i.id === id ? { ...i, state: 'done' } : i));
    return { closed: true, posted: true, error: null };
  };
  const deps = {
    loadLedger: () => ({}), saveLedger: () => {}, loadItems: () => state.items,
    activityTs: () => () => null, parkHours: () => 168, now: () => NOW,
    release: async () => ({ released: true, to: 'idle', posted: true, error: null }),
    closeIdle,
  };
  const made = await createParkSweepLoop(deps).maker({});
  assert.deepEqual(made.result.closed, [], 'closeIdle declined, so the maker records no close for it');
  assert.equal(state.items[0].state, 'in_progress', 'the reopen stands; nothing overwrote it back to done');
});

test('round1 item1: two overlapping maker runs against a shared idempotent closeIdle post exactly once', async () => {
  const state = { items: [
    { id: 'x', state: 'idle', gate: { status: 'PASS' }, idleSince: new Date(NOW - 200 * 3_600_000).toISOString() },
    { id: 'y', state: 'idle', gate: { status: 'PASS' }, idleSince: new Date(NOW - 200 * 3_600_000).toISOString() },
  ] };
  let postCountY = 0;
  let releaseXGate;
  const xGate = new Promise((res) => { releaseXGate = res; });
  const closeIdle = async (id) => {
    if (id === 'x') await xGate; // x's post is slow: the stale run stalls here
    const fresh = state.items.find((i) => i.id === id);
    if (!fresh || fresh.state !== 'idle' || fresh.gate?.status !== 'PASS') return { closed: false, posted: false, error: null };
    state.items = state.items.map((i) => (i.id === id ? { ...i, state: 'done' } : i));
    if (id === 'y') postCountY += 1;
    return { closed: true, posted: true, error: null };
  };
  const deps = {
    loadLedger: () => ({}), saveLedger: () => {}, loadItems: () => state.items,
    activityTs: () => () => null, parkHours: () => 168, now: () => NOW,
    release: async () => ({ released: false, to: 'idle', posted: false, error: 'n/a' }),
    closeIdle,
  };
  const staleMakerRun = createParkSweepLoop(deps).maker({}); // snapshot: [x idle, y idle]; stalls on x's slow post
  await deps.closeIdle('y'); // a fresh, faster actor closes y for real while the stale run is stuck
  assert.equal(postCountY, 1);
  releaseXGate();
  const made = await staleMakerRun;
  assert.equal(postCountY, 1, "the stale run's late arrival at y did not post a second Closed message");
  assert.deepEqual(made.result.closed.sort(), ['x'], 'the stale run only claims the close it actually performed');
});

test('round1 item1: an aborted signal stops the maker before it starts the next release or close', async () => {
  const { deps } = world();
  let releaseCalls = 0;
  deps.release = async () => { releaseCalls += 1; return { released: true, to: 'idle', posted: true, error: null }; };
  const ac = new AbortController();
  ac.abort();
  const made = await createParkSweepLoop(deps).maker({ signal: ac.signal });
  assert.equal(releaseCalls, 0, 'aborted before the first release call');
  assert.deepEqual(made.result.decisions, []);
});

test('round1 item2: the checker names every failed post, not only the first', async () => {
  const { deps } = world();
  const loop = createParkSweepLoop(deps);
  const result = {
    recovered: 0, decisions: [], closed: [],
    postFailures: [
      { id: 'p-1', error: 'thread post failed: channel_not_found' },
      { id: 'p-2', error: 'thread post failed: rate_limited' },
    ],
  };
  const verdict = await loop.checker(result);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /p-1: thread post failed: channel_not_found/);
  assert.match(verdict.reason, /p-2: thread post failed: rate_limited/);
});

test('round1 item3: activityTs is built once per sweep (maker) and once per check (checker), not once per ledger entry', async () => {
  const ledger = {
    'p-1': { parkedSince: NOW - 3_600_000, parkLastPollTs: NOW - STALE_MS - 10 },
    'p-2': { parkedSince: NOW - 3_600_000, parkLastPollTs: NOW - STALE_MS - 10 },
  };
  const items = [
    { id: 'p-1', state: 'in_progress', gate: null },
    { id: 'p-2', state: 'in_progress', gate: null },
  ];
  let factoryCalls = 0;
  const activityTs = () => { factoryCalls += 1; return () => null; };
  const deps = {
    loadLedger: () => structuredClone(ledger), saveLedger: () => {}, loadItems: () => structuredClone(items),
    activityTs, parkHours: () => 168, now: () => NOW,
    release: async (id, { to }) => ({ released: true, to, posted: true, error: null }),
    closeIdle: async () => ({ closed: false, posted: false, error: null }),
  };
  const loop = createParkSweepLoop(deps);
  const made = await loop.maker({});
  assert.equal(made.result.decisions.length, 2, 'both ledger entries were swept');
  assert.equal(factoryCalls, 1, 'built once for the whole sweep, not once per ledger entry');
  await loop.checker(made.result);
  assert.equal(factoryCalls, 2, 'built once more for the whole check, not once per decision');
});

test('round1 item4: a release declined mid-sweep (already released elsewhere) is skipped with a named reason, not a post failure', async () => {
  const { deps } = world();
  deps.release = async () => ({ released: false, to: 'idle', posted: false, error: 'not in the ledger' });
  const loop = createParkSweepLoop(deps);
  const made = await loop.maker({});
  assert.deepEqual(made.result.decisions, []);
  assert.deepEqual(made.result.postFailures, []);
  assert.deepEqual(made.result.skipped, [{ id: 'p-1', reason: 'not in the ledger' }]);
  assert.equal(made.outcome, 'nothing-to-do');
  const verdict = await loop.checker(made.result);
  assert.equal(verdict.ok, true);
});
