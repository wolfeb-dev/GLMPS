// The release's signing choices and its check of what PowerShell reports (card glmps-2-0-runtime-32).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signingMode, checkSigned } from '../scripts/sign-lib.mjs';

const T = 'C74BBD54C1211B9386A27E2904D2463908B6F9E9';

test('signingMode: test certificate, or a purchased one by thumbprint with a timestamp', () => {
  assert.deepEqual(signingMode({ testCert: true }), { ok: true, mode: 'test', timestamp: null });
  assert.deepEqual(signingMode({ thumbprint: T.toLowerCase().replace(/(.{8})/g, '$1 '), timestamp: 'http://ts.example' }), { ok: true, mode: 'release', thumbprint: T, timestamp: 'http://ts.example' });
  assert.match(signingMode({}).reason, /--test-cert .* --thumbprint/);
  assert.match(signingMode({ testCert: true, thumbprint: T }).reason, /not both/);
  assert.match(signingMode({ thumbprint: 'abc', timestamp: 'x' }).reason, /40 hex/);
  assert.match(signingMode({ thumbprint: T }).reason, /--timestamp/);
});

test('checkSigned: right signer and status pass; anything else names the file', () => {
  const ok = { file: 'a.exe', status: 'UnknownError', thumbprint: T };
  assert.equal(checkSigned([ok], { mode: 'test', thumbprint: T }), null);
  assert.equal(checkSigned(ok, { mode: 'test', thumbprint: T }), null, 'PowerShell collapses a one-item array');
  assert.match(checkSigned([ok], { mode: 'release', thumbprint: T }), /a\.exe: signature status UnknownError/);
  assert.equal(checkSigned([{ ...ok, status: 'Valid' }], { mode: 'release', thumbprint: T }), null);
  assert.match(checkSigned([{ ...ok, thumbprint: 'B'.repeat(40) }], { mode: 'test', thumbprint: T }), /a\.exe: signed by B+/);
  assert.match(checkSigned([{ ...ok, status: 'HashMismatch' }], { mode: 'test', thumbprint: T }), /HashMismatch/);
});
