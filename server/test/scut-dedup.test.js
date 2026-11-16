// Tests for SCUT inbound dedup (server/lib/scut/dedup.js). A duplicate Socket
// Mode delivery must not double-launch/steer under routing model C.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDedup } from '../lib/scut/dedup.js';

test('isNew: true the first time a key is seen, false on repeat', () => {
  const d = makeDedup();
  assert.equal(d.isNew('E1'), true);
  assert.equal(d.isNew('E1'), false);
  assert.equal(d.isNew('E2'), true);
  assert.equal(d.isNew('E2'), false);
});

test('a null/undefined key is treated as new (cannot dedup what has no id)', () => {
  const d = makeDedup();
  assert.equal(d.isNew(null), true);
  assert.equal(d.isNew(undefined), true);
});

test('stays bounded: evicts the oldest beyond max', () => {
  const d = makeDedup({ max: 2 });
  assert.equal(d.isNew('a'), true);
  assert.equal(d.isNew('b'), true);
  assert.equal(d.isNew('c'), true); // 'a' evicted (oldest)
  assert.equal(d.isNew('a'), true); // evicted -> seen as new again
  assert.equal(d.isNew('c'), false); // still remembered
});
