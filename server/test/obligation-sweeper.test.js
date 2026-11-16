import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openObligationStore } from '../lib/kernel/obligations.js';
import { loopObligations, sweepObligations, obligationAlerts, obligationSweeperLoop, closeGateVerdict } from '../lib/kernel/obligation-sweeper.js';
import { tsToMs } from '../lib/observability/event-log.js';
import * as sweeperModule from '../lib/kernel/obligation-sweeper.js';
import { createLoopRegistry, CeilingError } from '../lib/loops/registry.js';
import { diagnosisStubReason } from '../lib/loops/auto-diagnosis.js';

function mk(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sweep-')); return { dir, store: openObligationStore({ dbFile: path.join(dir, 'kernel.db'), now: () => t.v, emit: () => {} }) }; }

test('a registered loop opens a freshness obligation; a checked done closes it by the checker and reopens it', async () => {
  const t = { v: 1000 }; const { dir, store } = mk(t);
  const reg = createLoopRegistry({ stateDir: dir, now: () => t.v, setTimer: () => 0, clearTimer: () => {}, obligations: loopObligations(store, { now: () => t.v }) });
  reg.registerLoop({ name: 'wiki', trigger: { onEvent: 'x' }, maker: async () => ({ outcome: 'done', result: 1 }), checker: async () => ({ ok: true, verifierRef: 'verify:abc' }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 5000 } });
  const first = store.findOpen({ kind: 'loop.freshness', subject: 'wiki' });
  assert.equal(first.dueTs, 6000);
  t.v = 2000; await reg.emit('x');
  const closed = store.get(first.id);
  assert.equal(closed.closer, 'verified.done'); assert.equal(closed.closedBy, 'checker:wiki'); assert.equal(closed.verifierRef, 'verify:abc');
  assert.equal(store.findOpen({ kind: 'loop.freshness', subject: 'wiki' }).dueTs, 7000);
  reg.stop(); store.closeDb();
});

test('nothing-to-do closes by the classifier, and sla.obligation false opens nothing', async () => {
  const t = { v: 1 }; const { dir, store } = mk(t);
  const reg = createLoopRegistry({ stateDir: dir, now: () => t.v, setTimer: () => 0, clearTimer: () => {}, obligations: loopObligations(store, { now: () => t.v }) });
  const spec = (name, sla) => ({ name, trigger: { onEvent: name }, maker: async () => ({ outcome: 'nothing-to-do' }), checker: async () => ({ ok: true }), ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla });
  reg.registerLoop(spec('a', { maxAgeMs: 100 })); reg.registerLoop(spec('b', { maxAgeMs: 100, obligation: false }));
  await reg.emit('a');
  assert.equal(store.listAll().find((r) => r.subject === 'a' && r.closedTs).closedBy, 'classifier:a');
  assert.equal(store.listAll().filter((r) => r.subject === 'b').length, 0);
  reg.stop(); store.closeDb();
});

test('proof it closes: an overdue loop expires, alerts, diagnoses once, climbs the ladder hourly, and a good run clears it', async () => {
  const t = { v: 0 }; const { dir, store } = mk(t);
  const posts = []; const diags = [];
  store.open({ kind: 'loop.freshness', subject: 'wiki', openedBy: 'kernel', dueTs: 100 });
  const sweep = () => sweepObligations({ store, now: () => t.v, notify: async (row, level) => posts.push(level), diagnose: async (row) => diags.push(row.subject) });
  t.v = 200; await sweep();
  assert.equal(obligationAlerts(store.listOpen()).length, 1);
  assert.deepEqual(diags, ['wiki']); assert.deepEqual(posts, []);
  t.v = 300; await sweep(); assert.deepEqual(posts, [], 'not before an hour');
  t.v = 200 + 3_600_000; await sweep(); assert.deepEqual(posts, [1]);
  t.v = 200 + 7_200_000; await sweep(); assert.deepEqual(posts, [1, 2]);
  const row = store.findOpen({ kind: 'loop.freshness', subject: 'wiki' });
  store.close(row.id, { closer: 'verified.done', closedBy: 'checker:wiki', verifierRef: 'v' });
  assert.equal(obligationAlerts(store.listOpen()).length, 0);
  assert.deepEqual(diags, ['wiki'], 'diagnosis ran once for the expiry');
  store.closeDb();
});

test('proof it closes (the loop): a store that will not open fails every run; a stuck overdue row fails the checker; a good sweep clears', async () => {
  const { createLoopRegistry } = await import('../lib/loops/registry.js');
  const { loopAlerts } = await import('../lib/loops/loop-health.js');
  const { obligationSweeperLoop } = await import('../lib/kernel/obligation-sweeper.js');
  const t = { v: 0 }; const { dir, store } = mk(t);
  const reg = createLoopRegistry({ stateDir: dir, now: () => t.v, setTimer: () => 0, clearTimer: () => {} });
  const spec = (st, sweep) => ({ trigger: { onEvent: 'tick' }, ...obligationSweeperLoop({ store: st, sweep, now: () => t.v }), ceiling: { maxAttempts: 1, maxModelCalls: 5, timeoutMs: 1000 }, sla: { maxAgeMs: 300_000, obligation: false } });
  reg.registerLoop({ name: 'sweeper-down', ...spec(null, async () => ({})) });
  await reg.emit('tick');
  assert.match(reg.get('sweeper-down').lastReason, /obligations store unavailable/);
  store.open({ kind: 'loop.freshness', subject: 'x', openedBy: 'kernel', dueTs: 1 });
  t.v = 400_000;
  let broken = true;
  reg.registerLoop({ name: 'sweeper', ...spec(store, async (a) => (broken ? { expired: [], escalated: [] } : sweepObligations(a))) });
  await reg.emit('tick');
  assert.match(reg.get('sweeper').lastReason, /checker:1 overdue rows not expired/);
  broken = false; await reg.emit('tick');
  assert.equal(reg.get('sweeper').consecutiveFailures, 0, 'a good sweep clears the loop failure');
  assert.equal(loopAlerts(reg.snapshot()).filter((a) => a.title === 'Loop failing: sweeper').length, 0);
  reg.stop(); store.closeDb();
});

test('a failed Slack post is an error the sweep reports, not silence', async () => {
  const t = { v: 0 }; const { store } = mk(t);
  store.open({ kind: 'loop.freshness', subject: 'x', openedBy: 'kernel', dueTs: 1 });
  t.v = 10; await sweepObligations({ store, now: () => t.v, notify: async () => {}, diagnose: async () => {} });
  t.v = 10 + 3_600_000;
  await assert.rejects(sweepObligations({ store, now: () => t.v, notify: async () => { throw new Error('slack down'); }, diagnose: async () => {} }), /slack down/);
  store.closeDb();
});

// K4 fix round 1, item 1, corrected fix round 2,
// items 1 and 2: sweepObligations no longer calls ctx.countModelCall()
// itself (a bare catch there used to swallow EVERY ceiling breach silently
// and, worse, spent a ceiling slot on rows the wiring would never actually
// diagnose - see the two dedicated tests below for that). It only passes
// ctx through as diagnose's second argument, for every row unconditionally
// - whether and when to spend a ceiling slot is entirely the diagnose
// callback's own decision (server.js's wiring makes it per row-eligibility;
// see diagnosisStubReason, auto-diagnosis.js). This test's diagnose
// discriminates its own ceiling breach and keeps going, proving that
// choice (not sweepObligations catching anything) is what keeps the
// remaining diagnoses and the escalation step alive past the ceiling.
test('ctx reaches diagnose(row, ctx) for every row; a diagnose that discriminates its own ceiling breach keeps the sweep and escalation going', async () => {
  const t = { v: 0 }; const { store } = mk(t);
  // A row already an hour past its own expiry, due for its first escalation.
  store.open({ kind: 'loop.freshness', subject: 'stale', openedBy: 'kernel', dueTs: 1 });
  t.v = 1; await sweepObligations({ store, now: () => t.v, notify: async () => {}, diagnose: async () => {} });
  t.v = 1 + 3_600_000 + 10;
  // Ten more rows, freshly due right now (this sweep's own expireDue()).
  for (let i = 0; i < 10; i++) store.open({ kind: 'loop.freshness', subject: `x${i}`, openedBy: 'kernel', dueTs: t.v - 1 });

  const diagnosed = []; const posts = [];
  const diagnose = async (row, passedCtx) => {
    assert.ok(passedCtx, 'ctx reaches every diagnose(row, ctx) call');
    // This diagnose's own choice to absorb its ceiling breach and keep
    // going - not something sweepObligations does on its behalf. K4 fix
    // catch only CeilingError, matching the real wiring's
    // own discrimination (diagnosisStubReason) - anything else propagates,
    // never a bare catch even in a test double.
    try { passedCtx.countModelCall(); }
    catch (e) { if (!(e instanceof CeilingError)) throw e; /* recorded by the tally below; this diagnose still "runs" (files its card) regardless */ }
    diagnosed.push(row.subject);
  };
  const notify = async (row) => { posts.push(row.subject); };
  let calls = 0;
  const ctx = { countModelCall() { calls += 1; if (calls > 5) throw new CeilingError('ceiling:model-calls'); } };

  await sweepObligations({ store, now: () => t.v, notify, diagnose, ctx });

  assert.equal(diagnosed.length, 10, 'every newly-expired row still gets a diagnosis attempt, even past the ceiling');
  assert.deepEqual(posts, ['stale'], 'the already-due escalation still runs after a ceiling exception mid-diagnosis');
  assert.equal(calls, 10, 'the SAME ctx object reached diagnose ten times');
});

// a ceiling slot must be spent only
// when a real model call would actually happen - not for every expired
// row regardless of kind. Six gate.independent-verdict expiries (this
// finding's own example) alongside a loop's own ceiling of 5 must NOT
// fail the run, since none of them are ever eligible for diagnosis at all
// (the eligibility gate is server.js's own wiring; this proves
// sweepObligations itself never spends a slot on their behalf - only a
// diagnose implementation that calls ctx.countModelCall() does, and this
// one only does so for the kind it considers eligible).
test('ineligible rows never spend a ceiling slot: six gate.independent-verdict expiries do not trip a ceiling of 5', async () => {
  const t = { v: 0 }; const { store } = mk(t);
  for (let i = 0; i < 6; i++) store.open({ kind: 'gate.independent-verdict', subject: `tkt${i}`, openedBy: 'kernel', dueTs: 1 });
  t.v = 10;
  let calls = 0;
  const ctx = { countModelCall() { calls += 1; if (calls > 5) throw new Error('ceiling:model-calls'); } };
  // Mirrors server.js's own eligibility gate: only a 'loop.freshness' row
  // is ever a candidate for a real diagnosis attempt.
  const diagnose = async (row, passedCtx) => { if (row.kind !== 'loop.freshness') return; passedCtx?.countModelCall?.(); };
  await sweepObligations({ store, now: () => t.v, notify: async () => {}, diagnose, ctx });
  assert.equal(calls, 0, 'none of the six ineligible rows ever call countModelCall()');
});

test('sweep() with no ctx (an injected test double, or a caller that omits it) is unaffected: countModelCall is simply never called', async () => {
  const t = { v: 0 }; const { store } = mk(t);
  store.open({ kind: 'loop.freshness', subject: 'x', openedBy: 'kernel', dueTs: 1 });
  t.v = 10;
  const diags = [];
  await sweepObligations({ store, now: () => t.v, notify: async () => {}, diagnose: async (row) => diags.push(row.subject) });
  assert.deepEqual(diags, ['x']);
  store.closeDb();
});

// obligationSweeperLoop's maker must accept and forward ctx - the registry
// (registry.js execute()) always calls `spec.maker(ctx)`; a maker that
// ignores its own parameter silently drops the ceiling wiring, which is
// exactly bug 1 above.
test('obligationSweeperLoop\'s maker accepts ctx and threads it into sweep()', async () => {
  const t = { v: 0 }; const { store } = mk(t);
  let seenCtx;
  const sweep = async (args) => { seenCtx = args.ctx; return { expired: [], escalated: [] }; };
  const { maker } = obligationSweeperLoop({ store, sweep, now: () => t.v });
  const ctx = { countModelCall: () => {} };
  await maker(ctx);
  assert.equal(seenCtx, ctx);
  store.closeDb();
});

// End to end, through the real registry: a burst of expired rows in one
// tick, gated by the SAME persisted daily budget nextDiagnosisBudget (and
// therefore handleLoopStreak) uses, with the loop's own per-run ceiling
// wired via ctx. K4 fix round 3, item 1: this test used to assert the run
// FAILED on ceiling:model-calls here, enshrining the very bug that round's
// re-review caught - ctx.countModelCall() was being spent on every
// eligible row regardless of whether the daily budget even had room, so
// ten attempts against a ceiling of 5 failed the run even though only 3
// of them ever made (or tried to make) a real call. With the budget
// peeked BEFORE the ceiling, only those 3 real attempts ever touch
// ctx.countModelCall() at all - well under 5 - so the run now correctly
// succeeds.
test('proof it closes (the budget): 10 expired rows, maxPerDay 3 -> at most 3 real diagnoses, all 10 filed, escalation still runs, and the run succeeds', async () => {
  const t = { v: 0 }; const { dir, store } = mk(t);
  const reg = createLoopRegistry({ stateDir: dir, now: () => t.v, setTimer: () => 0, clearTimer: () => {} });
  // A row already an hour past its own expiry, due for its first
  // escalation THIS tick, alongside the ten freshly-expiring ones below.
  store.open({ kind: 'loop.freshness', subject: 'stale', openedBy: 'kernel', dueTs: 1 });
  t.v = 1; await sweepObligations({ store, now: () => t.v, notify: async () => {}, diagnose: async () => {} });
  t.v = 1 + 3_600_000 + 10;
  for (let i = 0; i < 10; i++) store.open({ kind: 'loop.freshness', subject: `row${i}`, openedBy: 'kernel', dueTs: t.v - 1 });

  const budgetStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sweep-budget-'));
  const cfg = { enabled: true, maxPerDay: 3 };
  let realDiagnoses = 0;
  const filed = []; const escalated = [];
  const diagnose = async (row, ctx) => {
    const stubReason = diagnosisStubReason({ ctx, stateDir: budgetStateDir, cfg, now: () => t.v, label: row.subject });
    if (!stubReason) realDiagnoses += 1;
    filed.push(row.subject);
  };
  const notify = async (row) => { escalated.push(row.subject); };

  reg.registerLoop({
    name: 'sweeper', trigger: { onEvent: 'tick' },
    ...obligationSweeperLoop({ store, notify, diagnose, now: () => t.v }),
    ceiling: { maxAttempts: 1, maxModelCalls: 5, timeoutMs: 5000 }, sla: { maxAgeMs: 300_000, obligation: false },
  });
  await reg.emit('tick');

  assert.equal(realDiagnoses, 3, 'the persisted daily budget caps real diagnoses at maxPerDay');
  assert.equal(filed.length, 10, 'every expired row still gets a diagnosis attempt (a filed card), regardless of either ceiling');
  assert.deepEqual(escalated, ['stale'], 'escalation for the already-due row still runs alongside the diagnoses');
  assert.equal(reg.get('sweeper').lastOutcome, 'done', 'only 3 real diagnoses ever touch the run ceiling (well under 5) - the run succeeds');
  reg.stop(); store.closeDb();
});

// the companion case the coordinator's own fix
// asks for - a daily budget already EXHAUSTED before this tick even
// starts. Six expired rows, a run ceiling of 5: under the old (buggy)
// order every one of them would have spent a ceiling slot regardless of
// the budget, failing this run on ceiling:model-calls despite zero real
// model calls ever being attempted. With the peek-first order, none of
// the six ever reaches ctx.countModelCall() at all.
test('proof it closes (the budget): six rows over an already-exhausted daily budget never touch the run ceiling, and the run succeeds', async () => {
  const t = { v: 0 }; const { dir, store } = mk(t);
  const reg = createLoopRegistry({ stateDir: dir, now: () => t.v, setTimer: () => 0, clearTimer: () => {} });
  for (let i = 0; i < 6; i++) store.open({ kind: 'loop.freshness', subject: `row${i}`, openedBy: 'kernel', dueTs: 1 });
  t.v = 10;

  const budgetStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sweep-budget-'));
  const today = new Date(t.v).toISOString().slice(0, 10);
  // The budget file lives at <stateDir>/loops/diagnosis-budget.json (see
  // budgetFile(), auto-diagnosis.js) - not directly under stateDir.
  fs.mkdirSync(path.join(budgetStateDir, 'loops'), { recursive: true });
  fs.writeFileSync(path.join(budgetStateDir, 'loops', 'diagnosis-budget.json'), JSON.stringify({ day: today, n: 3 }));
  const cfg = { enabled: true, maxPerDay: 3 };
  let realDiagnoses = 0;
  const filed = [];
  const diagnose = async (row, ctx) => {
    const stubReason = diagnosisStubReason({ ctx, stateDir: budgetStateDir, cfg, now: () => t.v, label: row.subject });
    if (!stubReason) realDiagnoses += 1;
    filed.push(row.subject);
  };

  reg.registerLoop({
    name: 'sweeper', trigger: { onEvent: 'tick' },
    ...obligationSweeperLoop({ store, notify: async () => {}, diagnose, now: () => t.v }),
    ceiling: { maxAttempts: 1, maxModelCalls: 5, timeoutMs: 5000 }, sla: { maxAgeMs: 300_000, obligation: false },
  });
  await reg.emit('tick');

  assert.equal(realDiagnoses, 0, 'the daily budget was already exhausted before this tick - no real diagnosis is ever attempted');
  assert.equal(filed.length, 6, 'every row still gets a diagnosis attempt (a filed card, with the daily-ceiling stub)');
  assert.equal(reg.get('sweeper').lastOutcome, 'done', 'the run is not failed - none of the six rows ever touched the run ceiling at all');
  reg.stop(); store.closeDb();
});

// the escalation loop used to ignore
// what escalate() actually returned. `next` is escalate()'s own fresh
// re-read by id - it is the only thing trusted about a row's CURRENT
// state at the moment of escalation, never the store.listOpen() snapshot
// taken at the top of the sweep (a row later in that snapshot can close,
// or otherwise change, while an EARLIER row's own `await notify()` is
// still in flight).
test('escalate: a row closed while an earlier row\'s notify() is still awaited is never escalated - no false overdue post', async () => {
  const t = { v: 0 }; const { store } = mk(t);
  const a = store.open({ kind: 'loop.freshness', subject: 'A', openedBy: 'kernel', dueTs: 1 });
  const b = store.open({ kind: 'loop.freshness', subject: 'B', openedBy: 'kernel', dueTs: 2 });
  t.v = 2; await sweepObligations({ store, now: () => t.v, notify: async () => {}, diagnose: async () => {} }); // expires both, in dueTs order
  t.v = 2 + 3_600_000 + 10; // both due for their first escalation
  const posts = [];
  const notify = async (row) => {
    posts.push(row.subject);
    if (row.subject === 'A') {
      // A concurrent process closes B while A's own notify() is in flight.
      store.close(b.id, { closer: 'verified.done', closedBy: 'checker:B', verifierRef: 'v' });
    }
  };
  await sweepObligations({ store, now: () => t.v, notify, diagnose: async () => {} });
  assert.deepEqual(posts, ['A'], 'B closed mid-sweep must never get a false overdue post');
  const closedB = store.get(b.id);
  assert.ok(closedB.closedTs != null, 'B is closed, from the concurrent close during A\'s notify()');
  assert.equal(closedB.escalationLevel, 0, 'B\'s escalation level never advanced past its first-expiry level - it was already closed by the time its own turn came');
});

test('escalate: setMeta persists the FRESH meta after escalate(), not the pre-sweep snapshot', async () => {
  const t = { v: 0 }; const { store } = mk(t);
  const a = store.open({ kind: 'loop.freshness', subject: 'A', openedBy: 'kernel', dueTs: 1 });
  const c = store.open({ kind: 'loop.freshness', subject: 'C', openedBy: 'kernel', dueTs: 2 });
  t.v = 2; await sweepObligations({ store, now: () => t.v, notify: async () => {}, diagnose: async () => {} });
  t.v = 2 + 3_600_000 + 10;
  const notify = async (row) => {
    if (row.subject === 'A') {
      // A concurrent process tags C's meta while A's own notify() is in flight.
      store.setMeta(c.id, { taggedByOther: true });
    }
  };
  await sweepObligations({ store, now: () => t.v, notify, diagnose: async () => {} });
  assert.equal(store.get(c.id).meta.taggedByOther, true, 'the concurrent tag on C must survive C\'s own escalation setMeta call, not be reverted to the stale pre-sweep snapshot');
});

// Task 11's brief, verbatim: "when a verdict row with a non-null ticketId
// lands, close obligationStore.findOpen({ kind: 'gate.independent-verdict',
// subject: ticketId }) with { closer: 'verified.done', closedBy:
// 'judge-plugin', verifierRef: `judge:${rowId}` }." Task 11 opened the
// obligation (POST /api/backlog/:id/gate on a PASS) and left it with no
// closer wired, since the judge was not yet a registered loop on this
// branch; K Task 6 (the judge cutover as a loop) is what supplies a landed
// verdict to close it from.

test('closeGateVerdict closes the open gate.independent-verdict obligation for the verdicted ticket', () => {
  const t = { v: 1000 }; const { store } = mk(t);
  const opened = store.open({ kind: 'gate.independent-verdict', subject: 'card-1', openedBy: 'agent:reviewer' });
  const closed = closeGateVerdict({ store, ticketId: 'card-1', rowId: 'row-9' });
  assert.equal(closed.id, opened.id);
  assert.equal(closed.closer, 'verified.done');
  assert.equal(closed.closedBy, 'judge-plugin');
  assert.equal(closed.verifierRef, 'judge:row-9');
  assert.ok(closed.closedTs != null);
});

test('closeGateVerdict is a no-op (not a throw) when the ticket never had an open gate obligation', () => {
  const t = { v: 1000 }; const { store } = mk(t);
  const result = closeGateVerdict({ store, ticketId: 'never-gated', rowId: 'row-1' });
  assert.equal(result, null);
});

test('closeGateVerdict is a no-op when the ticket\'s obligation is already closed', () => {
  const t = { v: 1000 }; const { store } = mk(t);
  const opened = store.open({ kind: 'gate.independent-verdict', subject: 'card-2', openedBy: 'agent:reviewer' });
  store.close(opened.id, { closer: 'decision.cancelled', closedBy: 'operator' });
  const result = closeGateVerdict({ store, ticketId: 'card-2', rowId: 'row-2' });
  assert.equal(result, null);
  assert.equal(store.get(opened.id).closer, 'decision.cancelled', 'an operator decision is never overwritten by a later verdict');
});

test('closeGateVerdict is a no-op (not a throw) with no store or no ticketId', () => {
  const t = { v: 1000 }; const { store } = mk(t);
  assert.equal(closeGateVerdict({ store: null, ticketId: 'card-3', rowId: 'row-3' }), null);
  assert.equal(closeGateVerdict({ store, ticketId: null, rowId: 'row-3' }), null);
});

// the closer must not let a STALE
// verdict (one computed for a session that ended before the CURRENT gate
// obligation was even opened - e.g. a slow retry from a much earlier
// attempt) close a fresh obligation for the same ticket. verdictTs is the
// judged session's own end/verdict timestamp; a verdict older than the
// obligation's openedTs is refused.
test('closeGateVerdict refuses a stale verdict (ended before the current obligation opened), leaving it open', () => {
  // "before" means before openedTs minus the
  // 5-minute FRESHNESS_TOLERANCE_MS, so the obligation here opens an hour in.
  const t = { v: 3_600_000 }; const { store } = mk(t);
  const opened = store.open({ kind: 'gate.independent-verdict', subject: 'card-4', openedBy: 'agent:reviewer' });
  const result = closeGateVerdict({ store, ticketId: 'card-4', rowId: 'row-4', verdictTs: 1000 });
  assert.equal(result, null, 'a verdict older than the obligation itself must not close it');
  assert.equal(store.get(opened.id).closedTs, null, 'still open');
});

test('closeGateVerdict closes when the verdict landed after the obligation opened', () => {
  const t = { v: 5000 }; const { store } = mk(t);
  store.open({ kind: 'gate.independent-verdict', subject: 'card-5', openedBy: 'agent:reviewer' });
  const result = closeGateVerdict({ store, ticketId: 'card-5', rowId: 'row-5', verdictTs: 6000 });
  assert.ok(result, 'a fresh verdict (after the obligation opened) closes it');
  assert.equal(result.closedTs, 5000);
});

test('closeGateVerdict with no verdictTs given closes unconditionally (caller opted out of the freshness check)', () => {
  const t = { v: 5000 }; const { store } = mk(t);
  store.open({ kind: 'gate.independent-verdict', subject: 'card-6', openedBy: 'agent:reviewer' });
  const result = closeGateVerdict({ store, ticketId: 'card-6', rowId: 'row-6' });
  assert.ok(result);
});

// K Task 6 fix round 4 RULING (closer freshness, with real ISO-derived
// timestamps). verdictTs is the judged SESSION's last event ts (tsToMs of an
// ISO-8601 event ts), not the time the judge ran. A gate PASS posted as the
// session's own last act opens its obligation at or slightly AFTER that last
// event, so a strict verdictTs < openedTs check would stop the session's own
// verdict from ever closing its own obligation (a false 24h expiry alert on
// most tickets). The verdict closes when the last event ts >= openedTs -
// FRESHNESS_TOLERANCE_MS (5 minutes); a genuinely earlier session (judged
// before a reopen) is still refused.
test('closeGateVerdict (round 4): the gating session\'s own verdict closes the obligation its PASS opened just after its last event', () => {
  const lastEventIso = '2026-09-30T12:00:00.000Z';
  const t = { v: Date.parse('2026-09-30T12:00:40.000Z') }; const { store } = mk(t); // the PASS lands 40s after the last captured event
  const opened = store.open({ kind: 'gate.independent-verdict', subject: 'card-iso', openedBy: 'agent:reviewer' });
  const result = closeGateVerdict({ store, ticketId: 'card-iso', rowId: 'row-iso', verdictTs: tsToMs(lastEventIso) });
  assert.ok(result, 'the session\'s own verdict must close its own gate obligation');
  assert.equal(result.id, opened.id);
  assert.equal(sweeperModule.FRESHNESS_TOLERANCE_MS, 5 * 60_000, 'the tolerance is a named, exported constant');
});

test('closeGateVerdict (round 4): a verdict for a session that ended before a reopen is refused', () => {
  const sessionEndIso = '2026-09-30T12:00:00.000Z';
  const t = { v: Date.parse('2026-09-30T12:00:40.000Z') }; const { store } = mk(t);
  const first = store.open({ kind: 'gate.independent-verdict', subject: 'card-re', openedBy: 'agent:reviewer' });
  store.close(first.id, { closer: 'decision.cancelled', closedBy: 'operator' });
  t.v = Date.parse('2026-09-30T14:00:00.000Z'); // the ticket is reopened and gated again two hours later
  const reopened = store.open({ kind: 'gate.independent-verdict', subject: 'card-re', openedBy: 'agent:reviewer' });
  const result = closeGateVerdict({ store, ticketId: 'card-re', rowId: 'row-old', verdictTs: tsToMs(sessionEndIso) });
  assert.equal(result, null, 'a pre-reopen session has nothing to say about the fresh obligation');
  assert.equal(store.get(reopened.id).closedTs, null, 'still open');
});

test('closeGateVerdict on a different ticket\'s obligation is unaffected', () => {
  const t = { v: 5000 }; const { store } = mk(t);
  const untouched = store.open({ kind: 'gate.independent-verdict', subject: 'card-other', openedBy: 'agent:reviewer' });
  closeGateVerdict({ store, ticketId: 'card-7', rowId: 'row-7', verdictTs: 6000 });
  assert.equal(store.get(untouched.id).closedTs, null, 'a different ticket\'s obligation stays open');
});

// Phase K final review I2 (reviewer probe P2): a loop.freshness row opened
// before downtime kept its stale dueTs across the next boot's re-register,
// so the first sweep after an overnight restart expired every loop before
// any of them had a chance to run once. On register, an overdue (not yet
// expired) freshness row is re-based to now + its interval.
test('I2/P2: a freshness row left overdue by downtime is re-based on re-register, not expired at the first post-boot sweep', () => {
  const t = { v: 1_000_000 }; const { store } = mk(t);
  const spec = { sla: { maxAgeMs: 60 * 60_000 } };
  loopObligations(store, { now: () => t.v }).onRegister('git-remote-feed', spec); // process 1 boot
  t.v += 2 * 3_600_000; // 2h downtime
  loopObligations(store, { now: () => t.v }).onRegister('git-remote-feed', spec); // process 2 boot
  const expired = store.expireDue();
  assert.deepEqual(expired.map((r) => r.subject), [], 'the first sweep after a reboot must not expire a loop that has not had a chance to run');
  const row = store.findOpen({ kind: 'loop.freshness', subject: 'git-remote-feed' });
  assert.equal(row.dueTs, t.v + 60 * 60_000, 're-based to now + the loop\'s own interval');
  assert.equal(row.meta?.rebasedFromDueTs, 1_000_000 + 60 * 60_000, 'the original due time is kept for the record');
  t.v += 60 * 60_000 + 1; // the loop still never runs: a real miss now expires as before
  assert.deepEqual(store.expireDue().map((r) => r.subject), ['git-remote-feed']);
  store.closeDb();
});

test('I2: a row that already expired before the restart is not re-based (a real miss stays a miss)', () => {
  const t = { v: 1_000_000 }; const { store } = mk(t);
  const spec = { sla: { maxAgeMs: 1000 } };
  loopObligations(store, { now: () => t.v }).onRegister('x-loop', spec);
  t.v += 5000; store.expireDue();
  const before = store.findOpen({ kind: 'loop.freshness', subject: 'x-loop' });
  assert.equal(before.escalationLevel, 0);
  t.v += 3_600_000;
  loopObligations(store, { now: () => t.v }).onRegister('x-loop', spec);
  const after = store.findOpen({ kind: 'loop.freshness', subject: 'x-loop' });
  assert.equal(after.id, before.id);
  assert.equal(after.dueTs, before.dueTs, 'an expired row keeps its due time and its escalation');
  assert.equal(after.escalationLevel, 0);
  store.closeDb();
});

test('I2: a row not yet due at re-register keeps its own due time', () => {
  const t = { v: 1_000_000 }; const { store } = mk(t);
  const spec = { sla: { maxAgeMs: 60 * 60_000 } };
  loopObligations(store, { now: () => t.v }).onRegister('y-loop', spec);
  const first = store.findOpen({ kind: 'loop.freshness', subject: 'y-loop' }).dueTs;
  t.v += 10 * 60_000;
  loopObligations(store, { now: () => t.v }).onRegister('y-loop', spec);
  assert.equal(store.findOpen({ kind: 'loop.freshness', subject: 'y-loop' }).dueTs, first);
  store.closeDb();
});

// Phase K final review I2: a loop that used to promise freshness and now
// registers with sla.obligation false (nightly-run on an instance whose
// nightly actor is off) must not leave the earlier boot's open row behind
// to expire into a false alert. It is closed decision.cancelled by the
// kernel, with the reason, at register.
test('I2: registering with sla.obligation false cancels a freshness row an earlier boot left open', () => {
  const t = { v: 1_000_000 }; const { store } = mk(t);
  loopObligations(store, { now: () => t.v }).onRegister('nightly-run', { sla: { maxAgeMs: 36 * 3_600_000 } });
  const old = store.findOpen({ kind: 'loop.freshness', subject: 'nightly-run' });
  assert.ok(old);
  t.v += 1000;
  loopObligations(store, { now: () => t.v }).onRegister('nightly-run', { sla: { maxAgeMs: 36 * 3_600_000, obligation: false } });
  assert.equal(store.findOpen({ kind: 'loop.freshness', subject: 'nightly-run' }), null);
  const closed = store.get(old.id);
  assert.equal(closed.closer, 'decision.cancelled');
  assert.equal(closed.closedBy, 'kernel');
  assert.match(closed.verifierRef, /obligation: false/);
  store.closeDb();
});

test('isGateVerdictStale: true only for a verdict older than the open obligation beyond the tolerance', () => {
  const t = { v: 3_600_000 }; const { store } = mk(t);
  store.open({ kind: 'gate.independent-verdict', subject: 'card-s', openedBy: 'agent:reviewer' });
  assert.equal(sweeperModule.isGateVerdictStale({ store, ticketId: 'card-s', verdictTs: 1000 }), true);
  assert.equal(sweeperModule.isGateVerdictStale({ store, ticketId: 'card-s', verdictTs: 3_600_000 - 60_000 }), false);
  assert.equal(sweeperModule.isGateVerdictStale({ store, ticketId: 'card-s', verdictTs: null }), false);
  assert.equal(sweeperModule.isGateVerdictStale({ store, ticketId: 'never-gated', verdictTs: 1 }), false);
  assert.equal(sweeperModule.isGateVerdictStale({ store: null, ticketId: 'card-s', verdictTs: 1 }), false);
});

// glmps-2-0-64: a host sleep with no restart. The 2026-10-18 shape: rows due
// inside the sleep expired on the first sweep after wake.
function sleepFixture() {
  const t = { v: 0 }; const { dir, store } = mk(t);
  const resumes = [];
  const suspend = sweeperModule.createSuspendDetector({ now: () => t.v, gapMs: 60_000, onSuspend: (s) => resumes.push({ ...s, rebased: sweeperModule.rebaseForSuspend(store, s) }) });
  const diags = [];
  const loop = obligationSweeperLoop({ store, now: () => t.v, suspend, diagnose: async (row) => diags.push(row.subject) });
  return { t, dir, store, suspend, resumes, diags, loop };
}

test('suspend: a clock jump past the SLA with no restart expires nothing on the first sweep after resume', async () => {
  const { t, store, suspend, resumes, diags, loop } = sleepFixture();
  suspend.check();
  store.open({ kind: 'loop.freshness', subject: 'scut-park-sweep', openedBy: 'kernel', dueTs: 300_000 });
  store.open({ kind: 'loop.freshness', subject: 'git-remote-feed', openedBy: 'kernel', dueTs: 2_700_000 });
  t.v = 10_000; suspend.check(); await loop.maker(null);
  // Asleep for 76 minutes; the sweeper timer fires before the heartbeat.
  t.v = 10_000 + 76 * 60_000;
  const out = await loop.maker(null);
  assert.deepEqual(out.result.expired, []);
  assert.deepEqual(diags, []);
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].fromTs, 10_000); assert.equal(resumes[0].toTs, t.v);
  assert.equal(resumes[0].rebased.length, 2);
  const park = store.findOpen({ kind: 'loop.freshness', subject: 'scut-park-sweep' });
  assert.equal(park.dueTs, 300_000 + 76 * 60_000, 'the sleep does not count against the SLA');
  assert.equal(park.meta.rebasedFromDueTs, 300_000);
  assert.ok((await loop.checker()).ok);
  suspend.check(); assert.equal(resumes.length, 1, 'one gap, one resume');
  store.closeDb();
});

