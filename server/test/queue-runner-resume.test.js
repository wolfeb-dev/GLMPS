// Phase 5 (glmps-81): superstep-boundary checkpointing.
//
// The queue-runner's persisted ledger (runner-store.js) is already the
// checkpoint, and reconcileLedger (queue-runner.js) is already the
// resume-decision function -- both built before this ticket, unmodified here.
// What was untested is the actual claim glmps-80 wants: a "rebooted runner"
// resumes DETERMINISTICALLY (same next action every time), not merely
// "doesn't crash." This file proves that by simulating a reboot as two fully
// independent loads of the same on-disk ledger, each reconciled against a
// freshly-injected liveness predicate (no shared in-memory state between the
// two "boots" -- exactly what a real process restart looks like).
//
// reconcileLedger already accepts `isAlive` as an injected predicate (see
// server.js:2909, `isAlive: pidAlive`, and the existing queue-runner.test.js
// cases) -- no signature change was needed to make liveness fakeable for this
// test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/orchestration/runner-store.js';
import { reconcileLedger, ledgerChecksum } from '../lib/orchestration/queue-runner.js';

// Isolated temp dir per test, matching runner-store.test.js's own convention
// (loadLedger/saveLedger take stateDir as a direct argument, not read from
// env) -- never touches the real ~/.glmps state.
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runner-resume-')); }

test('reboot with the process dead: two independent reconcile loads land on identical {ledger, actions} and checksum', () => {
  const dir = tmp();
  const items = [
    { id: 'glmps-1', state: 'in_progress' }, // retries:0 -> below maxRetries -> requeue
    { id: 'glmps-2', state: 'in_progress' }, // retries:2 -> at maxRetries -> hold, dropped
  ];
  store.saveLedger(dir, {
    'glmps-1': { pid: 111, startedAt: 0, target: 'cursor', retries: 0 },
    'glmps-2': { pid: 222, startedAt: 0, target: 'cursor', retries: 2 },
  });

  const deadIsAlive = () => false; // simulated reboot: old pids are gone from the process table

  // Two independent "boots": each re-reads the ledger fresh from disk (no
  // shared state) and reconciles against the same simulated liveness input.
  function boot() {
    const ledger = store.loadLedger(dir);
    return reconcileLedger({ ledger, items, isAlive: deadIsAlive, now: 10, maxRuntimeMs: 1000, maxRetries: 2 });
  }
  const bootA = boot();
  const bootB = boot();

  assert.deepEqual(bootA.ledger, bootB.ledger, 'reconciled ledger identical across independent reboots');
  assert.deepEqual(bootA.actions, bootB.actions, 'reconciled actions identical across independent reboots');
  assert.equal(ledgerChecksum(bootA.ledger), ledgerChecksum(bootB.ledger), 'checksum agrees byte-for-byte across reboots');

  // Not a vacuous "both empty" pass -- something real happened, and it's the
  // SAME real thing both times: glmps-1 requeues (still under budget),
  // glmps-2 holds and drops out of the next ledger (at maxRetries).
  assert.equal(bootA.actions.find(a => a.id === 'glmps-1').action, 'requeue');
  assert.equal(bootA.actions.find(a => a.id === 'glmps-2').action, 'hold');
  assert.equal(bootA.ledger['glmps-1'].retries, 1);
  assert.equal(bootA.ledger['glmps-2'], undefined);
});

test('reboot with the process still alive: no spurious requeue/hold, checksum stable across reboots', () => {
  const dir = tmp();
  const items = [{ id: 'glmps-3', state: 'in_progress' }];
  store.saveLedger(dir, { 'glmps-3': { pid: 333, startedAt: 0, target: 'cursor', retries: 0 } });

  const aliveIsAlive = () => true; // simulated reboot: the pid is still present and within budget

  function boot() {
    const ledger = store.loadLedger(dir);
    return reconcileLedger({ ledger, items, isAlive: aliveIsAlive, now: 10, maxRuntimeMs: 1000, maxRetries: 2 });
  }
  const bootA = boot();
  const bootB = boot();

  assert.deepEqual(bootA.actions, [], 'live process within budget -> no requeue/hold');
  assert.deepEqual(bootB.actions, [], 'same on second independent reboot');
  assert.ok(bootA.ledger['glmps-3'], 'entry retained');
  assert.equal(bootA.ledger['glmps-3'].retries, 0, 'no retry burned for a live process');
  assert.equal(ledgerChecksum(bootA.ledger), ledgerChecksum(bootB.ledger), 'checksum agrees byte-for-byte across reboots');
});


test('ledgerChecksum: insertion order does not affect the checksum (stable key ordering)', () => {
  const a = {
    'glmps-2': { pid: 2, startedAt: 0, target: 'cursor', retries: 0 },
    'glmps-1': { pid: 1, startedAt: 0, target: 'cursor', retries: 1 },
  };
  const b = {
    'glmps-1': { retries: 1, target: 'cursor', startedAt: 0, pid: 1 },
    'glmps-2': { target: 'cursor', pid: 2, retries: 0, startedAt: 0 },
  };
  assert.equal(ledgerChecksum(a), ledgerChecksum(b), 'same content, different key order -> same checksum');
});

test('ledgerChecksum: different decision-relevant state -> different checksum', () => {
  const a = { 'glmps-1': { pid: 1, startedAt: 0, target: 'cursor', retries: 0 } };
  const b = { 'glmps-1': { pid: 1, startedAt: 0, target: 'cursor', retries: 1 } };
  assert.notEqual(ledgerChecksum(a), ledgerChecksum(b));
});

test('ledgerChecksum: empty ledger is a stable, defined string', () => {
  assert.equal(ledgerChecksum({}), ledgerChecksum({}));
  assert.equal(typeof ledgerChecksum({}), 'string');
  assert.ok(ledgerChecksum({}).length > 0);
});

test('ledgerChecksum: default arg handles undefined the same as an empty ledger', () => {
  assert.equal(ledgerChecksum(), ledgerChecksum({}));
});
