// apps/shell/test/launch-auth-parity.test.js
// The shell's own copy of the challenge-response primitives (it cannot
// import server code at runtime) must be byte-identical to the kernel's -
// see launch-auth.js's own header comment, on both sides, for the protocol.
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shellAuth from '../src/lib/launch-auth.js';
import * as kernelAuth from '../../../server/lib/governance/launch-auth.js';

const shellFile = new URL('../src/lib/launch-auth.js', import.meta.url);
const kernelFile = new URL('../../../server/lib/governance/launch-auth.js', import.meta.url);

test('sha256Hex/computeProof/proofsMatch/nonceTime produce identical output on both copies for the same inputs', () => {
  const token = 'a'.repeat(64);
  assert.equal(shellAuth.sha256Hex('body'), kernelAuth.sha256Hex('body'));
  assert.equal(shellAuth.sha256Hex(''), kernelAuth.sha256Hex(''));
  const msg = { direction: 'req', method: 'POST', path: '/api/launches/x/claim', nonce: 'n1', bodyHash: shellAuth.sha256Hex('body') };
  assert.equal(shellAuth.computeProof(token, msg), kernelAuth.computeProof(token, msg));
  const res = { ...msg, direction: 'res' };
  assert.equal(shellAuth.computeProof(token, res), kernelAuth.computeProof(token, res));
  const p = shellAuth.computeProof(token, msg);
  assert.equal(shellAuth.proofsMatch(p, p), kernelAuth.proofsMatch(p, p));
  assert.equal(shellAuth.proofsMatch(p, p), true);
  assert.equal(shellAuth.proofsMatch('', ''), false, 'empty/empty is never a valid match on either copy');
  const n = shellAuth.randomNonce(1_790_000_000_000);
  assert.equal(kernelAuth.nonceTime(n), 1_790_000_000_000, 'a shell-minted nonce reads back on the kernel');
});

test('randomNonce on the shell copy produces a fresh, reasonably long hex value each time', () => {
  const n1 = shellAuth.randomNonce();
  const n2 = shellAuth.randomNonce();
  assert.match(n1, /^[0-9a-f]{32,}$/);
  assert.notEqual(n1, n2);
});

// comparing outputs for a few inputs cannot catch a drift
// on an input nobody thought to test. The code itself (comments and blank
// lines stripped, line endings normalized) must be identical.
function codeOnly(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/\s+\/\/ .*$/, '').trimEnd()))
    .filter((line) => line.trim() !== '')
    .join('\n');
}

test('F3: the two launch-auth.js copies are the same code, comments aside', () => {
  const shell = codeOnly(fs.readFileSync(shellFile, 'utf8'));
  const kernel = codeOnly(fs.readFileSync(kernelFile, 'utf8'));
  assert.ok(shell.length > 200, 'the comparison is over real code, not an empty string');
  assert.equal(shell, kernel);
});

test('F3: codeOnly itself notices a one-character code change', () => {
  const kernel = fs.readFileSync(kernelFile, 'utf8');
  const drifted = kernel.replace("'sha256'", "'sha512'");
  assert.notEqual(drifted, kernel, 'the mutation applied');
  assert.notEqual(codeOnly(drifted), codeOnly(kernel));
});
