// server/test/launch-auth.test.js
// the challenge-response primitives both the kernel and
// the shell use to prove knowledge of the per-install launch token without
// ever putting the token itself on the wire. See launch-auth.js's own
// header comment for the protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, computeProof, proofsMatch, randomNonce, nonceTime } from '../lib/governance/launch-auth.js';

const token = 'a'.repeat(64);
const base = { direction: 'req', method: 'POST', path: '/api/launches/x/claim', nonce: 'n1', bodyHash: sha256Hex('body') };

test('sha256Hex is deterministic and empty-body-safe', () => {
  assert.equal(sha256Hex('x').length, 64);
  assert.equal(sha256Hex('x'), sha256Hex('x'));
  assert.notEqual(sha256Hex('x'), sha256Hex('y'));
  assert.match(sha256Hex(''), /^[0-9a-f]{64}$/);
  assert.match(sha256Hex(undefined), /^[0-9a-f]{64}$/, 'a missing body hashes the same as an empty one');
});

// the MAC used to cover only `${nonce}\n${bodyHash}`, so a
// proof captured from one route (a GET over '') verified on any other route
// with the same body, and a response proof verified as a request proof.
// Every component of the bound message must now change the proof.
test('computeProof depends on the token, direction, method, path, nonce and body hash - changing any one changes the proof', () => {
  const p = computeProof(token, base);
  assert.match(p, /^[0-9a-f]{64}$/);
  assert.notEqual(p, computeProof('b'.repeat(64), base), 'different token');
  assert.notEqual(p, computeProof(token, { ...base, direction: 'res' }), 'different direction');
  assert.notEqual(p, computeProof(token, { ...base, method: 'GET' }), 'different method');
  assert.notEqual(p, computeProof(token, { ...base, path: '/api/launches/y/claim' }), 'different path');
  assert.notEqual(p, computeProof(token, { ...base, path: '/api/launches/x/result' }), 'different route');
  assert.notEqual(p, computeProof(token, { ...base, nonce: 'n2' }), 'different nonce');
  assert.notEqual(p, computeProof(token, { ...base, bodyHash: sha256Hex('different body') }), 'different body hash');
  assert.equal(p, computeProof(token, { ...base }), 'same inputs, same proof');
  assert.equal(p, computeProof(token, { ...base, method: 'post' }), 'the method is case-normalized');
});

test('computeProof refuses an unknown direction rather than signing an ambiguous message', () => {
  assert.throws(() => computeProof(token, { ...base, direction: 'x' }), /direction/);
  assert.throws(() => computeProof(token, { ...base, direction: undefined }), /direction/);
});

test('proofsMatch is true only for an exact match, constant-time safe against length/type surprises', () => {
  const a = computeProof(token, base);
  assert.equal(proofsMatch(a, a), true);
  assert.equal(proofsMatch(a, a.slice(0, -1)), false, 'a truncated proof never matches');
  assert.equal(proofsMatch(a, a + '0'), false, 'a longer proof never matches');
  assert.equal(proofsMatch(null, a), false);
  assert.equal(proofsMatch(a, undefined), false);
  assert.equal(proofsMatch('', ''), false, 'two empty strings are never treated as a valid match');
});

test('randomNonce produces a fresh, reasonably long hex value each time', () => {
  const n1 = randomNonce();
  const n2 = randomNonce();
  assert.match(n1, /^[0-9a-f]{32,}$/);
  assert.notEqual(n1, n2);
});

// the kernel's replay cache can only stay bounded if a nonce older than
// its window is refused outright - so the nonce carries the time it was
// minted (and the MAC covers the nonce, so that time cannot be altered).
test('randomNonce embeds its mint time; nonceTime reads it back and rejects anything malformed', () => {
  const t = 1_790_000_000_000;
  assert.equal(nonceTime(randomNonce(t)), t);
  assert.equal(nonceTime(randomNonce()) <= Date.now(), true);
  assert.equal(nonceTime('zz'), null);
  assert.equal(nonceTime(''), null);
  assert.equal(nonceTime(undefined), null);
  assert.equal(nonceTime('0'.repeat(12)), null, 'a time with no random part is not a nonce');
  assert.equal(nonceTime('G'.repeat(44)), null);
});
