// server/test/file-api-unc.test.js
// a \\host\share path made Windows authenticate to an attacker's SMB host
// because realpath and stat ran BEFORE the root check. Both must now run only
// for a path already known to be local and inside a root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileApi } from '../lib/governance/file-api.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fapi-unc-'));
  tmpDirs.push(root);
  return { root, api: new FileApi([root], path.join(root, '.undo')) };
}

test('F1: UNC and device paths are refused before any realpath or stat (no outbound SMB)', (t) => {
  const { api } = mkRoot();
  const rp = t.mock.method(fs.realpathSync, 'native');
  const st = t.mock.method(fs, 'statSync');
  for (const p of ['\\\\attacker.example\\share\\x.txt', '//attacker.example/share/x.txt', '\\\\?\\C:\\x.txt', '\\\\.\\pipe\\x']) {
    assert.throws(() => api.read(p), /UNC or device/, p);
    assert.equal(api.allows(p).ok, false, p);
  }
  assert.equal(rp.mock.callCount(), 0, 'realpath never ran');
  assert.equal(st.mock.callCount(), 0, 'stat never ran');
});

test('F1: a path outside every root is refused before any realpath', (t) => {
  const { api } = mkRoot();
  const outside = path.join(os.tmpdir(), `mc-fapi-outside-${process.pid}`, 'x.txt');
  const rp = t.mock.method(fs.realpathSync, 'native');
  assert.throws(() => api.read(outside), /Path not allowed/);
  assert.equal(rp.mock.callCount(), 0);
});

test('F1: the access-token file is denied by name, like launch-token', () => {
  const { root, api } = mkRoot();
  const f = path.join(root, 'access-token');
  fs.writeFileSync(f, 'not-a-real-token');
  assert.throws(() => api.read(f), /sensitive/);
});

// Windows ignores trailing dots and spaces in a name, so 'access-token.'
// IS the token file; it must be refused as sensitive, not by an ENOENT.
test('M4: trailing-dot and trailing-space spellings of a denied name are refused as sensitive (win32)', { skip: process.platform !== 'win32' }, () => {
  const { root, api } = mkRoot();
  for (const name of ['access-token.', 'launch-token ', 'access-token. .', 'actor-tokens.json.']) {
    assert.throws(() => api.read(path.join(root, name)), /sensitive/, name);
  }
});
