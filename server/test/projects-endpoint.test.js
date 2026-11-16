import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

const scratchUuid = '0115959d-9e75-46da-85d0-b9d0f007ae26';
const strayUuid = '241b9972-7013-4b55-95a6-112db408126e';

let stateDir;
let claudeDir;
let claudeJson;
let antigravityDir;
let strayRoot;
let privateDirsFile;
let h;

before(async () => {
  stateDir = tmp('mc-state-');
  claudeDir = tmp('mc-claude-');
  claudeJson = claudeDir + '.json';
  antigravityDir = tmp('mc-ag-');
  strayRoot = tmp('mc-stray-');
  privateDirsFile = path.join(stateDir, 'private-dirs.json');

  const scratchDir = path.join(antigravityDir, 'brain', scratchUuid);
  fs.mkdirSync(path.join(scratchDir, '.git'), { recursive: true });
  const strayDir = path.join(strayRoot, strayUuid);
  fs.mkdirSync(path.join(strayDir, '.git'), { recursive: true });

  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'index.json'), JSON.stringify([
    { id: 'ag-session-scratch', tool: 'antigravity', cwd: scratchDir, lastTs: Date.now() },
    { id: 'ag-session-stray', tool: 'antigravity', cwd: strayDir, lastTs: Date.now() },
  ]));

  fs.writeFileSync(claudeJson, JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [] } }));

  const env = {
    ...process.env,
    GLMPS_STATE_DIR: stateDir,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_ANTIGRAVITY_DIR: antigravityDir,
    GLMPS_PRIVATE_DIRS_FILE: privateDirsFile,
    GLMPS_UNMERGED_SCAN: 'off',
  };
  delete env.GLMPS_AUTO_TRUST;
  h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
});

after(async () => {
  await h?.close?.();
  for (const d of [stateDir, claudeDir, antigravityDir, strayRoot]) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  fs.rmSync(claudeJson, { force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(stateDir, 'backlog'), { recursive: true, force: true });
  fs.rmSync(path.join(stateDir, 'backlog.json'), { force: true });
  fs.rmSync(privateDirsFile, { force: true });
  fs.writeFileSync(claudeJson, JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [] } }));
});

