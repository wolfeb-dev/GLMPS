// Routes under test: server/lib/routes/learning-integrity-routes.js
// Routes under test: server/lib/routes/guards-routes.js
// Routes under test: server/lib/routes/surface-routes.js
// Routes under test: server/lib/routes/tap-routes.js
// Routes under test: server/lib/routes/lessons-routes.js
// server/test/client-token-scope.test.js
// Server-and-client-tap task 3: the per-client token class. Every route the
// server dispatches is read out of server.js and checked against the scope
// table pinned below, so each out-of-scope route has its own refusal assertion
// and a new route shows up here the day it is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAccess, clientScopeAllows, isGuardedRoute, CLIENT_WRITE_SCOPE } from '../lib/governance/access-guard.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { startServer } from '../server.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';
import { serverSource } from './helpers/server-source.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = serverSource();
const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Independent of the guard's own table on purpose: a scope change has to be
// made twice, once here, so it is a visible test diff.
const EXPECTED_WRITES = new Set([
  'POST /api/tap/ingest', 'POST /api/tap/heartbeat',
  'POST /api/tap/mirror/append', 'POST /api/tap/mirror/snapshot', 'POST /api/tap/git',
  'POST /api/backlog', 'PATCH /api/backlog/x',
  'POST /api/backlog/x/devlog', 'POST /api/backlog/x/gate', 'POST /api/backlog/x/progress', 'POST /api/backlog/x/merge-request',
  'POST /api/control/gate',
  'POST /api/launches/x/claim', 'POST /api/launches/x/result',
  'POST /api/guards/refusal', 'POST /api/outcomes/finalize',
  'POST /api/ingest/learning-gaps', 'POST /api/ingest/backlog-ticket', 'POST /api/ingest/decision-log', 'POST /api/ingest/qa-trends',
  'POST /api/otel', 'POST /v1/traces',
]);
const EXPECTED_DENIED_READS = ['/api/file', '/api/surface/tree', '/api/surface/file-diff', '/api/budget', '/api/config', '/api/runner/config', '/api/wiki/ticket', '/api/clients',
  // the local-session routes (file undo, terminal, resume, editor, restart) for every method
  '/api/file/undo', '/api/terminal', '/api/resume', '/api/open-in-editor', '/api/restart', '/api/actions/restart-all'];
const DENIED_READ_PREFIXES = ['/api/clients/', '/api/tap/'];
// The only reads under /api/tap/ a client token may make: its update archive and its own mirror manifest.
const ALLOWED_TAP_READS = ['/api/tap/download/update', '/api/tap/mirror'];
function expectedAllowed(method, p) {
  if (method === 'GET' || method === 'HEAD') {
    if (ALLOWED_TAP_READS.includes(p)) return true;
    return p.startsWith('/api/') && !EXPECTED_DENIED_READS.includes(p) && !DENIED_READ_PREFIXES.some((d) => p.startsWith(d));
  }
  return EXPECTED_WRITES.has(`${method} ${p}`);
}

