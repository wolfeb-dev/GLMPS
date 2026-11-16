// server/test/csrf-port.integration.test.js
// F6 end to end: a page on another localhost port must not drive the kernel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-csrfport-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
}

function post(port, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/backlog',
      headers: { 'content-type': 'text/plain', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let b = ''; sock.setTimeout(5000, () => { sock.destroy(); resolve(b); }); sock.on('data', (d) => { b += d; }); sock.on('end', () => resolve(b)); sock.on('error', reject);
  });
}

test('F6: a text/plain POST from another localhost port, or a same-site fetch, is refused; the dashboard\'s own origin is not', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
  try {
    const body = JSON.stringify({ source: 'manual', title: 'csrf port probe', prompt: 'x' });
    assert.equal(await post(srv.port, { origin: `http://localhost:${srv.port + 1}` }, body), 403);
    assert.equal(await post(srv.port, { origin: `http://127.0.0.1:${srv.port}`, 'sec-fetch-site': 'same-site' }, body), 403);
    assert.equal(await post(srv.port, { origin: `http://127.0.0.1:${srv.port}`, 'sec-fetch-site': 'same-origin' }, body), 201);
  } finally { await srv.close(); }
});

test('F6: Origin "null" on a guarded mutating route answers 403 and creates nothing', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
  try {
    const body = JSON.stringify({ source: 'manual', title: 'null origin probe', prompt: 'x' });
    assert.equal(await post(srv.port, { origin: 'null' }, body), 403);
    const list = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.port, path: '/api/backlog' }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); }).on('error', reject));
    assert.ok(!list.includes('null origin probe'), 'nothing was created');
  } finally { await srv.close(); }
});

test('raw target with a backslash second character is 400 and the kernel keeps serving', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
  try {
    const reply = await rawGet(srv.port, '/\\api/backlog');
    assert.match(reply, /^HTTP\/1\.1 400 /);
    assert.match(await rawGet(srv.port, '/api/health'), /^HTTP\/1\.1 200 /, 'still alive');
  } finally { await srv.close(); }
});
