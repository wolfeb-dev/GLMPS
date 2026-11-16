// Routes under test: server/lib/routes/guards-routes.js
// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-relay.test.js
// The tap agent's local relay (card glmps-2-0-runtime-37): route classes,
// forwarding with the client token, the offline queue and cache, browser
// refusal, and each guard hook's own failure handling run through the relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { relayRoute, canonicalPath, createRelay, QUEUE_FILE, REJECTED_FILE, STALE_HEADER } from '../../taps/tap-relay.js';
import { startAgent } from '../../taps/tap-agent.js';
import { awaitGate } from '../../hooks/workspace-steer.js';
import { fetchChain } from '../../hooks/lib/card-context.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { startServer } from '../server.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (p = 'mc-relay-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

// An upstream stand-in: records each request and answers with `respond`.
async function upstream(respond = () => [200, { ok: true }]) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
      const [status, body, headers = {}] = respond(req, b);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { seen, port: s.address().port, url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.close(r); s.closeAllConnections?.(); }) };
}

async function closedPort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// A relay behind its own listener, so requests travel the real HTTP path.
async function relayServer({ server, token = 'client-tok', home = mkTmp(), unavailable = null, ...opts } = {}) {
  const getUpstream = async () => (unavailable ? { unavailable } : { server: typeof server === 'function' ? server() : server, token });
  const relay = createRelay({ home, getUpstream, log: () => {}, ...opts });
  const s = http.createServer((req, res) => { relay.handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  return { relay, home, port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { s.close(r); s.closeAllConnections?.(); }) };
}

async function call(base, p, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

test('route classes: queue, cache, forward, local, and refusal of every out-of-scope route', () => {
  assert.equal(relayRoute('GET', '/tap/status'), 'local');
  for (const p of ['/api/backlog/c-1/devlog', '/api/backlog/c-1/gate', '/api/backlog/c-1/progress', '/api/outcomes/finalize']) assert.equal(relayRoute('POST', p), 'queue', p);
  for (const p of ['/api/memory/lookup', '/api/brief', '/api/state']) assert.equal(relayRoute('GET', p), 'cache', p);
  for (const [m, p] of [['GET', '/api/sessions/live'], ['GET', '/api/backlog/c-1/chain'], ['POST', '/api/control/gate'], ['POST', '/api/guards/refusal'],
    ['POST', '/api/backlog'], ['PATCH', '/api/backlog/c-1'], ['POST', '/api/backlog/c-1/merge-request']]) {
    assert.equal(relayRoute(m, p), 'forward', `${m} ${p}`);
  }
  for (const p of ['/v1/traces', '/api/otel']) assert.equal(relayRoute('POST', p), 'spool', p);
  assert.equal(relayRoute('GET', '/v1/traces'), 'refused');
  for (const [m, p] of [['POST', '/api/restart'], ['GET', '/api/config'], ['POST', '/api/config'], ['GET', '/api/budget'],
    ['GET', '/api/file'], ['POST', '/api/file'], ['POST', '/api/terminal'], ['POST', '/api/resume'], ['POST', '/api/open-in-editor'],
    ['POST', '/api/tap/pair'], ['GET', '/api/clients'], ['POST', '/api/clients/c1/revoke'], ['GET', '/'], ['GET', '/index.html'], ['DELETE', '/api/backlog/c-1']]) {
    assert.equal(relayRoute(m, p), 'refused', `${m} ${p}`);
  }
});

// Scan F6 (card glmps-2-0-runtime-106): the client token's scope includes the
// tap agent's own routes, but the agent calls those directly. Through the relay
// they would let any local account claim launches or rewrite heartbeats and mirrors.
const TAP_PRIVATE = [
  ['GET', '/api/launches'], ['GET', '/api/launches/l-1'], ['POST', '/api/launches/l-1/claim'], ['POST', '/api/launches/l-1/result'],
  ['POST', '/api/tap/heartbeat'], ['POST', '/api/tap/ingest'], ['POST', '/api/tap/git'],
  ['POST', '/api/tap/mirror/append'], ['POST', '/api/tap/mirror/snapshot'], ['GET', '/api/tap/mirror'], ['GET', '/api/tap/download/update'],
  ['HEAD', '/api/tap/mirror'], ['GET', '/api/launches/'],
];

test('tap-private routes are refused on the relay while hook and agent routes still pass', async () => {
  for (const [m, p] of TAP_PRIVATE) assert.equal(relayRoute(m, p), 'refused', `${m} ${p}`);
  assert.equal(relayRoute('GET', '/api/launchesx'), 'forward', 'only the launches routes, not a prefix match on the word');
  for (const [m, p, cls] of [['POST', '/api/backlog/c-1/devlog', 'queue'], ['POST', '/api/backlog/c-1/gate', 'queue'], ['POST', '/api/backlog/c-1/progress', 'queue'],
    ['POST', '/api/ingest/learning-gaps', 'queue'], ['POST', '/api/otel', 'spool'], ['POST', '/v1/traces', 'spool'], ['GET', '/api/memory/lookup', 'cache'],
    ['GET', '/api/brief', 'cache'], ['GET', '/api/backlog/c-1/chain', 'forward'], ['POST', '/api/control/gate', 'forward']]) {
    assert.equal(relayRoute(m, p), cls, `${m} ${p}`);
  }

  const up = await upstream();
  const r = await relayServer({ server: up.url });
  try {
    for (const [m, p] of TAP_PRIVATE.filter(([m]) => m !== 'HEAD')) {
      const res = await call(r.base, p, { method: m, body: m === 'POST' ? { x: 1 } : undefined });
      assert.equal(res.status, 403, `${m} ${p}`);
      assert.equal(res.json.error, 'relay-refused', `${m} ${p}`);
    }
    assert.equal(up.seen.length, 0, 'no tap-private request left the machine');
    const ok = await call(r.base, '/api/backlog/c-1/chain');
    assert.equal(ok.status, 200);
    assert.equal(up.seen.length, 1);
  } finally { await r.close(); await up.close(); }
});

function fakeSpool(throwWith = null) {
  const records = [];
  return { records, append(kind, payload) { if (throwWith) throw throwWith; records.push({ kind, payload }); return { seq: records.length }; } };
}

async function rawPost(base, p, body, headers) {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers, body });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

test('OTLP posts are spooled as otel records and never forwarded, paired or not', async () => {
  const up = await upstream();
  const spool = fakeSpool();
  const otlp = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'claude_code.llm_request' }] }] }] };
  for (const unavailable of [null, 'tap-unpaired']) {
    const r = await relayServer({ server: up.url, spool, unavailable });
    try {
      for (const p of ['/v1/traces', '/api/otel']) {
        const res = await rawPost(r.base, p, JSON.stringify(otlp), { 'content-type': 'application/json; charset=utf-8' });
        assert.equal(res.status, 200, p);
        assert.deepEqual(res.json, { partialSuccess: {} });
      }
      const noType = await fetch(`${r.base}/v1/traces`, { method: 'POST', body: JSON.stringify(otlp), headers: { 'content-type': '' } });
      assert.equal(noType.status, 200);
    } finally { await r.close(); }
  }
  assert.equal(spool.records.length, 6);
  assert.ok(spool.records.every((x) => x.kind === 'otel'));
  assert.deepEqual(spool.records[0].payload, otlp);
  assert.equal(up.seen.length, 0);
  await up.close();
});

