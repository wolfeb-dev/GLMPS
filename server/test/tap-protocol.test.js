// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-protocol.test.js
// Tap agent skeleton (card glmps-2-0-runtime-31): the protocol version refusal,
// the heartbeat route and the 426 check, over a real socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TAP_PROTOCOL_HEADER, TAP_PROTOCOL, TAP_PROTOCOL_MIN, tapProtocolRefusal } from '../lib/kernel/tap-protocol.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { startServer } from '../server.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';

test('the protocol constants are pinned', () => {
  assert.equal(TAP_PROTOCOL_HEADER, 'x-glmps-tap-protocol');
  assert.equal(TAP_PROTOCOL, 1);
  assert.equal(TAP_PROTOCOL_MIN, 1);
});

test('tapProtocolRefusal passes the current and newer protocols and refuses everything else with 426', () => {
  assert.equal(tapProtocolRefusal('1'), null);
  assert.equal(tapProtocolRefusal(1), null);
  assert.equal(tapProtocolRefusal('2'), null);
  const refused = { status: 426, error: 'tap-protocol-too-old', min: TAP_PROTOCOL_MIN, current: TAP_PROTOCOL };
  for (const v of [undefined, null, '', '0', '-1', 'abc', '1.5', '1 ', ' 1x', 0, ['1', '2']]) {
    assert.deepEqual(tapProtocolRefusal(v), refused, `value ${JSON.stringify(v)}`);
  }
});

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapproto-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: 'shared-remote-token' };
}
// cur and certs: the private bind's CA and each paired client's certificate by token. remote: true is HTTPS from 127.0.0.2 (the remote path);
// otherwise plain loopback.
const cur = { ca: null, stateDir: null };
const certs = new Map();
function pair(store, o) { const c = pairWithCert(store, cur.stateDir, o); certs.set(c.token, { cert: c.cert, key: c.key }); return c; }
function call(port, { method = 'GET', path: p, token, proto, body, remote = false } = {}) {
  if (remote) return remoteHttps(port, { method, path: p, token: token, body, client: token ? certs.get(token) : undefined, ca: cur.ca, headers: { [TAP_PROTOCOL_HEADER]: proto === undefined ? null : String(proto) } }).then((r) => ({ ...r, json: () => JSON.parse(r.body) }));
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (proto !== undefined) headers[TAP_PROTOCOL_HEADER] = String(proto);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, json: () => JSON.parse(b) }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function withServer(fn) {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  cur.ca = bind.homeCaPem; cur.stateDir = env.GLMPS_STATE_DIR;
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try { await fn({ srv, store, env }); } finally { store.closeDb(); await srv.close(); }
}

test('heartbeat route: a paired client token records the heartbeat, on loopback and remote alike', async () => {
  await withServer(async ({ srv, store }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    for (const remote of [false, true]) {
      const r = await call(srv.port, { method: 'POST', path: '/api/tap/heartbeat', token, proto: 1, remote,
        body: { tapVersion: '0.2.0', spoolDepth: 3, dataRoots: ['C:/a'], tools: ['cursor', 'zed'] } });
      assert.equal(r.status, 200, r.body);
      const j = r.json();
      assert.equal(j.ok, true);
      assert.equal(j.clientId, clientId);
      assert.deepEqual(j.protocol, { current: TAP_PROTOCOL, min: TAP_PROTOCOL_MIN });
      assert.equal(typeof j.serverTime, 'number');
    }
    const c = store.get(clientId);
    assert.equal(c.tapVersion, '0.2.0');
    assert.equal(c.spoolDepth, 3);
    assert.deepEqual(c.dataRoots, ['C:/a']);
    assert.deepEqual(c.tools, ['cursor', 'zed']);
    assert.equal(typeof c.lastSeenTs, 'number');
  });
});

test('heartbeat route: a client id in the body is ignored, the token decides', async () => {
  await withServer(async ({ srv, store }) => {
    const a = pair(store, { name: 'a' });
    const b = pair(store, { name: 'b' });
    const r = await call(srv.port, { method: 'POST', path: '/api/tap/heartbeat', token: a.token, proto: 1, body: { clientId: b.clientId, tapVersion: '9.9.9' } });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json().clientId, a.clientId);
    assert.equal(store.get(a.clientId).tapVersion, '9.9.9');
    assert.equal(store.get(b.clientId).tapVersion, null);
  });
});

test('heartbeat route: unknown, missing and revoked tokens are 401, even on loopback', async () => {
  await withServer(async ({ srv, store }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const post = (t) => call(srv.port, { method: 'POST', path: '/api/tap/heartbeat', token: t, proto: 1, body: {} });
    assert.equal((await post('nope')).status, 401);
    assert.equal((await post(undefined)).status, 401);
    assert.equal((await post('shared-remote-token')).status, 401, 'the dashboard token is not a client');
    store.revoke(clientId, { actor: 'test' });
    assert.equal((await post(token)).status, 401);
  });
});

test('heartbeat route: malformed bodies are 400', async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    const post = (body) => call(srv.port, { method: 'POST', path: '/api/tap/heartbeat', token, proto: 1, body });
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post({ spoolDepth: -1 })).status, 400);
    assert.equal((await post({ tools: 'cursor' })).status, 400);
    for (const tapVersion of [7, true, '', 'x'.repeat(65), ['1']]) assert.equal((await post({ tapVersion })).status, 400, JSON.stringify(tapVersion));
  });
});

test('426: a client-token request with no, bad or old protocol header is refused before any handler runs', async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    for (const proto of [undefined, 'abc', '0']) {
      // Remote only: loopback skips the guard's token check, so only the heartbeat resolves a client there.
      const r = await call(srv.port, { path: '/api/sessions/live', token, proto, remote: true });
      assert.equal(r.status, 426, `proto ${proto}`);
      assert.deepEqual(r.json(), { error: 'tap-protocol-too-old', min: TAP_PROTOCOL_MIN, current: TAP_PROTOCOL, update: null });
      const hb = await call(srv.port, { method: 'POST', path: '/api/tap/heartbeat', token, proto, body: {} });
      assert.equal(hb.status, 426, `heartbeat proto ${proto}`);
    }
    assert.equal((await call(srv.port, { path: '/api/sessions/live', token, proto: 1, remote: true })).status, 200);
  });
});

test('426 does not touch the dashboard token or tokenless loopback callers', async () => {
  await withServer(async ({ srv }) => {
    assert.equal((await call(srv.port, { path: '/api/sessions/live' })).status, 200);
    assert.equal((await call(srv.port, { path: '/api/sessions/live', token: 'shared-remote-token', remote: true })).status, 200);
  });
});
