// --apply records through the running server's API; it never writes the backlog file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { applyBackfill, makeApi, runBackfill } from '../../scripts/worktree-backfill.mjs';

const DAY = 86_400_000;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf-8' });

async function withFixture(fn) {
  const root = tmp('mc-bfapply-');
  const repo = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const worktreesDir = path.join(root, 'wts');
  fs.mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) g(repo, 'config', k, v);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'seed');
  // "Merged" is judged against origin/* only, so the seed commit goes to a remote main.
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  g(repo, 'remote', 'add', 'origin', origin);
  g(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const make = (title, edit) => {
    const { item } = backlogStore.addItemTo(stateDir, { title, prompt: 'x', project: 'p' });
    backlogStore.updateItemIn(stateDir, item.id, { state: 'done' });
    const dir = path.join(worktreesDir, 'p', item.id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    g(repo, 'worktree', 'add', '-q', '-b', `glmps-runner/p/${item.id}`, dir);
    edit?.(dir);
    backlogStore.setRunSessionIn(stateDir, item.id, { worktree: { dir, branch: `glmps-runner/p/${item.id}`, repo } });
    return { id: item.id, dir };
  };
  const paths = { stateDir, worktreesDir, projectsDir: path.join(root, 'claude-projects') };
  try { await fn({ root, repo, stateDir, paths, make }); }
  finally { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} }
}

test('apply refuses when the server cannot be reached, and changes nothing', async () => {
  await withFixture(async ({ paths, make, stateDir }) => {
    const clean = make('clean');
    const before = fs.readFileSync(path.join(stateDir, 'backlog', 'store.json'), 'utf8');
    const api = { reachable: async () => false, post: async () => { throw new Error('should not post'); } };
    await assert.rejects(applyBackfill({ paths, api, now: Date.now() + 30 * DAY }), /server is not reachable/i);
    assert.ok(fs.existsSync(clean.dir));
    assert.equal(fs.readFileSync(path.join(stateDir, 'backlog', 'store.json'), 'utf8'), before);
  });
});

test('runBackfill stays a dry run: it will not apply', async () => {
  await withFixture(async ({ paths }) => {
    assert.throws(() => runBackfill({ paths, apply: true }), /applyBackfill/);
  });
});

test('apply records through the live server, then removes only the safe worktree', async () => {
  await withFixture(async ({ paths, make, stateDir }) => {
    const clean = make('clean');
    const dirty = make('dirty', (d) => fs.writeFileSync(path.join(d, 'wip.txt'), 'x\n'));
    const claudeDir = tmp('mc-bfapply-claude-');
    const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off', GLMPS_RUNNER_DRYRUN: '1' };
    const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
    try {
      const api = makeApi(`http://127.0.0.1:${h.port}`);
      const plan = await applyBackfill({ paths, api, now: Date.now() + 30 * DAY });
      assert.deepEqual(plan.counts, { remove: 1, keep: 0, flag: 1 });
      assert.ok(!fs.existsSync(clean.dir), 'clean worktree removed');
      assert.ok(fs.existsSync(dirty.dir), 'dirty worktree kept');
      const items = backlogStore.load(stateDir).items;
      const c = items.find((i) => i.id === clean.id);
      assert.ok(c.runSession.outcome && c.runSession.purgedTs, 'recorded, then marked removed');
      assert.ok(c.devLog.some((e) => /^worktree outcome:/.test(e.text)));
      assert.ok(items.find((i) => i.id === dirty.id).devLog.some((e) => /^worktree kept: .*uncommitted/.test(e.text)));
    } finally { await h.close?.(); try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch {} }
  });
});
