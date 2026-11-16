// server/test/tap-shipper.test.js
// The tap's shipper (server-and-client-tap task 9) against a fake server:
// batching, ack from the server's high-water mark, the backoff ladder, and the
// 401/426 stop that keeps the spool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShipper, nextBackoffMs, ingestRequest, BACKOFF_MIN_MS, BACKOFF_MAX_MS, INGEST_PATH } from '../../taps/tap-shipper.js';
import { openSpool } from '../../taps/tap-spool.js';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkSpool = (opts = {}) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapship-')); tmpDirs.push(d); return openSpool({ dir: d, now: () => 1000, ...opts }); };
const CREDS = { config: { server: 'http://100.64.0.1:8123' }, token: 'tok' };

// A fake server holding its own high-water mark, like the real route.
function fakeServer() {
  const f = { hw: 0, seen: [], mode: 'ok' };
  f.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    f.seen.push({ url, headers: init.headers, body });
    if (f.mode === 'down') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (typeof f.mode === 'number') return { status: f.mode, json: async () => ({}) };
    let accepted = 0; let duplicates = 0;
    for (const r of body.records) { if (r.seq <= f.hw) duplicates++; else { f.hw = r.seq; accepted++; } }
    return { status: 200, json: async () => ({ ok: true, accepted, duplicates, highWater: f.hw }) };
  };
  return f;
}

test('the backoff ladder is 1 s doubling to 5 minutes', () => {
  assert.equal(BACKOFF_MIN_MS, 1000);
  assert.equal(BACKOFF_MAX_MS, 300_000);
  const ladder = [0];
  for (let i = 0; i < 12; i++) ladder.push(nextBackoffMs(ladder.at(-1)));
  assert.deepEqual(ladder.slice(1), [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000]);
});

test('ingestRequest carries the token and protocol header, and no client id', () => {
  const r = ingestRequest({ config: CREDS.config, token: 'tok', records: [], spool: { depth: 0 } });
  assert.equal(r.url, `http://100.64.0.1:8123${INGEST_PATH}`);
  assert.equal(r.headers.authorization, 'Bearer tok');
  assert.equal(r.headers[TAP_PROTOCOL_HEADER], '1');
  assert.deepEqual(Object.keys(JSON.parse(r.body)).sort(), ['records', 'spool']);
});

test('an empty spool sends nothing', async () => {
  const f = fakeServer();
  const sh = createShipper({ spool: mkSpool(), getCreds: () => CREDS, fetch: f.fetch, log: () => {} });
  assert.deepEqual(await sh.tick(), { idle: true });
  assert.equal(f.seen.length, 0);
});

test('a batch ships, the server mark is acked, and the spool drains', async () => {
  const f = fakeServer();
  const spool = mkSpool();
  for (let i = 0; i < 3; i++) spool.append('hook', { i });
  const sh = createShipper({ spool, getCreds: () => CREDS, fetch: f.fetch, log: () => {} });
  const r = await sh.tick();
  assert.equal(r.shipped, true);
  assert.equal(r.accepted, 3);
  assert.equal(spool.stats().depth, 0);
  assert.deepEqual(f.seen[0].body.spool, { depth: 3, bytes: f.seen[0].body.spool.bytes, full: false, dropped: 0 });
  assert.deepEqual(await sh.tick(), { idle: true });
});

test('no credentials (unconfigured or unpaired) ships nothing', async () => {
  const f = fakeServer();
  const spool = mkSpool(); spool.append('hook', 1);
  const sh = createShipper({ spool, getCreds: () => null, fetch: f.fetch, log: () => {} });
  assert.deepEqual(await sh.tick(), { skipped: 'no-credentials' });
  assert.equal(f.seen.length, 0);
});

test('a failure backs off on the ladder, holds until due, and a success resets it', async () => {
  const f = fakeServer(); f.mode = 'down';
  let t = 0;
  const spool = mkSpool(); spool.append('hook', 1);
  const sh = createShipper({ spool, getCreds: () => CREDS, fetch: f.fetch, now: () => t, log: () => {} });
  assert.equal((await sh.tick()).backoffMs, 1000);
  assert.deepEqual(await sh.tick(), { skipped: 'backoff' });
  t = 1000; assert.equal((await sh.tick()).backoffMs, 2000);
  t = 2999; assert.deepEqual(await sh.tick(), { skipped: 'backoff' });
  t = 3000; f.mode = 503; assert.equal((await sh.tick()).backoffMs, 4000);
  assert.equal(sh.status().state, 'backoff');
  assert.match(sh.status().lastError, /503/);
  t = 7000; f.mode = 'ok';
  assert.equal((await sh.tick()).shipped, true);
  assert.deepEqual([sh.status().state, sh.status().backoffMs, sh.status().lastError], ['ok', 0, null]);
  assert.equal(spool.stats().depth, 0, 'the record that failed three times landed once');
});

