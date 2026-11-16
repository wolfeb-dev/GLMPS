// Record the worktree outcome on the card before the runner removes the
// checkout, and keep (and flag, once) anything that would lose work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer } from '../server.js';
import * as runnerStore from '../lib/orchestration/runner-store.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';

function deadPid() { return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid; }
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }); }

function makeRepo() {
  const repo = tmp('mc-wtout-');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  // "Merged" is judged against origin/* only, so the seed commit must be on a remote main.
  const origin = tmp('mc-wtout-origin-');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(repo, 'branch', '-M', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return repo;
}

async function withRepoServer(fn) {
  const repo = makeRepo();
  const project = path.basename(repo);
  const stateDir = tmp('mc-wtout-state-');
  const claudeDir = tmp('mc-wtout-claude-');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [repo] } }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, pollMs: 25, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const api = {
    get: (p) => j(p),
    post: (p, o) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }),
    patch: (p, o) => j(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }),
  };
  try { await fn({ ...api, h, repo, project, stateDir }); }
  finally {
    await h.close?.();
    for (const d of [repo, stateDir, claudeDir]) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }
}

// Launch a card into its worktree, let `edit(wt)` change it, then finish the
// card with the agent provably gone so the next tick departs and reclaims it.
async function runAndDepart({ get, post, patch, h, project, stateDir }, edit = () => {}) {
  await post('/api/runner/config', { enabled: true, useWorktrees: true });
  const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
  await h.runnerTick();
  const wt = (await get('/api/runner')).body.ledger[card.id].worktree.dir;
  edit(wt);
  const ledger = runnerStore.loadLedger(stateDir);
  ledger[card.id] = { ...ledger[card.id], pid: deadPid() };
  runnerStore.saveLedger(stateDir, ledger);
  await patch(`/api/backlog/${card.id}`, { labels: ['agent:done'] });
  await h.runnerTick();
  return { id: card.id, wt };
}

const cardOf = (stateDir, id) => backlogStore.load(stateDir).items.find((i) => i.id === id);
const outcomeLines = (c) => (c.devLog ?? []).filter((e) => /^worktree outcome:/.test(e.text));
const keptLines = (c) => (c.devLog ?? []).filter((e) => /^worktree kept:/.test(e.text));

test('a clean, merged worktree is recorded on the card and then removed', async () => {
  await withRepoServer(async (ctx) => {
    const { id, wt } = await runAndDepart(ctx);
    assert.ok(!fs.existsSync(wt), 'removed');
    const c = cardOf(ctx.stateDir, id);
    assert.equal(outcomeLines(c).length, 1);
    assert.match(outcomeLines(c)[0].text, /merged true, 0 uncommitted/);
    assert.equal(c.runSession.outcome.branch, `glmps-runner/${ctx.project}/${id}`);
    assert.equal(c.runSession.outcome.dirty, 0);
    assert.ok(c.runSession.purgedTs, 'marked purged');
  });
});

test('uncommitted changes keep the worktree and flag the card once', async () => {
  await withRepoServer(async (ctx) => {
    const { id, wt } = await runAndDepart(ctx, (dir) => fs.writeFileSync(path.join(dir, 'wip.txt'), 'unsaved\n'));
    assert.ok(fs.existsSync(wt), 'kept');
    const c = cardOf(ctx.stateDir, id);
    assert.equal(c.runSession.outcome.dirty, 1, 'the record is still written');
    assert.equal(c.runSession.purgedTs ?? null, null);
    assert.equal(keptLines(c).length, 1);
    assert.match(keptLines(c)[0].text, /uncommitted/);
  });
});

