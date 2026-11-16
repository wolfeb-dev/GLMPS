import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pingMemoryDistill } from '../lib/evaluation/memory-distill-ping.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('pingMemoryDistill POSTs the session/transcript/cwd and resolves on success', async () => {
  let receivedPath = null;
  let receivedBody = '';
  const server = http.createServer((req, res) => {
    receivedPath = req.url;
    req.on('data', (c) => { receivedBody += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"queued":true}'); });
  });
  const port = await listen(server);
  try {
    await pingMemoryDistill('abc123', '/path/to/transcript.jsonl', '/path/to/cwd', { port });
    assert.equal(receivedPath, '/api/memory/distill');
    assert.deepEqual(JSON.parse(receivedBody), {
      sessionId: 'abc123',
      transcriptPath: '/path/to/transcript.jsonl',
      cwd: '/path/to/cwd',
    });
  } finally {
    server.close();
  }
});

test('pingMemoryDistill resolves (never rejects) when the server is unreachable', async () => {
  // Nothing listening on this port - ECONNREFUSED.
  await assert.doesNotReject(pingMemoryDistill('nosession', '/t', '/c', { port: 1 }));
});

test('pingMemoryDistill resolves (never rejects) against a closed port', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  await assert.doesNotReject(pingMemoryDistill('closedport', '/t', '/c', { port }));
});

test('pingMemoryDistill resolves (never rejects) when the server hangs past the timeout', async () => {
  const server = http.createServer(() => { /* never respond */ });
  const port = await listen(server);
  try {
    const start = Date.now();
    await assert.doesNotReject(pingMemoryDistill('slow', '/t', '/c', { port, timeoutMs: 100 }));
    assert.ok(Date.now() - start < 1000, 'should resolve promptly after the timeout, not hang');
  } finally {
    server.close();
  }
});
