// server/test/skill-observation-log.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordFirstSeen, getObservedSince } from '../lib/evaluation/skill-observation-log.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-skill-obs-'));
  tmpDirs.push(d);
  return d;
}

test('getObservedSince: missing store file resolves to {}, never throws', () => {
  const dir = mkTmp();
  assert.deepEqual(getObservedSince(dir), {});
});

test('recordFirstSeen: records a first-seen timestamp for a new skill id', () => {
  const dir = mkTmp();
  recordFirstSeen(dir, ['plugin:foo'], 1000);
  assert.deepEqual(getObservedSince(dir), { 'plugin:foo': 1000 });
});

test('recordFirstSeen: idempotent - a SECOND call with a later nowMs does NOT overwrite the original timestamp', () => {
  const dir = mkTmp();
  recordFirstSeen(dir, ['plugin:foo'], 1000);
  recordFirstSeen(dir, ['plugin:foo'], 999999);
  assert.equal(getObservedSince(dir)['plugin:foo'], 1000);
});

test('recordFirstSeen: multiple ids accumulate across calls, existing entries untouched', () => {
  const dir = mkTmp();
  recordFirstSeen(dir, ['a:one'], 1000);
  recordFirstSeen(dir, ['a:one', 'b:two'], 2000);
  const map = getObservedSince(dir);
  assert.equal(map['a:one'], 1000);
  assert.equal(map['b:two'], 2000);
});

test('recordFirstSeen: malformed ids (non-string, empty) are skipped, not fatal', () => {
  const dir = mkTmp();
  assert.doesNotThrow(() => recordFirstSeen(dir, [null, '', 42, undefined, 'ok:id'], 500));
  assert.deepEqual(getObservedSince(dir), { 'ok:id': 500 });
});

test('recordFirstSeen: empty/malformed skillIds array never throws and does not create a file', () => {
  const dir = mkTmp();
  assert.doesNotThrow(() => recordFirstSeen(dir, [], 1));
  assert.doesNotThrow(() => recordFirstSeen(dir, undefined, 1));
  assert.deepEqual(getObservedSince(dir), {});
  assert.ok(!fs.existsSync(path.join(dir, 'skills', 'observed-since.json')));
});

test('recordFirstSeen: default nowMs (Date.now()) is used when omitted', () => {
  const dir = mkTmp();
  const before = Date.now();
  recordFirstSeen(dir, ['x:y']);
  const after = Date.now();
  const ts = getObservedSince(dir)['x:y'];
  assert.ok(ts >= before && ts <= after);
});

test('getObservedSince: a corrupt JSON file resolves to {} rather than throwing', () => {
  const dir = mkTmp();
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'observed-since.json'), '{not valid json');
  assert.deepEqual(getObservedSince(dir), {});
});

test('getObservedSince: a non-object (array) JSON file resolves to {} rather than throwing', () => {
  const dir = mkTmp();
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'observed-since.json'), '[1,2,3]');
  assert.deepEqual(getObservedSince(dir), {});
});
