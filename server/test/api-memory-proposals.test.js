// server/test/api-memory-proposals.test.js
// Memory distiller HTTP surface: proposals list/approve/reject, the distill
// enqueue route's validation, and that mutations sit behind the loopback
// Origin/Host guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { stageProposal } from '../lib/evaluation/memory-writer.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-mdapi-');
  const claudeDir = tmp('mc-mdapi-claude-');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({}));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile });
  const base = `http://127.0.0.1:${h.port}`;
  const get = async (p, headers) => { const r = await fetch(base + p, headers ? { headers } : undefined); return { status: r.status, body: await r.json().catch(() => null) }; };
  const post = async (p, obj, headers) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(obj || {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try { await fn({ get, post, stateDir, claudeDir }); }
  finally { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(claudeDir, { recursive: true, force: true }); }
}

const fact = { name: 'api-fact', description: 'd', type: 'project', body: 'b', wikilinks: [], confidence: 0.5 };

test('GET /api/memory/proposals lists staged proposals', async () => {
  await withServer(async ({ get, stateDir }) => {
    assert.deepEqual((await get('/api/memory/proposals')).body.proposals, []);
    stageProposal(stateDir, { fact, memoryDir: path.join(stateDir, 'md'), sessionId: 's1', poison: { clean: true }, decisionReasons: ['low-confidence'], ts: 1 });
    const r = await get('/api/memory/proposals');
    assert.equal(r.body.proposals.length, 1);
    assert.equal(r.body.proposals[0].fact.name, 'api-fact');
  });
});

test('POST approve writes the memory file and removes the proposal', async () => {
  await withServer(async ({ get, post, stateDir }) => {
    const memoryDir = path.join(stateDir, 'md2');
    const id = stageProposal(stateDir, { fact, memoryDir, sessionId: 's1', poison: { clean: true }, decisionReasons: [], ts: 1 });
    const r = await post(`/api/memory/proposals/${id}/approve`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.written, true);
    assert.ok(fs.existsSync(path.join(memoryDir, 'api-fact.md')));
    assert.equal((await get('/api/memory/proposals')).body.proposals.length, 0);
  });
});

test('POST reject removes the proposal without writing', async () => {
  await withServer(async ({ get, post, stateDir }) => {
    const memoryDir = path.join(stateDir, 'md3');
    const id = stageProposal(stateDir, { fact, memoryDir, sessionId: 's1', poison: { clean: true }, decisionReasons: [], ts: 1 });
    const r = await post(`/api/memory/proposals/${id}/reject`, {});
    assert.equal(r.status, 200);
    assert.ok(!fs.existsSync(path.join(memoryDir, 'api-fact.md')));
    assert.equal((await get('/api/memory/proposals')).body.proposals.length, 0);
  });
});

test('POST /api/memory/distill validates required fields and enqueues', async () => {
  await withServer(async ({ post, claudeDir }) => {
    assert.equal((await post('/api/memory/distill', {})).status, 400);
    const transcriptPath = path.join(claudeDir, 'projects', 'p1', 'sess.jsonl');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '');
    const ok = await post('/api/memory/distill', { sessionId: 's1', transcriptPath, cwd: '/c' });
    assert.equal(ok.status, 202);
    assert.equal(ok.body.queued, true);
  });
});

// transcriptPath is caller-supplied and
// this route sits behind only the loopback Origin/Host guard, not full
// authentication - an unconstrained path would let any loopback caller make
// the distiller read (and, via Mem0 admission, potentially surface back
// through memory lookup) an arbitrary file on disk.
test('POST /api/memory/distill refuses a transcriptPath outside <claudeDir>/projects', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/memory/distill', { sessionId: 's1', transcriptPath: '/etc/passwd', cwd: '/c' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /transcriptPath/);
  });
});

test('POST /api/memory/distill refuses a transcriptPath that escapes via ../ traversal', async () => {
  await withServer(async ({ post, claudeDir }) => {
    const escaping = path.join(claudeDir, 'projects', '..', 'settings.json');
    const r = await post('/api/memory/distill', { sessionId: 's1', transcriptPath: escaping, cwd: '/c' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /transcriptPath/);
  });
});

test('cross-origin mutation is blocked (loopback Origin guard)', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/memory/distill', { sessionId: 's1', transcriptPath: '/t' }, { origin: 'http://evil.example' });
    assert.equal(r.status, 403);
  });
});

test('review P4: POST /api/memory/distill refuses a transcriptPath that escapes projects through a link', async () => {
  await withServer(async ({ post, claudeDir }) => {
    const outside = tmp('mc-mdapi-outside-');
    try {
      fs.writeFileSync(path.join(outside, 'secret.jsonl'), '');
      fs.symlinkSync(outside, path.join(claudeDir, 'projects', 'link'), 'junction');
      const r = await post('/api/memory/distill', { sessionId: 's1', transcriptPath: path.join(claudeDir, 'projects', 'link', 'secret.jsonl'), cwd: '/c' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /transcriptPath/);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
