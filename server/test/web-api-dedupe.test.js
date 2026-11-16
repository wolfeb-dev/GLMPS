// server/test/web-api-dedupe.test.js
// Card glmps-2-0-53 phase 1, P2: same-origin /api GETs share one request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGetDeduper, isDedupableGet } from '../../web/shared/api.js';

function fakeFetch() {
  const calls = [];
  const impl = (url) => {
    calls.push(url);
    return Promise.resolve(new Response(JSON.stringify({ url, n: calls.length }), { status: 200 }));
  };
  return { impl, calls };
}

test('concurrent GETs of one URL make one request and each caller can read the body', async () => {
  const f = fakeFetch();
  const get = createGetDeduper(f.impl);
  const [a, b, c] = await Promise.all([get('http://x/api/backlog'), get('http://x/api/backlog'), get('http://x/api/backlog')]);
  assert.equal(f.calls.length, 1);
  for (const r of [a, b, c]) assert.deepEqual(await r.json(), { url: 'http://x/api/backlog', n: 1 });
});

test('a finished response is reused inside the ttl and refetched after it', async () => {
  let t = 0;
  const f = fakeFetch();
  const get = createGetDeduper(f.impl, { ttlMs: 1000, now: () => t });
  await get('http://x/api/alerts');
  t = 999; await get('http://x/api/alerts');
  assert.equal(f.calls.length, 1);
  t = 1000; await get('http://x/api/alerts');
  assert.equal(f.calls.length, 2);
});

test('failed requests and error statuses are never cached', async () => {
  let fail = true;
  const calls = [];
  const get = createGetDeduper((url) => { calls.push(url); return fail ? Promise.reject(new Error('down')) : Promise.resolve(new Response('{}', { status: 503 })); });
  await assert.rejects(get('http://x/api/state'));
  fail = false;
  const r = await get('http://x/api/state');
  assert.equal(r.status, 503);
  await get('http://x/api/state');
  assert.equal(calls.length, 3);
});

test('clear() drops finished responses so the next GET goes out', async () => {
  const f = fakeFetch();
  const get = createGetDeduper(f.impl, { ttlMs: 5000 });
  await get('http://x/api/alerts');
  await get('http://x/api/alerts');
  assert.equal(f.calls.length, 1);
  get.clear();
  await get('http://x/api/alerts');
  assert.equal(f.calls.length, 2);
});

test('only same-origin /api GETs are de-duplicated, never the event stream or a mutation', () => {
  const o = 'http://127.0.0.1:8123/now';
  assert.equal(isDedupableGet('/api/backlog', {}, o), true);
  assert.equal(isDedupableGet('/api/backlog?counts=1', { method: 'get' }, o), true);
  assert.equal(isDedupableGet('/api/events', {}, o), false);
  assert.equal(isDedupableGet('/api/backlog', { method: 'POST', body: '{}' }, o), false);
  assert.equal(isDedupableGet('/api/state', { cache: 'no-store' }, o), false);
  assert.equal(isDedupableGet('/vendor/d3.min.js', {}, o), false);
  assert.equal(isDedupableGet('https://other.example/api/x', {}, o), false);
  assert.equal(isDedupableGet(new Request('http://127.0.0.1:8123/api/x'), {}, o), false);
});
