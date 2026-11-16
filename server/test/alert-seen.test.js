// server/test/alert-seen.test.js
// Persisted "have we already recorded a shadow-arm occurrence for this alert
// id" set (Phase 3 of the alert -> learning loop). Deliberately unbounded
// (unlike alert-acks.js's 90-day prune): an id that never recurs is a tiny
// string forever, and pruning here would let a still-standing alert
// re-record and double-count its shadow occurrence after the id aged out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAlertSeen, saveAlertSeen } from '../lib/observability/alert-seen.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-alert-seen-'));
  return path.join(dir, 'state', 'alert-seen.json');
}

test('loadAlertSeen: missing file -> empty Set', () => {
  const s = loadAlertSeen(tmpFile());
  assert.ok(s instanceof Set);
  assert.equal(s.size, 0);
});

test('loadAlertSeen: corrupt JSON -> empty Set (fail-open)', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json{{{');
  assert.equal(loadAlertSeen(file).size, 0);
});

test('loadAlertSeen: non-array JSON -> empty Set (fail-open)', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ not: 'an array' }));
  assert.equal(loadAlertSeen(file).size, 0);
});

test('saveAlertSeen then loadAlertSeen round-trips the set, creating parent dirs', () => {
  const file = tmpFile();
  saveAlertSeen(file, new Set(['a', 'b', 'c']));
  assert.ok(fs.existsSync(file));
  const loaded = loadAlertSeen(file);
  assert.deepEqual([...loaded].sort(), ['a', 'b', 'c']);
});

test('saveAlertSeen: non-string entries are dropped on reload', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(['ok', 42, null, 'also-ok']));
  const loaded = loadAlertSeen(file);
  assert.deepEqual([...loaded].sort(), ['also-ok', 'ok']);
});
