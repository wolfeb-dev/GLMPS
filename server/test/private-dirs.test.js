// Tests for server/lib/private-dirs.js - the opt-out list that keeps a
// directory usable as a job cwd while excluding it from the global session
// sync, /api/projects, and the graph/wiki rebuild allowlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { privateDirsPath, loadPrivateDirs, isPrivateDir } from '../lib/private-dirs.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-privdirs-')); }
function withFile(contents) {
  const dir = tmp();
  const file = path.join(dir, 'private-dirs.json');
  fs.writeFileSync(file, contents);
  return file;
}

test('privateDirsPath: GLMPS_PRIVATE_DIRS_FILE wins outright', () => {
  assert.equal(privateDirsPath({ GLMPS_PRIVATE_DIRS_FILE: 'X:/custom.json' }), 'X:/custom.json');
});

test('privateDirsPath: otherwise it lives in the state dir, never in the repo', () => {
  const p = privateDirsPath({ GLMPS_STATE_DIR: 'X:/state' });
  assert.match(p.replace(/\\/g, '/'), /X:\/state\/private-dirs\.json$/);
});

test('loadPrivateDirs: a missing file yields no private dirs and never throws', () => {
  assert.deepEqual(loadPrivateDirs({ file: path.join(tmp(), 'absent.json') }), []);
});

test('loadPrivateDirs: malformed JSON yields no private dirs and never throws', () => {
  assert.deepEqual(loadPrivateDirs({ file: withFile('{ not json') }), []);
});

test('loadPrivateDirs: reads the private array and normalizes separators + trailing slash', () => {
  const file = withFile(JSON.stringify({ private: ['D:\\Vault\\', 'D:/Taxes'] }));
  assert.deepEqual(loadPrivateDirs({ file }), ['D:/Vault', 'D:/Taxes']);
});

test('isPrivateDir: an exact match is private', () => {
  assert.equal(isPrivateDir('D:\\Vault', ['D:/Vault']), true);
});

test('isPrivateDir: a subdirectory of a private dir is private', () => {
  assert.equal(isPrivateDir('D:/Vault/notes/2026', ['D:/Vault']), true);
});

// The prefix boundary is the bug worth pinning: a naive startsWith() would make
// the unrelated D:\Vaults private (or worse, leave D:\Vault exposed while
// hiding a sibling), so the separator must be part of the comparison.
test('isPrivateDir: a sibling sharing a prefix is NOT private', () => {
  assert.equal(isPrivateDir('D:/Vaults', ['D:/Vault']), false);
});

test('isPrivateDir: comparison is case-insensitive (Windows paths)', () => {
  assert.equal(isPrivateDir('d:/vault', ['D:/Vault']), true);
});

test('isPrivateDir: with no private dirs configured, nothing is private', () => {
  assert.equal(isPrivateDir('D:/Vault', []), false);
});
