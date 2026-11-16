// Card glmps-2-0-runtime-101 (security scan F1, CWE-73): a learning-gap
// project path a client supplies names the client's disk, so the server must
// never stat it or walk its ancestors for a .git file. A UNC or device path is
// refused before any fs call for every caller, since Windows dials an SMB share
// with the service account's credentials on a plain stat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { clientMirrorDir } from '../lib/kernel/tap-mirror.js';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';

let sqliteOk = true;
try { if (!process.getBuiltinModule('node:sqlite')?.DatabaseSync) sqliteOk = false; } catch { sqliteOk = false; }
const SKIP = sqliteOk ? false : 'node:sqlite is unavailable on this Node, so kernel.db cannot open';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };

// A real dir on the server whose .git FILE points at a worktree of another
// repo: the exact shape the worktree walk resolves, so a stat would be visible
// as a folded key.
function serverWorktree(tmp) {
  const repo = path.join(tmp, 'server-repo');
  const wt = path.join(tmp, 'server-wt');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'w'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'w')}\n`);
  return { repo, wt };
}

// Records every statSync/readFileSync whose path argument mentions `marker`.
function spyFs(t, marker) {
  const hits = [];
  for (const name of ['statSync', 'readFileSync', 'existsSync', 'lstatSync', 'realpathSync']) {
    const orig = fs[name];
    t.mock.method(fs, name, function (p, ...rest) {
      if (String(p).includes(marker)) hits.push(`${name}(${p})`);
      return orig.call(this, p, ...rest);
    });
  }
  return hits;
}

test('projectKey with a client id never touches the disk and is client-namespaced', (t) => {
  const tmp = mkTmp('mc-gapclient-');
  const { wt } = serverWorktree(tmp);
  const hits = spyFs(t, tmp);
  const a = learningStore.projectKey(wt, { clientId: 'cli_aaaa' });
  const b = learningStore.projectKey(wt, { clientId: 'cli_bbbb' });
  assert.deepEqual(hits, [], 'a client-scoped key must not stat or read the path');
  assert.notEqual(a, b, 'two clients naming the same path are different projects');
  assert.match(a, /^client-cli-aaaa-/);
  assert.equal(learningStore.projectKey('D:\\repo\\.claude\\worktrees\\x', { clientId: 'cli_aaaa' }), 'client-cli-aaaa-D--repo',
    'the string-only worktree fallback still applies');
});

test('projectKey refuses UNC and device paths before any fs call, for a loopback caller too', (t) => {
  const calls = [];
  for (const name of ['statSync', 'readFileSync']) {
    const orig = fs[name];
    t.mock.method(fs, name, function (p, ...rest) {
      if (/nohost-f1/.test(String(p))) calls.push(`${name}(${p})`);
      return orig.call(this, p, ...rest);
    });
  }
  for (const p of ['\\\\nohost-f1\\share\\repo', '//nohost-f1/share/repo', '\\\\?\\C:\\nohost-f1', '\\\\.\\nohost-f1']) {
    const k = learningStore.projectKey(p);
    assert.equal(k, learningStore.normalizeProject(p), p);
  }
  assert.deepEqual(calls, []);
});

test('projectKey cache is bounded', () => {
  for (let i = 0; i < learningStore.PROJECT_KEY_CACHE_MAX + 50; i++) learningStore.projectKey(`slug-${i}`);
  assert.equal(learningStore.projectKeyCacheSize(), learningStore.PROJECT_KEY_CACHE_MAX);
  assert.equal(learningStore.projectKey('slug-5'), 'slug-5', 'an evicted key recomputes to the same value');
});

function mkEnv() {
  const tmp = mkTmp('mc-gapclient-srv-');
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const assetsDir = path.join(tmp, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  return { tmp, env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ASSETS_DIR: assetsDir, GLMPS_ACCESS_TOKEN: 'shared-remote-token' } };
}
async function withServer(pollMs, fn) {
  const { tmp, env } = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(tmp, 'config.json') });
  const srv = await startServer({ port: 0, pollMs, env, ...bind.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  // HTTPS from 127.0.0.2 (the remote path) with the client token and certificate.
  const post = (port, p, c, body) => remoteHttps(port, { method: 'POST', path: p, token: c.token, client: c, body, ca: bind.homeCaPem });
  try { await fn({ srv, store, env, tmp, post }); } finally { store.closeDb(); await srv.close(); }
}

const GAP = { code: 'ui-without-frontend-design', severity: 'warn', message: 'edited UI without the skill' };

test('POST /api/ingest/learning-gaps with a client token never stats the project path (absolute or UNC)', { skip: SKIP }, async (t) => {
  await withServer(1000, async ({ srv, store, env, tmp, post }) => {
    const me = pairWithCert(store, env.GLMPS_STATE_DIR, { name: 'laptop' });
    const { clientId } = me;
    const { wt } = serverWorktree(tmp);
    const hits = spyFs(t, 'server-wt');
    const unc = spyFs(t, 'nohost-f1');
    for (const project of [wt, '\\\\nohost-f1\\share\\repo']) {
      const r = await post(srv.port, '/api/ingest/learning-gaps', me, { project, sessionId: 's1', gaps: [GAP] });
      assert.equal(r.status, 200, r.body);
    }
    assert.deepEqual(hits, [], 'the client path was stat-ed on the server');
    assert.deepEqual(unc, [], 'the UNC path was stat-ed on the server');
    const projects = learningStore.load(env.GLMPS_STATE_DIR).items.filter((i) => i.source === 'gap').map((i) => i.project);
    assert.equal(projects.length, 2);
    for (const p of projects) assert.ok(p.startsWith(learningStore.normalizeProject(`client-${clientId}-`)), p);
  });
});

const line = (o) => JSON.stringify(o) + '\n';

test('GET /api/state?session=<clientId>:<sid> never stats the client session cwd when folding its gaps', { skip: SKIP }, async (t) => {
  await withServer(50, async ({ srv, store, env, tmp }) => {
    const { clientId } = store.pair({ name: 'laptop', actor: 'test' });
    const { wt } = serverWorktree(tmp);
    const mirror = clientMirrorDir(env.GLMPS_STATE_DIR, clientId);
    const file = path.join(mirror, 'claude', 'projects', 'p', 'gapsess.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The client's hook-fed registry names the cwd; process.pid keeps the entry live.
    fs.mkdirSync(path.join(mirror, 'claude', '.claude-manager'), { recursive: true });
    fs.writeFileSync(path.join(mirror, 'claude', '.claude-manager', 'active-sessions.json'),
      JSON.stringify([{ sessionId: 'gapsess', ppid: process.pid, cwd: wt, ts: Date.now() }]));
    const ts = '2026-10-31T10:00:00Z';
    fs.writeFileSync(file,
      line({ type: 'user', timestamp: ts, cwd: wt, sessionId: 'gapsess', message: { role: 'user', content: 'go' } })
      + line({ type: 'assistant', timestamp: ts, cwd: wt, sessionId: 'gapsess', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: path.join(wt, 'web', 'site.css'), content: 'a{}' } }] } }));
    const id = `${clientId}:gapsess`;
    const base = `http://127.0.0.1:${srv.port}`;
    const row = await waitFor(async () => (await (await fetch(`${base}/api/state`)).json()).sessions.find((s) => s.id === id), { timeoutMs: 8000, intervalMs: 40 });
    assert.equal(row.cwd, wt, 'the planted cwd reached the session row');
    const hits = spyFs(t, 'server-wt');
    const body = await waitFor(async () => {
      const b = await (await fetch(`${base}/api/state?session=${encodeURIComponent(id)}`)).json();
      return (b.gaps ?? []).length ? b : null;
    }, { timeoutMs: 8000, intervalMs: 40 });
    const gapHits = hits.filter((h) => !h.includes('site.css'));
    assert.deepEqual(gapHits, [], 'the client cwd was stat-ed on the server');
    const item = learningStore.load(env.GLMPS_STATE_DIR).items.find((i) => i.source === 'gap' && i.code === GAP.code);
    assert.ok(item, 'the gap was folded into the queue');
    assert.ok(item.project.startsWith(learningStore.normalizeProject(`client-${clientId}-`)), item.project);
    const g = body.gaps.find((x) => x.code === GAP.code);
    assert.equal(g.id, item.id, 'the callout enrichment finds the row the upsert wrote');
  });
});
