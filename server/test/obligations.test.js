// server/test/obligations.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openObligationStore, OBLIGATION_KINDS, CLOSERS } from '../lib/kernel/obligations.js';
import { SPINE_KINDS } from '../lib/observability/spine.js';

function store(t = { v: 1000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-obl-')); const events = [];
  const s = openObligationStore({ dbFile: path.join(dir, 'kernel.db'), now: () => t.v, emit: (_d, e) => events.push(e) });
  return { s, events, t, dir };
}

test('open is idempotent per (kind, subject) while open, and emits obligation.opened once', () => {
  const { s, events } = store();
  const a = s.open({ kind: 'loop.freshness', subject: 'wiki', openedBy: 'kernel', dueTs: 5000 });
  const b = s.open({ kind: 'loop.freshness', subject: 'wiki', openedBy: 'kernel', dueTs: 9000 });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.id, b.id);
  assert.equal(s.countOpen(), 1);
  assert.deepEqual(events.map((e) => e.kind), [SPINE_KINDS.OBLIGATION_OPENED]);
  s.closeDb();
});

test('verified.done needs a verifierRef from a different actor', () => {
  const { s } = store();
  const { id } = s.open({ kind: 'gate.independent-verdict', subject: 'mc-1', openedBy: 'agent:mc-1', dueTs: 5000 });
  assert.throws(() => s.close(id, { closer: 'verified.done', closedBy: 'judge' }), /verifierRef/);
  assert.throws(() => s.close(id, { closer: 'verified.done', closedBy: 'agent:mc-1', verifierRef: 'x' }), /different actor/);
  assert.throws(() => s.close(id, { closer: 'done', closedBy: 'judge', verifierRef: 'x' }), /closer/);
  s.close(id, { closer: 'verified.done', closedBy: 'judge', verifierRef: 'judge:r1' });
  const row = s.get(id);
  assert.equal(row.closer, 'verified.done'); assert.equal(row.verifierRef, 'judge:r1'); assert.equal(s.countOpen(), 0);
  s.closeDb();
});

test('decision.deferred and decision.cancelled close without a verifier', () => {
  const { s } = store();
  const a = s.open({ kind: 'loop.freshness', subject: 'a', openedBy: 'kernel', dueTs: 1 });
  const b = s.open({ kind: 'loop.freshness', subject: 'b', openedBy: 'kernel', dueTs: 1 });
  s.close(a.id, { closer: 'decision.deferred', closedBy: 'operator' });
  s.close(b.id, { closer: 'decision.cancelled', closedBy: 'operator' });
  assert.equal(s.countOpen(), 0);
  assert.deepEqual(CLOSERS, ['verified.done', 'decision.deferred', 'decision.cancelled']);
  s.closeDb();
});

test('expireDue marks overdue rows expired at level 0, once, and escalate walks the ladder to 2', () => {
  const { s, events, t } = store();
  const { id } = s.open({ kind: 'loop.freshness', subject: 'wiki', openedBy: 'kernel', dueTs: 2000 });
  assert.deepEqual(s.expireDue(), []);
  t.v = 3000;
  const [row] = s.expireDue();
  assert.equal(row.id, id); assert.equal(row.escalationLevel, 0); assert.equal(row.expiredTs, 3000);
  assert.deepEqual(s.expireDue(), [], 'expired once');
  assert.equal(s.escalate(id).escalationLevel, 1);
  assert.equal(s.escalate(id).escalationLevel, 2);
  assert.equal(s.escalate(id).escalationLevel, 2, 'the ladder tops out');
  assert.deepEqual(events.map((e) => e.kind), ['obligation.opened', 'obligation.expired', 'obligation.escalated', 'obligation.escalated']);
  s.closeDb();
});

test('an unknown kind is refused; the store survives a reopen', () => {
  const t = { v: 1 }; const { s, dir } = store(t);
  assert.throws(() => s.open({ kind: 'nope', subject: 'x', openedBy: 'k', dueTs: 1 }), /unknown obligation kind/);
  s.open({ kind: 'wiki.reflects-head', subject: 'abc123', openedBy: 'kernel', dueTs: 10 });
  s.closeDb();
  const again = openObligationStore({ dbFile: path.join(dir, 'kernel.db'), now: () => 1, emit: () => {} });
  assert.equal(again.countOpen(), 1);
  assert.equal(again.findOpen({ kind: 'wiki.reflects-head', subject: 'abc123' }).openedBy, 'kernel');
  again.closeDb();
});

test('setMeta round-trips an object', () => {
  const { s } = store();
  const { id } = s.open({ kind: 'loop.freshness', subject: 'm', openedBy: 'kernel', dueTs: 1 });
  assert.deepEqual(s.setMeta(id, { lastEscalatedTs: 5 }).meta, { lastEscalatedTs: 5 });
  s.closeDb();
});

test('every declared kind has a default due time and at least one closer', () => {
  for (const [kind, k] of Object.entries(OBLIGATION_KINDS)) {
    assert.ok(k.defaultDueMs > 0, kind); assert.ok(k.closers.length > 0, kind);
    for (const c of k.closers) assert.ok(CLOSERS.includes(c), `${kind}: ${c}`);
  }
});

// Task 10 minor (folded into Task 11): closing an already-closed row is
// idempotent, never a second write or a throw - a retried report, or two
// closers racing, must not corrupt the row or surface as a caller error.
test('closing an already-closed obligation twice is idempotent, not a throw', () => {
  const { s } = store();
  const { id } = s.open({ kind: 'loop.freshness', subject: 'dbl', openedBy: 'kernel', dueTs: 1 });
  const first = s.close(id, { closer: 'decision.cancelled', closedBy: 'operator' });
  const second = s.close(id, { closer: 'decision.cancelled', closedBy: 'operator' });
  assert.deepEqual(second, first);
  // Even a closer/actor mismatch on the second call is ignored: the row is
  // already closed, so escalate's own idempotence path (below) is the only
  // contract that matters here, not a fresh validation of arguments nobody
  // can act on anymore.
  assert.deepEqual(s.close(id, { closer: 'verified.done', closedBy: 'someone-else', verifierRef: 'x' }), first);
  s.closeDb();
});

// Task 10 minor (folded into Task 11): escalate on a row that has not yet
// expired (escalationLevel -1) or on an id that does not exist is a safe
// no-op, never a throw - the sweeper's own loop (obligation-sweeper.js)
// calls escalate() on whatever store.listOpen() just returned, and a stale
// or already-closed id must not take the whole sweep down.
test('escalate on a non-expired row or an unknown id is a safe no-op', () => {
  const { s } = store();
  const { id } = s.open({ kind: 'loop.freshness', subject: 'ne', openedBy: 'kernel', dueTs: 100 });
  const row = s.escalate(id);
  assert.equal(row.escalationLevel, -1, 'a row that has not expired yet is never escalated');
  assert.equal(s.escalate('obl_nope'), null, 'escalating an unknown id is a safe no-op, not a throw');
  s.closeDb();
});
