import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonStore, readJsonStoreOrDegrade, writeJsonStore, JsonStoreError } from '../lib/json-store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-'));

test('ENOENT returns the fallback', () => {
  const f = path.join(dir(), 'nope.json');
  assert.deepEqual(readJsonStore(f, { fallback: { a: 1 } }), { a: 1 });
  assert.deepEqual(readJsonStore(f, { fallback: () => [] }), []);
});

test('a corrupt file throws a JsonStoreError after retrying, never an empty value', () => {
  const f = path.join(dir(), 's.json');
  fs.writeFileSync(f, '{"a":');
  const t0 = Date.now();
  assert.throws(() => readJsonStore(f, { fallback: {}, retries: 2, delayMs: 20 }), (e) => e instanceof JsonStoreError && e.file === f);
  assert.ok(Date.now() - t0 >= 35, 'retried with a delay');
});

test('a parse failure names the file and reason but never echoes the file text', () => {
  const f = path.join(dir(), 's.json');
  fs.writeFileSync(f, '{"botToken": xoxb-SECRET-1234}');
  assert.throws(() => readJsonStore(f, { retries: 0 }), (e) => {
    assert.equal(e.code, 'EPARSE');
    assert.match(e.message, /not valid JSON/);
    assert.doesNotMatch(e.message, /SECRET|xoxb/);
    return true;
  });
});

test('a wrong-shaped file throws when validate rejects it', () => {
  const f = path.join(dir(), 's.json');
  fs.writeFileSync(f, '[1]');
  assert.throws(() => readJsonStore(f, { validate: (v) => !Array.isArray(v) }), { code: 'ESHAPE' });
});

test('readJsonStoreOrDegrade logs and returns the fallback', () => {
  const f = path.join(dir(), 's.json');
  fs.writeFileSync(f, 'garbage');
  const logs = [];
  const v = readJsonStoreOrDegrade(f, { fallback: { x: 1 }, retries: 0, log: (m) => logs.push(m) });
  assert.deepEqual(v, { x: 1 });
  assert.equal(logs.length, 1);
});

test('writeJsonStore writes via rename, leaves no temp file, and can keep a .bak', () => {
  const d = dir();
  const f = path.join(d, 'sub', 's.json');
  writeJsonStore(f, { v: 1 }, { backup: true });
  writeJsonStore(f, { v: 2 }, { backup: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { v: 1 });
  assert.deepEqual(fs.readdirSync(path.join(d, 'sub')).filter((n) => n.endsWith('.tmp')), []);
});
