// server/test/tap-tls.test.js
// Card glmps-2-0-runtime-147: the tap's pinned-trust helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFingerprint, groupFingerprint, pinFromChain, certificateState, createTapFetch, tapKeyPair } from '../../taps/tap-tls.js';
import { createCa, issueClientCert, certFingerprint } from '../lib/kernel/x509-lite.js';

const CA = createCa({ cn: 'GLMPS Test CA', days: 30 });
const FP = certFingerprint(CA.certPem);

test('a fingerprint is read from any spelling the dashboard or an operator gives, and nothing shorter', () => {
  assert.equal(normalizeFingerprint(groupFingerprint(FP).toUpperCase()), FP);
  assert.equal(normalizeFingerprint(FP.match(/../g).join(':')), FP);
  assert.equal(normalizeFingerprint(FP.slice(0, 16)), null);
  assert.equal(normalizeFingerprint(''), null);
});

test('pinFromChain pins only the presented certificate whose SHA-256 is the fingerprint', () => {
  const other = createCa({ cn: 'Other', days: 30 });
  assert.deepEqual(pinFromChain([other.certPem, CA.certPem], FP), { ok: true, caPem: CA.certPem });
  const miss = pinFromChain([other.certPem], FP);
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /nothing was sent/);
  assert.equal(pinFromChain([], FP).ok, false);
});

test('certificateState: missing CA, missing key or certificate, expired, ok', () => {
  const keys = tapKeyPair();
  const c = issueClientCert({ caCertPem: CA.certPem, caKeyPem: CA.keyPem, publicKeyPem: keys.publicKeyPem, clientId: 'cli_1' });
  assert.equal(certificateState({ certPem: c.certPem, keyPresent: true, caPem: null }).state, 'missing');
  assert.equal(certificateState({ certPem: c.certPem, keyPresent: false, caPem: CA.certPem }).state, 'missing');
  assert.equal(certificateState({ certPem: null, keyPresent: true, caPem: CA.certPem }).state, 'missing');
  assert.deepEqual(certificateState({ certPem: c.certPem, keyPresent: true, caPem: CA.certPem }), { state: 'ok', notAfter: c.notAfter, reason: null });
  const exp = certificateState({ certPem: c.certPem, keyPresent: true, caPem: CA.certPem, now: c.notAfter + 1 });
  assert.equal(exp.state, 'expired');
  assert.match(exp.reason, /Pair again/);
});

test('createTapFetch sends a request without tls options through the base fetch untouched', async () => {
  const seen = [];
  const f = createTapFetch({ base: async (url, init) => { seen.push([url, init]); return 'base'; } });
  assert.equal(await f('http://127.0.0.1:1/x', { method: 'GET' }), 'base');
  assert.deepEqual(seen, [['http://127.0.0.1:1/x', { method: 'GET' }]]);
});
