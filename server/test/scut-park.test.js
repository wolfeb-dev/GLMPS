// server/test/scut-park.test.js
// Pure park-state helpers over runner-ledger entries (server/lib/scut/park.js).
// Park = the agent long-polls between phases; these helpers decide what each
// poll/wake/sweep does. Pure data-in data-out, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isParked, stampPoll, takePending, queueNote, bankStretch, parkWaitMs,
  pickEviction, sweep, STALE_MS, GATE_GRACE_MS,
  releaseTarget, idleClosures, ticketActivityMs, REOPEN_CONFIRM_MS,
} from '../lib/scut/park.js';
import * as park from '../lib/scut/park.js';

test('isParked: only a numeric parkedSince counts', () => {
  assert.equal(isParked(null), false);
  assert.equal(isParked({}), false);
  assert.equal(isParked({ parkedSince: null }), false);
  assert.equal(isParked({ parkedSince: 1000 }), true);
});

test('stampPoll: first poll parks and reports firstPark, later polls only heartbeat', () => {
  const first = stampPoll({ pid: null }, 1000);
  assert.equal(first.firstPark, true);
  assert.equal(first.entry.parkedSince, 1000);
  assert.equal(first.entry.parkLastPollTs, 1000);
  const second = stampPoll(first.entry, 2000);
  assert.equal(second.firstPark, false);
  assert.equal(second.entry.parkedSince, 1000, 'parkedSince is the stretch start, not the last poll');
  assert.equal(second.entry.parkLastPollTs, 2000);
});

test('stampPoll does not mutate its argument', () => {
  const entry = { parkedSince: null };
  stampPoll(entry, 5);
  assert.equal(entry.parkLastPollTs, undefined);
});

test('takePending: queued note wakes, banks the stretch, clears park state', () => {
  const parked = { parkedSince: 1000, parkLastPollTs: 1000, parkBankMs: 0, parkNote: 'phase 2 please' };
  const { entry, response } = takePending(parked, 61_000);
  assert.deepEqual(response, { action: 'wake', note: 'phase 2 please', provenance: 'external' });
  assert.equal(entry.parkNote, null);
  assert.equal(entry.parkedSince, null);
  assert.equal(entry.parkBankMs, 60_000);
});

test('takePending: nothing pending means null response and an unchanged entry', () => {
  const parked = { parkedSince: 1000, parkBankMs: 0, parkNote: null };
  const { response } = takePending(parked, 2000);
  assert.equal(response, null);
});

test('queueNote appends with a blank line between notes', () => {
  const one = queueNote({ parkNote: null }, 'first');
  assert.equal(one.parkNote, 'first');
  const two = queueNote(one, 'second');
  assert.equal(two.parkNote, 'first\n\nsecond');
});

test('parkWaitMs sums banked and live stretches', () => {
  assert.equal(parkWaitMs(null, 99), 0);
  assert.equal(parkWaitMs({ parkBankMs: 500 }, 99), 500);
  assert.equal(parkWaitMs({ parkBankMs: 500, parkedSince: 1000 }, 1600), 1100);
});

test('bankStretch closes the live stretch; harmless when not parked', () => {
  const banked = bankStretch({ parkedSince: 1000, parkBankMs: 10 }, 1510);
  assert.equal(banked.parkBankMs, 520);
  assert.equal(banked.parkedSince, null);
  const noop = bankStretch({ parkBankMs: 10 }, 999);
  assert.equal(noop.parkBankMs, 10);
});

test('pickEviction picks the OLDEST parked entry and ignores running ones', () => {
  const ledger = {
    running: { pid: 1 },
    newer: { parkedSince: 2000 },
    older: { parkedSince: 1000 },
  };
  assert.equal(pickEviction(ledger), 'older');
  assert.equal(pickEviction({ running: { pid: 1 } }), null);
});

test('sweep flags stale, ttl, and gated-unparked; leaves healthy entries alone', () => {
  const now = 10_000_000;
  const items = new Map([
    ['gated', { id: 'gated', origin: { via: 'slack' }, gate: { ts: new Date(now - GATE_GRACE_MS - 1000).toISOString() } }],
    ['fresh-gate', { id: 'fresh-gate', origin: { via: 'slack' }, gate: { ts: new Date(now - 1000).toISOString() } }],
    ['healthy', { id: 'healthy', origin: { via: 'slack' } }],
    ['stale', { id: 'stale', origin: { via: 'slack' } }],
    ['expired', { id: 'expired', origin: { via: 'slack' } }],
  ]);
  const ledger = {
    healthy: { parkedSince: now - 1000, parkLastPollTs: now - 1000 },
    stale: { parkedSince: now - 1000, parkLastPollTs: now - STALE_MS - 1 },
    expired: { parkedSince: now - 2 * 3_600_000, parkLastPollTs: now - 1000 },
    gated: { parkLastPollTs: null },
    'fresh-gate': { parkLastPollTs: null },
  };
  const out = sweep(ledger, items, { parkHours: 1, now });
  assert.deepEqual(
    out.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'expired', reason: 'ttl', to: 'idle' },
      { id: 'gated', reason: 'gated-unparked', to: 'idle' },
      { id: 'stale', reason: 'stale', to: 'idle' },
    ],
  );
});

