// Card glmps-2-0-runtime-69: a pid-less (editor-hosted) runner session that has
// provably ended frees its slot like an exited process; one that is alive,
// waiting at its prompt, or was never seen does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pidlessLiveness, reconcileLedger } from '../lib/orchestration/queue-runner.js';

const SID = '0a1b2c3d-1111-2222-3333-444455556666';
const entry = (extra = {}) => ({ pid: null, startedAt: 1000, target: 'antigravity', retries: 0, sessionId: SID, ...extra });
const snap = (ts, sessions = []) => ({ ts, sessions });
const live = (ticketId = 'c1', sessionId = SID) => ({ ticketId, sessionId, pid: 42, rootPid: 41 });

test('a session present in the snapshot is recorded as seen', () => {
  const r = pidlessLiveness('c1', entry(), snap(2000, [live()]));
  assert.equal(r.ended, false);
  assert.deepEqual(r.entry.liveness, { sessionId: SID, seenAt: 2000, missedAt: null });
});

test('the session id join is case-insensitive', () => {
  const r = pidlessLiveness('c1', entry({ sessionId: SID.toUpperCase() }), snap(2000, [live()]));
  assert.equal(r.entry.liveness.seenAt, 2000);
});

test('a session never seen is not ended, however many snapshots miss it', () => {
  let e = entry();
  for (const ts of [2000, 3000, 4000]) {
    const r = pidlessLiveness('c1', e, snap(ts));
    assert.equal(r.ended, false);
    e = r.entry;
  }
  assert.equal(e.liveness, undefined);
});

test('seen, then missing from two later snapshots: ended', () => {
  let r = pidlessLiveness('c1', entry(), snap(2000, [live()]));
  r = pidlessLiveness('c1', r.entry, snap(3000));
  assert.equal(r.ended, false);
  assert.equal(r.entry.liveness.missedAt, 3000);
  r = pidlessLiveness('c1', r.entry, snap(4000));
  assert.equal(r.ended, true);
});

test('one miss then present again clears the miss', () => {
  let r = pidlessLiveness('c1', entry(), snap(2000, [live()]));
  r = pidlessLiveness('c1', r.entry, snap(3000));
  r = pidlessLiveness('c1', r.entry, snap(4000, [live()]));
  assert.deepEqual(r.entry.liveness, { sessionId: SID, seenAt: 4000, missedAt: null });
  r = pidlessLiveness('c1', r.entry, snap(5000));
  assert.equal(r.ended, false);
});

test('a reused snapshot never advances to ended', () => {
  let r = pidlessLiveness('c1', entry(), snap(2000, [live()]));
  r = pidlessLiveness('c1', r.entry, snap(3000));
  r = pidlessLiveness('c1', r.entry, snap(3000));
  assert.equal(r.ended, false);
});

test('no snapshot, a snapshot older than the launch, or no session id: unchanged', () => {
  const e = entry({ liveness: { sessionId: SID, seenAt: 1500, missedAt: 1600 } });
  assert.deepEqual(pidlessLiveness('c1', e, null), { entry: e, ended: false });
  const early = pidlessLiveness('c1', entry({ startedAt: 5000 }), snap(4000, [live()]));
  assert.equal(early.ended, false);
  assert.equal(early.entry.liveness, undefined);
  const noSid = entry({ sessionId: null });
  assert.deepEqual(pidlessLiveness('c1', noSid, snap(2000)), { entry: noSid, ended: false });
});

test('a sighting recorded for an earlier session id is ignored', () => {
  const e = entry({ liveness: { sessionId: 'ffffffff-1111-2222-3333-444455556666', seenAt: 1500, missedAt: 1600 } });
  const r = pidlessLiveness('c1', e, snap(2000));
  assert.equal(r.ended, false);
});

test('the same session id under another card does not count as alive', () => {
  let r = pidlessLiveness('c1', entry(), snap(2000, [live()]));
  r = pidlessLiveness('c1', r.entry, snap(3000, [live('other')]));
  r = pidlessLiveness('c1', r.entry, snap(4000, [live('other')]));
  assert.equal(r.ended, true);
});

const base = { isAlive: () => true, now: 10_000, maxRuntimeMs: 8 * 3600_000, maxRetries: 2 };
const items = [{ id: 'c1', state: 'in_progress' }];

test('reconcileLedger requeues a pid-less entry whose session has ended', () => {
  const ledger = { c1: entry({ liveness: { sessionId: SID, seenAt: 2000, missedAt: 3000 } }) };
  const r = reconcileLedger({ ...base, ledger, items, pidlessSnapshot: snap(4000) });
  assert.deepEqual(r.actions, [{ id: 'c1', action: 'requeue', reason: 'session ended' }]);
  assert.equal(r.ledger.c1.retries, 1);
  const again = reconcileLedger({ ...base, ledger: r.ledger, items: [{ id: 'c1', state: 'queued' }], pidlessSnapshot: snap(5000) });
  assert.deepEqual(again.actions, [], 'one ended session is requeued once, not again on the next snapshot');
});

test('reconcileLedger holds an ended pid-less entry out of retries', () => {
  const ledger = { c1: entry({ retries: 2, liveness: { sessionId: SID, seenAt: 2000, missedAt: 3000 } }) };
  const r = reconcileLedger({ ...base, ledger, items, pidlessSnapshot: snap(4000) });
  assert.deepEqual(r.actions, [{ id: 'c1', action: 'hold', reason: 'session ended' }]);
  assert.equal('c1' in r.ledger, false);
});

test('reconcileLedger keeps a live pid-less entry and persists its sighting', () => {
  const ledger = { c1: entry() };
  const r = reconcileLedger({ ...base, ledger, items, pidlessSnapshot: snap(4000, [live()]) });
  assert.deepEqual(r.actions, []);
  assert.equal(r.ledger.c1.liveness.seenAt, 4000);
});

test('reconcileLedger without a snapshot leaves pid-less entries exactly as before', () => {
  const ledger = { c1: entry() };
  const r = reconcileLedger({ ...base, ledger, items });
  assert.deepEqual(r, { ledger, actions: [] });
});

test('headless and real-pid entries ignore the snapshot', () => {
  const ledger = {
    c1: entry({ headless: true, liveness: { sessionId: SID, seenAt: 2000, missedAt: 3000 } }),
    c2: { pid: 7, startedAt: 1000, retries: 0, sessionId: SID, liveness: { sessionId: SID, seenAt: 2000, missedAt: 3000 } },
  };
  const r = reconcileLedger({ ...base, ledger, items: [...items, { id: 'c2', state: 'in_progress' }], headlessLive: () => true, pidlessSnapshot: snap(4000) });
  assert.deepEqual(r.actions, []);
  assert.deepEqual(Object.keys(r.ledger).sort(), ['c1', 'c2']);
});
