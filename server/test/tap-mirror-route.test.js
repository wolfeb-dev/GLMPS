// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-mirror-route.test.js
// GET /api/tap/mirror, POST /api/tap/mirror/append and /snapshot over a real
// socket (server-and-client-tap task 10): the token decides the client, the
// protocol header, the 1 MiB cap, confinement, the quota alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { collectAlerts } from '../lib/observability/alert-sources.js';
import { startServer } from '../server.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';

let sqliteOk = true;
try { if (!process.getBuiltinModule('node:sqlite')?.DatabaseSync) sqliteOk = false; } catch { sqliteOk = false; }
const SKIP = sqliteOk ? false : 'node:sqlite is unavailable on this Node, so kernel.db cannot open';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkEnv(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapmirrorroute-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: 'shared-remote-token', ...extra };
}
// cur and certs: the private bind's CA and each paired client's certificate by token. remote: true is HTTPS from 127.0.0.2 (the remote path);
// otherwise plain loopback.
const cur = { ca: null, stateDir: null };
const certs = new Map();
function pair(store, o) { const c = pairWithCert(store, cur.stateDir, o); certs.set(c.token, { cert: c.cert, key: c.key }); return c; }
function call(port, { method = 'POST', path: p, token, proto = 1, body, remote = false } = {}) {
  if (remote) return remoteHttps(port, { method, path: p, token: token, body, client: token ? certs.get(token) : undefined, ca: cur.ca, headers: { [TAP_PROTOCOL_HEADER]: proto == null ? null : String(proto) } }).then((r) => ({ ...r, json: () => JSON.parse(r.body) }));
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (proto != null) headers[TAP_PROTOCOL_HEADER] = String(proto);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, json: () => JSON.parse(b) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
async function withServer(fn, config = {}) {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json'), config });
  cur.ca = bind.homeCaPem; cur.stateDir = env.GLMPS_STATE_DIR;
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try { await fn({ srv, store, env }); } finally { store.closeDb(); await srv.close(); }
}
const b64 = (s) => Buffer.from(s).toString('base64');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const APPEND = '/api/tap/mirror/append';
const SNAP = '/api/tap/mirror/snapshot';
const P1 = 'claude/projects/p/s1.jsonl';

test('mirror routes: append lands under the token client, the manifest lists it, loopback and remote alike', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store, env }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const a = await call(srv.port, { path: APPEND, token, body: { path: P1, offset: 0, data: b64('l1\n'), clientId: 'cli_forged' } });
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(a.json(), { size: 3 });
    const b = await call(srv.port, { path: APPEND, token, remote: true, body: { path: P1, offset: 3, data: b64('l2\n') } });
    assert.deepEqual(b.json(), { size: 6 });
    assert.equal(fs.readFileSync(path.join(env.GLMPS_STATE_DIR, 'clients', clientId, 'mirror', 'claude', 'projects', 'p', 's1.jsonl'), 'utf8'), 'l1\nl2\n');
    for (const remote of [false, true]) {
      const m = await call(srv.port, { method: 'GET', path: '/api/tap/mirror', token, remote });
      assert.equal(m.status, 200, m.body);
      const j = m.json();
      assert.deepEqual(j.files, { [P1]: { size: 6, sha256: null } });
      assert.equal(j.usedBytes, 6);
      assert.equal(j.quotaBytes, 20 * 1024 ** 3);
    }
  });
});

test('mirror routes: a stale offset is 409 with the size the server holds', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    await call(srv.port, { path: APPEND, token, body: { path: P1, offset: 0, data: b64('abc') } });
    const r = await call(srv.port, { path: APPEND, token, body: { path: P1, offset: 1, data: b64('x') } });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json(), { size: 3 });
  });
});

test('mirror routes: a snapshot stages, verifies and stores, and the same hash again is unchanged', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store, env }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const buf = Buffer.from(JSON.stringify({ hello: 'world' }));
    const body = { path: 'claude/.claude-manager/active-sessions.json', kind: 'json', sha256: sha(buf), size: buf.length, offset: 0, data: buf.toString('base64') };
    const first = await call(srv.port, { path: SNAP, token, body });
    assert.deepEqual(first.json(), { stored: true, size: buf.length });
    assert.deepEqual(fs.readFileSync(path.join(env.GLMPS_STATE_DIR, 'clients', clientId, 'mirror', 'claude', '.claude-manager', 'active-sessions.json')), buf);
    assert.deepEqual((await call(srv.port, { path: SNAP, token, body })).json(), { unchanged: true });
    const bad = await call(srv.port, { path: SNAP, token, body: { ...body, sha256: sha(Buffer.from('other')) } });
    assert.equal(bad.status, 400, 'a hash that does not match the bytes is refused');
    assert.deepEqual(fs.readFileSync(path.join(env.GLMPS_STATE_DIR, 'clients', clientId, 'mirror', 'claude', '.claude-manager', 'active-sessions.json')), buf);
  });
});

