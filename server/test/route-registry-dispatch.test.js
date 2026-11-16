// Routes under test: server/lib/routes/workspace-routes.js
// Regression test for the route-registry seam (open-core Phase-0, Task 3):
// proves the cold-start path works. matchRoute()'s dispatcher check in
// server.js runs on every request, but the workspace routes are only
// registered inside the same per-request handler (registerRoute is
// idempotent, so re-registering per request is harmless and keeps the
// registry populated before matchRoute runs - see task-3-report.md for the
// full rationale). Without that ordering, the VERY FIRST request to a
// freshly-started server would 404 because the registry would still be
// empty when the dispatcher check ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-state-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const get = (p) => j(p);
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    await fn({ get, post });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
}

test('cold start: the very first request to a fresh server dispatches through the registry (no 404)', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/api/workspace');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.sessions));
  });
});

test('GET /api/workspace/:id for an unknown id -> 404', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/api/workspace/does-not-exist');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});

test('POST /api/workspace/:id/steer then GET reflects the note (byte-identical behavior to the pre-migration inline routes)', async () => {
  await withServer(async ({ get, post }) => {
    const p = await post('/api/workspace/smoke-test/steer', { note: 'test', from: 'operator' });
    assert.equal(p.status, 200);
    assert.deepEqual(p.body, { ok: true });
    const g = await get('/api/workspace/smoke-test');
    assert.equal(g.status, 200);
    assert.equal(g.body.steer.note, 'test');
    assert.equal(g.body.steer.from, 'operator');
    assert.equal(g.body.steer.consumedTs, null);
  });
});

test('two servers in one process each answer registered routes from their own state', async () => {
  await withServer(async ({ get, post }) => {
    const { body: card } = await post('/api/backlog', { title: 'only on the first server', prompt: 'x', project: 'p' });
    assert.ok(card.id, JSON.stringify(card));
    assert.equal((await get(`/api/backlog/${card.id}/chain`)).status, 200);
    await withServer(async ({ get: getSecond }) => {
      assert.equal((await getSecond(`/api/backlog/${card.id}/chain`)).status, 404, 'the second server has no such card');
      assert.equal((await get(`/api/backlog/${card.id}/chain`)).status, 200, 'the first server still answers from its own store');
    });
    assert.equal((await get(`/api/backlog/${card.id}/chain`)).status, 200, 'and still does after the second server closed');
  });
});