async function withServer(fn) {
  const base = `http://127.0.0.1:${h.port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  await fn({ get, stateDir });
}

test('GET /api/projects returns summarized known repos', async () => {
  await withServer(async ({ get, stateDir }) => {
    // Seed a backlog item under the server's own repo basename so backlogOpen >= 1
    const selfKey = path.basename(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..'));
    backlogStore.addItemTo(stateDir, { project: selfKey, title: 'seeded test item' });

    const res = await get('/api/projects');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.projects), 'projects is an array');

    const self = res.body.projects.find(p => p.key === selfKey);
    assert.ok(self, `server own repo present (key=${selfKey})`);
    assert.equal(typeof self.sessionCount, 'number');
    assert.ok('branch' in self, 'branch field present');
    assert.ok(self.graph && 'nodes' in self.graph, 'graph.nodes present');
    assert.ok(self.backlogOpen >= 1, `backlogOpen=${self.backlogOpen} should be >= 1`);

    // Structural checks on all entries
    for (const p of res.body.projects) {
      assert.ok(typeof p.key === 'string' && p.key.length > 0, 'key is non-empty string');
      assert.ok(typeof p.name === 'string', 'name is string');
      assert.ok(typeof p.path === 'string', 'path is string');
      assert.ok(typeof p.sessionCount === 'number', 'sessionCount is number');
      assert.ok(typeof p.liveCount === 'number', 'liveCount is number');
      assert.ok('lastTs' in p, 'lastTs field present');
      assert.ok('branch' in p, 'branch field present');
      assert.ok(p.graph && typeof p.graph.nodes === 'number', 'graph.nodes is number');
      assert.ok(typeof p.graph.needsUpdate === 'boolean', 'graph.needsUpdate is boolean');
      assert.ok(typeof p.backlogOpen === 'number', 'backlogOpen is number');
    }
  });
});

// idle is deliberately NOT closed
// (backlog-store.js CLOSED_STATES), so an idle card must still count toward
// backlogOpen -- it is reopenable, not finished.
test('GET /api/projects counts an idle card as open backlog, a done one as closed', async () => {
  await withServer(async ({ get, stateDir }) => {
    const selfKey = path.basename(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..'));
    const idle = backlogStore.addItemTo(stateDir, { project: selfKey, title: 'idle open card' }).item;
    backlogStore.updateItemIn(stateDir, idle.id, { state: 'idle' });
    const done = backlogStore.addItemTo(stateDir, { project: selfKey, title: 'done closed card' }).item;
    backlogStore.updateItemIn(stateDir, done.id, { state: 'done' });

    const res = await get('/api/projects');
    const self = res.body.projects.find(p => p.key === selfKey);
    assert.ok(self, `server own repo present (key=${selfKey})`);
    assert.equal(self.backlogOpen, 1, 'the idle card counts as open; the done card does not');
  });
});

// glmps-73: Antigravity CLI (agy) auto-git-inits + snapshot-commits inside its
// own per-session scratch dir (~/.gemini/<tool>/brain/<uuid>), giving that
// scratch dir a real .git directory. That defeats the plain .git-existence
// filter and pollutes /api/projects with dozens of UUID-named "projects".
// This test seeds that exact shape (session cwd = brain/<uuid> WITH a real
// .git dir) plus a bare-UUID cwd elsewhere, and asserts both are excluded
// while a real repo reached via additionalDirectories still appears.
test('GET /api/projects excludes Antigravity/UUID scratch cwds, keeps real repos', async () => {
  const realRepo = tmp('mc-realrepo-');
  fs.mkdirSync(path.join(realRepo, '.git'), { recursive: true });

  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [realRepo.replace(/\\/g, '/')] },
  }));

  const base = `http://127.0.0.1:${h.port}`;
  try {
    const r = await fetch(base + '/api/projects');
    const body = await r.json();
    const keys = body.projects.map(p => p.key);
    assert.ok(keys.includes(path.basename(realRepo)), `real repo present (keys=${keys.join(',')})`);
    assert.ok(!keys.includes(scratchUuid), 'agy-cli brain/<uuid> scratch repo excluded');
    assert.ok(!keys.includes(strayUuid), 'bare UUID-basename cwd excluded regardless of location');
  } finally {
    fs.rmSync(realRepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Private dirs: sync-project-dirs.mjs puts every D:\ git repo into
// additionalDirectories, so `git init` on a personal directory (D:\Vault,
// personal papers) silently made it readable by every agent
// session. collectGraphRoots() is the single source for BOTH /api/projects and
// the graph/wiki rebuild allowlist (server.js: 'root not in graph allowlist'),
// so excluding private dirs there closes listing and indexing together.
test('GET /api/projects excludes a private dir but keeps its non-private sibling', async () => {
  const openRepo = tmp('mc-openrepo-');
  const privateRepo = tmp('mc-privaterepo-');
  for (const r of [openRepo, privateRepo]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });

  // Both reach the root set the same way the live D:\ repos do.
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: {
      additionalDirectories: [openRepo.replace(/\\/g, '/'), privateRepo.replace(/\\/g, '/')],
    },
  }));

  fs.writeFileSync(privateDirsFile, JSON.stringify({ private: [privateRepo.replace(/\\/g, '/')] }));

  const base = `http://127.0.0.1:${h.port}`;
  try {
    const r = await fetch(base + '/api/projects');
    const body = await r.json();
    const keys = body.projects.map(p => p.key);
    assert.ok(keys.includes(path.basename(openRepo)), `non-private repo still listed (keys=${keys.join(',')})`);
    assert.ok(!keys.includes(path.basename(privateRepo)), 'private repo excluded from /api/projects');
    // The allowlist is collectGraphRoots(), so exclusion must also make the
    // private root unbuildable - otherwise the directory could still be indexed.
    const rebuild = await fetch(base + '/api/graph/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: privateRepo }),
    });
    assert.equal(rebuild.status, 400, 'private root rejected by the graph rebuild allowlist');
  } finally {
    for (const d of [openRepo, privateRepo])
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// glmps-192: the residency feed and the unmerged-branch scan now read one
// checkout per repository, but /api/projects must stay per checkout: on the
// live box glmps and glmps-2.0-runtime are separate board projects
// that are worktrees of one repository, and collapsing them here would drop
// a project row (and its backlog count) from the navigator.
test('GET /api/projects still lists a linked worktree next to its primary repo', async () => {
  const { execFileSync } = await import('node:child_process');
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
  const holder = tmp('mc-wtdedupe-');
  const primary = path.join(holder, 'primary-repo');
  const linked = path.join(holder, 'primary-repo-wt-feature');
  fs.mkdirSync(primary);
  git(['init', '-q', '-b', 'main', primary], primary);
  git(['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], primary);
  git(['worktree', 'add', '-q', '-b', 'feature', linked], primary);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [linked.replace(/\\/g, '/'), primary.replace(/\\/g, '/')] },
  }));
  try {
    const body = await (await fetch(`http://127.0.0.1:${h.port}/api/projects`)).json();
    const keys = body.projects.map(p => p.key);
    assert.ok(keys.includes('primary-repo'), `primary listed (keys=${keys.join(',')})`);
    assert.ok(keys.includes('primary-repo-wt-feature'), 'a linked worktree is still its own project row');
  } finally {
    fs.rmSync(holder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// POST /api/projects {path} is createProject over HTTP: the dir is made, git
// init'd, registered in additionalDirectories (so GET /api/projects lists it,
// keyed by basename) and trusted in the sibling harness config.
async function withCreateServer(fn) {
  const parent = tmp('mc-newproj-');
  const base = `http://127.0.0.1:${h.port}`;
  const req = async (p, method = 'GET', body) => {
    const r = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ req, parent, privateDirsFile, claudeDir, claudeJson }); }
  finally {
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('POST /api/projects creates a project that GET /api/projects then lists', async () => {
  await withCreateServer(async ({ req, parent, claudeDir, claudeJson }) => {
    const dir = path.join(parent, 'fresh-app');
    const fwd = dir.replace(/\\/g, '/');
    const r = await req('/api/projects', 'POST', { path: dir });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.dir, fwd);
    assert.equal(r.body.initialized, true);
    assert.ok(fs.existsSync(path.join(dir, '.git')));
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.additionalDirectories, [fwd]);
    assert.equal(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[fwd].hasTrustDialogAccepted, true);
    const list = await req('/api/projects');
    assert.ok(list.body.projects.some((p) => p.key === 'fresh-app'), `listed (keys=${list.body.projects.map((p) => p.key)})`);
  });
});

test('POST /api/projects refuses a relative path with 400 and a private dir with 403', async () => {
  await withCreateServer(async ({ req, parent, privateDirsFile }) => {
    const rel = await req('/api/projects', 'POST', { path: 'relative/dir' });
    assert.equal(rel.status, 400);
    assert.match(rel.body.error, /absolute/);
    const secret = path.join(parent, 'secret');
    fs.writeFileSync(privateDirsFile, JSON.stringify({ private: [secret.replace(/\\/g, '/')] }));
    const priv = await req('/api/projects', 'POST', { path: secret });
    assert.equal(priv.status, 403);
    assert.match(priv.body.error, /private/);
    assert.ok(!fs.existsSync(secret));
  });
});