test('mirror routes: confinement refusals are 400 over the wire', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    for (const p of ['claude/../escape', 'etc/passwd', 'claude\\x', 'claude/C:/x', '/claude/x', 'claude/NUL']) {
      const r = await call(srv.port, { path: APPEND, token, body: { path: p, offset: 0, data: b64('x') } });
      assert.equal(r.status, 400, p);
    }
  });
});

test('mirror routes: unknown, missing, revoked and dashboard tokens are 401, even on loopback', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const body = { path: P1, offset: 0, data: b64('x') };
    const tries = (t, remote) => [
      call(srv.port, { path: APPEND, token: t, remote, body }), call(srv.port, { path: SNAP, token: t, remote, body }),
      call(srv.port, { method: 'GET', path: '/api/tap/mirror', token: t, remote }),
    ];
    for (const t of ['nope', undefined, 'shared-remote-token']) for (const remote of [false, true]) for (const r of await Promise.all(tries(t, remote))) assert.equal(r.status, 401, `${t} ${remote}`);
    store.revoke(clientId, { actor: 'test' });
    for (const r of await Promise.all(tries(token, false))) assert.equal(r.status, 401);
  });
});

test('mirror routes: no or old protocol header is 426', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    for (const proto of [null, '0']) {
      assert.equal((await call(srv.port, { path: APPEND, token, proto, body: { path: P1, offset: 0, data: '' } })).status, 426);
      assert.equal((await call(srv.port, { method: 'GET', path: '/api/tap/mirror', token, proto })).status, 426);
    }
  });
});

test('mirror routes: a body over 1 MiB is 413 and nothing lands', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    const r = await call(srv.port, { path: APPEND, token, body: { path: P1, offset: 0, data: 'A'.repeat(1024 * 1024 + 10) } });
    assert.equal(r.status, 413);
    assert.deepEqual((await call(srv.port, { method: 'GET', path: '/api/tap/mirror', token })).json().files, {});
  });
});

test('mirror routes: malformed JSON is 400', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    assert.equal((await call(srv.port, { path: APPEND, token, body: '{nope' })).status, 400);
    assert.equal((await call(srv.port, { path: SNAP, token, body: '[]' })).status, 400);
  });
});

test('mirror quota: tap.mirrorQuotaBytes in config.json caps a client with 507, a tap-mirror alert opens and a fitting write clears it', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    const alerts = async () => {
      const j = await (await fetch(`http://127.0.0.1:${srv.port}/api/alerts`)).json();
      return (Array.isArray(j) ? j : (j.alerts ?? j.items ?? [])).filter((a) => a.source === 'tap-mirror');
    };
    assert.equal((await call(srv.port, { path: APPEND, token, body: { path: P1, offset: 0, data: b64('0123456') } })).status, 200);
    const over = await call(srv.port, { path: APPEND, token, body: { path: P1, offset: 7, data: b64('789ABCD') } });
    assert.equal(over.status, 507);
    assert.equal(over.json().quotaBytes, 10);
    const on = await alerts();
    assert.equal(on.length, 1, JSON.stringify(on));
    assert.equal(on[0].severity, 'warn');
    assert.match(on[0].title, /laptop/);
    assert.equal((await call(srv.port, { path: APPEND, token, body: { path: P1, offset: 7, data: b64('789') } })).status, 200);
    assert.deepEqual(await alerts(), []);
  }, { tap: { mirrorQuotaBytes: 10 } });
});

test('collectAlerts renders one warn row per client over its mirror quota, keyed on the episode start', () => {
  const rows = collectAlerts({ tapMirrorQuota: [{ clientId: 'cli_a', name: 'laptop', sinceTs: 1000, lastTs: 2000, usedBytes: 3 * 1024 ** 3, quotaBytes: 4 * 1024 ** 3 }, { name: 'no id' }] })
    .filter((a) => a.source === 'tap-mirror');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'warn');
  assert.match(rows[0].title, /laptop/);
  assert.match(rows[0].detail, /3 GiB/);
  assert.match(rows[0].detail, /4 GiB/);
  assert.deepEqual(rows[0].target, { view: 'clients', clientId: 'cli_a', since: 1000 });
});
