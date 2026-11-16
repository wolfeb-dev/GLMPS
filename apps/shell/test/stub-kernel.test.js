// apps/shell/test/stub-kernel.test.js
// Card glmps-2-0-runtime-133, review finding 6: when the smoke stub cannot
// re-bind the kernel port, /__stub/up must answer with the error instead of
// leaving the request hanging and the stub claiming to be healthy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStubKernel } from '../smoke/stub-kernel.mjs';

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

test('stub kernel: a failed re-bind answers /__stub/up with a 500 and stays down; a later up works', async () => {
  const stub = await startStubKernel();
  const port = Number(new URL(stub.url).port);
  const blocker = http.createServer((req, res) => { res.writeHead(418); res.end(); });
  try {
    assert.equal((await fetch(`${stub.controlUrl}/__stub/down`)).status, 204);
    await listen(blocker, port);

    const r = await fetch(`${stub.controlUrl}/__stub/up`, { signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 500);
    assert.match(await r.text(), /EADDRINUSE/);

    await new Promise((resolve) => blocker.close(resolve));
    assert.equal((await fetch(`${stub.controlUrl}/__stub/up`, { signal: AbortSignal.timeout(5000) })).status, 204, 'still down, so a retry re-binds');
    assert.equal((await fetch(`${stub.url}/healthz`)).status, 200);
  } finally {
    if (blocker.listening) blocker.close();
    await stub.close();
  }
});
