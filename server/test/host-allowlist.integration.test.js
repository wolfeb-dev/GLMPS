// Routes under test: server/lib/routes/guards-routes.js
// server/test/host-allowlist.integration.test.js
// Task 15, K-2, end to end: a same-host DNS-rebound page (connects to
// 127.0.0.1, sends a foreign Host) could read any non-sensitive route - state,
// config, static assets. Every loopback request now needs a local Host at the
// bound port. Same isolation as csrf-guard.integration.test.js: GLMPS_* temp
// dirs, port 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.js';

/** Raw request (fetch/undici refuses to override the Host header). */
function rawRequest(port, { method = 'GET', path: p, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hostallow-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') };
}

test('K-2: a rebound Host is refused on reads, config and static assets; local Hosts at the bound port are served', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
  try {
    const port = srv.port;
    for (const p of ['/api/state', '/api/config', '/healthz', '/']) {
      assert.equal(await rawRequest(port, { path: p, headers: { host: `evil.example.com:${port}` } }), 403, `rebound ${p}`);
      assert.equal(await rawRequest(port, { path: p, headers: { host: `127.0.0.1:${port + 1}` } }), 403, `wrong port ${p}`);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal(await rawRequest(port, { path: '/api/state', headers: { host } }), 200, host);
    }
    // The ordinary client path every other test and the dashboard use.
    const ok = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(ok.status, 200);
  } finally { await srv.close(); }
});

// Task 15, K-1, end to end: a Slack link opened in the shell's dashboard pane
// is a top-level navigation (Sec-Fetch-Mode: navigate, Sec-Fetch-Site: none).
// GET /api/memory/scan writes the memory-integrity baseline when none exists,
// so a navigation could bake whatever memory is on disk right now in as the
// trusted baseline. Refused, and nothing is written; the dashboard's own
// same-origin fetch still works and still writes it.
test('K-1: a navigation to a state-changing GET is refused and writes nothing; the dashboard fetch still works', async () => {
  const env = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const port = srv.port;
    const baseline = path.join(env.GLMPS_STATE_DIR, 'memory-baseline.json');
    const host = `127.0.0.1:${port}`;
    assert.equal(await rawRequest(port, { path: '/api/memory/scan', headers: { host, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }), 403);
    assert.equal(await rawRequest(port, { path: '/api/memory/scan', headers: { host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } }), 403);
    assert.equal(fs.existsSync(baseline), false, 'a refused GET wrote nothing');
    assert.equal(await rawRequest(port, { path: '/api/guards/retire-candidates?minObservations=1', headers: { host, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } }), 403);
    // A read-only route is still openable directly.
    assert.equal(await rawRequest(port, { path: '/api/config', headers: { host, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } }), 200);
    // The dashboard's own poll: same-origin, cors.
    assert.equal(await rawRequest(port, { path: '/api/memory/scan', headers: { host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } }), 200);
    assert.equal(fs.existsSync(baseline), true, 'the dashboard fetch still establishes the baseline');
  } finally { await srv.close(); }
});

/** Raw request returning status and parsed JSON body (null when empty). */
function rawJson(port, { method = 'GET', path: p, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { let body = null; try { body = b ? JSON.parse(b) : null; } catch { body = b; } resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

// Task 15 residual 1: /api/state answers ANY method, so a cross-site HEAD (or
// a CORS preflight OPTIONS) to ?session= reached the same write path a GET is
// refused for (reviewer reproduced HEAD 200 vs GET 403).
// Residual 3: each refusal names its reason in the body.
test('K-1 residuals: HEAD and OPTIONS are refused like GET; each refusal names its reason', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
  try {
    const port = srv.port;
    const host = `127.0.0.1:${port}`;
    const xs = { host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };
    assert.equal((await rawJson(port, { method: 'HEAD', path: '/api/state?session=x', headers: xs })).status, 403, 'cross-site HEAD');
    assert.equal((await rawJson(port, { method: 'OPTIONS', path: '/api/state?session=x', headers: { host, origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } })).status, 403, 'cross-site preflight');
    assert.equal((await rawJson(port, { method: 'HEAD', path: '/api/state?session=x', headers: { host, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } })).status, 403, 'navigation HEAD');
    assert.equal((await rawJson(port, { method: 'HEAD', path: '/api/state?session=x', headers: { host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } })).status, 200, 'same-origin HEAD');

    const xsGet = await rawJson(port, { path: '/api/state?session=x', headers: xs });
    assert.deepEqual([xsGet.status, xsGet.body?.error], [403, 'cross-site-state-changing-get']);
    const nav = await rawJson(port, { path: '/api/memory/scan', headers: { host, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } });
    assert.deepEqual([nav.status, nav.body?.error], [403, 'navigation-to-state-changing-get']);
    const rebound = await rawJson(port, { path: '/api/config', headers: { host: `evil.example.com:${port}` } });
    assert.deepEqual([rebound.status, rebound.body?.error], [403, 'host-not-allowed']);
    // The pre-existing mutation Origin/Host refusal keeps its body.
    const csrf = await rawJson(port, { method: 'POST', path: '/api/backlog', headers: { host, origin: 'https://evil.example.com', 'content-type': 'application/json' } });
    assert.deepEqual([csrf.status, csrf.body?.error], [403, 'forbidden origin/host']);
  } finally { await srv.close(); }
});
