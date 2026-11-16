// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-git-client.test.js
// The tap's git summary watcher (card glmps-2-0-runtime-40): repo discovery,
// per-repo summaries from a fake git, credential stripping, and the shipping
// rules (post on change or every 10 minutes, stop on 401/426, back off on failure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stripUserinfo, resolveRepoSettings, discoverRepos, summarizeRepo, createGitWatcher, GIT_REPEAT_MS, GIT_MAX_REPOS,
} from '../../taps/tap-git.js';
import { BACKOFF_MIN_MS } from '../../taps/tap-shipper.js';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mk = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mc-tapgit-${tag}-`)); tmpDirs.push(d); return d; };
const CREDS = { config: { server: 'http://100.64.0.1:8123' }, token: 'tok' };
const OID = 'a'.repeat(40);
const fwd = (p) => p.replace(/\\/g, '/');

function reposIn(root, names) {
  for (const n of names) fs.mkdirSync(path.join(root, n, '.git'), { recursive: true });
}

// A fake git: status output and remote url per repo dir.
function fakeRun(table) {
  const calls = [];
  const run = async (dir, args) => {
    calls.push([dir, ...args]);
    const row = table[fwd(dir)] ?? {};
    if (args.includes('status')) {
      if (row.statusError) return { ok: false, stdout: '', stderr: row.statusError };
      return { ok: true, stdout: row.status ?? `# branch.oid ${OID}\n# branch.head main\n# branch.ab +1 -2\n? new.txt\n`, stderr: '' };
    }
    if (row.remote === undefined) return { ok: false, stdout: '', stderr: '' };
    return { ok: true, stdout: `${row.remote}\n`, stderr: '' };
  };
  return { run, calls };
}

test('stripUserinfo removes credentials from every remote form and leaves the rest alone', () => {
  assert.equal(stripUserinfo('https://user:token@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(stripUserinfo('https://tok@github.com/o/r'), 'https://github.com/o/r');
  assert.equal(stripUserinfo('ssh://git:pw@github.com/o/r.git'), 'ssh://github.com/o/r.git');
  assert.equal(stripUserinfo('git@github.com:o/r.git'), 'git@github.com:o/r.git', 'scp form carries a user, not a secret');
  assert.equal(stripUserinfo('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(stripUserinfo(''), null);
  assert.equal(stripUserinfo(null), null);
});

test('resolveRepoSettings prefers tap-config, then the client settings.json, then the process env', () => {
  const home = mk('home');
  const claudeDir = mk('claude');
  const sep = path.delimiter;
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { GLMPS_PROJECT_ROOTS: `/s1${sep}/s2` } }));
  assert.deepEqual(resolveRepoSettings({ home, claudeDir, env: { GLMPS_PROJECT_ROOTS: '/p1' } }), { roots: ['/s1', '/s2'], exclude: [] });
  fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ repoRoots: ['/c1'], repoExclude: ['/c1/skip'] }));
  assert.deepEqual(resolveRepoSettings({ home, claudeDir, env: {} }), { roots: ['/c1'], exclude: ['/c1/skip'] });
  fs.rmSync(path.join(home, 'tap-config.json'));
  fs.rmSync(path.join(claudeDir, 'settings.json'));
  assert.deepEqual(resolveRepoSettings({ home, claudeDir, env: { GLMPS_PROJECT_ROOTS: `/p1${sep}/p2` } }), { roots: ['/p1', '/p2'], exclude: [] });
  assert.deepEqual(resolveRepoSettings({ home, claudeDir, env: {} }), { roots: [], exclude: [] });
});

test('discoverRepos lists immediate children with .git, marks a .git file as a worktree, applies the exclude list and the cap', () => {
  const root = mk('root');
  reposIn(root, ['alpha', 'beta', 'skipme']);
  fs.mkdirSync(path.join(root, 'plain'));
  fs.mkdirSync(path.join(root, 'wt'));
  fs.writeFileSync(path.join(root, 'wt', '.git'), 'gitdir: /elsewhere\n');
  const found = discoverRepos({ roots: [root], exclude: [path.join(root, 'SKIPME')] });
  assert.deepEqual(found.repos.map((r) => [path.basename(r.path), r.worktree]), [['alpha', false], ['beta', false], ['wt', true]]);
  assert.equal(found.skipped, 0);
  assert.ok(found.repos.every((r) => !r.path.includes('\\')), 'paths are slash-normalised');

  const big = mk('big');
  reposIn(big, Array.from({ length: GIT_MAX_REPOS + 5 }, (_, i) => `r${String(i).padStart(4, '0')}`));
  const capped = discoverRepos({ roots: [big], exclude: [] });
  assert.equal(capped.repos.length, GIT_MAX_REPOS);
  assert.equal(capped.skipped, 5);
});

test('summarizeRepo turns status and remote output into a row, with credentials stripped', async () => {
  const { run, calls } = fakeRun({ '/r/a': { remote: 'https://me:secret@github.com/o/a.git' } });
  const row = await summarizeRepo({ path: '/r/a', worktree: false }, run);
  assert.deepEqual(row, { path: '/r/a', branch: 'main', head: OID, detached: false, worktree: false, ahead: 1, behind: 2, dirty: 1, remote: 'https://github.com/o/a.git', error: null });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c[1] === '--no-optional-locks'));
});