test('OTLP spool answers: 415 non-JSON, 400 bad JSON, 413 oversize, 503 no spool', async () => {
  const spool = fakeSpool();
  const r = await relayServer({ server: 'http://127.0.0.1:1', spool });
  try {
    const proto = await rawPost(r.base, '/v1/traces', Buffer.from([1, 2, 3]), { 'content-type': 'application/x-protobuf' });
    assert.equal(proto.status, 415);
    assert.equal(proto.json.error, 'otlp-json-only');
    const bad = await rawPost(r.base, '/v1/traces', '{nope', { 'content-type': 'application/json' });
    assert.equal(bad.status, 400);
    assert.equal(spool.records.length, 0);
  } finally { await r.close(); }
  const big = await relayServer({ server: 'http://127.0.0.1:1', spool: fakeSpool(new RangeError('record too large')) });
  try { assert.equal((await rawPost(big.base, '/v1/traces', '{}', { 'content-type': 'application/json' })).status, 413); } finally { await big.close(); }
  const none = await relayServer({ server: 'http://127.0.0.1:1', spool: null });
  try { assert.equal((await rawPost(none.base, '/v1/traces', '{}', { 'content-type': 'application/json' })).status, 503); } finally { await none.close(); }
});

test('the agent wires its spool into the relay: an OTLP post lands as an otel record', async () => {
  const home = mkTmp();
  const agent = await startAgent({ home, port: 0, homeDir: mkTmp(), intervalMs: 3_600_000, log: () => {} });
  try {
    const res = await rawPost(`http://127.0.0.1:${agent.address.port}`, '/v1/traces', JSON.stringify({ resourceSpans: [] }), { 'content-type': 'application/json' });
    assert.equal(res.status, 200);
    const [rec] = agent.spool.readBatch();
    assert.equal(rec.kind, 'otel');
    assert.deepEqual(rec.payload, { resourceSpans: [] });
  } finally { await agent.close(); }
});