test('sweep: parkHours 0 disables ttl; a woken entry (parkLastPollTs set) is never gated-unparked', () => {
  const now = 10_000_000;
  const items = new Map([
    ['expired', { id: 'expired', origin: { via: 'slack' } }],
    ['woken', { id: 'woken', origin: { via: 'slack' }, gate: { ts: new Date(now - GATE_GRACE_MS - 1000).toISOString() } }],
  ]);
  const ledger = {
    expired: { parkedSince: now - 100 * 3_600_000, parkLastPollTs: now - 1000 },
    woken: { parkLastPollTs: now - 1000 },
  };
  assert.deepEqual(sweep(ledger, items, { parkHours: 0, now }), []);
});

// takePending used to remove parkNote from the entry and hand it to the poller
// in the SAME step, with no acknowledgement and no retry. Observed 2026-08-13:
// a session woke with the operator's note at 03:27:42Z, read it at 03:27:44Z
// and terminated without answering; the sweep requeued the card as stale at
// 03:53 and the note was simply gone. The operator got silence.
//
// The fix is at-least-once instead of at-most-once. Delivering an operator's
// instruction twice is recoverable; losing it is not. The NEXT poll is the
// proof of life that retires the in-flight copy.

test('takePending holds the note in flight rather than dropping it', () => {
  const e = park.queueNote({ parkedSince: 100, parkBankMs: 0 }, 'do the thing');
  const taken = park.takePending(e, 200);
  assert.deepEqual(taken.response, { action: 'wake', note: 'do the thing', provenance: 'external' });
  assert.equal(taken.entry.parkNote, null, 'it is no longer queued');
  assert.equal(taken.entry.parkNoteInFlight, 'do the thing', 'but it is not gone either');
  assert.equal(taken.entry.parkNoteInFlightTs, 200);
});

test('the next poll is proof of life and retires the in-flight note', () => {
  const delivered = park.takePending(park.queueNote({ parkedSince: 100 }, 'n'), 200).entry;
  const next = park.stampPoll(delivered, 300).entry;
  assert.equal(next.parkNoteInFlight ?? null, null, 'the agent survived delivery, so nothing to recover');
  assert.equal(next.parkNoteInFlightTs ?? null, null);
});

test('a note in flight past the timeout is requeued for redelivery', () => {
  const delivered = park.takePending(park.queueNote({ parkedSince: 100 }, 'answer me'), 200).entry;
  const recovered = park.recoverInFlight(delivered, 200 + park.INFLIGHT_TIMEOUT_MS + 1);
  assert.equal(recovered.parkNote, 'answer me', 'the operator gets their reply delivered again');
  assert.equal(recovered.parkNoteInFlight ?? null, null);
});

test('a note still inside the timeout is left alone', () => {
  const delivered = park.takePending(park.queueNote({ parkedSince: 100 }, 'n'), 200).entry;
  const same = park.recoverInFlight(delivered, 200 + 1000);
  assert.equal(same.parkNote ?? null, null, 'not yet: the agent may simply still be working');
  assert.equal(same.parkNoteInFlight, 'n');
});

test('recovery merges with a note queued while the first was in flight, keeping order', () => {
  const delivered = park.takePending(park.queueNote({ parkedSince: 100 }, 'first'), 200).entry;
  const alsoQueued = park.queueNote(delivered, 'second');
  const recovered = park.recoverInFlight(alsoQueued, 200 + park.INFLIGHT_TIMEOUT_MS + 1);
  assert.equal(recovered.parkNote, 'first\n\nsecond', 'the redelivered note leads, since it was sent first');
});

test('recoverInFlight is a no-op on an entry that has nothing in flight', () => {
  const e = { parkedSince: 100 };
  assert.deepEqual(park.recoverInFlight(e, 999999), e);
  assert.deepEqual(park.recoverInFlight(null, 1), null);
});

