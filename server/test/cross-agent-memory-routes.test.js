// Routes under test: server/lib/routes/cross-agent-memory-routes.js
// Integration test for Task 13: the 7 cross-agent-memory routes wired into
// server.js via registerRoute, with poison-scan on intake
// actions. Modeled on route-registry-dispatch.test.js (Task 3's own
// cold-start regression test) - startServer({port:0}) against real temp
// dirs, never the live :8123 instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { renderMemoryFile } from '../lib/evaluation/memory-distill-core.js';
import { upsertCandidate, approveCandidateIn } from '../lib/governance/cross-agent-memory-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(envOverrides, fn) {
  const stateDir = tmp('mc-cam-state-');
  const memoryDir = tmp('mc-cam-memory-');
  const claudeDir = claudeTmp();
  const env = {
    ...process.env,
    GLMPS_STATE_DIR: stateDir,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_MEMORY_DIR: memoryDir,
    ...envOverrides,
  };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); const status = r.status; let body = null; try { body = await r.json(); } catch {} return { status, body }; };
  const get = (p) => j(p);
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });
  try {
    await fn({ get, post, memoryDir, stateDir });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(memoryDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
}

test('GET /api/cross-agent-memory (default tier) -> 200 {items:[]} on a fresh state dir', async () => {
  await withServer({}, async ({ get }) => {
    const res = await get('/api/cross-agent-memory');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { items: [] });
  });
});


test('POST /api/cross-agent-memory/capture (default/pro tier) -> 200 {captured,scanned} and the item shows up in the list', async () => {
  await withServer({}, async ({ get, post, memoryDir }) => {
    const fact = { name: 'Cam Test Fact', description: 'A capturable fact.', type: 'project', body: 'Body text.', wikilinks: [] };
    fs.writeFileSync(path.join(memoryDir, 'cam-test-fact.md'), renderMemoryFile(fact, { sessionId: 's1' }));

    const cap = await post('/api/cross-agent-memory/capture');
    assert.equal(cap.status, 200);
    assert.equal(typeof cap.body.captured, 'number');
    assert.equal(typeof cap.body.scanned, 'number');
    assert.equal(cap.body.scanned, 1);
    assert.equal(cap.body.captured, 1);

    const list = await get('/api/cross-agent-memory');
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].fact.name, 'cam-test-fact');
  });
});


test('POST /api/cross-agent-memory/:id/approve for an unknown id -> 409', async () => {
  await withServer({}, async ({ post }) => {
    const res = await post('/api/cross-agent-memory/does-not-exist/approve');
    assert.equal(res.status, 409);
    assert.ok(res.body.error);
  });
});

test('GET /api/cross-agent-memory/attestation -> 200 {configured:false,...} with no baseline yet', async () => {
  await withServer({}, async ({ get }) => {
    const res = await get('/api/cross-agent-memory/attestation');
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, false);
    assert.deepEqual(res.body.findings, []);
  });
});

test('POST /api/cross-agent-memory/:id/start-trial: approved -> trialing (200); non-approved id -> 409', async () => {
  await withServer({}, async ({ post, stateDir }) => {
    const fact = { name: 'Trial Test Fact', description: 'A fact ready to trial.', type: 'project', body: 'Body text.', confidence: 0.9 };
    const { item: seeded } = upsertCandidate(stateDir, fact, 'test-project');
    const { item: approved } = approveCandidateIn(stateDir, seeded.id);
    assert.equal(approved.status, 'approved');

    const res = await post(`/api/cross-agent-memory/${approved.id}/start-trial`);
    assert.equal(res.status, 200);
    assert.equal(res.body.item.status, 'trialing');

    const stillPending = { name: 'Not Yet Approved Fact', description: 'Still pending approval.', type: 'project', body: 'Body text 2.', confidence: 0.5 };
    const { item: pending } = upsertCandidate(stateDir, stillPending, 'test-project');
    assert.equal(pending.status, 'pending-approval');

    const res2 = await post(`/api/cross-agent-memory/${pending.id}/start-trial`);
    assert.equal(res2.status, 409);
    assert.ok(res2.body.error);
  });
});



// POST /api/cross-agent-memory/push is intentionally NOT exercised at the
// server.js integration level here: REPO_ROOT is resolved from
// import.meta.url (server.js's own location), not from any GLMPS_* env
// override, so a real call writes managed-memory blocks into this
// worktree's actual CLAUDE.md / AGENTS.md / GEMINI.md / .cursor/... /
// .github/copilot-instructions.md - there is no test seam to redirect it to
// a temp dir. This mirrors the pre-existing analogous
// /api/governance/policy/push route, which likewise has no server.js-level
// test for the same reason (only vendor-writers.js's applyPush is
// lib-tested with injected readFile/exists). Route wiring itself (imports,
// registerRoute, distributeMemory/recordMemoryBaseline call shape) is
// verified by code review against the task brief instead.
