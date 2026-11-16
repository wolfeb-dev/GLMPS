import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkHealth } from '../src/lib/health-client.js';

const reply = (status, json) => async () => ({ status, json: async () => { if (json instanceof Error) throw json; return json; } });

test('200 with status up is ok and returns the body; the URL is <kernel>/healthz', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, hasSignal: Boolean(opts.signal) }; return reply(200, { status: 'up', open_obligations: 1 })(); };
  const r = await checkHealth({ kernelUrl: 'http://127.0.0.1:8124/', fetchImpl });
  assert.deepEqual(r, { ok: true, body: { status: 'up', open_obligations: 1 } });
  assert.deepEqual(seen, { url: 'http://127.0.0.1:8124/healthz', hasSignal: true });
});

test('degraded is still an answering kernel', async () => {
  assert.equal((await checkHealth({ kernelUrl: 'http://x/', fetchImpl: reply(200, { status: 'degraded' }) })).ok, true);
});

test('each failure has a named reason', async () => {
  assert.deepEqual(await checkHealth({ kernelUrl: 'http://x/', fetchImpl: reply(503, {}) }), { ok: false, reason: 'http-503' });
  assert.deepEqual(await checkHealth({ kernelUrl: 'http://x/', fetchImpl: reply(200, { ok: true }) }), { ok: false, reason: 'bad-body' });
  assert.deepEqual(await checkHealth({ kernelUrl: 'http://x/', fetchImpl: reply(200, new SyntaxError('bad json')) }), { ok: false, reason: 'bad-body' });
  const timeout = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
  assert.deepEqual(await checkHealth({ kernelUrl: 'http://x/', fetchImpl: timeout }), { ok: false, reason: 'timeout' });
  const refused = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await checkHealth({ kernelUrl: 'http://x/', fetchImpl: refused }), { ok: false, reason: 'unreachable' });
});

test('against a real server: up while listening, unreachable after close', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"up"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const kernelUrl = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await checkHealth({ kernelUrl })).ok, true);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  assert.deepEqual(await checkHealth({ kernelUrl }), { ok: false, reason: 'unreachable' });
});

test('tcpAccepts is true for a listening port and false for a closed one', async () => {
  const { tcpAccepts } = await import('../src/lib/health-client.js');
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await tcpAccepts({ kernelUrl: `http://127.0.0.1:${port}/` }), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await tcpAccepts({ kernelUrl: `http://127.0.0.1:${port}/` }), false);
});

// Card glmps-2-0-214: the GLMPS Tap's relay holds 127.0.0.1:8123 on a client
// machine and answers /healthz with 403, which once read as this app's own
// slow kernel. identifyPortHolder names it from the agent's own status route.
test('identifyPortHolder names the GLMPS Tap from /tap/status, and anything else as other', async () => {
  const { identifyPortHolder } = await import('../src/lib/health-client.js');
  let seen = null;
  const tap = async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({ agent: 'glmps-tap', version: '0.1.0' }) }; };
  assert.equal(await identifyPortHolder({ kernelUrl: 'http://127.0.0.1:8123/', fetchImpl: tap }), 'tap');
  assert.equal(seen, 'http://127.0.0.1:8123/tap/status');
  assert.equal(await identifyPortHolder({ kernelUrl: 'http://x/', fetchImpl: reply(404, { error: 'nope' }) }), 'other');
  assert.equal(await identifyPortHolder({ kernelUrl: 'http://x/', fetchImpl: reply(200, { agent: 'something-else' }) }), 'other');
  assert.equal(await identifyPortHolder({ kernelUrl: 'http://x/', fetchImpl: async () => { throw new TypeError('fetch failed'); } }), 'other');
});

test('against a relay-shaped server: /healthz is http-403 and the holder is the tap', async () => {
  const { identifyPortHolder } = await import('../src/lib/health-client.js');
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/tap/status' ? 200 : 403, { 'content-type': 'application/json' });
    res.end(req.url === '/tap/status' ? '{"agent":"glmps-tap"}' : '{"error":"relay-refused"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const kernelUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await checkHealth({ kernelUrl }), { ok: false, reason: 'http-403' });
    assert.equal(await identifyPortHolder({ kernelUrl }), 'tap');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
