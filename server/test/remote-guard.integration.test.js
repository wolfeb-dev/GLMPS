// server/test/remote-guard.integration.test.js
// F3 and F4 end to end from loopback (a non-loopback client cannot be
// simulated over a real socket here; the remote half is pinned by the pure
// checkAccess tests in access-guard.test.js).
import { test, before, after } from 'node:test';
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rguard-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
}

/** Raw request: fetch normalises '/.//' away, http.request sends the target verbatim. */
function raw(port, { method = 'GET', path: p, headers = {}, body, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, localAddress }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// A non-loopback client over a real socket: the whole 127/8 block is loopback
// to the OS, but only 127.0.0.1 is "loopback" to the access guard, so a
// request sourced from 127.0.0.2 takes the remote (token) path end to end.
const TOKEN = 'remote-test-token';
function remote(port, opts) { return raw(port, { ...opts, localAddress: '127.0.0.2' }); }

let sharedEnv;
let srv;

before(async () => {
  sharedEnv = { ...mkEnv(), GLMPS_ACCESS_TOKEN: TOKEN };
  srv = await startServer({ port: 0, pollMs: 1000, env: sharedEnv, restartFn: () => {} });
});

after(async () => {
  await srv?.close();
});

test('F3: a "/.//api/..." request target is refused 400 before any route runs', async () => {
  const body = JSON.stringify({ source: 'manual', title: 'f3 probe card', prompt: 'x' });
  const r = await raw(srv.port, { method: 'POST', path: '/.//api/backlog', headers: { 'content-type': 'application/json' }, body });
  assert.equal(r.status, 400);
  assert.match(r.body, /non-canonical-path/);
  const list = await raw(srv.port, { path: '/api/backlog' });
  assert.doesNotMatch(list.body, /f3 probe card/, 'the handler never ran');
});

test('F4: POST /v1/traces with a foreign Origin is refused 403 from loopback; an Origin-less exporter still ingests', async () => {
  const otlp = JSON.stringify({ resourceSpans: [] });
  const foreign = await raw(srv.port, { method: 'POST', path: '/v1/traces',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' }, body: otlp });
  assert.equal(foreign.status, 403);
  const exporter = await raw(srv.port, { method: 'POST', path: '/v1/traces', headers: { 'content-type': 'application/json' }, body: otlp });
  assert.equal(exporter.status, 200);
});

test('C2: a percent-encoded wiki asset is 401 for a remote client without the token', async () => {
  for (const p of ['/wiki/server%2ehtml', '/wiki/server.ht%6dl', '/wiki/server%2Ejson']) {
    assert.equal((await remote(srv.port, { path: p })).status, 401, p);
  }
  const authed = await remote(srv.port, { path: '/wiki/server%2ehtml', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(authed.status, 404, 'with the token it reaches the wiki handler (nothing published yet)');
});

test('C1: a wiki ticket from /api/wiki/ticket opens remote wiki reads only', async () => {
  assert.equal((await remote(srv.port, { path: '/api/wiki/ticket' })).status, 401, 'minting needs the token remotely');
  const minted = await remote(srv.port, { path: '/api/wiki/ticket', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(minted.status, 200);
  const { ticket, expiresAt } = JSON.parse(minted.body);
  assert.ok(ticket && !ticket.includes(TOKEN));
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 10 * 60 * 1000);
  const q = `wiki_ticket=${encodeURIComponent(ticket)}`;
  assert.equal((await remote(srv.port, { path: `/wiki-ext/nope/core.html?${q}` })).status, 401, 'F4: a kernel ticket opens no project wiki');
  const ext = await remote(srv.port, { path: '/api/wiki/ticket?base=%2Fwiki-ext%2Fnope', headers: { authorization: `Bearer ${TOKEN}` } });
  const qx = `wiki_ticket=${encodeURIComponent(JSON.parse(ext.body).ticket)}`;
  assert.equal((await remote(srv.port, { path: `/wiki-ext/nope/core.html?${qx}` })).status, 404, 'past the guard: unknown project');
  assert.equal((await remote(srv.port, { path: `/wiki-ext/other/core.html?${qx}` })).status, 401, 'F4: not another project');
  assert.equal((await remote(srv.port, { path: `/wiki/core.html?${qx}` })).status, 401, 'F4: not the kernel wiki');
  assert.equal((await remote(srv.port, { path: '/api/wiki/ticket?base=%2Fapi%2Fstate', headers: { authorization: `Bearer ${TOKEN}` } })).status, 400);
  assert.equal((await remote(srv.port, { path: `/wiki/core.html?${q}` })).status, 404, 'past the guard: nothing published');
  assert.equal((await remote(srv.port, { path: `/api/state?${q}` })).status, 401);
  assert.equal((await remote(srv.port, { method: 'POST', path: `/api/backlog?${q}`, headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await remote(srv.port, { path: `/wiki/core.html?wiki_ticket=${encodeURIComponent(ticket + 'x')}` })).status, 401, 'tampered');
});

test('I3: a raw request target that does not start with exactly one "/" is 400 and the kernel keeps serving', async () => {
  for (const target of ['//[', '//api/backlog', '*']) {
    const reply = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nConnection: close\r\n\r\n`));
      let b = ''; sock.setTimeout(5000, () => { sock.destroy(); resolve(b); }); sock.on('data', (d) => { b += d; }); sock.on('end', () => resolve(b)); sock.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 400 /, target);
  }
  assert.equal((await raw(srv.port, { path: '/api/health' })).status, 200, 'still alive');
});

// Scan 2026-10-15 F2: a loopback client with no session (another local
// account, a same-host proxy) is refused on the file, terminal and restart
// routes, even with same-origin browser headers it can simply forge.
test('F2: loopback needs the local session for file, terminal, resume, editor and restart routes', async () => {
  const forged = { origin: `http://127.0.0.1:${srv.port}`, 'sec-fetch-site': 'same-origin', host: `127.0.0.1:${srv.port}`, 'content-type': 'application/json' };
  const target = path.join(sharedEnv.GLMPS_CLAUDE_DIR, 'settings.json');
  const put = JSON.stringify({ path: target, content: '{"hooks":{}}', force: true });
  for (const [method, p, body] of [['PUT', '/api/file', put], ['GET', `/api/file?path=${encodeURIComponent(target)}`], ['POST', '/api/terminal', '{}'], ['POST', '/api/resume', '{}'], ['POST', '/api/open-in-editor', '{}'], ['POST', '/api/restart', '']]) {
    const r = await raw(srv.port, { method, path: p, headers: forged, body });
    assert.equal(r.status, 401, `${method} ${p}`);
    assert.match(r.body, /local-session-required/);
  }
  assert.ok(!fs.existsSync(target), 'the write never happened');
  const keyFile = path.join(sharedEnv.GLMPS_STATE_DIR, 'local-session-key');
  assert.match(fs.readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}$/, 'the key was created at boot');
  assert.notEqual(srv.localSession, fs.readFileSync(keyFile, 'utf8').trim(), 'the session is derived, not the raw key');
  const ok = await raw(srv.port, { method: 'PUT', path: '/api/file', headers: { 'content-type': 'application/json', 'x-glmps-local-session': srv.localSession }, body: put });
  assert.notEqual(ok.status, 401, 'with the session the route runs');
  assert.equal((await raw(srv.port, { path: '/api/state' })).status, 200, 'other loopback reads unchanged');
});