test('a lost answer is replayed and the server drops the duplicate', async () => {
  const f = fakeServer();
  const spool = mkSpool(); spool.append('hook', 1); spool.append('hook', 2);
  // The server stores the batch but the answer never arrives.
  const lossy = async (url, init) => { await f.fetch(url, init); throw new Error('socket hang up'); };
  let t = 0;
  const sh = createShipper({ spool, getCreds: () => CREDS, fetch: lossy, now: () => t, log: () => {} });
  assert.equal((await sh.tick()).shipped, false);
  assert.equal(spool.stats().depth, 2, 'nothing acked without an answer');
  const sh2 = createShipper({ spool, getCreds: () => CREDS, fetch: f.fetch, log: () => {} });
  const r = await sh2.tick();
  assert.deepEqual([r.accepted, r.duplicates], [0, 2]);
  assert.equal(spool.stats().depth, 0);
});

test('401 and 426 stop shipping and keep the spool; resume ships it', async () => {
  for (const [code, state] of [[401, 'unpaired'], [426, 'protocol-too-old']]) {
    const f = fakeServer(); f.mode = code;
    const spool = mkSpool(); spool.append('hook', 1);
    const sh = createShipper({ spool, getCreds: () => CREDS, fetch: f.fetch, log: () => {} });
    assert.deepEqual(await sh.tick(), { shipped: false, stopped: state });
    assert.deepEqual(await sh.tick(), { skipped: state });
    assert.equal(sh.status().state, state);
    assert.equal(spool.stats().depth, 1);
    f.mode = 'ok'; sh.resume();
    assert.equal((await sh.tick()).shipped, true);
  }
});

test('a paired heartbeat does not reset the ladder when ingest is failing, only a stop', async () => {
  const f = fakeServer(); f.mode = 503;
  let t = 0;
  const spool = mkSpool(); spool.append('hook', 1);
  const sh = createShipper({ spool, getCreds: () => CREDS, fetch: f.fetch, now: () => t, log: () => {} });
  assert.equal((await sh.tick()).backoffMs, 1000);
  t = 1000; assert.equal((await sh.tick()).backoffMs, 2000);
  sh.resume();
  assert.deepEqual(await sh.tick(), { skipped: 'backoff' });
  t = 3000; assert.equal((await sh.tick()).backoffMs, 4000);
});

test('a full spool is reported even with nothing to ship, and the cleared state is reported once', async () => {
  const f = fakeServer();
  const spool = mkSpool({ cap: 50 });
  spool.append('hook', 'p'.repeat(60));
  assert.deepEqual(spool.append('status', 1), { dropped: true });
  const sh = createShipper({ spool, getCreds: () => CREDS, fetch: f.fetch, log: () => {} });
  assert.equal((await sh.tick()).shipped, true);
  assert.equal(f.seen[0].body.spool.full, true);
  assert.equal(f.seen[0].body.spool.dropped, 1);
  // Acked, under the cap, drops reported: the next tick tells the server the episode is over.
  assert.equal(spool.stats().full, false);
  assert.equal((await sh.tick()).shipped, true);
  assert.deepEqual([f.seen[1].body.records, f.seen[1].body.spool.full], [[], false]);
  assert.deepEqual(await sh.tick(), { idle: true });
});

test('batches stay under the 1 MiB ingest cap', async () => {
  const f = fakeServer();
  const spool = mkSpool();
  for (let i = 0; i < 30; i++) spool.append('hook', 'p'.repeat(100_000));
  const sh = createShipper({ spool, getCreds: () => CREDS, fetch: f.fetch, log: () => {} });
  while (!(await sh.tick()).idle) { /* drain */ }
  assert.ok(f.seen.length >= 3);
  for (const s of f.seen) assert.ok(Buffer.byteLength(JSON.stringify(s.body)) <= 1024 * 1024);
  assert.equal(f.hw, spool.stats().lastSeq);
});
