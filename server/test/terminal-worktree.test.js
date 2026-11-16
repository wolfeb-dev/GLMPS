// server/test/terminal-worktree.test.js
// Integration coverage for the opt-in "isolate in a git worktree" launcher
// option (glmps-71 A2): POST /api/terminal with isolate:true should provision
// a private worktree and rewrite record.cwd before it's queued, and must
// fail open (launch in the original cwd) on any git error. Skips gracefully
// if git is unavailable in this environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }); }

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// A real, committed git repo to launch a terminal "in".
function makeRepo() {
  const repo = tmp('mc-termwt-repo-');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  return repo;
}

async function withServer({ worktreesDir }, fn) {
  const stateDir = tmp('mc-termwt-state-');
  const claudeDir = tmp('mc-termwt-claude-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  if (worktreesDir) env.GLMPS_WORKTREES_DIR = worktreesDir;
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir(), os.homedir()] }));
  const h = await startServer({ port: 0, env, configFile });
  const base = `http://127.0.0.1:${h.port}`;
  const post = async (p, o) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: JSON.stringify(o) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ post, h }); }
  finally {
    await h.close?.();
    try { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    try { fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
}

test('isolate:true provisions a worktree and queues the request with cwd rewritten to it', { skip: !gitAvailable() ? 'git not available' : false }, async () => {
  const repo = makeRepo();
  const worktreesDir = tmp('mc-termwt-wts-');
  try {
    await withServer({ worktreesDir }, async ({ post, h }) => {
      const { status, body } = await post('/api/terminal', { terminal: 'Claude', cwd: repo, isolate: true });
      assert.equal(status, 200);
      assert.equal(body.launched, true);
      const record = { cwd: body.cwd, worktree: body.worktree ?? undefined };
      assert.equal(path.resolve(h.dryRunLaunches.at(-1).cwd), path.resolve(body.cwd));
      assert.notEqual(path.resolve(record.cwd), path.resolve(repo), 'cwd was rewritten to an isolated worktree');
      assert.ok(fs.existsSync(record.cwd), 'worktree dir exists on disk');
      assert.ok(fs.existsSync(path.join(record.cwd, '.git')), 'worktree is a real git worktree');
      assert.ok(fs.existsSync(path.join(record.cwd, 'README.md')), 'seeded file present in the isolated checkout');
      assert.ok(record.worktree, 'record stamps worktree metadata');
      assert.match(record.worktree.branch, /^session\//);
      assert.equal(path.resolve(record.worktree.parent), path.resolve(repo));

      const branches = git(repo, 'branch', '--list', 'session/*');
      assert.match(branches, /session\//);
    });
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    try { fs.rmSync(worktreesDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
});

test('isolate:true on a non-git cwd is a no-op (fail-open, launches in the given cwd)', { skip: !gitAvailable() ? 'git not available' : false }, async () => {
  const plainDir = tmp('mc-termwt-plain-');
  const worktreesDir = tmp('mc-termwt-wts2-');
  try {
    await withServer({ worktreesDir }, async ({ post, h }) => {
      const { status, body } = await post('/api/terminal', { terminal: 'Claude', cwd: plainDir, isolate: true });
      assert.equal(status, 200);
      assert.equal(body.launched, true);
      const record = { cwd: body.cwd, worktree: body.worktree ?? undefined };
      assert.equal(path.resolve(h.dryRunLaunches.at(-1).cwd), path.resolve(body.cwd));
      assert.equal(path.resolve(record.cwd), path.resolve(plainDir), 'cwd left unchanged - not a git repo');
      assert.equal(record.worktree, undefined);
    });
  } finally {
    try { fs.rmSync(plainDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    try { fs.rmSync(worktreesDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
});

// in a test process, isolate:true against a real
// (non-temp) target is refused with a named reason before any git write. The
// target is the home directory: real, never under os.tmpdir(), and (checked
// below) not itself a git repo, so even a missing guard could not reach a
// `git worktree add` there - the refusal must come before the .git check.
const HOME_HAS_GIT = fs.existsSync(path.join(os.homedir(), '.git'));
test('M5: isolate:true against a real (non-temp) target is refused in a test process, before any git write', { skip: HOME_HAS_GIT ? 'home directory is a git repo; refusing to point a test at it' : false }, async () => {
  const worktreesDir = tmp('mc-termwt-wts4-');
  try {
    resetAdapterHealth();
    await withServer({ worktreesDir }, async ({ post, h }) => {
      const { status, body } = await post('/api/terminal', { terminal: 'Claude', cwd: os.homedir(), isolate: true });
      assert.equal(status, 409, `refused, got ${status} ${JSON.stringify(body)}`);
      assert.match(body.error, /test process/);
      assert.equal(h.dryRunLaunches.length, 0, 'no launch was queued');
      assert.equal(fs.readdirSync(worktreesDir).length, 0, 'no worktree provisioned');
      assert.ok(adapterHealth()['terminal-isolate-test-guard']?.misses >= 1, 'the refusal is reported with a named reason');
    });
  } finally {
    try { fs.rmSync(worktreesDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
});

test('isolate omitted (default off) launches in the shared cwd unchanged', { skip: !gitAvailable() ? 'git not available' : false }, async () => {
  const repo = makeRepo();
  const worktreesDir = tmp('mc-termwt-wts3-');
  try {
    await withServer({ worktreesDir }, async ({ post, h }) => {
      const { status, body } = await post('/api/terminal', { terminal: 'Claude', cwd: repo });
      assert.equal(status, 200);
      assert.equal(body.launched, true);
      const record = { cwd: body.cwd, worktree: body.worktree ?? undefined };
      assert.equal(path.resolve(h.dryRunLaunches.at(-1).cwd), path.resolve(body.cwd));
      assert.equal(path.resolve(record.cwd), path.resolve(repo));
      assert.equal(record.worktree, undefined);
      assert.equal(fs.readdirSync(worktreesDir).length, 0, 'no worktree provisioned');
    });
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    try { fs.rmSync(worktreesDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
});