test('a head that is neither pushed nor merged keeps the worktree', async () => {
  await withRepoServer(async (ctx) => {
    const { id, wt } = await runAndDepart(ctx, (dir) => {
      fs.writeFileSync(path.join(dir, 'new.txt'), 'work\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'agent work');
    });
    assert.ok(fs.existsSync(wt), 'kept');
    const c = cardOf(ctx.stateDir, id);
    assert.equal(c.runSession.outcome.merged, false);
    assert.equal(c.runSession.outcome.pushed, false);
    assert.match(keptLines(c)[0].text, /neither pushed nor merged/);
  });
});

// The sweeper asks the same gate as the runner reclaim, through its guard.
async function withSweepServer(fn) {
  const repo = makeRepo();
  const stateDir = tmp('mc-wtsw-state-');
  const claudeDir = tmp('mc-wtsw-claude-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  delete env.GLMPS_UNMERGED_SCAN;
  let sweepArgs = null;
  const h = await startServer({
    port: 0, env, configFile: path.join(stateDir, 'no-config.json'),
    gitRepoRootsFn: () => [{ project: 'p', path: repo }],
    sweepSessionWorktreesFn: async (args) => { sweepArgs = args; return { removed: [], kept: [] }; },
  });
  try { await h.sweepWorktreesTick(); await fn({ repo, stateDir, sweepArgs }); }
  finally {
    await h.close?.();
    for (const d of [repo, stateDir, claudeDir]) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }
}

function plantCard(stateDir, repo, edit) {
  const { item } = backlogStore.addItemTo(stateDir, { title: 'swept', prompt: 'x', project: 'p' });
  const branch = `glmps-runner/p/${item.id}`;
  const dir = path.join(path.dirname(repo), `${path.basename(repo)}-wt-${item.id}`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir);
  edit?.(dir);
  backlogStore.setRunSessionIn(stateDir, item.id, { worktree: { dir, branch, repo } });
  return { id: item.id, dir, branch };
}

test('sweeper guard records a card worktree outcome, approves a clean merged one, and marks it purged on removal', async () => {
  await withSweepServer(async ({ repo, stateDir, sweepArgs }) => {
    const { id, dir, branch } = plantCard(stateDir, repo);
    try {
      const v = await sweepArgs.guard({ dir, branch });
      assert.equal(v.remove, true);
      assert.equal(outcomeLines(cardOf(stateDir, id)).length, 1, 'recorded before the removal decision');
      sweepArgs.onRemove({ dir, branch, kind: 'worktree' });
      assert.ok(cardOf(stateDir, id).runSession.purgedTs);
    } finally { try { git(repo, 'worktree', 'remove', '--force', dir); } catch {} }
  });
});

test('sweeper guard refuses a dirty card worktree and flags it once across sweeps', async () => {
  await withSweepServer(async ({ repo, stateDir, sweepArgs }) => {
    const { id, dir, branch } = plantCard(stateDir, repo, (d) => fs.writeFileSync(path.join(d, 'wip.txt'), 'x\n'));
    try {
      assert.equal((await sweepArgs.guard({ dir, branch })).remove, false);
      assert.equal((await sweepArgs.guard({ dir, branch })).remove, false);
      const c = cardOf(stateDir, id);
      assert.equal(keptLines(c).length, 1, 'flagged once');
      assert.equal(outcomeLines(c).length, 1, 'unchanged facts are not re-recorded');
    } finally { try { git(repo, 'worktree', 'remove', '--force', dir); } catch {} }
  });
});

test('sweeper guard leaves a worktree that is not a card checkout to the existing rules', async () => {
  await withSweepServer(async ({ sweepArgs }) => {
    assert.equal((await sweepArgs.guard({ dir: '/nowhere/session-x', branch: 'session/p/x' })).remove, true);
    assert.equal((await sweepArgs.guard({ dir: '/nowhere/other', branch: 'glmps-runner/p/no-such-card' })).remove, true);
  });
});

test('reopen recreates a removed worktree from the recorded branch and resumes into it', async () => {
  await withRepoServer(async (ctx) => {
    const { id, wt } = await runAndDepart(ctx);
    assert.ok(!fs.existsSync(wt));
    const sessionId = '44444444-5555-4333-8444-555555555555';
    backlogStore.setRunSessionIn(ctx.stateDir, id, { sessionId, launcher: 'native-terminal' });
    await ctx.patch(`/api/backlog/${id}`, { state: 'idle' });

    const r = await ctx.h.relaunchJobNow(id, { resume: { sessionId }, note: 'one more thing', reason: null });
    assert.equal(r.ok, true, r.reason);
    assert.ok(fs.existsSync(wt), 'worktree is back at the same directory');
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), `glmps-runner/${ctx.project}/${id}`);
    const c = cardOf(ctx.stateDir, id);
    assert.equal(c.runSession.purgedTs ?? null, null, 'no longer purged');
  });
});

test('reopen recreates the worktree at the recorded head when the branch itself was deleted', async () => {
  await withRepoServer(async (ctx) => {
    const { id, wt } = await runAndDepart(ctx);
    const branch = `glmps-runner/${ctx.project}/${id}`;
    git(ctx.repo, 'branch', '-D', branch);
    const sessionId = '44444444-5555-4333-8444-555555555555';
    backlogStore.setRunSessionIn(ctx.stateDir, id, { sessionId, launcher: 'native-terminal' });
    await ctx.patch(`/api/backlog/${id}`, { state: 'idle' });
    const head = cardOf(ctx.stateDir, id).runSession.outcome.head;

    const r = await ctx.h.relaunchJobNow(id, { resume: { sessionId }, note: 'x', reason: null });
    assert.equal(r.ok, true, r.reason);
    assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), head);
  });
});

