import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwrMemo } from '../lib/surface/swr-memo.js';

test('the first call waits for the value; later calls answer from the memo', async () => {
  let n = 0; const t = 0;
  const get = createSwrMemo(async () => ++n, { maxAgeMs: 1000, now: () => t });
  assert.equal(await get(), 1);
  assert.equal(await get(), 1);
  assert.equal(n, 1);
});

test('an aged memo answers its last value at once and refreshes once behind it', async () => {
  let n = 0; let t = 0; let release;
  const get = createSwrMemo(() => { n++; if (n === 1) return 'first'; return new Promise((r) => { release = r; }); }, { maxAgeMs: 1000, now: () => t });
  assert.equal(await get(), 'first');
  t = 5000;
  assert.equal(await get(), 'first');
  assert.equal(await get(), 'first');
  assert.equal(n, 2, 'one refresh in flight, not one per call');
  release('second');
  await new Promise((r) => setImmediate(r));
  assert.equal(await get(), 'second');
});

test('a failed refresh keeps the last value', async () => {
  let n = 0; let t = 0;
  const get = createSwrMemo(async () => { n++; if (n > 1) throw new Error('git failed'); return 'kept'; }, { maxAgeMs: 10, now: () => t });
  assert.equal(await get(), 'kept');
  t = 100;
  assert.equal(await get(), 'kept');
  await new Promise((r) => setImmediate(r));
  assert.equal(await get(), 'kept');
});

test('a failed first measurement rejects, so the route can report it', async () => {
  const get = createSwrMemo(async () => { throw new Error('no residency'); }, { maxAgeMs: 10 });
  await assert.rejects(get(), /no residency/);
});