test('non-canonical paths are refused before the scope check', () => {
  for (const p of ['/api/backlog/x/../../restart', '/api/./state', '//api/state', '/api\\state', '/api/backlog/x%2f..%2frestart', '/api/%2e%2e/restart', '/api/%zz', 'api/state']) {
    assert.equal(canonicalPath(p), false, p);
    assert.equal(relayRoute('GET', p), 'refused', p);
  }
  assert.equal(canonicalPath('/api/memory/lookup'), true);
  assert.equal(canonicalPath('/api/backlog/glmps-2-0-runtime-37/devlog'), true);
});

test('forwards with the client token and protocol header, strips the caller credentials, passes the body, query and status', async () => {
  const up = await upstream((req) => [201, { got: req.url }, { 'set-cookie': 'a=b', 'x-extra': 'kept' }]);
  const r = await relayServer({ server: up.url });
  try {
    const res = await call(r.base, '/api/backlog?project=p', { method: 'POST', body: { title: 't' }, headers: { authorization: 'Bearer dashboard-token', 'x-glmps-token': 'shared', cookie: 'mc=1', 'x-glmps-local-session': 'k' } });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { got: '/api/backlog?project=p' });
    assert.equal(res.headers.get('x-extra'), 'kept');
    assert.equal(res.headers.get('set-cookie'), null);
    const s = up.seen[0];
    assert.equal(s.headers.authorization, 'Bearer client-tok');
    assert.equal(s.headers['x-glmps-tap-protocol'], '1');
    for (const h of ['x-glmps-token', 'cookie', 'x-glmps-local-session']) assert.equal(s.headers[h], undefined, h);
    assert.deepEqual(JSON.parse(s.body), { title: 't' });
  } finally { await r.close(); await up.close(); }
});

test('admin routes answer 403 and never open a connection upstream', async () => {
  const up = await upstream();
  const r = await relayServer({ server: up.url });
  try {
    for (const [m, p] of [['POST', '/api/restart'], ['GET', '/api/config'], ['POST', '/api/tap/pair'], ['GET', '/api/file?path=C:/x'], ['GET', '/']]) {
      const res = await call(r.base, p, { method: m, body: m === 'POST' ? {} : undefined });
      assert.equal(res.status, 403, `${m} ${p}`);
      assert.equal(res.json.error, 'relay-refused');
    }
    assert.equal(up.seen.length, 0);
  } finally { await r.close(); await up.close(); }
});

test('browser requests are refused: a foreign Host, an Origin, or a Sec-Fetch-Site header', async () => {
  const up = await upstream();
  const r = await relayServer({ server: up.url });
  try {
    for (const headers of [{ host: 'evil.example:' + r.port }, { origin: 'http://evil.example' }, { origin: `http://127.0.0.1:${r.port}` }, { 'sec-fetch-site': 'cross-site' }]) {
      const res = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: r.port, path: '/api/brief', headers }, (x) => { let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => resolve({ status: x.statusCode, json: JSON.parse(b) })); }).on('error', reject);
      });
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.equal(res.json.reason, 'browser-request');
    }
    assert.equal(up.seen.length, 0);
    assert.equal((await call(r.base, '/api/brief')).status, 200, 'node fetch (sec-fetch-mode only) passes');
  } finally { await r.close(); await up.close(); }
});

