// D27: a release parks the card as idle (reopenable), never done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bs from '../lib/orchestration/backlog-store.js';
import { reconcileLedger } from '../lib/orchestration/queue-runner.js';

const seeded = () => {
  const r = bs.addItem(bs.emptyState(), { project: 'p', title: 't' });
  return { state: r.state, id: r.item.id };
};

test('idle is a valid state; entering stamps idleSince, leaving clears it', () => {
  const { state, id } = seeded();
  const a = bs.updateItem(state, id, { state: 'idle' });
  assert.equal(a.item.state, 'idle');
  assert.equal(typeof a.item.idleSince, 'string');
  const b = bs.updateItem(a.state, id, { state: 'in_progress' });
  assert.equal(b.item.idleSince, null);
});

test('releaseToIdle records the release and an activity line naming scut:released', () => {
  const { state, id } = seeded();
  const r = bs.releaseToIdle(state, id, { kind: 'stale', why: 'the parked session went silent' });
  assert.equal(r.item.state, 'idle');
  assert.equal(r.item.release.kind, 'stale');
  assert.equal(r.item.release.why, 'the parked session went silent');
  assert.equal(typeof r.item.release.ts, 'string');
  assert.equal(r.item.doneAt, null, 'a release is not a close');
  assert.equal(r.item.activity.at(-1).text, 'scut:released (stale): the parked session went silent');
});

test('releaseToIdle on an unknown id changes nothing', () => {
  const { state } = seeded();
  const r = bs.releaseToIdle(state, 'nope-1', { kind: 'ttl', why: 'x' });
  assert.equal(r.item, null);
  assert.deepEqual(r.state.items, state.items);
});

test('reorderItems accepts idle as a target column', () => {
  const { state, id } = seeded();
  const r = bs.reorderItems(state, { ids: [id], status: 'idle' });
  assert.equal(r.items[0].state, 'idle');
  assert.equal(typeof r.items[0].idleSince, 'string');
});

test('reconcileLedger lets an entry whose card is idle depart, with no action', () => {
  const r = reconcileLedger({
    ledger: { 'p-1': { pid: null, startedAt: 0, retries: 0 } },
    items: [{ id: 'p-1', state: 'idle' }],
    isAlive: () => true, now: 1, maxRuntimeMs: 1e9, maxRetries: 1,
  });
  assert.deepEqual(r.ledger, {});
  assert.deepEqual(r.actions, []);
});

// Fix round 1 (coordinator, important): addItem creating a card DIRECTLY in
// state 'idle' (bypassing updateItem/releaseToIdle) must still stamp
// idleSince on the way in, exactly like doneAt is stamped for a card created
// directly in 'done'. Without this an idle-TTL check reading idleSince would
// never fire for a card that was born idle rather than transitioned there.
test('addItem creating a card directly in state idle stamps idleSince', () => {
  const r = bs.addItem(bs.emptyState(), { project: 'p', title: 't', state: 'idle' });
  assert.equal(r.item.state, 'idle');
  assert.equal(typeof r.item.idleSince, 'string');
});

test('addItem creating a card in any other state leaves idleSince null', () => {
  const r = bs.addItem(bs.emptyState(), { project: 'p', title: 't' });
  assert.equal(r.item.idleSince, null);
});

// reopenBranch's reference time is now when the
// card entered its CURRENT reopenable state, not when it was released
// (item.release.ts, never cleared, went stale across a resume-then-done
// cycle - I4). idle/done already had idleSince/doneAt; cancelled/archived
// had nothing - stateEnteredAt extends the SAME entry/exit stamping
// uniformly to all four REOPENABLE_STATES, so it can never go stale the
// same way: it is always set fresh on entry and cleared on exit.
test('stateEnteredAt stamps entry into cancelled or archived, and clears on exit', () => {
  const { state, id } = seeded();
  const a = bs.updateItem(state, id, { state: 'cancelled' });
  assert.equal(a.item.state, 'cancelled');
  assert.equal(typeof a.item.stateEnteredAt, 'string');
  const b = bs.updateItem(a.state, id, { state: 'in_progress' });
  assert.equal(b.item.stateEnteredAt, null);

  const c = bs.updateItem(b.state, id, { state: 'archived' });
  assert.equal(typeof c.item.stateEnteredAt, 'string');
  const d = bs.updateItem(c.state, id, { state: 'queued' });
  assert.equal(d.item.stateEnteredAt, null);
});

test('stateEnteredAt is stamped uniformly for idle and done too, alongside idleSince/doneAt', () => {
  const { state, id } = seeded();
  const a = bs.updateItem(state, id, { state: 'idle' });
  assert.equal(typeof a.item.stateEnteredAt, 'string');
  assert.equal(a.item.stateEnteredAt, a.item.idleSince, 'set in the same stampDone call, so they must agree exactly');
  const b = bs.updateItem(a.state, id, { state: 'done' });
  assert.equal(typeof b.item.stateEnteredAt, 'string');
  assert.equal(b.item.stateEnteredAt, b.item.doneAt, 'set in the same stampDone call, so they must agree exactly');
});