test('summarizeRepo: no remote is null, detached has no branch, a failed status is an error row', async () => {
  const detached = fakeRun({ '/r/d': { status: `# branch.oid ${OID}\n# branch.head (detached)\n` } });
  assert.deepEqual(await summarizeRepo({ path: '/r/d', worktree: true }, detached.run), { path: '/r/d', branch: null, head: OID, detached: true, worktree: true, ahead: 0, behind: 0, dirty: 0, remote: null, error: null });
  const bad = fakeRun({ '/r/x': { statusError: `fatal: detected dubious ownership\n${'x'.repeat(600)}` } });
  const row = await summarizeRepo({ path: '/r/x', worktree: false }, bad.run);
  assert.equal(row.branch, null); assert.equal(row.head, null); assert.equal(row.dirty, 0); assert.equal(row.remote, null);
  assert.equal(row.error, 'fatal: detected dubious ownership');
  const thrown = await summarizeRepo({ path: '/r/t', worktree: false }, async () => { throw new Error(`boom${'y'.repeat(400)}`); });
  assert.ok(thrown.error.length <= 300 && thrown.error.startsWith('boom'));
});

function setup({ table = {}, fetch, roots } = {}) {
  const root = mk('w');
  reposIn(root, ['one', 'two']);
  const t = { now: 1_000_000 };
  const posts = [];
  const git = fakeRun(table);
  const fetchFn = fetch ?? (async (url, init) => { posts.push({ url, init, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ ok: true }) }; });
  const watcher = createGitWatcher({
    getCreds: () => CREDS, getSettings: () => ({ roots: roots ?? [root], exclude: [] }), run: git.run, fetch: fetchFn, now: () => t.now, log: () => {},
  });
  return { watcher, t, posts, git, root };
}

test('a scan posts the repo list, then stays quiet until something changes or 10 minutes pass', async () => {
  const s = setup();
  const first = await s.watcher.tick();
  assert.equal(first.posted, true);
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].url, 'http://100.64.0.1:8123/api/tap/git');
  assert.equal(s.posts[0].init.headers.authorization, 'Bearer tok');
  assert.ok(s.posts[0].init.headers[TAP_PROTOCOL_HEADER]);
  assert.deepEqual(s.posts[0].body.repos.map((r) => path.basename(r.path)), ['one', 'two']);
  assert.equal(s.posts[0].body.scannedTs, 1_000_000);

  s.t.now += 60_000;
  assert.equal((await s.watcher.tick()).posted, false, 'unchanged within the beat');
  assert.equal(s.posts.length, 1);

  s.t.now += GIT_REPEAT_MS;
  assert.equal((await s.watcher.tick()).posted, true, 'freshness beat');
  assert.equal(s.posts.length, 2);

  const st = s.watcher.status();
  assert.equal(st.repos, 2); assert.equal(st.skipped, 0); assert.equal(st.lastError, null);
  assert.equal(st.lastPostTs, s.t.now); assert.equal(st.lastScanTs, s.t.now);
});

test('a changed summary posts at once', async () => {
  const table = {};
  const s = setup({ table });
  await s.watcher.tick();
  s.t.now += 60_000;
  table[fwd(path.join(s.root, 'two'))] = { status: ['# branch.oid ' + 'c'.repeat(40), '# branch.head main', ''].join(String.fromCharCode(10)) };
  assert.equal((await s.watcher.tick()).posted, true);
  assert.equal(s.posts.length, 2);
  assert.equal(s.posts[1].body.repos.find((r) => r.path.endsWith('/two')).head, 'c'.repeat(40));
});

test('401 and 426 stop the watcher until resume; other failures back off and retry the same summary', async () => {
  let status = 401;
  const s = setup({ fetch: async () => ({ status, json: async () => ({}) }) });
  assert.deepEqual(await s.watcher.tick(), { posted: false, stopped: 'unpaired' });
  assert.deepEqual(await s.watcher.tick(), { skipped: 'unpaired' });
  assert.equal(s.watcher.status().state, 'unpaired');
  status = 426;
  s.watcher.resume();
  assert.equal((await s.watcher.tick()).stopped, 'protocol-too-old');
  status = 500;
  s.watcher.resume();
  const failed = await s.watcher.tick();
  assert.equal(failed.posted, false); assert.equal(failed.backoffMs, BACKOFF_MIN_MS);
  assert.deepEqual(await s.watcher.tick(), { skipped: 'backoff' });
  assert.equal(s.watcher.status().state, 'backoff');
  s.t.now += BACKOFF_MIN_MS + 1;
  status = 200;
  assert.equal((await s.watcher.tick()).posted, true, 'the unaccepted summary is retried');
  assert.equal(s.watcher.status().state, 'ok');
  assert.equal(s.watcher.status().lastError, null);
});

test('a scan never overlaps the previous one, and with no credentials nothing runs', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({ fetch: async () => { await gate; return { status: 200, json: async () => ({}) }; } });
  const first = s.watcher.tick();
  assert.equal(s.watcher.busy(), true);
  assert.deepEqual(await s.watcher.tick(), { skipped: 'in-flight' });
  release();
  await first;
  assert.equal(s.watcher.busy(), false);
  const idle = createGitWatcher({ getCreds: () => null, getSettings: () => ({ roots: [], exclude: [] }), run: async () => ({ ok: false }), log: () => {} });
  assert.deepEqual(await idle.tick(), { skipped: 'no-credentials' });
});

test('no repo roots is a quiet no-op that still reports an empty list once', async () => {
  const s = setup({ roots: [] });
  const r = await s.watcher.tick();
  assert.equal(r.posted, true);
  assert.deepEqual(s.posts[0].body.repos, []);
  assert.equal(s.git.calls.length, 0);
});