test('suspend: a real miss while awake still expires, before and after a sleep', async () => {
  const { t, store, suspend, resumes, diags, loop } = sleepFixture();
  suspend.check();
  store.open({ kind: 'loop.freshness', subject: 'awake-miss', openedBy: 'kernel', dueTs: 25_000 });
  for (t.v = 10_000; t.v <= 40_000; t.v += 10_000) suspend.check();
  // Due 25s, last tick 40s: missed while awake, swept only after the sleep.
  t.v = 40_000 + 30 * 60_000;
  const out = await loop.maker(null);
  assert.equal(resumes.length, 1); assert.deepEqual(resumes[0].rebased, []);
  assert.equal(out.result.expired.length, 1);
  assert.deepEqual(diags, ['awake-miss']);
  store.open({ kind: 'loop.freshness', subject: 'later-miss', openedBy: 'kernel', dueTs: t.v + 15_000 });
  const start = t.v;
  for (t.v = start + 10_000; t.v <= start + 30_000; t.v += 10_000) suspend.check();
  const again = await loop.maker(null);
  assert.equal(again.result.expired.length, 1);
  assert.deepEqual(diags, ['awake-miss', 'later-miss']);
  assert.equal(resumes.length, 1);
  store.closeDb();
});

test('suspend: a sweeper backing off between runs is not a suspend while the heartbeat keeps ticking', async () => {
  const { t, store, suspend, resumes, loop } = sleepFixture();
  suspend.check();
  store.open({ kind: 'loop.freshness', subject: 'stale', openedBy: 'kernel', dueTs: 100_000 });
  for (t.v = 10_000; t.v <= 600_000; t.v += 10_000) suspend.check();
  const out = await loop.maker(null);
  assert.deepEqual(resumes, []);
  assert.equal(out.result.expired.length, 1);
  store.closeDb();
});