test('recovery covers the post-wake state, which is WORKING and not parked', () => {
  // The subtle part. takePending banks the stretch and clears parkedSince, so
  // a just-woken entry is NOT parked: park.sweep's stale branch never sees it,
  // and its runtime is governed by maxRuntimeMs instead. That is exactly the
  // window mc-57 describes - the agent read the note and died - so recovery
  // must not depend on the entry being parked.
  const delivered = park.takePending(park.queueNote({ parkedSince: 100, parkLastPollTs: 100 }, 'answer me'), 200).entry;
  assert.equal(park.isParked(delivered), false, 'precondition: a woken agent reads as working');
  assert.deepEqual(
    park.sweep({ t1: delivered }, new Map(), { parkHours: 0, now: 200 + park.STALE_MS + 1 }),
    [],
    'so the parked-stale sweep does NOT catch it, which is why recovery is its own pass',
  );
  const recovered = park.recoverInFlight(delivered, 200 + park.INFLIGHT_TIMEOUT_MS + 1);
  assert.equal(recovered.parkNote, 'answer me');
});


const H = 3_600_000;

test('sweep: a parked entry with no recent poll but recent activity is NOT released', () => {
  const now = 10 * H;
  const ledger = { 'p-1': { parkedSince: now - H, parkLastPollTs: now - STALE_MS - 1 } };
  const out = sweep(ledger, new Map(), { parkHours: 168, now, activityTs: () => now - 60_000 });
  assert.deepEqual(out, []);
});

test('sweep: with neither a poll nor activity inside the window it is released to idle, not done', () => {
  const now = 10 * H;
  const ledger = { 'p-1': { parkedSince: now - H, parkLastPollTs: now - STALE_MS - 1 } };
  const items = new Map([['p-1', { id: 'p-1', gate: { status: 'PASS' } }]]);
  const out = sweep(ledger, items, { parkHours: 168, now, activityTs: () => now - STALE_MS - 5 });
  assert.deepEqual(out, [{ id: 'p-1', reason: 'stale', to: 'idle' }]);
});

test('sweep: a TTL release goes to idle, except a PASS gate, which closes', () => {
  const now = 400 * H;
  const ledger = {
    'p-1': { parkedSince: now - 169 * H, parkLastPollTs: now - 1000 },
    'p-2': { parkedSince: now - 169 * H, parkLastPollTs: now - 1000 },
  };
  const items = new Map([['p-1', { id: 'p-1', gate: { status: 'CONCERNS' } }], ['p-2', { id: 'p-2', gate: { status: 'PASS' } }]]);
  assert.deepEqual(sweep(ledger, items, { parkHours: 168, now }), [
    { id: 'p-1', reason: 'ttl', to: 'idle' },
    { id: 'p-2', reason: 'ttl', to: 'done' },
  ]);
});

test('sweep: gated-unparked is skipped while the session shows activity, and goes to idle otherwise', () => {
  const now = 10 * H;
  const gate = { status: 'PASS', ts: new Date(now - GATE_GRACE_MS - 1).toISOString() };
  const ledger = { 'p-1': { parkLastPollTs: null } };
  const items = new Map([['p-1', { id: 'p-1', origin: { via: 'slack' }, gate }]]);
  assert.deepEqual(sweep(ledger, items, { parkHours: 168, now, activityTs: () => now - 1000 }), []);
  assert.deepEqual(sweep(ledger, items, { parkHours: 168, now }), [{ id: 'p-1', reason: 'gated-unparked', to: 'idle' }]);
});

// a relaunched entry (branch b/c's reopenedTs) is proven
// alive by a LATER actor - the next park poll, or any captured activity -
// never by this run's own checker, which cannot wait 15 minutes inside its
// ceiling. No sign of life for REOPEN_CONFIRM_MS after the relaunch releases
// it back to idle, same as any other unconfirmed session.
test('sweep: a relaunched entry with no sign of life for REOPEN_CONFIRM_MS goes back to idle', () => {
  const now = 10 * H;
  const reopenedTs = now - REOPEN_CONFIRM_MS - 1;
  const ledger = { 'p-1': { reopenedTs, parkLastPollTs: null } };
  assert.deepEqual(sweep(ledger, new Map(), { parkHours: 168, now }), [{ id: 'p-1', reason: 'reopen-unconfirmed', to: 'idle' }]);
  assert.deepEqual(sweep(ledger, new Map(), { parkHours: 168, now, activityTs: () => reopenedTs + 5 }), [], 'activity after the relaunch is proof of life');
  assert.deepEqual(sweep({ 'p-1': { reopenedTs, parkLastPollTs: reopenedTs + 5 } }, new Map(), { parkHours: 168, now }), [], 'a poll after the relaunch is proof of life');
});

// Fix round 1, M7 (part 1): a relaunched entry still WELL inside its grace
// window - no poll, no activity, but the timeout has not elapsed either -
// must be left alone. It is not yet a failure to have no sign of life 30
// seconds after a relaunch.
test('sweep: a relaunched entry inside REOPEN_CONFIRM_MS with no sign of life yet is left alone', () => {
  const now = 10 * H;
  const reopenedTs = now - 30_000; // well under REOPEN_CONFIRM_MS
  const ledger = { 'p-1': { reopenedTs, parkLastPollTs: null } };
  assert.deepEqual(sweep(ledger, new Map(), { parkHours: 168, now }), []);
});

