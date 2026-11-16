// server/test/internal-sessions.test.js
// Persisted set of session ids that are GLMPS's own internal
// worker spawns (the memory distiller's headless `claude -p` extraction
// calls), not real user sessions. Mirrors alert-seen.test.js's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInternal, saveInternal, markInternal } from '../lib/evaluation/internal-sessions.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-internal-sessions-'));
  return path.join(dir, 'state', 'internal-sessions.json');
}

test('loadInternal: missing file -> empty Set', () => {
  const s = loadInternal(tmpFile());
  assert.ok(s instanceof Set);
  assert.equal(s.size, 0);
});

test('loadInternal: corrupt JSON -> empty Set (fail-open)', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json{{{');
  assert.equal(loadInternal(file).size, 0);
});

test('loadInternal: non-array JSON -> empty Set (fail-open)', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ not: 'an array' }));
  assert.equal(loadInternal(file).size, 0);
});

test('saveInternal then loadInternal round-trips the set, creating parent dirs', () => {
  const file = tmpFile();
  saveInternal(file, new Set(['b-id', 'a-id', 'c-id']));
  assert.ok(fs.existsSync(file));
  const loaded = loadInternal(file);
  assert.deepEqual([...loaded].sort(), ['a-id', 'b-id', 'c-id']);
  // sorted array on disk
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), ['a-id', 'b-id', 'c-id']);
});

test('saveInternal: non-string entries are dropped on reload', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(['ok', 42, null, 'also-ok']));
  const loaded = loadInternal(file);
  assert.deepEqual([...loaded].sort(), ['also-ok', 'ok']);
});

test('markInternal: true on first add, false on a repeat', () => {
  const file = tmpFile();
  assert.equal(markInternal(file, 'sess-1'), true);
  assert.equal(markInternal(file, 'sess-1'), false);
  const loaded = loadInternal(file);
  assert.deepEqual([...loaded], ['sess-1']);
});

test('markInternal: a second distinct id is also newly added', () => {
  const file = tmpFile();
  assert.equal(markInternal(file, 'sess-1'), true);
  assert.equal(markInternal(file, 'sess-2'), true);
  assert.deepEqual([...loadInternal(file)].sort(), ['sess-1', 'sess-2']);
});
