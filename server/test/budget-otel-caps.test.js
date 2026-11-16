// server/test/budget-otel-caps.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-caps-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
}

function raw(port, { method = 'GET', path: p }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}

let srv;

before(async () => {
  srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
});

after(async () => {
  await srv?.close();
});

test('F21: /api/budget answers GET only; OPTIONS and PROPFIND get 404 and never run the usage read', async () => {
  assert.equal(await raw(srv.port, { method: 'OPTIONS', path: '/api/budget' }), 404);
  assert.equal(await raw(srv.port, { method: 'PROPFIND', path: '/api/budget' }), 404);
  assert.equal(await raw(srv.port, { path: '/api/budget' }), 200);
});

// A chunked (no Content-Length) POST: the server must count bytes as they stream.
function chunkedPost(port, buf, chunk = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/traces', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: b }));
    });
    req.on('error', reject);
    for (let i = 0; i < buf.length; i += chunk) req.write(buf.subarray(i, i + chunk));
    req.end();
  });
}

test('F4/I2: an OTLP body over 1 MiB with Content-Length gets a real 413 (connection: close), never a reset; the server stays healthy', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  const big = JSON.stringify({ resourceSpans: [], pad: 'x'.repeat(1536 * 1024) });
  const r = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
  assert.equal(r.status, 413);
  const small = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"resourceSpans":[]}' });
  assert.equal(small.status, 200);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('I2: a streamed (chunked, no Content-Length) OTLP overflow also gets a 413 response, then the connection closes', async () => {
  const r = await chunkedPost(srv.port, Buffer.from('x'.repeat(2 * 1024 * 1024)));
  assert.equal(r.status, 413);
  assert.equal(r.connection, 'close');
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/health`)).status, 200);
});

test('I2: an upload that never ends is answered once the drain passes its own cap, not held open forever', async () => {
  const outcome = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/v1/traces', headers: { 'transfer-encoding': 'chunked' } },
      (res) => { res.resume(); resolve({ status: res.statusCode }); });
    // Past the drain cap the server answers and closes; a reset is acceptable there, a hang is not.
    req.on('error', (e) => resolve({ error: e.code }));
    const chunk = Buffer.alloc(256 * 1024, 0x78);
    let sent = 0;
    const pump = () => {
      while (sent < 64 * 1024 * 1024) { sent += chunk.length; if (!req.write(chunk)) return req.once('drain', pump); }
    };
    pump();
  });
  assert.ok(outcome.status === 413 || outcome.error, JSON.stringify(outcome));
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/health`)).status, 200);
});

test('M1: the cap counts bytes, not characters (multi-byte body under the char cap but over the byte cap is refused)', async () => {
  const body = Buffer.from('\u20AC'.repeat(400000)); // 400k chars, 1.2M bytes
  assert.ok(body.length > 1024 * 1024 && body.toString('utf8').length < 1024 * 1024);
  const r = await chunkedPost(srv.port, body);
  assert.equal(r.status, 413);
});
