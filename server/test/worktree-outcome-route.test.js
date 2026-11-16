// POST /api/backlog/:id/worktree-outcome: how the backfill script records on the
// card through the running server instead of writing the backlog file itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';

async function withServer(fn) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wtroute-state-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wtroute-claude-'));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off', GLMPS_RUNNER_DRYRUN: '1' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try { await fn({ post, stateDir }); }
  finally { await h.close?.(); for (const d of [stateDir, claudeDir]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} } }
}

const record = { branch: 'glmps-runner/p/x', head: 'a'.repeat(40), pushed: true, merged: false, dirty: 0, prUrl: null, mergeStage: null, gate: null };
const cardOf = (stateDir, id) => backlogStore.load(stateDir).items.find((i) => i.id === id);

test('record stores the outcome on the card and a devlog line, once for the same facts', async () => {
  await withServer(async ({ post, stateDir }) => {
    const { item } = backlogStore.addItemTo(stateDir, { title: 't', prompt: 'x', project: 'p' });
    const dir = path.join(os.tmpdir(), 'wt-x');
    const body = { action: 'record', dir, repo: os.tmpdir(), record: { ...record, dir } };
    assert.equal((await post(`/api/backlog/${item.id}/worktree-outcome`, body)).status, 200);
    assert.equal((await post(`/api/backlog/${item.id}/worktree-outcome`, body)).status, 200);
    const c = cardOf(stateDir, item.id);
    assert.equal(c.runSession.outcome.head, record.head);
    assert.equal(c.devLog.filter((e) => /^worktree outcome:/.test(e.text)).length, 1);
  });
});

test('kept flags the card once; removed marks the worktree purged', async () => {
  await withServer(async ({ post, stateDir }) => {
    const { item } = backlogStore.addItemTo(stateDir, { title: 't', prompt: 'x', project: 'p' });
    const url = `/api/backlog/${item.id}/worktree-outcome`;
    await post(url, { action: 'kept', reason: 'dirty' });
    await post(url, { action: 'kept', reason: 'dirty' });
    assert.equal(cardOf(stateDir, item.id).devLog.filter((e) => /^worktree kept:/.test(e.text)).length, 1);
    await post(url, { action: 'removed' });
    const c = cardOf(stateDir, item.id);
    assert.ok(c.runSession.purgedTs);
    assert.equal(c.runSession.keptReason, null);
  });
});

test('worktree-outcome refuses a bad request and an unknown card', async () => {
  await withServer(async ({ post, stateDir }) => {
    const { item } = backlogStore.addItemTo(stateDir, { title: 't', prompt: 'x', project: 'p' });
    assert.equal((await post(`/api/backlog/${item.id}/worktree-outcome`, { action: 'nope' })).status, 400);
    assert.equal((await post(`/api/backlog/${item.id}/worktree-outcome`, { action: 'record', dir: 'x' })).status, 400);
    assert.equal((await post('/api/backlog/no-such/worktree-outcome', { action: 'removed' })).status, 404);
  });
});