/** Every (method, sample path) the server dispatches, read from its source; ids become 'x'. */
function serverRoutes() {
  const out = new Map();
  const add = (methods, p) => { for (const m of methods) out.set(`${m} ${p}`, { method: m, path: p }); };
  for (const r of SERVER_SRC.matchAll(/method: '([A-Z]+)', pattern: '([^']+)'/g)) add([r[1]], r[2].replace(/:[a-zA-Z]+/g, 'x'));
  for (const r of SERVER_SRC.matchAll(/u\.pathname === '([^']+)'(?: && req\.method === '([A-Z]+)')?/g)) add(r[2] ? [r[2]] : ALL_METHODS, r[1]);
  for (const r of SERVER_SRC.matchAll(/pathname\.match\(\/\^(.*?)\$\/\)/g)) {
    let p = r[1].split('([^/]+)').join('x').replace(/\\\//g, '/');
    // '/a(?:/(b|c))?' -> '/a', '/a/b', '/a/c'; '/a/(b|c)' -> '/a/b', '/a/c'
    const opt = /^(.*)\(\?:\/\(([a-z|-]+)\)\)\?$/.exec(p);
    const alt = /^(.*)\(([a-z|-]+)\)$/.exec(p);
    const paths = opt ? [opt[1], ...opt[2].split('|').map((a) => `${opt[1]}/${a}`)] : alt ? alt[2].split('|').map((a) => alt[1] + a) : [p];
    for (const one of paths) if (!/[()[\]\\?*+|^$]/.test(one)) add(ALL_METHODS, one);
  }
  return [...out.values()].filter((r) => r.path.startsWith('/api/') || r.path.startsWith('/v1/'));
}

const CERT_SHA = 'ab'.repeat(32);
const CLIENT = { id: 'cli_test', name: 'laptop', paired: true, certSha256: CERT_SHA };
const remoteCall = (method, pathname, extra = {}) => checkAccess({
  remoteAddress: '192.168.1.77', method, pathname, presentedToken: 'client-tok', token: 'shared-tok',
  clientCert: { fingerprint256: CERT_SHA, authorized: true },
  authenticateClient: (t) => (t === 'client-tok' ? CLIENT : null), ...extra,
});

// Card glmps-2-0-152: a client token is accepted only beside the certificate
// issued to that same client, chained to the client CA and within its validity.
test('a client token without its own certificate is 401 with a named reason', () => {
  assert.deepEqual(remoteCall('GET', '/api/state', { clientCert: null }), { allow: false, status: 401, reason: 'client-certificate-required' });
  assert.deepEqual(remoteCall('GET', '/api/state', { clientCert: { fingerprint256: 'cd'.repeat(32), authorized: true } }), { allow: false, status: 401, reason: 'client-certificate-mismatch' });
  assert.deepEqual(remoteCall('GET', '/api/state', { clientCert: { fingerprint256: CERT_SHA, authorized: false } }), { allow: false, status: 401, reason: 'client-certificate-untrusted' });
  const noCertOnFile = { ...CLIENT, certSha256: null };
  assert.deepEqual(remoteCall('GET', '/api/state', { authenticateClient: () => noCertOnFile }), { allow: false, status: 401, reason: 'client-must-re-pair' });
  assert.deepEqual(remoteCall('GET', '/api/state'), { allow: true, clientId: 'cli_test' });
});

test('a certificate alone, with no token, opens nothing but the pairing route', () => {
  assert.deepEqual(remoteCall('GET', '/api/state', { presentedToken: '' }), { allow: false, status: 401 });
  assert.deepEqual(remoteCall('POST', '/api/tap/pair', { presentedToken: '', clientCert: null }), { allow: true });
});

test('the dashboard token needs no client certificate, and loopback never needs one', () => {
  assert.deepEqual(remoteCall('GET', '/api/state', { presentedToken: 'shared-tok', clientCert: null }), { allow: true });
  assert.deepEqual(checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state', presentedToken: 'client-tok', authenticateClient: () => CLIENT }), { allow: true });
});

test('route enumeration finds the server surface (guards the parser, not the guard)', () => {
  const routes = serverRoutes();
  assert.ok(routes.length > 200, `found only ${routes.length} method+route pairs`);
  for (const k of ['POST /api/restart', 'POST /api/file/undo', 'POST /api/backlog/x/approve', 'POST /api/sessions/x/stop', 'POST /api/control/gate/x/decision', 'GET /api/config', 'POST /api/launches/x/claim']) {
    assert.ok(routes.some((r) => `${r.method} ${r.path}` === k), `enumeration missed ${k}`);
  }
});

test('route enumeration includes routes moved to route modules (card glmps-2-0-151)', () => {
  const routes = serverRoutes();
  for (const k of ['GET /api/loops', 'POST /api/loops/x/run', 'POST /api/lessons/x/promote']) {
    assert.ok(routes.some((r) => `${r.method} ${r.path}` === k), `enumeration missed ${k}`);
  }
});

test('every out-of-scope route refuses a client token with 403, every in-scope route allows it and names the client', () => {
  let refused = 0;
  for (const { method, path: p } of serverRoutes()) {
    const d = remoteCall(method, p);
    if (!isGuardedRoute(method, p)) {
      assert.deepEqual(d, { allow: true }, `${method} ${p} is open to any remote caller (liveness, icons)`);
    } else if (expectedAllowed(method, p)) {
      assert.deepEqual(d, { allow: true, clientId: 'cli_test' }, `${method} ${p} should be in scope`);
    } else {
      assert.deepEqual(d, { allow: false, status: 403, reason: 'client-token-out-of-scope' }, `${method} ${p} should be refused`);
      refused++;
    }
  }
  assert.ok(refused > 100, `only ${refused} refusals checked`);
});

test('a client token reads the tap update archive and its mirror manifest, and nothing else under /api/tap/', () => {
  for (const m of ['GET', 'HEAD']) assert.deepEqual(remoteCall(m, '/api/tap/download/update'), { allow: true, clientId: 'cli_test' }, m);
  assert.deepEqual(remoteCall('GET', '/api/tap/mirror'), { allow: true, clientId: 'cli_test' });
  for (const p of ['/api/tap/mirror/append', '/api/tap/mirror/snapshot', '/api/tap/mirrorx']) assert.equal(remoteCall('GET', p).status, 403, `GET ${p}`);
  assert.equal(remoteCall('GET', '/api/tap/mirror/').allow, false, 'another spelling of the path');
  for (const m of ['PUT', 'DELETE']) assert.equal(remoteCall(m, '/api/tap/mirror').status, 403, m);
  for (const p of ['/api/tap/release', '/api/tap/download/installer', '/api/tap/download/updatex', '/api/tap/pair-code']) {
    assert.equal(remoteCall('GET', p).status, 403, p);
  }
  assert.equal(remoteCall('GET', '/api/tap/download/update/').allow, false, 'another spelling of the path');
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal(remoteCall(m, '/api/tap/download/update').status, 403, m);
});

test('the admin routes the spec names are refused for every method', () => {
  const admin = ['/api/restart', '/api/config', '/api/file', '/api/file/undo', '/api/terminal', '/api/resume', '/api/open-in-editor',
    '/api/tap/pair', '/api/clients', '/api/clients/cli_x/revoke', '/api/clients/cli_x/rotate', '/api/runner/config'];
  for (const p of admin) for (const m of ALL_METHODS) {
    const d = remoteCall(m, p);
    assert.equal(d.allow, false, `${m} ${p}`);
    assert.equal(d.status, 403, `${m} ${p}`);
  }
});

test('operator-only board and control writes stay refused even though their neighbours are in scope', () => {
  for (const p of ['/api/backlog/x/approve', '/api/backlog/x/merge-request/release', '/api/backlog/x/channel', '/api/backlog/x/review',
    '/api/backlog/x/worktree-outcome', '/api/backlog/x/purge-worktree', '/api/backlog/pause', '/api/backlog/reorder',
    '/api/sessions/x/stop', '/api/control/gate/x/decision', '/api/lessons/x/promote', '/api/learning-integrity/freeze']) {
    assert.equal(remoteCall('POST', p).status, 403, p);
  }
  assert.equal(remoteCall('DELETE', '/api/backlog/x').status, 403);
  assert.equal(remoteCall('PATCH', '/api/backlog/x/devlog').status, 403, 'the method is part of the scope');
  assert.equal(remoteCall('POST', '/api/backlog/x/y/devlog').status, 403, 'an id never spans a path segment');
});

test('a client token is refused off /api on reads: OTLP reads and wiki pages', () => {
  for (const p of ['/v1/traces', '/wiki/server.html', '/wiki-ext/repo/index.html']) assert.equal(remoteCall('GET', p).status, 403, p);
});

test('an unknown or revoked token is 401, and a client token in the URL is not accepted', () => {
  assert.deepEqual(remoteCall('GET', '/api/state', { presentedToken: 'nope' }), { allow: false, status: 401 });
  assert.deepEqual(remoteCall('GET', '/api/state', { authenticateClient: () => null }), { allow: false, status: 401 });
  assert.deepEqual(remoteCall('GET', '/api/state', { presentedToken: '', queryToken: 'client-tok' }), { allow: false, status: 401 });
  assert.deepEqual(remoteCall('GET', '/api/state', { authenticateClient: undefined }), { allow: false, status: 401 }, 'no store: fail closed');
});

test('the shared token keeps full remote access, and loopback is unchanged by a client token', () => {
  assert.deepEqual(remoteCall('POST', '/api/restart', { presentedToken: 'shared-tok' }), { allow: true });
  const loop = checkAccess({ remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/learning/idea', presentedToken: 'client-tok', token: 'shared-tok', authenticateClient: () => CLIENT });
  assert.deepEqual(loop, { allow: true });
  const ls = checkAccess({ remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/terminal', presentedToken: 'client-tok', token: 'shared-tok', localSessionExpected: 'k', authenticateClient: () => CLIENT });
  assert.equal(ls.status, 401, 'a client token is not the local-session proof');
});

test('the guard scope matches the pinned table, and every scoped write is a real route', () => {
  const pinned = [...EXPECTED_WRITES].sort();
  const guard = CLIENT_WRITE_SCOPE.map((s) => `${s.method} ${s.path.replace(':id', 'x')}`).sort();
  assert.deepEqual(guard, pinned);
  const routes = new Set(serverRoutes().map((r) => `${r.method} ${r.path}`));
  for (const k of pinned) assert.ok(routes.has(k), `${k} is scoped but the server has no such route`);
  for (const k of pinned) { const [m, p] = k.split(' '); assert.equal(clientScopeAllows(m, p), true, k); }
});

// End to end over a real socket: a request sourced from 127.0.0.2 over the private
// HTTPS listener takes the remote path (see mtls-remote.integration.test.js).
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-clitok-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: 'shared-remote-token' };
}
test('a paired client token reaches in-scope routes, is refused 403 on admin routes, and is 401 one request after revoke', async () => {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  const remote = (port, o) => remoteHttps(port, { ca: bind.homeCaPem, ...o });
  try {
    const me = pairWithCert(store, env.GLMPS_STATE_DIR, { name: 'laptop' });
    const { clientId, token } = me;
    const client = { cert: me.cert, key: me.key };
    assert.equal((await remote(srv.port, { path: '/api/sessions/live', token, client })).status, 200);
    const card = await remote(srv.port, { method: 'POST', path: '/api/backlog', token, client, body: JSON.stringify({ source: 'manual', title: 'client token probe', prompt: 'x' }) });
    assert.ok(card.status >= 200 && card.status < 300, `POST /api/backlog answered ${card.status} ${card.body}`);
    for (const [method, p] of [['POST', '/api/restart'], ['GET', '/api/config'], ['GET', '/api/budget'], ['POST', '/api/learning/idea'], ['POST', '/api/backlog/x/approve']]) {
      const r = await remote(srv.port, { method, path: p, token, client, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.match(r.body, /client-token-out-of-scope/);
    }
    assert.equal((await remote(srv.port, { path: `/api/state?access_token=${token}` })).status, 401, 'never via the URL');
    store.revoke(clientId, { actor: 'test' });
    assert.equal((await remote(srv.port, { path: '/api/sessions/live', token, client })).status, 401, 'revoked: refused on the next request');
  } finally { store.closeDb(); await srv.close(); }
});
