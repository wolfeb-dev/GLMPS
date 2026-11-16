// A slow git call must not stall the server: while the worktree-list git behind
// the purge route is hanging, other requests are still answered promptly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import { waitFor } from './helpers/wait-for.js';

test('a slow git call behind a request does not block a concurrent request', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nonblock-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off', GLMPS_SCUT: 'off' };
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const gitRunner = async (file, args) => {
    calls.push([file, ...args]);
    await gate;
    return { status: 1, stdout: '', stderr: 'slow git gave up' };
  };
  const h = await startServer({ port: 0, pollMs: 25, env, configFile: path.join(stateDir, 'no-config.json'), gitRunner });
  try {
    const { item } = backlogStore.addItemTo(stateDir, { title: 'job-a', prompt: 'x', project: 'p' });
    backlogStore.setRunSessionIn(stateDir, item.id, { worktree: { dir: path.join(stateDir, 'wt'), branch: 'glmps-runner/p/x', repo: path.join(stateDir, 'repo') } });
    const base = `http://127.0.0.1:${h.port}`;

    let slowSettled = false;
    const slow = fetch(`${base}/api/backlog/${item.id}/purge-worktree`, { method: 'POST' }).finally(() => { slowSettled = true; });
    await waitFor(() => calls.length === 1, { message: 'the request to reach the slow git runner' });
    assert.deepEqual(calls[0].slice(0, 2), ['git', '-C']);

    // Ordering, not a millisecond bound (card glmps-2-0-runtime-120): the git
    // call is held until release(), so /healthz answering at all proves the
    // loop was free. A loaded test run made a 1000 ms bound fail at 1850 ms.
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(slowSettled, false, '/healthz answered while the purge request was still waiting on git');

    release();
    const purge = await slow;
    assert.equal(purge.status, 409);
    assert.match((await purge.json()).error, /git refused to list worktrees: slow git gave up/, 'the git failure still surfaces as before');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// glmps-75's ECONNRESETs came from the runner tick's worktree git
// holding the loop for seconds; this pins the tick path, not just a route.
test('a slow git call inside the runner tick creating a worktree does not block a concurrent request', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nonblock-tick-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nonblock-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const claudeDir = claudeTmp();
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [repo] } }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_UNMERGED_SCAN: 'off', GLMPS_SCUT: 'off' };
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const gitRunner = async (file, args) => {
    calls.push([file, ...args]);
    await gate;
    return { status: 1, stdout: '', stderr: 'slow git gave up' };
  };
  const h = await startServer({ port: 0, pollMs: 25, env, configFile: path.join(stateDir, 'no-config.json'), gitRunner });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const cfg = await fetch(`${base}/api/runner/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, useWorktrees: true }) });
    assert.equal(cfg.status, 200);
    const { item } = backlogStore.addItemTo(stateDir, { title: 'job-tick', prompt: 'x', project: path.basename(repo), acceptanceCriteria: ['launches'] });

    let tickSettled = false;
    const tick = Promise.resolve(h.runnerTick()).catch(() => {}).finally(() => { tickSettled = true; });
    await waitFor(() => calls.some((c) => c.includes('worktree')), { message: 'the runner tick to reach the slow worktree git' });

    // Same ordering check as above: the tick is parked on git until release().
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(tickSettled, false, "/healthz answered while the tick's worktree git was still hanging");

    release();
    await tick;
    assert.equal(backlogStore.load(stateDir).items.find((i) => i.id === item.id).state, 'held', 'a failed worktree still holds the card instead of launching into the shared repo');
  } finally {
    release();
    await h.close?.();
    for (const d of [stateDir, repo]) fs.rmSync(d, { recursive: true, force: true });
  }
});
