// glmps-2-0-41 branches runner worktrees from the fetched upstream. In service
// mode the fetch needs the operator's credentials, so it is a gitops record the
// desktop shell runs; with no shell the launch is fail-open and starts from the
// local HEAD, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer } from '../server.js';
import { fakeShell } from './helpers/fake-gitops-shell.js';
import { waitFor } from './helpers/wait-for.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

function makeRepo() {
  const repo = tmp('mc-wtshell-repo-');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  return repo;
}

// Two races under a loaded test run (card glmps-2-0-runtime-120). The server's
// own 5 s runner tick could run between creating the card and the test's
// first tick, start and finish the fetch, and so launch on what the test calls
// its first tick; ticks are the test's alone here. And with the stand-in shell
// running, the upstream probe's claim wait (min(3000, this)) was 150 ms, which
// the shell's 5 ms poll could slip past: the probe went NO_SHELL and the
// worktree started at the stale local HEAD. So the short claim wait is only
// for the test with no shell; a shell that is present never reaches the
// production wait.
async function withServiceRepo(fn, { shellClaimWaitMs } = {}) {
  const repo = makeRepo();
  const project = path.basename(repo);
  const stateDir = tmp('mc-wtshell-state-');
  const claudeDir = tmp('mc-wtshell-claude-');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [repo] } }));
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, ...(shellClaimWaitMs ? { mergeQueue: { shellClaimWaitMs } } : {}) }));
  const env = { ...process.env, GLMPS_SERVICE: '1', GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_UNMERGED_SCAN: 'off', GLMPS_WORKTREES_DIR: path.join(stateDir, 'wts') };
  const h = await startServer({ port: 0, pollMs: 25, env, configFile });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const api = {
    get: (p) => j(p),
    post: (p, o) => j(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: JSON.stringify(o) }),
  };
  try { await fn({ ...api, h, repo, project }); }
  finally {
    await h.close?.();
    for (const d of [repo, stateDir, claudeDir]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* handle held */ } }
  }
}

test('service mode: the first tick asks the shell to fetch, the next branches the worktree from the fetched upstream', async (t) => {
  await withServiceRepo(async ({ get, post, h, repo, project }) => {
    const upstream = makeRepo();
    try {
      git(repo, 'remote', 'add', 'origin', upstream);
      git(repo, 'fetch', '-q', 'origin');
      const upBranch = git(upstream, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      git(repo, 'branch', '-q', '-u', `origin/${upBranch}`);
      fs.writeFileSync(path.join(upstream, 'merged-later.txt'), 'x\n');
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-q', '-m', 'merged after the local checkout last pulled');
      const fresh = git(upstream, 'rev-parse', 'HEAD').trim();

      // The stand-in shell does what the real one would: run the allowlisted git in the repo.
      const shell = fakeShell(h.launchBroker, (op) => {
        const out = execFileSync('git', ['-C', op.cwd, ...op.args], { encoding: 'utf8' });
        return { stdout: out };
      });
      t.after(() => shell.stop());
      await post('/api/runner/config', { enabled: true, useWorktrees: true });
      const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-fresh', prompt: 'do it', project });
      await h.runnerTick();
      assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'the launch waits for the fetch');
      await waitFor(() => shell.seen.some((o) => o.args?.[0] === 'fetch'), { message: 'the shell to run the fetch' });
      // The fetch result reaches the runner asynchronously; each tick before
      // that only defers the launch again, so tick until the card is claimed.
      const entry = await waitFor(async () => { await h.runnerTick(); return (await get('/api/runner')).body.ledger[card.id]; }, { intervalMs: 25, message: 'the card to be claimed' }).catch(() => undefined);
      shell.stop();
      assert.ok(entry?.worktree, 'card was claimed into a worktree');
      assert.equal(git(entry.worktree.dir, 'rev-parse', 'HEAD').trim(), fresh, 'worktree starts at the upstream tip');
    } finally {
      try { fs.rmSync(upstream, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* handle held */ }
    }
  });
});

test('service mode: a detached clone branches from the remote default branch the shell fetched (card glmps-2-0-159)', async (t) => {
  await withServiceRepo(async ({ get, post, h, repo, project }) => {
    const upstream = makeRepo();
    try {
      git(repo, 'remote', 'add', 'origin', upstream);
      git(repo, 'fetch', '-q', 'origin');
      git(repo, 'remote', 'set-head', 'origin', '-a');
      git(repo, 'checkout', '-q', '--detach');
      fs.writeFileSync(path.join(upstream, 'merged-later.txt'), 'x\n');
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-q', '-m', 'merged after the clone last moved');
      const fresh = git(upstream, 'rev-parse', 'HEAD').trim();

      // Like the real shell, report a failing git (no upstream) as a status, not a throw.
      const shell = fakeShell(h.launchBroker, (op) => {
        const r = spawnSync('git', ['-C', op.cwd, ...op.args], { encoding: 'utf8', windowsHide: true });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      });
      t.after(() => shell.stop());
      await post('/api/runner/config', { enabled: true, useWorktrees: true });
      const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-detached', prompt: 'do it', project });
      await h.runnerTick();
      await waitFor(() => shell.seen.some((o) => o.args?.[0] === 'fetch'), { message: 'the shell to run the fetch' });
      const entry = await waitFor(async () => { await h.runnerTick(); return (await get('/api/runner')).body.ledger[card.id]; }, { intervalMs: 25, message: 'the card to be claimed' }).catch(() => undefined);
      shell.stop();
      assert.ok(entry?.worktree, 'card was claimed into a worktree');
      assert.equal(git(entry.worktree.dir, 'rev-parse', 'HEAD').trim(), fresh, 'worktree starts at the remote default tip');
    } finally {
      try { fs.rmSync(upstream, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* handle held */ }
    }
  });
});

test('service mode with no shell: the launch is fail-open and starts from the local HEAD after one claim wait', async () => {
  await withServiceRepo(async ({ get, post, h, repo, project }) => {
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-local', prompt: 'do it', project });
    await h.runnerTick();
    const entry = await waitFor(async () => { await h.runnerTick(); return (await get('/api/runner')).body.ledger[card.id]; }, { intervalMs: 25, message: 'the card to be claimed' }).catch(() => undefined);
    assert.ok(entry?.worktree, 'launch is not blocked by the missing shell');
    assert.equal(git(entry.worktree.dir, 'rev-parse', 'HEAD').trim(), head);
    assert.equal(h.launchBroker.pending().length, 0, 'the unclaimed fetch is not left for a late shell');
  }, { shellClaimWaitMs: 150 });
});