test('releaseTarget: only ttl+PASS and close go to done', () => {
  assert.equal(releaseTarget({ reason: 'ttl', gateStatus: 'PASS' }), 'done');
  assert.equal(releaseTarget({ reason: 'close', gateStatus: null }), 'done');
  for (const reason of ['stale', 'evict', 'stop', 'gated-unparked', 'reopen-unconfirmed']) {
    assert.equal(releaseTarget({ reason, gateStatus: 'PASS' }), 'idle', reason);
  }
  assert.equal(releaseTarget({ reason: 'ttl', gateStatus: 'CONCERNS' }), 'idle');
});

test('idleClosures: an idle card with a PASS gate, idle past the TTL, closes; anything else stays', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  const old = new Date(now - 169 * H).toISOString();
  const young = new Date(now - 10 * H).toISOString();
  const items = [
    { id: 'a-1', state: 'idle', idleSince: old, gate: { status: 'PASS' } },
    { id: 'a-2', state: 'idle', idleSince: young, gate: { status: 'PASS' } },
    { id: 'a-3', state: 'idle', idleSince: old, gate: { status: 'FAIL' } },
    { id: 'a-4', state: 'done', idleSince: null, gate: { status: 'PASS' } },
    { id: 'a-5', state: 'idle', idleSince: old, gate: null },
  ];
  assert.deepEqual(idleClosures(items, { parkHours: 168, now }), ['a-1']);
  assert.deepEqual(idleClosures(items, { parkHours: 0, now }), [], 'parkHours 0 disables the automatic close');
});

test('ticketActivityMs: newest of the recorded session and any live runner session in the ticket worktree', () => {
  const summaries = [
    { id: 's-old', lastTs: 1000, worktree: { kind: 'runner', id: 'p-1' } },
    { id: 's-other', lastTs: 9000, worktree: { kind: 'runner', id: 'p-2' } },
    { id: 's-rec', lastTs: 2000, worktree: null },
  ];
  const tails = { 's-rec': '1970-01-01T00:00:05.000Z' };
  const tailTsOf = (id) => tails[id] ?? null;
  assert.equal(ticketActivityMs({ ticketId: 'p-1', entry: { sessionId: 's-rec' }, summaries, tailTsOf }), 5000);
  assert.equal(ticketActivityMs({ ticketId: 'p-1', entry: {}, summaries, tailTsOf }), 1000);
  assert.equal(ticketActivityMs({ ticketId: 'p-9', entry: {}, summaries, tailTsOf }), null);
});

// The reply carries who the note came from, as stamped by the server. Only
// 'operator' may take the handoff path; anything else, including a note queued
// with no provenance at all, stays 'external'.

test('a queued operator note is delivered with provenance operator', () => {
  const e = park.queueNote({ parkedSince: 100, parkBankMs: 0 }, 'ship it', 'operator');
  const taken = park.takePending(e, 200);
  assert.deepEqual(taken.response, { action: 'wake', note: 'ship it', provenance: 'operator' });
});

test('queueNote without provenance is external (fail closed)', () => {
  assert.equal(park.queueNote({}, 'x').parkNoteProvenance, 'external');
});

test('operator note plus an external note together read as external', () => {
  const a = park.queueNote({}, 'mine', 'operator');
  const b = park.queueNote(a, 'theirs', 'external');
  assert.equal(b.parkNoteProvenance, 'external');
  const c = park.queueNote(park.queueNote({}, 'a', 'operator'), 'b', 'operator');
  assert.equal(c.parkNoteProvenance, 'operator');
});

test('provenance survives the in-flight slot and redelivery', () => {
  const delivered = park.takePending(park.queueNote({ parkedSince: 100 }, 'answer me', 'operator'), 200).entry;
  assert.equal(delivered.parkNoteInFlightProvenance, 'operator');
  const recovered = park.recoverInFlight(delivered, 200 + park.INFLIGHT_TIMEOUT_MS + 1);
  assert.equal(recovered.parkNote, 'answer me');
  assert.equal(recovered.parkNoteProvenance, 'operator');
  assert.equal(park.takePending(recovered, 999).response.provenance, 'operator');
});

test('recovery merging an operator note with a newer external one is external', () => {
  const delivered = park.takePending(park.queueNote({ parkedSince: 100 }, 'first', 'operator'), 200).entry;
  const alsoQueued = park.queueNote(delivered, 'second', 'external');
  const recovered = park.recoverInFlight(alsoQueued, 200 + park.INFLIGHT_TIMEOUT_MS + 1);
  assert.equal(recovered.parkNoteProvenance, 'external');
});
