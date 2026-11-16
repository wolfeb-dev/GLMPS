import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';

const OLD_SID = '11111111-2222-4333-8444-555555555555';

async function withServer(fn, { config } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-role-launch-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  const configFile = path.join(stateDir, 'no-config.json');
  if (config) fs.writeFileSync(configFile, JSON.stringify(config));
  const h = await startServer({ port: 0, env, configFile });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const patch = (p, obj) => j(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try { await fn({ post, patch, h, stateDir }); }
  finally { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(claudeDir, { recursive: true, force: true }); }
}

function settingsOf(seeded) {
  const m = /--settings (?:"([^"]+)"|(\S+))/.exec(seeded);
  assert.ok(m, `launch command should carry --settings <file>: ${seeded}`);
  return JSON.parse(fs.readFileSync(m[1] ?? m[2], 'utf8'));
}

test('a runner launch passes per-role worker settings: gh pr merge denied, GLMPS_ROLE=worker', async () => {
  await withServer(async ({ post, h }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const launch = h.lastDryRunLaunch();
    assert.ok(launch);
    const s = settingsOf(launch.seeded);
    assert.deepEqual(s.permissions.deny, ['Bash(gh pr merge:*)', 'Bash(gh pr merge *)']);
    assert.equal(s.env.GLMPS_ROLE, 'worker');
    assert.equal(s.env.GLMPS_INTEGRATION_BRANCHES, 'main,master,glmps2/main');
    assert.equal(s.env.GLMPS_CARD_ID, 'glmps-1', 'the denial feed finds the card outside the runner branch');
    assert.ok(/--session-id \S+/.test(launch.seeded), 'existing args are intact');
  });
});

test('a resumed session is also launched with the worker settings', async () => {
  await withServer(async ({ post, patch, h, stateDir }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    const keptDir = fs.mkdtempSync(path.join(stateDir, 'kept-'));
    backlogStore.setRunSessionIn(stateDir, 'glmps-1', {
      sessionId: OLD_SID, launcher: 'native-terminal',
      worktree: { dir: keptDir, branch: 'glmps-runner/p/glmps-1', repo: 'R' }, recordedTs: Date.now(), purgedTs: null,
    });
    await patch('/api/backlog/glmps-1', { state: 'idle' });
    assert.equal((await h.relaunchJobNow('glmps-1', { resume: { sessionId: OLD_SID }, note: 'x', reason: null })).ok, true);
    const launch = h.lastDryRunLaunch();
    assert.match(launch.seeded, new RegExp(`--resume ${OLD_SID}\\b`));
    assert.equal(settingsOf(launch.seeded).env.GLMPS_ROLE, 'worker');
  });
});

test('the integrationBranches config key reaches the session settings', async () => {
  await withServer(async ({ post, h }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    assert.equal(settingsOf(h.lastDryRunLaunch().seeded).env.GLMPS_INTEGRATION_BRANCHES, 'main,trunk');
  }, { config: { integrationBranches: ['main', 'trunk'] } });
});

test('a reviewer launch carries GLMPS_ROLE=reviewer and GLMPS_REVIEW_HEAD', async () => {
  await withServer(async ({ post, h }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    const r = await h.launchJobForTest('glmps-1', { role: 'reviewer', reviewHead: 'glmps-runner/p/glmps-1' });
    assert.ok(r);
    const s = settingsOf(h.lastDryRunLaunch().seeded);
    assert.equal(s.env.GLMPS_ROLE, 'reviewer');
    assert.equal(s.env.GLMPS_REVIEW_HEAD, 'glmps-runner/p/glmps-1');
  });
});
