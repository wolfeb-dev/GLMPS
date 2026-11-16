// server/test/csrf-guard.integration.test.js
// glmps-48 frozen acceptance, end to end: a mutating request with a foreign
// Origin/Host gets 403; a same-origin localhost request is allowed; GET reads
// stay open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.js';

/** Raw request (fetch/undici refuses to override the Host header). */
function rawRequest(port, { method, path: p, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-csrf-')); tmpDirs.push(tmp);
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

test('mutating routes reject foreign Origin/Host with 403; localhost + reads unaffected', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const body = JSON.stringify({ source: 'manual', title: 'csrf probe', prompt: 'x' });

    // DNS rebinding: browser resolved evil host to 127.0.0.1 -> Host is foreign
    const rebound = await rawRequest(srv.port, { method: 'POST', path: '/api/backlog',
      headers: { 'content-type': 'application/json', host: 'evil.example.com:8123' }, body });
    assert.equal(rebound, 403, 'foreign Host must be rejected');

    // CSRF: cross-origin fetch/form from a lured page -> Origin is foreign
    const csrf = await fetch(`${base}/api/backlog`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' }, body });
    assert.equal(csrf.status, 403, 'foreign Origin must be rejected');

    // Reads stay open even with a foreign Origin (localhost lens)
    const read = await fetch(`${base}/api/state`, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(read.status, 200);

    // Same-origin localhost mutation still works (dashboard + executor path)
    const ok = await fetch(`${base}/api/backlog`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}` }, body });
    assert.equal(ok.status, 201, 'same-origin localhost mutation allowed');
  } finally { await srv.close(); }
});

// these three GETs are sensitive reads
// (Mem0-admitted facts, the judge's independent verdict ledger) and are now
// guarded the same way as the secret GET /api/budget already was - a foreign
// Origin/Host is rejected even for a same-host (loopback) request, unlike an
// ordinary read (asserted above for /api/state, which stays open).
test('sensitive GET reads (memory lookup, judge verdicts/summary) reject a foreign Origin like a mutating route', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const foreign = { origin: 'https://evil.example.com' };
    const lookup = await fetch(`${base}/api/memory/lookup?q=x`, { headers: foreign });
    assert.equal(lookup.status, 403);
    const verdicts = await fetch(`${base}/api/judge/verdicts`, { headers: foreign });
    assert.equal(verdicts.status, 403);
    const summary = await fetch(`${base}/api/judge/summary`, { headers: foreign });
    assert.equal(summary.status, 403);
    // Same-origin localhost read still works normally.
    const ok = await fetch(`${base}/api/judge/summary`, { headers: { origin: `http://127.0.0.1:${srv.port}` } });
    assert.equal(ok.status, 200);
  } finally { await srv.close(); }
});
