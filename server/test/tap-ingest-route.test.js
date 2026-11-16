// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-ingest-route.test.js
// POST /api/tap/ingest (server-and-client-tap task 9) over a real socket: the
// token decides the client, the high-water mark drops replays, the batch cap,
// the protocol header, and the reported spool depth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { openTapIngest, TAP_INGEST_MAX_BYTES } from '../lib/kernel/tap-ingest.js';
import { collectAlerts } from '../lib/observability/alert-sources.js';
import { startServer } from '../server.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapingestroute-')); tmpDirs.push(tmp);
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
function call(port, { method = 'POST', path: p = '/api/tap/ingest', token, proto = 1, body, remote = false } = {}) {
  if (remote) return remoteHttps(port, { method, path: p, token, body, client: token ? certs.get(token) : undefined, ca: cur.ca, headers: { [TAP_PROTOCOL_HEADER]: proto == null ? null : String(proto) } }).then((r) => ({ ...r, json: () => JSON.parse(r.body) }));
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
async function withServer(fn) {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  cur.ca = bind.homeCaPem; cur.stateDir = env.GLMPS_STATE_DIR;
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const dbFile = dbFileFor(env.GLMPS_STATE_DIR);
  const store = openClientStore({ dbFile });
  const inbox = openTapIngest({ dbFile });
  try { await fn({ srv, store, inbox }); } finally { inbox.closeDb(); store.closeDb(); await srv.close(); }
}
const rec = (seq, kind = 'hook') => ({ seq, kind, ts: 1000 + seq, payload: { seq, clientId: 'cli_forged', sessionId: 's1' } });

test('ingest: records land under the token client, on loopback and remote alike, and replays are dropped', async () => {
  await withServer(async ({ srv, store, inbox }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const first = await call(srv.port, { token, body: { records: [rec(1), rec(2)] } });
    assert.equal(first.status, 200, first.body);
    assert.deepEqual(first.json(), { ok: true, accepted: 2, duplicates: 0, highWater: 2 });
    const replay = await call(srv.port, { token, remote: true, body: { records: [rec(2), rec(3)] } });
    assert.equal(replay.status, 200, replay.body);
    assert.deepEqual(replay.json(), { ok: true, accepted: 1, duplicates: 1, highWater: 3 });
    const rows = inbox.records({});
    assert.deepEqual(rows.map((r) => [r.clientId, r.seq]), [[clientId, 1], [clientId, 2], [clientId, 3]]);
    assert.equal(rows[0].payload.clientId, 'cli_forged', 'the payload is stored as sent; the row is stamped from the token');
  });
});

test('ingest: a client id in the body is ignored, the token decides', async () => {
  await withServer(async ({ srv, store, inbox }) => {
    const a = pair(store, { name: 'a' });
    const b = pair(store, { name: 'b' });
    const r = await call(srv.port, { token: a.token, body: { clientId: b.clientId, records: [rec(5)] } });
    assert.equal(r.status, 200, r.body);
    assert.equal(inbox.highWater(a.clientId), 5);
    assert.equal(inbox.highWater(b.clientId), 0);
  });
});

test('ingest: unknown, missing, revoked and dashboard tokens are 401, even on loopback', async () => {
  await withServer(async ({ srv, store }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const post = (t, remote = false) => call(srv.port, { token: t, remote, body: { records: [rec(1)] } });
    assert.equal((await post('nope')).status, 401);
    assert.equal((await post(undefined)).status, 401);
    assert.equal((await post('shared-remote-token')).status, 401, 'the dashboard token is not a client');
    assert.equal((await post('shared-remote-token', true)).status, 401, 'nor from a remote address');
    store.revoke(clientId, { actor: 'test' });
    assert.equal((await post(token)).status, 401);
    assert.equal((await post(token, true)).status, 401);
  });
});

test('ingest: no or old protocol header is 426', async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    for (const proto of [null, '0']) {
      assert.equal((await call(srv.port, { token, proto, body: { records: [] } })).status, 426);
      assert.equal((await call(srv.port, { token, proto, remote: true, body: { records: [] } })).status, 426);
    }
  });
});

test('ingest: a malformed or out-of-order batch is 400 and moves nothing', async () => {
  await withServer(async ({ srv, store, inbox }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const post = (body) => call(srv.port, { token, body });
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post({ records: [rec(3), rec(2)] })).status, 400);
    assert.equal((await post({ records: [rec(1, 'BAD')] })).status, 400);
    assert.equal((await post([])).status, 400);
    assert.equal(inbox.highWater(clientId), 0);
  });
});

test('ingest: a body over 1 MiB is 413 and nothing lands', async () => {
  await withServer(async ({ srv, store, inbox }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const big = { records: [{ seq: 1, kind: 'hook', ts: 1, payload: 'x'.repeat(TAP_INGEST_MAX_BYTES) }] };
    const r = await call(srv.port, { token, body: big });
    assert.equal(r.status, 413);
    assert.equal(inbox.highWater(clientId), 0);
  });
});

test('ingest: the reported spool depth reaches the client row, and spool full opens an episode', async () => {
  await withServer(async ({ srv, store, inbox }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const r = await call(srv.port, { token, body: { records: [], spool: { depth: 42, bytes: 2_147_483_700, full: true, dropped: 3 } } });
    assert.equal(r.status, 200, r.body);
    assert.equal(store.get(clientId).spoolDepth, 42);
    assert.equal(inbox.spoolFull()[0].clientId, clientId);
  });
});

test('collectAlerts renders one warn row per spool-full client, keyed on the episode start', () => {
  const rows = collectAlerts({ tapSpoolFull: [{ clientId: 'cli_a', name: 'laptop', sinceTs: 1000, lastTs: 2000, dropped: 4, bytes: 3 * 1048576 }, { name: 'no id' }] })
    .filter((a) => a.source === 'tap-spool');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'warn');
  assert.match(rows[0].title, /laptop/);
  assert.match(rows[0].detail, /3 MiB/);
  assert.match(rows[0].detail, /4 status or heartbeat/);
  assert.deepEqual(rows[0].target, { view: 'clients', clientId: 'cli_a', since: 1000 });
});

test('ingest: a spool-full report raises a tap-spool alert, and a later not-full report clears it', async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    const alerts = async () => {
      const j = await (await fetch(`http://127.0.0.1:${srv.port}/api/alerts`)).json();
      return (Array.isArray(j) ? j : (j.alerts ?? j.items ?? [])).filter((a) => a.source === 'tap-spool');
    };
    assert.equal((await call(srv.port, { token, body: { records: [], spool: { depth: 1, bytes: 2_200_000_000, full: true, dropped: 2 } } })).status, 200);
    const on = await alerts();
    assert.equal(on.length, 1, JSON.stringify(on));
    assert.match(on[0].title, /laptop/);
    assert.equal((await call(srv.port, { token, body: { records: [], spool: { depth: 0, bytes: 0, full: false, dropped: 0 } } })).status, 200);
    assert.deepEqual(await alerts(), []);
  });
});
