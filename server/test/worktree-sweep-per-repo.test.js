import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';

function tmp(p) { return fs.mkdtempSync(path.join(tmpRoot(), p)); }
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }); }
function makeRepo(prefix) {
  const repo = tmp(prefix);
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  return repo;
}

// Card glmps-2-0-runtime-68 AC-4: the live kernel swept every checkout root,
// and most roots were linked worktrees of one repository, so the per-branch
// `git cherry` pass ran once per copy: ~1,500 process launches a minute, each
// created on the main thread. A repository is swept once, from its primary
// checkout.
test('the worktree sweep runs once per repository, not once per checkout of it', async () => {
  const repo = makeRepo('mc-sweep1-');
  const linked = path.join(path.dirname(repo), `${path.basename(repo)}-wt-x`);
  git(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
  const other = makeRepo('mc-sweep2-');
  const stateDir = tmp('mc-sweep-state-');
  const claudeDir = tmp('mc-sweep-claude-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  delete env.GLMPS_UNMERGED_SCAN;
  const swept = [];
  const h = await startServer({
    port: 0, env, configFile: path.join(stateDir, 'no-config.json'),
    gitRepoRootsFn: () => [linked, repo, other].map((p) => ({ project: path.basename(p), path: p })),
    sweepSessionWorktreesFn: async ({ repo: r }) => { swept.push(r); return { removed: [], kept: [] }; },
  });
  try {
    // The boot sweep has already called in; a tick may add another full pass.
    await h.sweepWorktreesTick();
    assert.deepEqual([...new Set(swept)].sort(), [repo, other].sort());
  } finally {
    await h.close?.();
    for (const d of [linked, repo, other, stateDir, claudeDir]) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }
});
