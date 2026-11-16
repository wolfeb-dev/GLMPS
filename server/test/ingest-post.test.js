import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { postIngest } from '../lib/ingest-post.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

test('postIngest POSTs the JSON body and reports sent with the status', async () => {
  let got = null;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got = { url: req.url, method: req.method, body: b }; res.writeHead(200); res.end('{}'); });
  });
  const port = await listen(server);
  try {
    const r = await postIngest('/api/ingest/qa-trends', { point: { ts: 1 } }, { port });
    assert.deepEqual(r, { sent: true, status: 200 });
    assert.equal(got.url, '/api/ingest/qa-trends');
    assert.equal(got.method, 'POST');
    assert.deepEqual(JSON.parse(got.body), { point: { ts: 1 } });
  } finally { server.close(); }
});

test('postIngest reports not sent when the connection is refused (the caller falls back)', async () => {
  const r = await postIngest('/api/ingest/qa-trends', {}, { port: await freePort() });
  assert.deepEqual(r, { sent: false });
});

test('postIngest counts an HTTP error answer as sent (no fallback: the server got it)', async () => {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(400); res.end('{"error":"bad"}'); });
  const port = await listen(server);
  try {
    assert.deepEqual(await postIngest('/api/ingest/x', {}, { port }), { sent: true, status: 400 });
  } finally { server.close(); }
});

test('postIngest counts a hang after connect as sent and returns after the timeout', async () => {
  const server = http.createServer(() => { /* never answer */ });
  const port = await listen(server);
  try {
    const start = Date.now();
    const r = await postIngest('/api/ingest/x', {}, { port, timeoutMs: 100 });
    assert.deepEqual(r, { sent: true, status: null });
    assert.ok(Date.now() - start < 1500);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('postIngest never throws on an unserializable body and reports not sent', async () => {
  const cyc = {}; cyc.self = cyc;
  assert.deepEqual(await postIngest('/api/ingest/x', cyc, { port: await freePort() }), { sent: false });
});