// glmps-187: a gate verdict is due 24h after a PASS and is closed by a judge
// job that cannot run while the host sleeps either, so it gets the same rule.
test('suspend: rebaseForSuspend shifts a gate row due inside the sleep, and leaves expired and pre-sleep rows alone', () => {
  const t = { v: 0 }; const { store } = mk(t);
  const gate = store.open({ kind: 'gate.independent-verdict', subject: 'card-1', openedBy: 'gate', dueTs: 50_000 });
  store.open({ kind: 'gate.independent-verdict', subject: 'card-2', openedBy: 'gate', dueTs: 8_000 });
  store.open({ kind: 'loop.freshness', subject: 'expired', openedBy: 'kernel', dueTs: 5_000 });
  t.v = 6_000; store.expireDue();
  const rebased = sweeperModule.rebaseForSuspend(store, { fromTs: 10_000, toTs: 1_000_000 });
  assert.deepEqual(rebased, [gate.id]);
  assert.equal(store.findOpen({ kind: 'gate.independent-verdict', subject: 'card-1' }).dueTs, 50_000 + 990_000, 'shifted by exactly the sleep');
  assert.equal(store.findOpen({ kind: 'gate.independent-verdict', subject: 'card-2' }).dueTs, 8_000, 'due before the sleep began: a real miss');
  assert.equal(store.findOpen({ kind: 'loop.freshness', subject: 'expired' }).dueTs, 5_000);
  store.closeDb();
});

