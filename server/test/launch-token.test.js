// server/test/launch-token.test.js
// the shell trusts whatever answers on the loopback
// kernel URL - another local account binding the same port while the real
// service is down could otherwise serve launch records (and the allowlist
// from its own /api/config) just as convincingly as the real kernel. A
// per-install token, created once, is what tells the shell it is actually
// talking to ITS OWN kernel's state dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOrCreateLaunchToken } from '../lib/governance/launch-token.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launchtoken-'));

test('creates a random 64-hex-char token on first use, atomically', () => {
  const stateDir = tmp();
  const token = readOrCreateLaunchToken(stateDir);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(stateDir, 'launch-token')), true);
  assert.equal(fs.existsSync(path.join(stateDir, 'launch-token.tmp')), false, 'no leftover tmp file');
});

test('a second call reads back the SAME token, not a freshly minted one', () => {
  const stateDir = tmp();
  const a = readOrCreateLaunchToken(stateDir);
  const b = readOrCreateLaunchToken(stateDir);
  assert.equal(a, b);
});

test('a corrupt or malformed existing file is replaced with a freshly minted token', () => {
  const stateDir = tmp();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'launch-token'), 'not-a-real-token');
  const token = readOrCreateLaunchToken(stateDir);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('two different installs (different state dirs) get two different tokens', () => {
  const a = readOrCreateLaunchToken(tmp());
  const b = readOrCreateLaunchToken(tmp());
  assert.notEqual(a, b);
});

// the original bare catch treated ANY read failure on an
// EXISTING token file the same as "missing" and silently minted (and
// overwrote) a fresh one - a permissions glitch (EACCES) would then
// invisibly invalidate every shell that already had the old token. Only a
// genuinely missing file (ENOENT) may create one; any other read error is
// a named failure, and the existing file is never touched.
test('M-2: a non-ENOENT read error (e.g. EACCES) on an existing token file throws a named error and never rotates the token', () => {
  const stateDir = tmp();
  let wrote = false;
  const fsImpl = {
    readFileSync: () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; },
    writeFileSync: () => { wrote = true; },
    renameSync: () => { wrote = true; },
    mkdirSync: () => {},
    chmodSync: () => {},
  };
  assert.throws(() => readOrCreateLaunchToken(stateDir, { fsImpl }), /EACCES|permission denied/i);
  assert.equal(wrote, false, 'never attempted to mint/overwrite a token over an unreadable-but-present file');
});

// M-2: ENOENT (the file genuinely does not exist) is the one read error
// that legitimately means "create a fresh token" - unaffected by the fix
// above.
test('M-2: ENOENT on a missing token file still creates a fresh one, same as before', () => {
  const stateDir = tmp();
  const fsImpl = {
    readFileSync: () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; },
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
  };
  const token = readOrCreateLaunchToken(stateDir, { fsImpl });
  assert.match(token, /^[0-9a-f]{64}$/);
});

// M-2: the tmp file is written exclusively (fails if it already exists)
// and privately (owner-only), set AT CREATION rather than via a later
// chmod - closing the brief window a world-readable tmp file would
// otherwise sit in before the rename+chmod ran.
test('M-2: the tmp file is created with an exclusive write flag and 0o600 mode', () => {
  const stateDir = tmp();
  let capturedOptions = null;
  const fsImpl = {
    readFileSync: () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; },
    writeFileSync: (file, data, options) => { capturedOptions = options; fs.writeFileSync(file, data); },
    renameSync: fs.renameSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
  };
  readOrCreateLaunchToken(stateDir, { fsImpl });
  assert.equal(capturedOptions?.flag, 'wx');
  assert.equal(capturedOptions?.mode, 0o600);
});