// Service mode (and any injected reviewGit) reads the facts through the shell's
// git seam, not the server's own git, which LocalSystem may be refused.
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

async function withShellGit(script, fn) {
  const repo = makeRepo();
  const stateDir = tmp('mc-wtsh-state-');
  const claudeDir = tmp('mc-wtsh-claude-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  delete env.GLMPS_UNMERGED_SCAN;
  const calls = [];
  const reviewGit = async (args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    return script(args, opts);
  };
  let sweepArgs = null;
  const h = await startServer({
    port: 0, env, configFile: path.join(stateDir, 'no-config.json'), reviewGit,
    gitRepoRootsFn: () => [{ project: 'p', path: repo }],
    sweepSessionWorktreesFn: async (args) => { sweepArgs = args; return { removed: [], kept: [] }; },
  });
  try { await h.sweepWorktreesTick(); await fn({ repo, stateDir, calls, sweepArgs }); }
  finally {
    await h.close?.();
    for (const d of [repo, stateDir, claudeDir]) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }
}

const HEAD = 'c'.repeat(40);
const readable = (args) => {
  const j = args.join(' ');
  if (j.startsWith('rev-parse HEAD')) return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
  if (j.startsWith('status --porcelain')) return { status: 0, stdout: '', stderr: '' };
  if (j.startsWith('merge-base --is-ancestor')) return { status: 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: '' };
};

test('service mode: the sweeper gate reads its facts through the shell git seam', async () => {
  await withShellGit(readable, async ({ repo, stateDir, calls, sweepArgs }) => {
    const { id, dir, branch } = plantCard(stateDir, repo);
    try {
      const v = await sweepArgs.guard({ dir, branch });
      assert.equal(v.remove, true);
      assert.ok(calls.some((c) => c.args[0] === 'status' && c.cwd === dir), 'status went through the seam, in the worktree');
      assert.equal(cardOf(stateDir, id).runSession.outcome.head, HEAD, 'the record holds what the shell reported');
    } finally { try { git(repo, 'worktree', 'remove', '--force', dir); } catch {} }
  });
});

test('service mode: a shell git that refuses keeps the worktree and reports it once', async () => {
  resetAdapterHealth();
  const refuse = () => ({ status: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository' });
  await withShellGit(refuse, async ({ repo, stateDir, sweepArgs }) => {
    const { id, dir, branch } = plantCard(stateDir, repo);
    try {
      const v = await sweepArgs.guard({ dir, branch });
      assert.deepEqual([v.remove, v.reason], [false, 'unreadable']);
      await sweepArgs.guard({ dir, branch });
      const h = adapterHealth()['worktree-outcome-unreadable'];
      assert.equal(h?.misses, 1, 'reported once, not every sweep');
      assert.match(JSON.stringify(h), /dubious ownership/);
      assert.match(JSON.stringify(h), new RegExp(id));
    } finally { try { git(repo, 'worktree', 'remove', '--force', dir); } catch {} }
  });
});

test('service mode: a shell that is down falls back to the server git', async () => {
  const down = () => { throw Object.assign(new Error('no desktop shell is connected'), { code: 'NO_SHELL' }); };
  await withShellGit(down, async ({ repo, stateDir, sweepArgs }) => {
    const { dir, branch } = plantCard(stateDir, repo);
    try {
      assert.equal((await sweepArgs.guard({ dir, branch })).remove, true, 'the server git could read it');
    } finally { try { git(repo, 'worktree', 'remove', '--force', dir); } catch {} }
  });
});

test('service mode: shell down and the server git unable to read either is unreadable, kept and reported', async () => {
  resetAdapterHealth();
  const down = () => { throw Object.assign(new Error('no desktop shell is connected'), { code: 'NO_SHELL' }); };
  await withShellGit(down, async ({ repo, stateDir, sweepArgs }) => {
    const { id, dir, branch } = plantCard(stateDir, repo);
    fs.rmSync(dir, { recursive: true, force: true }); // nothing for any git to read
    const v = await sweepArgs.guard({ dir, branch });
    assert.deepEqual([v.remove, v.reason], [false, 'unreadable']);
    assert.equal(adapterHealth()['worktree-outcome-unreadable']?.misses, 1);
    assert.match(JSON.stringify(adapterHealth()['worktree-outcome-unreadable']), new RegExp(id));
    try { git(repo, 'worktree', 'prune'); } catch {}
  });
});
