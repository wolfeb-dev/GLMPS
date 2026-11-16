// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-git-route.test.js
// POST /api/tap/git over a real socket (card glmps-2-0-runtime-40): the token
// decides the client, the protocol header, the 256 KiB cap, validation, and the
// board git status of a client session coming from the summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { openTapGit } from '../lib/kernel/tap-git.js';
import { startServer } from '../server.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';

let sqliteOk = true;
try { if (!process.getBuiltinModule('node:sqlite')?.DatabaseSync) sqliteOk = false; } catch { sqliteOk = false; }
const SKIP = sqliteOk ? false : 'node:sqlite is unavailable on this Node, so kernel.db cannot open';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkEnv(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapgitroute-')); tmpDirs.push(tmp);
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
async function withServer(fn) {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  cur.ca = bind.homeCaPem; cur.stateDir = env.GLMPS_STATE_DIR;
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  const git = openTapGit({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try { await fn({ srv, store, git, env }); } finally { git.closeDb(); store.closeDb(); await srv.close(); }
}
const GIT = '/api/tap/git';
const OID = 'a'.repeat(40);
const row = (over = {}) => ({ path: '/work/a', branch: 'main', head: OID, detached: false, worktree: false, ahead: 1, behind: 0, dirty: 2, remote: 'https://tok@github.com/Acme/a.git', error: null, ...over });

test('POST /api/tap/git stores the set under the token client, loopback and remote alike', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store, git }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const a = await call(srv.port, { path: GIT, token, body: { scannedTs: 1, clientId: 'cli_forged', repos: [row()] } });
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(a.json(), { ok: true, repos: 1 });
    assert.equal(git.list(clientId)[0].remote, 'https://github.com/Acme/a.git', 'credentials never reach the store');
    assert.deepEqual(git.list('cli_forged'), []);
    const b = await call(srv.port, { path: GIT, token, remote: true, body: { repos: [row({ path: '/work/b' })] } });
    assert.equal(b.status, 200, b.body);
    assert.deepEqual(git.list(clientId).map((r) => r.path), ['/work/b'], 'the post replaces the set');
  });
});

test('POST /api/tap/git: no token, an old protocol, a bad body and an oversized body are refused', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store, git }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    assert.equal((await call(srv.port, { path: GIT, body: { repos: [] } })).status, 401);
    assert.equal((await call(srv.port, { path: GIT, token: 'nope', body: { repos: [] } })).status, 401);
    assert.equal((await call(srv.port, { path: GIT, token, proto: null, body: { repos: [] } })).status, 426);
    assert.equal((await call(srv.port, { path: GIT, token, body: '{not json' })).status, 400);
    const bad = await call(srv.port, { path: GIT, token, body: { repos: [row(), row({ path: 'relative' })] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json().error, /repos\[1\]\.path/);
    assert.deepEqual(git.list(clientId), [], 'a refused body stores nothing');
    const big = await call(srv.port, { path: GIT, token, body: JSON.stringify({ repos: [], pad: 'x'.repeat(256 * 1024 + 10) }) });
    assert.equal(big.status, 413);
  });
});

test('a client session on the stage board takes its git status from the client summary', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store, git, env }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    // A repo on the SERVER's disk at the same path the client reports must not be what the board reads.
    const serverSide = path.join(path.dirname(env.GLMPS_STATE_DIR), 'same-path-repo');
    fs.mkdirSync(serverSide, { recursive: true });
    const res = await call(srv.port, { path: GIT, token, body: { repos: [row({ path: serverSide.replace(/\\/g, '/'), branch: 'client-branch', dirty: 9, ahead: 4, behind: 5, remote: null })] } });
    assert.equal(res.status, 200, res.body);
    const sid = `${clientId}:sessG`;
    const events = [];
    const mirrorBase = path.join(env.GLMPS_STATE_DIR, 'clients', clientId, 'mirror', 'claude');
    // A mirrored transcript and registry entry make a live client session with the client's cwd.
    fs.mkdirSync(path.join(mirrorBase, 'projects', 'p'), { recursive: true });
    fs.mkdirSync(path.join(mirrorBase, '.claude-manager'), { recursive: true });
    const line = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), cwd: path.join(serverSide, 'sub'), message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'x:y' } }] } });
    for (const [rel, text] of [['projects/p/sessG.jsonl', `${line}\n`], ['.claude-manager/active-sessions.json', JSON.stringify([{ sessionId: 'sessG', ppid: process.pid, cwd: path.join(serverSide, 'sub'), ts: Date.now() }])]]) {
      const post = await call(srv.port, { path: rel.endsWith('.json') ? '/api/tap/mirror/snapshot' : '/api/tap/mirror/append', token,
        body: rel.endsWith('.json')
          ? { path: `claude/${rel}`, kind: 'json', sha256: (await import('node:crypto')).createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text), offset: 0, data: Buffer.from(text).toString('base64') }
          : { path: `claude/${rel}`, offset: 0, data: Buffer.from(text).toString('base64') } });
      assert.equal(post.status, 200, post.body);
      events.push(post.status);
    }
    const found = await waitFor(async () => {
      const st = (await call(srv.port, { method: 'GET', path: '/api/state' })).json();
      return (st.board?.rows ?? []).find((r) => r.id === sid && r.git) ?? null;
    }, { timeoutMs: 20_000 });
    assert.ok(found, 'the client session is on the board with a git value');
    assert.deepEqual({ dirty: found.git.dirty, ahead: found.git.ahead, behind: found.git.behind, branch: found.git.branch }, { dirty: 9, ahead: 4, behind: 5, branch: 'client-branch' });
    assert.ok(git.list(clientId).length === 1);
  });
});