test('server unreachable: board writes queue with 202, other routes answer 503, never 404', async () => {
  const r = await relayServer({ server: `http://127.0.0.1:${await closedPort()}` });
  try {
    const q = await call(r.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { by: 'agent', text: 'one' } });
    assert.equal(q.status, 202);
    assert.deepEqual(q.json, { ok: true, queued: true, relay: true });
    for (const [m, p] of [['GET', '/api/sessions/live'], ['GET', '/api/backlog/c-1/chain'], ['POST', '/api/backlog'], ['POST', '/api/control/gate'], ['GET', '/api/brief']]) {
      const res = await call(r.base, p, { method: m, body: m === 'POST' ? {} : undefined });
      assert.equal(res.status, 503, `${m} ${p}`);
      assert.equal(res.json.error, 'server-unreachable');
    }
    assert.equal(r.relay.status().queueDepth, 1);
    assert.equal(r.relay.status().offline, true);
    assert.match(r.relay.status().lastError, /unreachable/);
  } finally { await r.close(); }
});

test('the queue survives a restart and drains in order once the server is back', async () => {
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const home = mkTmp();
  const r1 = await relayServer({ server: dead, home });
  for (const t of ['a', 'b']) await call(r1.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { text: t } });
  await call(r1.base, '/api/backlog/c-1/gate', { method: 'POST', body: { status: 'PASS' } });
  await r1.close();
  assert.equal(fs.readFileSync(path.join(home, QUEUE_FILE), 'utf8').trim().split('\n').length, 3);

  const up = await upstream(() => [200, { ok: true }]);
  const r2 = await relayServer({ server: up.url, home });
  try {
    assert.equal(r2.relay.queueDepth(), 3, 'reloaded from disk');
    assert.equal(await r2.relay.drain(), 3);
    assert.deepEqual(up.seen.map((s) => [s.url, JSON.parse(s.body)]), [
      ['/api/backlog/c-1/devlog', { text: 'a' }], ['/api/backlog/c-1/devlog', { text: 'b' }], ['/api/backlog/c-1/gate', { status: 'PASS' }]]);
    assert.ok(up.seen.every((s) => s.headers.authorization === 'Bearer client-tok' && s.headers['content-type'] === 'application/json'));
    assert.equal(r2.relay.queueDepth(), 0);
    assert.equal(fs.readFileSync(path.join(home, QUEUE_FILE), 'utf8'), '');
  } finally { await r2.close(); await up.close(); }
});

test('the hook ingest writes are queue-class: queued offline with 202, replayed in order after reconnect', async () => {
  const INGEST = ['/api/ingest/learning-gaps', '/api/ingest/backlog-ticket', '/api/ingest/decision-log', '/api/ingest/qa-trends'];
  for (const p of INGEST) assert.equal(relayRoute('POST', p), 'queue', p);
  assert.equal(relayRoute('GET', '/api/ingest/qa-trends'), 'forward', 'only the POST is queued');

  const dead = `http://127.0.0.1:${await closedPort()}`;
  const home = mkTmp();
  const r1 = await relayServer({ server: dead, home });
  for (const [i, p] of INGEST.entries()) {
    const q = await call(r1.base, p, { method: 'POST', body: { n: i } });
    assert.equal(q.status, 202, p);
    assert.deepEqual(q.json, { ok: true, queued: true, relay: true });
  }
  await r1.close();

  const up = await upstream(() => [200, { ok: true }]);
  const r2 = await relayServer({ server: up.url, home });
  try {
    assert.equal(r2.relay.queueDepth(), 4, 'reloaded from disk');
    assert.equal(await r2.relay.drain(), 4);
    assert.deepEqual(up.seen.map((s) => [s.url, JSON.parse(s.body).n]), INGEST.map((p, i) => [p, i]));
    assert.equal(r2.relay.queueDepth(), 0);
  } finally { await r2.close(); await up.close(); }
});

test('while records are queued, a new board write goes behind them so order holds', async () => {
  let live = false;
  const up = await upstream(() => [200, { ok: true }]);
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const r = await relayServer({ server: () => (live ? up.url : dead), offlineHoldMs: 0 });
  try {
    await call(r.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { text: 'first' } });
    live = true;
    const second = await call(r.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { text: 'second' } });
    assert.equal(second.status, 202);
    await waitFor(() => up.seen.length === 2, { message: 'both drained' });
    assert.deepEqual(up.seen.map((s) => JSON.parse(s.body).text), ['first', 'second']);
  } finally { await r.close(); await up.close(); }
});

