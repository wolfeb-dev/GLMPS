import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/orchestration/runner-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runner-')); }

test('loadConfig returns defaults when no file', () => {
  const dir = tmp();
  assert.deepEqual(store.loadConfig(dir), store.DEFAULTS);
});

test('saveConfig merges partial onto current and persists', () => {
  const dir = tmp();
  const merged = store.saveConfig(dir, { enabled: true, lastTarget: 'cursor' });
  assert.equal(merged.enabled, true);
  assert.equal(merged.lastTarget, 'cursor');
  assert.equal(merged.maxConcurrent, 1);
  assert.equal(store.loadConfig(dir).enabled, true);
});

test('ledger round-trips and prompt file is written', () => {
  const dir = tmp();
  store.saveLedger(dir, { 'glmps-1': { pid: 42, startedAt: 100, target: 'cursor', retries: 0 } });
  assert.equal(store.loadLedger(dir)['glmps-1'].pid, 42);
  const p = store.writePrompt(dir, 'glmps-1', 'do the thing');
  assert.equal(fs.readFileSync(p, 'utf-8'), 'do the thing');
  assert.ok(path.isAbsolute(p));
});

// loadLedger answers {} on ANY read error, which a caller
// deciding "is this launch orphaned?" cannot tell apart from a genuinely
// empty ledger. readLedger names the failure instead.
test('readLedger: no file is an empty ledger; a corrupt or unreadable file is a named error, never {}', () => {
  const dir = tmp();
  assert.deepEqual(store.readLedger(dir), { ledger: {}, error: null });
  store.saveLedger(dir, { 'glmps-1': { launchId: 'ln_x' } });
  assert.deepEqual(store.readLedger(dir), { ledger: { 'glmps-1': { launchId: 'ln_x' } }, error: null });
  fs.writeFileSync(path.join(dir, 'runner', 'launched.json'), '{"glmps-1": {"launc');
  const corrupt = store.readLedger(dir);
  assert.equal(corrupt.ledger, null);
  assert.match(corrupt.error, /JSON|Unterminated|Unexpected/i);
  fs.rmSync(path.join(dir, 'runner', 'launched.json'));
  fs.mkdirSync(path.join(dir, 'runner', 'launched.json'));
  const unreadable = store.readLedger(dir);
  assert.equal(unreadable.ledger, null);
  assert.match(unreadable.error, /EISDIR|EPERM|illegal operation/i);
});

test('saveConfig normalizes operatorSlots to a non-negative integer', () => {
  const dir = tmp();
  assert.equal(store.loadConfig(dir).operatorSlots, 0);
  for (const [v, want] of [[1, 1], ['2', 2], [1.7, 1], [-3, 0], ['x', 0], [null, 0]]) assert.equal(store.saveConfig(dir, { operatorSlots: v }).operatorSlots, want, String(v));
});
