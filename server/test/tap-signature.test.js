// server/test/tap-signature.test.js
// Server-and-client-tap task 7 (D4): the signed-catalog check on a tap payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CATALOG_FILE, parsePin, evaluateVerification, verifyTapPayload, powershellVerifier, windowsPowerShellEnv } from '../../taps/tap-signature.js';

const T = 'C74BBD54C1211B9386A27E2904D2463908B6F9E9';
const pin = { thumbprint: T, mode: 'test' };
const good = { catalog: 'Valid', signature: 'UnknownError', thumbprint: T, subject: 'CN=GLMPS Tap Test Signing', missing: [], extra: [], changed: [] };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapsig-'));

test('parsePin needs a 40-hex thumbprint and a known mode', () => {
  assert.deepEqual(parsePin({ thumbprint: T.toLowerCase(), mode: 'release' }), { thumbprint: T, mode: 'release', subject: null });
  assert.throws(() => parsePin({ thumbprint: 'abc', mode: 'test' }), /thumbprint/);
  assert.throws(() => parsePin({ thumbprint: T, mode: 'prod' }), /mode/);
  assert.throws(() => parsePin(null), /object/);
});

test('a test pin accepts the pinned signer on an untrusted chain', () => {
  assert.equal(evaluateVerification(good, parsePin(pin)), null);
  assert.equal(evaluateVerification({ ...good, signature: 'Valid' }, parsePin(pin)), null);
});

test('a release pin needs a trusted chain', () => {
  const rel = parsePin({ thumbprint: T, mode: 'release' });
  assert.match(evaluateVerification(good, rel), /needs a trusted chain/);
  assert.equal(evaluateVerification({ ...good, signature: 'Valid' }, rel), null);
});

test('every tamper is refused with a named reason', () => {
  const p = parsePin(pin);
  const cases = [
    [{ changed: ['hooks\\plan-gate.js'] }, /differ from the signed catalog: hooks\\plan-gate\.js/],
    [{ missing: 'node.exe' }, /missing: node\.exe/],
    [{ extra: ['evil.js'] }, /not in the signed catalog: evil\.js/],
    [{ catalog: 'ValidationFailed' }, /does not match its catalog/],
    [{ signature: 'NotSigned' }, /not signed/],
    [{ signature: 'HashMismatch' }, /does not match its content/],
    [{ thumbprint: 'A'.repeat(40) }, /not the pinned signer/],
    [{ signature: 'Incompatible' }, /signature is Incompatible/],
  ];
  for (const [delta, re] of cases) assert.match(evaluateVerification({ ...good, ...delta }, p), re);
  assert.match(evaluateVerification(null, p), /no verification result/);
});

// A tap or test started from PowerShell 7 inherits its module folders; 5.1 then
// cannot load its own Microsoft.PowerShell.Security (the windows-latest CI leg).
test('the verifier starts Windows PowerShell without an inherited PSModulePath', () => {
  const saved = process.env.PSModulePath;
  process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
  try {
    let env;
    powershellVerifier((cmd, args, opts) => { env = opts.env; return { status: 0, stdout: '{}' }; })('C:\\x');
    assert.equal('PSModulePath' in env, false);
    assert.equal(env.GLMPS_TAP_VERIFY_DIR, 'C:\\x');
    assert.deepEqual(windowsPowerShellEnv({ B: '2' }, { PSMODULEPATH: 'x', A: '1' }), { A: '1', B: '2' });
  } finally {
    if (saved === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = saved;
  }
});

test('verifyTapPayload refuses off Windows, with no pin, or with no catalog, before running anything', () => {
  const dir = tmp();
  let ran = 0;
  const verify = () => { ran++; return good; };
  assert.match(verifyTapPayload(dir, { pin, verify, platform: 'linux' }).reason, /needs Windows/);
  assert.match(verifyTapPayload(dir, { pin: {}, verify, platform: 'win32' }).reason, /no usable signer pin/);
  assert.match(verifyTapPayload(dir, { pin, verify, platform: 'win32' }).reason, /tap\.cat is missing/);
  assert.equal(ran, 0);
  fs.writeFileSync(path.join(dir, CATALOG_FILE), 'x');
  assert.equal(verifyTapPayload(dir, { pin, verify, platform: 'win32' }).ok, true);
  assert.match(verifyTapPayload(dir, { pin, verify: () => ({ error: 'boom' }), platform: 'win32' }).reason, /boom/);
});

// The real cmdlets: an unsigned catalog over a folder, then a tampered file.
// Unsigned is enough to prove the file comparison; signing is proved by the release smoke.
test('the PowerShell verifier reports a real catalog and a real tamper', { skip: process.platform !== 'win32' && 'Windows PowerShell only' }, () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'hooks'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'hooks', 'b.js'), 'b');
  const cat = path.join(tmp(), CATALOG_FILE);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'New-FileCatalog -Path $env:D -CatalogFilePath $env:C -CatalogVersion 2.0 | Out-Null'], { env: windowsPowerShellEnv({ D: dir, C: cat }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  fs.copyFileSync(cat, path.join(dir, CATALOG_FILE));
  const verify = powershellVerifier();
  const clean = verify(dir);
  assert.equal(clean.catalog, 'Valid');
  assert.equal(clean.signature, 'NotSigned');
  assert.match(evaluateVerification(clean, parsePin(pin)), /not signed/);
  fs.appendFileSync(path.join(dir, 'a.js'), 'x');
  fs.writeFileSync(path.join(dir, 'extra.js'), 'e');
  const bad = verify(dir);
  assert.equal(bad.catalog, 'ValidationFailed');
  assert.deepEqual([].concat(bad.changed), ['a.js']);
  assert.deepEqual([].concat(bad.extra), ['extra.js']);
});