test('drain keeps a record on 5xx and 401, drops and logs it on 400', async () => {
  const home = mkTmp();
  let answer = 503;
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const up = await upstream(() => [answer, { error: 'x' }]);
  let live = false;
  const r = await relayServer({ server: () => (live ? up.url : dead), home, offlineHoldMs: 0 });
  try {
    await call(r.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { text: 'keep' } });
    live = true;
    assert.equal(await r.relay.drain(), 0); assert.equal(r.relay.queueDepth(), 1, 'kept on 503');
    answer = 401;
    assert.equal(await r.relay.drain(), 0); assert.equal(r.relay.queueDepth(), 1, 'kept on 401');
    answer = 400;
    assert.equal(await r.relay.drain(), 1); assert.equal(r.relay.queueDepth(), 0, 'dropped on 400');
    const rejected = fs.readFileSync(path.join(home, REJECTED_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].status, 400);
    assert.equal(rejected[0].path, '/api/backlog/c-1/devlog');
    assert.equal(JSON.stringify(rejected).includes('client-tok'), false, 'no token in the log');
  } finally { await r.close(); await up.close(); }
});

test('a board write while unpaired, or answered 401, is queued; the token never reaches the queue file', async () => {
  const home = mkTmp();
  const r1 = await relayServer({ unavailable: 'tap-unpaired', home });
  assert.equal((await call(r1.base, '/api/backlog/c-1/progress', { method: 'POST', body: { plan: 'p' } })).status, 202);
  assert.equal((await call(r1.base, '/api/backlog/c-1/chain')).json.error, 'tap-unpaired');
  await r1.close();
  const up = await upstream(() => [401, { error: 'unauthorized' }]);
  const r2 = await relayServer({ server: up.url, home });
  try {
    // The reloaded record is ahead, so this one queues behind it without a forward; drain then meets the 401.
    assert.equal((await call(r2.base, '/api/backlog/c-1/gate', { method: 'POST', body: { status: 'PASS' } })).status, 202);
    await r2.relay.drain();
    assert.equal(r2.relay.queueDepth(), 2);
    assert.equal(fs.readFileSync(path.join(home, QUEUE_FILE), 'utf8').includes('client-tok'), false);
  } finally { await r2.close(); await up.close(); }
});

test('a fresh 401 on a direct board write queues it', async () => {
  const up = await upstream(() => [401, { error: 'unauthorized' }]);
  const r = await relayServer({ server: up.url });
  try {
    assert.equal((await call(r.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { text: 'x' } })).status, 202);
    assert.equal(up.seen.length, 1);
    assert.equal(r.relay.queueDepth(), 1);
    assert.equal((await call(r.base, '/api/backlog/c-1/chain')).status, 401, 'reads pass the 401 through');
  } finally { await r.close(); await up.close(); }
});

test('a failure after the request was sent answers 502 and is not queued', async () => {
  const s = http.createServer((req) => { req.on('data', () => {}); req.on('end', () => req.socket.destroy()); });
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const r = await relayServer({ server: `http://127.0.0.1:${s.address().port}` });
  try {
    const res = await call(r.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { text: 'maybe-applied' } });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'relay-forward-failed');
    assert.equal(r.relay.queueDepth(), 0);
  } finally { await r.close(); await new Promise((res) => s.close(res)); }
});

test('the queue cap answers 503 relay-queue-full instead of dropping', async () => {
  const r = await relayServer({ server: `http://127.0.0.1:${await closedPort()}`, queueCapBytes: 400 });
  try {
    assert.equal((await call(r.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { text: 'x'.repeat(100) } })).status, 202);
    const full = await call(r.base, '/api/backlog/c-1/devlog', { method: 'POST', body: { text: 'y'.repeat(300) } });
    assert.equal(full.status, 503);
    assert.equal(full.json.error, 'relay-queue-full');
    assert.equal(r.relay.queueDepth(), 1);
  } finally { await r.close(); }
});

