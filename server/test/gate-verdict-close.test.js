// server/test/gate-verdict-close.test.js
// glmps-2-0-39: a judge verdict must find its card (runSession lookup), a
// verdict older than the card's open gate obligation must be re-judged, and an
// orphaned gate obligation must be reconciled into a judge.session job. Real
// registry, real judge adapter, real obligation store and retry queue; only
// the model plugin is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopRegistry } from '../lib/loops/registry.js';
import { registerPluginLoops } from '../lib/loops/plugin-loops.js';
import { createJudgeAdapter } from '../lib/loops/plugin-adapters.js';
import { openObligationStore } from '../lib/kernel/obligations.js';
import { createRetryQueue } from '../lib/plugins/retry-queue.js';
import { ticketIdForSession, reconcileGateObligation, reconcileOpenGateRows } from '../lib/kernel/gate-reconcile.js';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

function rig({ events }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gate-close-'));
  const clock = { v: T0 };
  const obligationStore = openObligationStore({ dbFile: path.join(stateDir, 'kernel.db'), now: () => clock.v, emit: () => {} });
  const retryQueue = createRetryQueue({ file: path.join(stateDir, 'plugins', 'retry.ndjson') });
  const calls = { classify: 0, firstPrompts: [] };
  const judgePlugin = {
    classify: async ({ firstPrompt }) => { calls.classify++; calls.firstPrompts.push(firstPrompt); return { taskClass: 'feature', outcome: 'success', reason: 'ok' }; },
    verdict: async () => ({ by: 'judge', pass: true, comment: 'fine' }),
  };
  const judge = createJudgeAdapter({ judgePlugin, stateDir, appendDevlog: null, eventLog: new Map(), readEvents: () => events.v, obligationStore });
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({
    registry, retryQueue, stateDir, judge,
    memory: { admit: async () => ({}), verifyAdmitted: async () => ({ ok: true }) },
    gepa: { run: async () => ({ ok: true, proposed: [] }) },
  });
  return { stateDir, clock, obligationStore, retryQueue, registry, calls, judge };
}

const ev = (ts, label = 'do the thing') => ({ kind: 'prompt', tool: 'user', label, ts: new Date(ts).toISOString() });

test('T1: a session absent from the runner ledger resolves to its card via runSession.sessionId', () => {
  const items = [
    { id: 'card-a', runSession: { sessionId: 'other', worktree: { dir: 'D:/x' } } },
    { id: 'card-b', runSession: { sessionId: 'sid-1', worktree: { dir: 'D:/y' } } },
    { id: 'card-c' },
  ];
  assert.equal(ticketIdForSession(items, 'sid-1'), 'card-b');
  assert.equal(ticketIdForSession(items, 'missing'), null);
  assert.equal(ticketIdForSession(null, 'sid-1'), null);
});

test('T2: a verdict older than the card\'s open gate obligation is re-judged, then closes it', async () => {
  const events = { v: [ev(T0 - 2 * HOUR)] };
  const r = rig({ events });
  // First judge ran mid-session, before the gate passed.
  await r.registry.runNow('session-judge', { row: { id: 'session-s1' }, sessionId: 's1', firstPrompt: 'x', ticketId: 'card-1', rebuildEvents: true });
  const gate = r.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'card-1', openedBy: 'agent:card-1' });
  assert.equal(r.calls.classify, 1);
  assert.equal(r.obligationStore.get(gate.id).closedTs ?? null, null, 'the stale verdict did not close the newer obligation');
  // Session kept working and passed its gate later.
  events.v = [ev(T0 - 2 * HOUR), ev(T0 + 1000, 'more')];
  r.retryQueue.push({ kind: 'judge.session', sessionId: 's1', rowId: 'session-s1', firstPrompt: 'x', ticketId: 'card-1' });
  const out = await r.registry.runNow('plugin-retry');
  assert.equal(out.outcome, 'done');
  assert.equal(r.calls.classify, 2, 'the stale verdict forced a second model run');
  const closed = r.obligationStore.get(gate.id);
  assert.equal(closed.closer, 'verified.done');
  assert.equal(r.retryQueue.size(), 0);
  assert.equal(r.judge.verdictFor('session-s1').ts, T0 + 1000, 'verdictFor returns the latest verdict');
});