// glmps-2-0-112: the Slack line for an expired freshness row names the loop,
// when it last checked in, its limit and last outcome, not the row's kind.
test('overdueNotice says a freshness miss in plain words and keeps the old form for other kinds', () => {
  const row = { kind: 'loop.freshness', subject: 'nightly-run' };
  const record = { lastOkTs: Date.parse('2026-10-26T05:00:02Z'), lastOutcome: 'done', lastReason: null, sla: { maxAgeMs: 36 * 3_600_000 } };
  const msg = sweeperModule.overdueNotice(row, 2, record);
  assert.match(msg, /^Loop nightly-run has not checked in since .+ \(limit 36h\)\. Last outcome: done\. \(alert 3 of 3\)$/);
  assert.doesNotMatch(msg, /loop\.freshness/);
  // A failure as the registry really records it, from an external loop's own report.
  const t = { v: 1000 }; const { dir, store } = mk(t);
  const reg = createLoopRegistry({ stateDir: dir, now: () => t.v, setTimer: () => 0, clearTimer: () => {} });
  reg.registerLoop({ name: 'nightly-run', trigger: { external: 'test' }, maker: async () => { throw new Error('external'); }, checker: async () => ({ ok: false }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1 }, sla: { maxAgeMs: 36 * 3_600_000, obligation: false } });
  reg.report('nightly-run', { outcome: 'failed', reason: 'dashboard unreachable: timeout (3 attempts)' });
  const failedMsg = sweeperModule.overdueNotice(row, 0, reg.get('nightly-run'));
  assert.match(failedMsg, /has not checked in since it was registered \(limit 36h\)\. Last outcome: failed, dashboard unreachable: timeout \(3 attempts\)\. \(alert 1 of 3\)$/);
  assert.doesNotMatch(failedMsg, /failed:/);
  reg.stop?.(); store.closeDb();
  assert.equal(sweeperModule.overdueNotice({ kind: 'gate.independent-verdict', subject: 'card-1' }, 1),
    'Obligation gate.independent-verdict card-1 is overdue (alert 2 of 3).');
});