test('context injector reads are cached by path and query and served stale while offline', async () => {
  let live = true;
  const up = await upstream((req) => [200, { brief: req.url }]);
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const r = await relayServer({ server: () => (live ? up.url : dead), offlineHoldMs: 0 });
  try {
    const fresh = await call(r.base, '/api/memory/lookup?q=a&k=3');
    assert.equal(fresh.headers.get(STALE_HEADER), null);
    await call(r.base, '/api/brief');
    await call(r.base, '/api/sessions/live');
    live = false;
    const stale = await call(r.base, '/api/memory/lookup?q=a&k=3');
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.json, { brief: '/api/memory/lookup?q=a&k=3' });
    assert.match(stale.headers.get(STALE_HEADER), /^\d+$/);
    assert.equal((await call(r.base, '/api/brief')).headers.get(STALE_HEADER) !== null, true);
    assert.equal((await call(r.base, '/api/memory/lookup?q=other')).status, 503, 'a miss is 503');
    assert.equal((await call(r.base, '/api/sessions/live')).status, 503, 'the guard-shared live list is never served stale');
    assert.equal(r.relay.status().cacheEntries, 2);
  } finally { await r.close(); await up.close(); }
});

test('after one unreachable result the relay answers offline at once, and online() clears it', async () => {
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const up = await upstream();
  let live = false;
  const r = await relayServer({ server: () => (live ? up.url : dead), offlineHoldMs: 60_000 });
  try {
    assert.equal((await call(r.base, '/api/brief')).status, 503);
    live = true;
    assert.equal((await call(r.base, '/api/brief')).status, 503, 'held offline');
    assert.equal(up.seen.length, 0);
    r.relay.online();
    assert.equal((await call(r.base, '/api/brief')).status, 200);
  } finally { await r.close(); await up.close(); }
});

test('guard postures through the relay with the server down match today', async () => {
  const r = await relayServer({ server: `http://127.0.0.1:${await closedPort()}`, offlineHoldMs: 0 });
  try {
    // workspace-steer: fails open.
    const gate = await awaitGate({ port: r.port, sessionId: 's1', tool: 'Bash', summary: 'x', deadlineMs: 50 });
    assert.equal(gate.permissionDecision, 'allow');
    // plan-gate and test-file-guard: unavailable (fail open and logged), never "unknown card".
    const chain = await fetchChain('c-1', { port: r.port, timeoutMs: 5000 });
    assert.equal(chain.unknownCard, undefined);
    assert.match(chain.unavailable, /HTTP 503/);
    // push-lease-guard and concurrency-warn read !res.ok as unknown liveness.
    const live = await fetch(`${r.base}/api/sessions/live`);
    assert.equal(live.ok, false);
  } finally { await r.close(); }
});

test('end to end: the agent relays a new card and a devlog into a real server', async () => {
  const tmp = mkTmp('mc-relay-srv-');
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  const home = mkTmp('mc-relay-home-');
  let agent;
  try {
    const { clientId, token } = store.pair({ name: 'laptop', actor: 'test' });
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: `http://127.0.0.1:${srv.port}`, clientId, name: 'laptop' }));
    agent = await startAgent({ home, port: 0, homeDir: mkTmp(), intervalMs: 3_600_000, log: () => {}, readToken: () => token });
    await agent.ready;
    const base = `http://127.0.0.1:${agent.address.port}`;
    const card = await call(base, '/api/backlog', { method: 'POST', body: { title: 'relay e2e', prompt: 'p', project: 'relay-test' } });
    assert.ok(card.status === 200 || card.status === 201, card.text);
    const id = card.json.id ?? card.json.item?.id;
    assert.ok(id, card.text);
    const dl = await call(base, `/api/backlog/${id}/devlog`, { method: 'POST', body: { by: 'agent', text: 'via relay' } });
    assert.ok(dl.status < 300, dl.text);
    const after = await call(`http://127.0.0.1:${srv.port}`, `/api/backlog/${id}`);
    assert.match(after.text, /via relay/);
    const st = await call(base, '/tap/status');
    assert.equal(st.json.state, 'paired');
    assert.equal(st.json.relay.queueDepth, 0);
    assert.equal(st.text.includes(token), false);
  } finally { await agent?.close(); store.closeDb(); await srv.close(); }
});