// Spins to the next millisecond boundary so two ISO-string stamps taken back
// to back are provably distinct - now() has only ms resolution, so two fast
// successive updateItem calls can otherwise land on the identical string by
// coincidence, which would make this test's own assertion unreliable rather
// than the production code wrong.
function tickMs() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

test('stateEnteredAt refreshes on a direct transition between two reopenable states, never left stale (I4)', () => {
  const { state, id } = seeded();
  const a = bs.updateItem(state, id, { state: 'idle' });
  const idleStamp = a.item.stateEnteredAt;
  tickMs();
  const b = bs.updateItem(a.state, id, { state: 'cancelled' }); // direct idle -> cancelled
  assert.notEqual(b.item.stateEnteredAt, idleStamp, 'a direct transition between two reopenable states must refresh the stamp, not carry the prior one over');
  assert.equal(b.item.idleSince, null, 'idleSince is still correctly cleared on leaving idle');
});

// sweepArchive moves done -> archived by itself, outside
// updateItem. It must go through stampDone too, or an auto-archived card keeps
// its done-era stateEnteredAt (and a stale doneAt), and reopenBranch would
// measure activity against when the card went done, not when it was archived.
test('sweepArchive stamps the archive: stateEnteredAt refreshed, doneAt cleared (M2, fix round 4)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const { state, id } = seeded();
  const done = bs.updateItem(state, id, { state: 'done' }).state;
  const old = new Date(Date.now() - 8 * DAY).toISOString();
  const aged = { ...done, items: done.items.map((i) => (i.id === id ? { ...i, doneAt: old, stateEnteredAt: old } : i)) };
  const r = bs.sweepArchive(aged, { days: 7, now: Date.now() });
  assert.deepEqual(r.moved, [id]);
  const it = r.state.items.find((i) => i.id === id);
  assert.equal(it.state, 'archived');
  assert.equal(it.doneAt, null, 'leaving done clears doneAt, same as updateItem');
  assert.equal(typeof it.stateEnteredAt, 'string');
  assert.ok(Date.parse(it.stateEnteredAt) > Date.parse(old), 'stateEnteredAt is the archive time, not the done-era stamp');
});

test('addItem creating a card directly in cancelled or archived stamps stateEnteredAt', () => {
  const c = bs.addItem(bs.emptyState(), { project: 'p', title: 't', state: 'cancelled' });
  assert.equal(typeof c.item.stateEnteredAt, 'string');
  const q = bs.addItem(bs.emptyState(), { project: 'p', title: 'q' });
  assert.equal(q.item.stateEnteredAt, null);
});

test('setRunSession merges into runSession and is not a PATCH field', () => {
  const { state, id } = seeded();
  const a = bs.setRunSession(state, id, { sessionId: 's', launcher: 'native-terminal', worktree: null, recordedTs: 1 });
  assert.deepEqual(a.item.runSession, { sessionId: 's', launcher: 'native-terminal', worktree: null, recordedTs: 1 });
  const b = bs.setRunSession(a.state, id, { purgedTs: 2 });
  assert.equal(b.item.runSession.sessionId, 's');
  assert.equal(b.item.runSession.purgedTs, 2);
  const c = bs.updateItem(b.state, id, { runSession: null });
  assert.equal(c.item.runSession.sessionId, 's', 'PATCH cannot clear it');
});

test('setRunSession keeps the earlier session ids of a relaunched card (glmps-190)', () => {
  const { state, id } = seeded();
  const a = bs.setRunSession(state, id, { sessionId: 's1', recordedTs: 1 });
  assert.equal(a.item.runSession.previousSessionIds, undefined, 'a first launch has no history');
  const same = bs.setRunSession(a.state, id, { sessionId: 's1', recordedTs: 2 });
  assert.equal(same.item.runSession.previousSessionIds, undefined, 're-recording the same session is not a relaunch');
  const b = bs.setRunSession(same.state, id, { sessionId: 's2' });
  assert.deepEqual(b.item.runSession.previousSessionIds, ['s1']);
  const c = bs.setRunSession(b.state, id, { purgedTs: 3 });
  assert.deepEqual(c.item.runSession.previousSessionIds, ['s1'], 'a patch without a session keeps the history');
  const d = bs.setRunSession(c.state, id, { sessionId: 's3' });
  assert.deepEqual(d.item.runSession.previousSessionIds, ['s1', 's2']);
  const e = bs.setRunSession(d.state, id, { sessionId: 's1' });
  assert.deepEqual(e.item.runSession.previousSessionIds, ['s2', 's3'], 'the current session is never also in the history');
});
