import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pingOutcomesFinalize } from '../lib/evaluation/outcome-finalize-ping.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('pingOutcomesFinalize POSTs the session id and resolves on success', async () => {
  let receivedPath = null;
  let receivedBody = '';
  const server = http.createServer((req, res) => {
    receivedPath = req.url;
    req.on('data', (c) => { receivedBody += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  const port = await listen(server);
  try {
    await pingOutcomesFinalize('abc123', { port });
    assert.equal(receivedPath, '/api/outcomes/finalize');
    assert.deepEqual(JSON.parse(receivedBody), { session: 'abc123' });
  } finally {
    server.close();
  }
});

test('pingOutcomesFinalize resolves (never rejects) when the server is unreachable', async () => {
  // Nothing listening on this port - ECONNREFUSED.
  await assert.doesNotReject(pingOutcomesFinalize('nosession', { port: 1 }));
});

test('pingOutcomesFinalize resolves (never rejects) when the server hangs past the timeout', async () => {
  const server = http.createServer(() => { /* never respond */ });
  const port = await listen(server);
  try {
    const start = Date.now();
    await assert.doesNotReject(pingOutcomesFinalize('slow', { port, timeoutMs: 100 }));
    assert.ok(Date.now() - start < 1000, 'should resolve promptly after the timeout, not hang');
  } finally {
    server.close();
  }
});
