// server/test/launch-nonces.test.js
// the kernel refuses a request nonce it has already
// accepted, and refuses one minted outside its freshness window - which is
// what lets the seen-nonce cache stay bounded without ever forgetting a
// nonce that could still be replayed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNonceGuard } from '../lib/governance/launch-nonces.js';
import { randomNonce } from '../lib/governance/launch-auth.js';

test('a fresh nonce is accepted once; the same nonce again is refused as a replay', () => {
  let now = 1_790_000_000_000;
  const g = createNonceGuard({ windowMs: 60_000, now: () => now });
  const n = randomNonce(now);
  assert.deepEqual(g.accept(n), { ok: true });
  now += 1000;
  const again = g.accept(n);
  assert.equal(again.ok, false);
  assert.match(again.reason, /replay/);
});

test('a nonce minted outside the window (either side) is refused as stale', () => {
  const now = 1_790_000_000_000;
  const g = createNonceGuard({ windowMs: 60_000, now: () => now });
  assert.match(g.accept(randomNonce(now - 60_001)).reason, /stale/);
  assert.match(g.accept(randomNonce(now + 60_001)).reason, /stale/);
  assert.equal(g.accept(randomNonce(now - 59_000)).ok, true);
});

test('a malformed nonce is refused', () => {
  const g = createNonceGuard({ windowMs: 60_000 });
  assert.match(g.accept('not-a-nonce').reason, /malformed/);
  assert.match(g.accept(undefined).reason, /malformed/);
});

test('expired entries are pruned, so the cache stays bounded by the window, and a pruned nonce still cannot be replayed', () => {
  let now = 1_790_000_000_000;
  const g = createNonceGuard({ windowMs: 60_000, max: 3, now: () => now });
  const old = randomNonce(now);
  assert.equal(g.accept(old).ok, true);
  assert.equal(g.accept(randomNonce(now)).ok, true);
  assert.equal(g.accept(randomNonce(now)).ok, true);
  now += 61_000;
  assert.equal(g.accept(randomNonce(now)).ok, true, 'room is made by pruning the expired entries');
  assert.ok(g.size() <= 3);
  assert.match(g.accept(old).reason, /stale/, 'forgotten, but its window has passed, so it is refused anyway');
});

test('a cache full of still-live nonces refuses a new one rather than forgetting a replayable entry', () => {
  const now = 1_790_000_000_000;
  const g = createNonceGuard({ windowMs: 60_000, max: 2, now: () => now });
  assert.equal(g.accept(randomNonce(now)).ok, true);
  assert.equal(g.accept(randomNonce(now)).ok, true);
  const full = g.accept(randomNonce(now));
  assert.equal(full.ok, false);
  assert.match(full.reason, /full/);
});

// Post-breaker residual T1: the shell and kernel share one machine clock,
// so a nonce from the future only needs a small allowance (5 s by
// default); the past keeps the full window.
test('T1: a nonce from more than 5 s in the future is refused; up to 5 s ahead and up to the full window behind are accepted', () => {
  const now = 1_790_000_000_000;
  const g = createNonceGuard({ windowMs: 120_000, now: () => now });
  assert.match(g.accept(randomNonce(now + 5_001)).reason, /stale|future/);
  assert.equal(g.accept(randomNonce(now + 5_000)).ok, true);
  assert.equal(g.accept(randomNonce(now - 120_000)).ok, true);
  assert.match(g.accept(randomNonce(now - 120_001)).reason, /stale/);
});
