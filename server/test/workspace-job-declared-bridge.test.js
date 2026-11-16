// server/test/workspace-job-declared-bridge.test.js
// glmps-95: queue-runner jobs seed declared.goal under job.id (the backlog
// ticket id) at launch time - see launchJob()'s writeDeclared call in
// server.js - but the runtime session's own id (a Claude/Antigravity
// transcript UUID) doesn't exist yet at that moment, so /api/state?session=
// and /api/workspace (both keyed by the runtime sid) never see it: the
// seeded goal is orphaned and divergence never computes for runner jobs.
//
// Fix: the ONLY place a backlog item's sessionId field is ever set is a
// generic (non-label-delta) PATCH /api/backlog/:id - the agent's self-report
// of its own runtime session id. That is the first reliable moment MC can
// associate job.id with the runtime sid, so the PATCH handler forwards the
// job's declared goal onto the runtime sid's workspace right there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { writeDeclared, readWorkspace } from '../lib/orchestration/workspace-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-state-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const patch = (p, obj) => j(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    await fn({ post, patch, stateDir });
  } finally {
    await h.close?.();
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('PATCH sessionId bridges the job.id declared goal onto the runtime session workspace', async () => {
  await withServer(async ({ post, patch, stateDir }) => {
    const created = await post('/api/backlog', { title: 'Fix the frozen deploy script' });
    assert.equal(created.status, 201);
    const jobId = created.body.id;

    // Simulate launchJob()'s writeDeclared(P.stateDir, job.id, {...}) at launch time.
    writeDeclared(stateDir, jobId, { goal: created.body.title, ts: 1000 });

    // Agent self-reports its runtime session id - the only place sessionId is ever set.
    const patched = await patch(`/api/backlog/${jobId}`, { sessionId: 'runtime-sid-123' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.sessionId, 'runtime-sid-123');

    const ws = readWorkspace(stateDir, 'runtime-sid-123');
    assert.ok(ws?.declared, 'runtime sid workspace has a declared goal');
    assert.equal(ws.declared.goal, 'Fix the frozen deploy script');
  });
});

test('PATCH sessionId is a no-op for the bridge when job.id has no declared goal', async () => {
  await withServer(async ({ post, patch, stateDir }) => {
    const created = await post('/api/backlog', { title: 'no launch happened' });
    const jobId = created.body.id;
    const patched = await patch(`/api/backlog/${jobId}`, { sessionId: 'runtime-sid-456' });
    assert.equal(patched.status, 200);
    assert.equal(readWorkspace(stateDir, 'runtime-sid-456'), null);
  });
});

test('a label-delta PATCH carrying sessionId never persists it and never triggers the bridge', async () => {
  await withServer(async ({ post, patch, stateDir }) => {
    const created = await post('/api/backlog', { title: 'claimed via AO-style label delta' });
    const jobId = created.body.id;
    writeDeclared(stateDir, jobId, { goal: created.body.title, ts: 1000 });
    const patched = await patch(`/api/backlog/${jobId}`, { labels: ['agent:in-progress'], sessionId: 'runtime-sid-789' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.sessionId, null, 'label-delta path never persists sessionId (pre-existing behavior)');
    assert.equal(readWorkspace(stateDir, 'runtime-sid-789'), null, 'bridge did not fire for a label-delta PATCH');
  });
});

test('interactive sessions (no backlog item involved) are unaffected: declaring via workspace meta still works standalone', async () => {
  await withServer(async ({ stateDir }) => {
    // No backlog item, no PATCH - just the existing meta-event path (applyWorkspaceMeta).
    writeDeclared(stateDir, 'interactive-sid', { goal: 'exploring the codebase', ts: 5 });
    const ws = readWorkspace(stateDir, 'interactive-sid');
    assert.equal(ws.declared.goal, 'exploring the codebase');
  });
});
