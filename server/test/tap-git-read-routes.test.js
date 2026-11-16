// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-git-read-routes.test.js
// GET /api/clients/:id/git and /git/log (card glmps-2-0-runtime-40): the
// operator reads a client's repo summaries joined with the server's own copy,
// and commit history comes from that copy, never from the client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { startServer } from '../server.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';

let sqliteOk = true;
try { if (!process.getBuiltinModule('node:sqlite')?.DatabaseSync) sqliteOk = false; } catch { sqliteOk = false; }
const SKIP = sqliteOk ? false : 'node:sqlite is unavailable on this Node, so kernel.db cannot open';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mc-tapgitread-${tag}-`)); tmpDirs.push(d); return d; };
function mkEnv() {
  const tmp = mkTmp('env');
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
function call(port, { method = 'GET', path: p, token, proto = 1, body, remote = false, bearer } = {}) {
  if (remote) return remoteHttps(port, { method, path: p, token: (bearer ?? token), body, client: (bearer ?? token) ? certs.get((bearer ?? token)) : undefined, ca: cur.ca, headers: { [TAP_PROTOCOL_HEADER]: proto == null ? null : String(proto) } }).then((r) => ({ ...r, json: () => JSON.parse(r.body) }));
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    const t = bearer ?? token;
    if (t) headers.authorization = `Bearer ${t}`;
    if (proto != null) headers[TAP_PROTOCOL_HEADER] = String(proto);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, json: () => JSON.parse(b) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
const emptyConfig = path.join(mkTmp('gitcfg'), 'empty');
fs.writeFileSync(emptyConfig, '');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

// A source repo with two commits on main, mirrored the way the loop would into the state dir.
function seedMirror(stateDir) {
  const src = mkTmp('src');
  git(src, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(src, 'a.txt'), '1');
  git(src, 'add', '.'); git(src, 'commit', '-q', '-m', 'first commit');
  fs.writeFileSync(path.join(src, 'a.txt'), '2');
  git(src, 'commit', '-qam', 'second commit');
  const head = git(src, 'rev-parse', 'HEAD');
  const dest = path.join(stateDir, 'git-clones', 'github.com', 'Acme', 'widgets.git');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(path.dirname(dest), 'clone', '--mirror', '-q', src, dest);
  return { head, dest };
}
const row = (over = {}) => ({ path: '/work/widgets', branch: 'main', head: 'a'.repeat(40), detached: false, worktree: false, ahead: 0, behind: 0, dirty: 0, remote: 'https://github.com/Acme/widgets.git', error: null, ...over });

async function withServer(fn) {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  cur.ca = bind.homeCaPem; cur.stateDir = env.GLMPS_STATE_DIR;
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try { await fn({ srv, store, env }); } finally { store.closeDb(); await srv.close(); }
}
const writeState = (env, remotes) => {
  const dir = path.join(env.GLMPS_STATE_DIR, 'git-clones');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ts: 1, remotes }));
};

test('GET /api/clients/:id/git lists the rows with the server history source and pushed', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store, env }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const { head } = seedMirror(env.GLMPS_STATE_DIR);
    const post = await call(srv.port, { method: 'POST', path: '/api/tap/git', token, body: { repos: [
      row({ head }), row({ path: '/work/unpushed', head: 'f'.repeat(40) }), row({ path: '/work/none', remote: null, head: null }), row({ path: '/work/gl', remote: 'https://gitlab.example.org/o/r.git' }),
    ] } });
    assert.equal(post.status, 200, post.body);
    writeState(env, {
      'github.com/Acme/widgets': { source: 'clone', path: 'ignored', lastFetchTs: 777, error: null, heads: { [head]: true, ['f'.repeat(40)]: false } },
      'gitlab.example.org/o/r': { source: null, path: null, lastFetchTs: null, error: null, heads: {}, skipped: 'host not allowed' },
    });
    const res = await call(srv.port, { path: `/api/clients/${clientId}/git` });
    assert.equal(res.status, 200, res.body);
    const byPath = Object.fromEntries(res.json().repos.map((r) => [r.path, r]));
    assert.deepEqual(byPath['/work/widgets'].history, { source: 'clone', lastFetchTs: 777, error: null });
    assert.equal(byPath['/work/widgets'].pushed, true);
    assert.equal(byPath['/work/unpushed'].pushed, false);
    assert.equal(byPath['/work/none'].pushed, null);
    assert.deepEqual(byPath['/work/none'].history, { source: null, lastFetchTs: null, error: null });
    assert.deepEqual(byPath['/work/gl'].history, { source: null, lastFetchTs: null, error: 'host not allowed' });
    assert.equal(byPath['/work/gl'].pushed, null);
    assert.equal((await call(srv.port, { path: '/api/clients/cli_unknown0000000000/git' })).status, 404);
    assert.equal((await call(srv.port, { path: '/api/clients/not-an-id/git' })).status, 404);
  });
});

test('the read routes are the operator\'s: a client token is refused', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    assert.equal((await call(srv.port, { path: `/api/clients/${clientId}/git`, token, remote: true })).status, 403, 'list');
    assert.equal((await call(srv.port, { path: `/api/clients/${clientId}/git/log?path=/x`, token, remote: true })).status, 403, 'log');
  });
});

test('GET /api/clients/:id/git/log answers from the server copy for the reported branch', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store, env }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const { head, dest } = seedMirror(env.GLMPS_STATE_DIR);
    await call(srv.port, { method: 'POST', path: '/api/tap/git', token, body: { repos: [
      row({ head }), row({ path: '/work/det', branch: null, detached: true, head }), row({ path: '/work/other', branch: 'nope', head }),
      row({ path: '/work/nocopy', remote: 'https://github.com/Acme/unseen.git' }), row({ path: '/work/noremote', remote: null }), row({ path: '/work/badbranch', branch: '--output=x' }),
    ] } });
    writeState(env, { 'github.com/Acme/widgets': { source: 'clone', path: dest, lastFetchTs: 1, error: null, heads: { [head]: true } } });
    const q = (p, extra = '') => call(srv.port, { path: `/api/clients/${clientId}/git/log?path=${encodeURIComponent(p)}${extra}` });

    const ok = await q('/work/widgets');
    assert.equal(ok.status, 200, ok.body);
    const body = ok.json();
    assert.deepEqual({ path: body.path, remote: body.remote, source: body.source, ref: body.ref }, { path: '/work/widgets', remote: 'https://github.com/Acme/widgets.git', source: 'clone', ref: 'refs/heads/main' });
    assert.deepEqual(body.commits.map((c) => c.subject), ['second commit', 'first commit']);
    assert.equal(body.commits[0].sha, head);
    assert.equal(body.commits[0].author, 'T');
    assert.ok(Number.isFinite(body.commits[0].ts) && body.commits[0].ts > 1_000_000_000_000, 'ts is epoch milliseconds');
    assert.equal((await q('/work/widgets', '&n=1')).json().commits.length, 1);
    assert.equal((await q('/work/widgets', '&n=1000')).status, 400);
    assert.equal((await q('/work/widgets', '&n=abc')).status, 400);
    assert.equal((await q('/work/widgets', '&n=0')).status, 400);

    assert.equal((await q('/work/not-reported')).status, 404);
    assert.equal((await call(srv.port, { path: `/api/clients/${clientId}/git/log` })).status, 404, 'no path');
    assert.equal((await call(srv.port, { path: '/api/clients/cli_unknown0000000000/git/log?path=/work/widgets' })).status, 404);
    const noCopy = await q('/work/nocopy');
    assert.equal(noCopy.status, 409);
    assert.equal(noCopy.json().error, 'no server copy for github.com/Acme/unseen');
    assert.equal((await q('/work/noremote')).status, 409);
    assert.equal((await q('/work/det')).status, 409, 'detached');
    assert.equal((await q('/work/other')).status, 409, 'branch not on the server');
    assert.equal((await q('/work/badbranch')).status, 409, 'a branch name that could be an option is never passed to git');
  });
});

test('log from a server checkout reads refs/remotes/origin/<branch> and ignores a state path that is not the checkout', { skip: SKIP }, async () => {
  await withServer(async ({ srv, store, env }) => {
    const { clientId, token } = pair(store, { name: 'laptop' });
    const src = mkTmp('co');
    git(src, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(src, 'a.txt'), '1');
    git(src, 'add', '.'); git(src, 'commit', '-q', '-m', 'only commit');
    const co = mkTmp('checkout');
    git(co, 'clone', '-q', src, '.');
    fs.mkdirSync(path.join(env.GLMPS_STATE_DIR, 'residency'), { recursive: true });
    fs.writeFileSync(path.join(env.GLMPS_STATE_DIR, 'residency', 'current.json'), JSON.stringify({ ts: 1, rows: [{ repo: 'widgets', path: co, remote: 'https://github.com/Acme/widgets.git' }] }));
    await call(srv.port, { method: 'POST', path: '/api/tap/git', token, body: { repos: [row()] } });
    writeState(env, { 'github.com/Acme/widgets': { source: 'checkout', path: path.join(os.tmpdir(), 'somewhere-else'), lastFetchTs: null, error: null, heads: {} } });
    const res = await call(srv.port, { path: `/api/clients/${clientId}/git/log?path=${encodeURIComponent('/work/widgets')}` });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json().ref, 'refs/remotes/origin/main');
    assert.equal(res.json().source, 'checkout');
    assert.deepEqual(res.json().commits.map((c) => c.subject), ['only commit']);
  });
});
