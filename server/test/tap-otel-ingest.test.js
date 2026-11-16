// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-otel-ingest.test.js
// OTLP through the relay (card glmps-2-0-runtime-39): otel records shipped by a
// paired tap become client-namespaced session events at ingest, replays do not
// double-map, a bad record never fails the batch, and a remote client token
// posting straight to /v1/traces is namespaced too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { startServer } from '../server.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapotel-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: 'shared-remote-token' };
}
// cur and certs: the private bind's CA and each paired client's certificate by token. remote: true is HTTPS from 127.0.0.2
// (the remote path); otherwise plain loopback.
const cur = { ca: null, stateDir: null };
const certs = new Map();
function pair(store, o) { const c = pairWithCert(store, cur.stateDir, o); certs.set(c.token, { cert: c.cert, key: c.key }); return c; }
function post(port, p, { token, body, remote = false, proto = 1 } = {}) {
  if (remote) return remoteHttps(port, { method: 'POST', path: p, token, body, client: token ? certs.get(token) : undefined, ca: cur.ca, headers: { [TAP_PROTOCOL_HEADER]: proto == null ? null : String(proto) } }).then((r) => ({ ...r, text: r.body, json: () => JSON.parse(r.body) }));
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', [TAP_PROTOCOL_HEADER]: String(proto) };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, text: b, json: () => JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
async function eventsFor(port, sid) {
  const r = await fetch(`http://127.0.0.1:${port}/api/state?session=${encodeURIComponent(sid)}`);
  return (await r.json()).events;
}
const span = (sid, tool) => ({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'claude_code.tool', startTimeUnixNano: String(Date.now() * 1e6),
  attributes: [{ key: 'session.id', value: { stringValue: sid } }, { key: 'tool_name', value: { stringValue: tool } }] }] }] }] });
const rec = (seq, payload, kind = 'otel') => ({ seq, kind, ts: 1000 + seq, payload });

async function withServer(fn) {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  cur.ca = bind.homeCaPem; cur.stateDir = env.GLMPS_STATE_DIR;
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try { await fn({ srv, store }); } finally { store.closeDb(); await srv.close(); }
}

test('ingest maps new otel records under <clientId>:otel:<sid>, once, and leaves the response unchanged', async () => {
  await withServer(async ({ srv, store }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const first = await post(srv.port, '/api/tap/ingest', { token, body: { records: [rec(1, span('s1', 'Bash')), rec(2, { x: 1 }, 'hook')] } });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json(), { ok: true, accepted: 2, duplicates: 0, highWater: 2 });
    const sid = `${clientId}:otel:s1`;
    assert.equal((await eventsFor(srv.port, sid)).filter((e) => e.kind === 'tool-use').length, 1);
    assert.equal((await eventsFor(srv.port, 'otel:s1')).length, 0, 'not under the bare namespace');
    const replay = await post(srv.port, '/api/tap/ingest', { token, body: { records: [rec(1, span('s1', 'Bash')), rec(3, span('s1', 'Edit'))] } });
    assert.deepEqual(replay.json(), { ok: true, accepted: 1, duplicates: 1, highWater: 3 });
    const tools = (await eventsFor(srv.port, sid)).filter((e) => e.kind === 'tool-use').map((e) => e.tool);
    assert.deepEqual(tools, ['Bash', 'Edit'], 'the replayed record did not map twice');
  });
});

test('ingest: a malformed otel payload never fails the batch', async () => {
  await withServer(async ({ srv, store }) => {
    const { token } = pair(store, { name: 'laptop' });
    const r = await post(srv.port, '/api/tap/ingest', { token, body: { records: [rec(1, 'not an object'), rec(2, null), rec(3, { resourceSpans: [null, { scopeSpans: 5 }] })] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { ok: true, accepted: 3, duplicates: 0, highWater: 3 });
  });
});

test('a remote client token posting straight to /v1/traces and /api/otel is namespaced; the shared token is not', async () => {
  await withServer(async ({ srv, store }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    for (const [p, sid] of [['/v1/traces', 'd1'], ['/api/otel', 'd2']]) {
      const r = await post(srv.port, p, { token, remote: true, body: span(sid, 'Bash') });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json().sessions, [`${clientId}:otel:${sid}`]);
    }
    const shared = await post(srv.port, '/v1/traces', { token: 'shared-remote-token', remote: true, body: span('d3', 'Bash') });
    assert.deepEqual(shared.json().sessions, ['otel:d3']);
    const loop = await post(srv.port, '/v1/traces', { body: span('d4', 'Bash') });
    assert.deepEqual(loop.json().sessions, ['otel:d4']);
  });
});

test('end to end: a span posted to the tap agent while the server is down is spooled, then lands once under <clientId>:otel:<sid>', async () => {
  const { startAgent } = await import('../../taps/tap-agent.js');
  // The tap agent speaks plain HTTP (its mTLS side is a later card), so it stays pointed at loopback 127.0.0.1, which needs no certificate.
  await withServer(async ({ srv, store }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapotel-home-')); tmpDirs.push(home);
    const { clientId, token } = pair(store, { name: 'laptop' });
    const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
    const writeCfg = (port) => fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, clientId, name: 'laptop' }));
    writeCfg(deadPort);
    const agent = await startAgent({ home, port: 0, homeDir: home, intervalMs: 3_600_000, shipTickMs: 3_600_000, mirrorTickMs: 3_600_000, gitTickMs: 3_600_000, log: () => {}, readToken: () => token, budget: false });
    try {
      await agent.ready;
      const r = await post(agent.address.port, '/v1/traces', { body: span('s-e2e', 'Bash') });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json(), { partialSuccess: {} });
      assert.equal(agent.spool.stats().depth, 1);
      assert.equal((await agent.shipTick()).shipped, false);
      writeCfg(srv.port);
      await agent.heartbeatOnce();
      // The failed ship above backs off 1 s; tick until the shipper is due again.
      let shipped;
      await waitFor(async () => { shipped = await agent.shipTick(); return shipped.skipped !== 'backoff'; }, { message: 'the shipper backoff to pass' });
      assert.equal(shipped.shipped, true, JSON.stringify(shipped));
      assert.equal(agent.spool.stats().depth, 0);
      const evs = (await eventsFor(srv.port, `${clientId}:otel:s-e2e`)).filter((e) => e.kind === 'tool-use');
      assert.deepEqual(evs.map((e) => e.tool), ['Bash']);
      assert.deepEqual(await eventsFor(srv.port, 'otel:s-e2e'), []);
    } finally { await agent.close(); }
  });
});