test('T2: a fresh verdict closes the obligation with no model call', async () => {
  const events = { v: [ev(T0 + 1000)] };
  const r = rig({ events });
  const gate = r.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'card-1', openedBy: 'agent:card-1' });
  await r.registry.runNow('session-judge', { row: { id: 'session-s1' }, sessionId: 's1', firstPrompt: 'x', ticketId: null, rebuildEvents: true });
  assert.equal(r.calls.classify, 1);
  r.retryQueue.push({ kind: 'judge.session', sessionId: 's1', rowId: 'session-s1', firstPrompt: 'x', ticketId: 'card-1' });
  const out = await r.registry.runNow('plugin-retry');
  assert.equal(out.outcome, 'done');
  assert.equal(r.calls.classify, 1, 'no second model call');
  assert.equal(r.obligationStore.get(gate.id).closer, 'verified.done');
});

test('T3: reconciling an orphaned gate row queues exactly one job and the next retry tick closes it', async () => {
  const events = { v: [ev(T0 + 1000, 'the first prompt')] };
  const r = rig({ events });
  const gate = r.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'card-1', openedBy: 'agent:card-1' });
  const items = [{ id: 'card-1', runSession: { sessionId: 's1' } }];
  const row = r.obligationStore.get(gate.id);
  assert.deepEqual(reconcileGateObligation({ row, loadItems: () => items, retryQueue: r.retryQueue }), { queued: true, sessionId: 's1' });
  reconcileGateObligation({ row, loadItems: () => items, retryQueue: r.retryQueue });
  assert.equal(r.retryQueue.size(), 1, 'a repeat reconcile upserts, never duplicates');
  const job = r.retryQueue.take(5)[0];
  assert.equal(job.rowId, 'session-s1');
  assert.equal(job.ticketId, 'card-1');
  const out = await r.registry.runNow('plugin-retry');
  assert.equal(out.outcome, 'done');
  assert.equal(r.obligationStore.get(gate.id).closer, 'verified.done');
  assert.equal(r.calls.firstPrompts[0], 'the first prompt', 'firstPrompt derived from the rebuilt events');
});

test('T3: a card without runSession is left alone', () => {
  const r = rig({ events: { v: [] } });
  const gate = r.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'card-9', openedBy: 'agent:card-9' });
  const row = r.obligationStore.get(gate.id);
  assert.deepEqual(reconcileGateObligation({ row, loadItems: () => [{ id: 'card-9' }], retryQueue: r.retryQueue }), { queued: false });
  assert.equal(r.retryQueue.size(), 0);
  assert.equal(reconcileGateObligation({ row: { kind: 'loop.freshness', subject: 'card-9' }, loadItems: () => [], retryQueue: r.retryQueue }).queued, false);
});

test('T3: the boot pass reconciles every open gate row and ignores other kinds', () => {
  const r = rig({ events: { v: [] } });
  r.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'card-1', openedBy: 'a' });
  r.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'card-2', openedBy: 'a' });
  r.obligationStore.open({ kind: 'loop.freshness', subject: 'wiki', openedBy: 'kernel', dueTs: T0 + HOUR });
  const items = [{ id: 'card-1', runSession: { sessionId: 's1' } }, { id: 'card-2', runSession: { sessionId: 's2' } }];
  const res = reconcileOpenGateRows({ store: r.obligationStore, loadItems: () => items, retryQueue: r.retryQueue });
  assert.equal(res.queued, 2);
  assert.equal(r.retryQueue.size(), 2);
});
