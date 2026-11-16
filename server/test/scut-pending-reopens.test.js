// server/test/scut-pending-reopens.test.js
// The store behind glmps-2-0-108: replies refused for runner capacity are kept
// on disk in arrival order until the drain takes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pendingReopensPath, addPendingReopen, hasPendingReopen, listPendingReopens, takePendingReopens, restorePendingReopens, nextDrainAction, drainConsumed } from '../lib/scut/pending-reopens.js';

const fresh = () => ({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pending-reopens-')), 'scut', 'pending-reopens.json') });

test('the path lives under the state dir unless the env overrides it', () => {
  assert.equal(pendingReopensPath('S', {}), path.join('S', 'scut', 'pending-reopens.json'));
  assert.equal(pendingReopensPath('S', { SCUT_PENDING_REOPENS_FILE: 'X' }), 'X');
});

test('replies keep their order per ticket, list is longest-waiting first, take empties', () => {
  const o = fresh();
  assert.equal(hasPendingReopen('a', o), false);
  assert.deepEqual(listPendingReopens(o), []);
  addPendingReopen('b', { text: 'b1', ts: 20 }, o);
  addPendingReopen('a', { text: 'a1', ctx: { channel: 'C' }, ts: 10 }, o);
  addPendingReopen('a', { text: 'a2', ts: 30 }, o);
  assert.equal(hasPendingReopen('a', o), true);
  assert.deepEqual(listPendingReopens(o).map((p) => p.ticketId), ['a', 'b']);
  const taken = takePendingReopens('a', o);
  assert.deepEqual(taken.map((p) => p.text), ['a1', 'a2']);
  assert.deepEqual(taken[0].ctx, { channel: 'C' });
  assert.equal(hasPendingReopen('a', o), false);
  assert.deepEqual(takePendingReopens('a', o), []);
  assert.deepEqual(listPendingReopens(o).map((p) => p.ticketId), ['b']);
});

test('restore puts a failed replay back ahead of replies saved since it was taken', () => {
  const o = fresh();
  addPendingReopen('a', { text: 'a1', ts: 10 }, o);
  const taken = takePendingReopens('a', o);
  addPendingReopen('a', { text: 'a2', ts: 30 }, o);
  restorePendingReopens('a', taken.map((p) => ({ ...p, attempts: 1 })), o);
  assert.deepEqual(takePendingReopens('a', o).map((p) => [p.text, p.attempts]), [['a1', 1], ['a2', 0]]);
});

// Review round 1, finding 2: the drain only ever looked at the oldest entry,
// so one card stuck in a state it cannot act on blocked every younger reply.
test('nextDrainAction scans past an un-actionable oldest ticket', () => {
  const states = { stuck: 'queued', wedged: 'in_progress', ready: 'idle' };
  const deps = { stateOf: (id) => states[id] ?? null, hasLedger: () => false, reopenable: new Set(['idle', 'done']), canRelaunch: true };
  const pending = [{ ticketId: 'stuck' }, { ticketId: 'wedged' }, { ticketId: 'ready' }];
  assert.deepEqual(nextDrainAction(pending, deps), { ticketId: 'ready', action: 'reopen' });
  assert.equal(nextDrainAction(pending, { ...deps, canRelaunch: false }), null, 'a full runner reopens nothing');
  assert.deepEqual(nextDrainAction([{ ticketId: 'stuck' }, { ticketId: 'wedged' }], { ...deps, hasLedger: (id) => id === 'wedged' }), { ticketId: 'wedged', action: 'queue' });
  assert.deepEqual(nextDrainAction([{ ticketId: 'stuck' }, { ticketId: 'gone' }], deps), { ticketId: 'gone', action: 'drop' });
});

// Review round 1, finding 1: a replay that never ran the maker (the loop's
// overlap lock) or failed must not consume the saved words.
test('drainConsumed: only done, or a refusal already answered in the thread, consumes the replies', () => {
  assert.equal(drainConsumed({ outcome: 'done', result: {} }), true);
  assert.equal(drainConsumed({ outcome: 'nothing-to-do', result: { ticketId: 'a', refused: 'flagged' } }), true);
  assert.equal(drainConsumed({ outcome: 'nothing-to-do', reason: 'already running' }), false);
  assert.equal(drainConsumed({ outcome: 'nothing-to-do', result: { ticketId: 'a', state: 'in_progress' } }), false);
  assert.equal(drainConsumed({ outcome: 'failed:b:launch failed', reason: 'b:launch failed' }), false);
  assert.equal(drainConsumed(undefined), false);
});

test('nextDrainAction: a per-ticket canRelaunch skips an automation reopen with no room and takes the operator one behind it (glmps-2-0-111)', () => {
  const pending = [{ ticketId: 'auto' }, { ticketId: 'op' }];
  const deps = { stateOf: () => 'idle', hasLedger: () => false, reopenable: new Set(['idle']) };
  assert.deepEqual(nextDrainAction(pending, { ...deps, canRelaunch: (id) => id === 'op' }), { ticketId: 'op', action: 'reopen' });
  assert.equal(nextDrainAction(pending, { ...deps, canRelaunch: () => false }), null);
});
