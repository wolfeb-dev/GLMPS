// server/test/tap-token.test.js
// Tap agent skeleton (card glmps-2-0-runtime-31): the DPAPI token file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenFile, writeToken, readToken, dpapiRunner, clientKeyFile, writeClientKey, readClientKey } from '../../taps/tap-token.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-taptoken-'));

// A reversible stand-in for DPAPI that records what it was handed.
function fakeRunner(calls = []) {
  return {
    protect: (secret) => { calls.push(['protect', secret]); return Buffer.from(`blob:${secret}`); },
    unprotect: (blob) => { calls.push(['unprotect', blob.toString()]); return blob.toString().replace(/^blob:/, ''); },
  };
}

test('writeToken stores base64 of the protected blob, never the plaintext, and readToken returns the secret', () => {
  const home = tmp();
  const calls = [];
  writeToken(home, 'secret-token', { runner: fakeRunner(calls), platform: 'win32' });
  const file = fs.readFileSync(tokenFile(home), 'utf8');
  assert.equal(file.includes('secret-token'), false);
  assert.equal(Buffer.from(file.trim(), 'base64').toString(), 'blob:secret-token');
  assert.equal(readToken(home, { runner: fakeRunner(), platform: 'win32' }), 'secret-token');
  assert.deepEqual(calls, [['protect', 'secret-token']]);
});

test('readToken: no file is null, an unreadable blob is a named error that does not echo the blob', () => {
  const home = tmp();
  assert.equal(readToken(home, { runner: fakeRunner(), platform: 'win32' }), null);
  fs.writeFileSync(tokenFile(home), Buffer.from('garbage').toString('base64'));
  const bad = { protect: () => Buffer.alloc(0), unprotect: () => { throw new Error('cannot decrypt'); } };
  assert.throws(() => readToken(home, { runner: bad, platform: 'win32' }), (e) => e.code === 'TAP_TOKEN_UNREADABLE' && !e.message.includes('garbage'));
});

test('off Windows both directions throw a named error and write nothing', () => {
  const home = tmp();
  assert.throws(() => writeToken(home, 'x', { platform: 'linux' }), (e) => e.code === 'TAP_TOKEN_UNSUPPORTED_PLATFORM');
  assert.equal(fs.existsSync(tokenFile(home)), false);
  assert.throws(() => readToken(home, { platform: 'darwin' }), (e) => e.code === 'TAP_TOKEN_UNSUPPORTED_PLATFORM');
});

test('writeToken refuses an empty secret', () => {
  assert.throws(() => writeToken(tmp(), '', { runner: fakeRunner(), platform: 'win32' }), /token/);
});

test('the real runner puts the secret on stdin, not on the command line', () => {
  const seen = [];
  const spawn = (file, args, opts) => { seen.push({ file, args, input: opts.input }); return { status: 0, stdout: Buffer.from('QUJD'), stderr: Buffer.alloc(0) }; };
  const r = dpapiRunner(spawn);
  r.protect('s3cret');
  assert.equal(seen[0].file, 'powershell.exe');
  assert.equal(seen[0].input.toString(), 's3cret');
  assert.equal(JSON.stringify(seen[0].args).includes('s3cret'), false);
  assert.match(seen[0].args.join(' '), /ProtectedData/);
  assert.throws(() => dpapiRunner(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') })).protect('x'), /DPAPI/);
});

test('a real DPAPI round trip on Windows', { skip: process.platform !== 'win32' }, () => {
  const home = tmp();
  writeToken(home, 'real-round-trip-token');
  const onDisk = fs.readFileSync(tokenFile(home), 'utf8');
  assert.equal(onDisk.includes('real-round-trip-token'), false);
  assert.equal(readToken(home), 'real-round-trip-token');
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC-3: the client key is DPAPI-protected beside the token, never in plaintext, and reads back', () => {
  const home = tmp();
  const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
  assert.equal(readClientKey(home, { runner: fakeRunner(), platform: 'win32' }), null, 'no key file is null');
  writeClientKey(home, pem, { runner: fakeRunner(), platform: 'win32' });
  assert.equal(path.dirname(clientKeyFile(home)), path.dirname(tokenFile(home)));
  assert.equal(fs.readFileSync(clientKeyFile(home), 'utf8').includes('PRIVATE KEY'), false);
  assert.equal(readClientKey(home, { runner: fakeRunner(), platform: 'win32' }), pem);
  assert.throws(() => writeClientKey(home, pem, { platform: 'linux' }), { code: 'TAP_TOKEN_UNSUPPORTED_PLATFORM' });
});
