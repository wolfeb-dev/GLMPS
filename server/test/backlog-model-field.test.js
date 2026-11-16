import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { modelRunRows, modelRunSummary } from '../lib/orchestration/vendor-agents.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-state-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const send = (method) => (p, obj) => j(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    await fn({ post: send('POST'), patch: send('PATCH'), get: (p) => j(p), stateDir });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
}

const AC = ['AC-1: it works'];

test('AC-1: "use gemini" in the card text is read into the model field at intake', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/backlog', { title: 'Fix the parser', prompt: 'It crashes. Use Gemini.', acceptanceCriteria: AC, state: 'held' });
    assert.equal(r.status, 201);
    assert.equal(r.body.model, 'gemini');
    const plain = await post('/api/backlog', { title: 'Plain card', prompt: 'no directive', acceptanceCriteria: AC, state: 'held' });
    assert.equal(plain.body.model, null);
  });
});

test('AC-1: a model named by the caller wins over the text', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/backlog', { title: 'Fix it', prompt: 'use gemini', model: 'gpt', acceptanceCriteria: AC, state: 'held' });
    assert.equal(r.body.model, 'gpt');
  });
});

test('AC-1: the model field is editable, normalised, clearable and validated', async () => {
  await withServer(async ({ post, patch }) => {
    const { body: card } = await post('/api/backlog', { title: 'Fix it', prompt: 'x', acceptanceCriteria: AC, state: 'held' });
    const set = await patch(`/api/backlog/${card.id}`, { model: 'Google:Gemini 4 Argon (High)' });
    assert.equal(set.status, 200);
    assert.equal(set.body.model, 'gemini:Gemini 4 Argon (High)');
    const bad = await patch(`/api/backlog/${card.id}`, { model: 'llama' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /unknown model/);
    const cleared = await patch(`/api/backlog/${card.id}`, { model: '' });
    assert.equal(cleared.body.model, null);
  });
});

test('AC-5: GET /api/model-runs lines up recorded runs with merge rounds and gate', async () => {
  await withServer(async ({ post, get, stateDir }) => {
    const { body: a } = await post('/api/backlog', { title: 'A', prompt: 'x', acceptanceCriteria: AC, state: 'held' });
    const { body: b } = await post('/api/backlog', { title: 'B', prompt: 'x', acceptanceCriteria: AC, state: 'held' });
    backlogStore.appendRunIn(stateDir, a.id, { vendor: 'gemini', model: 'Gemini 3.8 Flash (High)', startedAt: '2026-11-06T10:00:00Z', endedAt: '2026-11-06T10:20:00Z', wallMs: 1200000, exit: 0, tokens: { input: 100, output: 20, total: 120 }, costUsd: null });
    backlogStore.appendRunIn(stateDir, b.id, { vendor: 'claude', model: null, startedAt: '2026-11-06T11:00:00Z', endedAt: '2026-11-06T11:23:00Z', wallMs: 1380000, exit: 0, tokens: null, costUsd: null });
    backlogStore.setMergeRequestIn(stateDir, a.id, { stage: 'merged', round: 2 });
    backlogStore.setGateIn(stateDir, a.id, { status: 'FAIL', evidence: ['red'], risk: 'P2' });
    const r = await get('/api/model-runs');
    assert.equal(r.status, 200);
    assert.equal(r.body.rows.length, 2);
    const ga = r.body.rows.find((x) => x.cardId === a.id);
    assert.deepEqual({ vendor: ga.vendor, wallMs: ga.wallMs, total: ga.tokens.total, mergeRounds: ga.mergeRounds, gate: ga.gate },
      { vendor: 'gemini', wallMs: 1200000, total: 120, mergeRounds: 2, gate: 'FAIL' });
    assert.deepEqual(r.body.byVendor.map((v) => v.vendor).sort(), ['claude', 'gemini']);
  });
});

test('run records are runner-written: a PATCH carrying runs is ignored', () => {
  const s0 = { items: [], seq: 0 };
  const { state: s1, item } = backlogStore.addItem(s0, { title: 't', prompt: 'p' });
  const { state: s2 } = backlogStore.updateItem(s1, item.id, { runs: [{ vendor: 'gpt' }] });
  assert.equal(s2.items[0].runs, undefined);
  const { state: s3 } = backlogStore.appendRun(s2, item.id, { vendor: 'gemini' });
  assert.equal(s3.items[0].runs.length, 1);
});

test('the per-vendor summary totals runs, time, tokens, passes and merge rounds', () => {
  const rows = modelRunRows([
    { id: 'c1', project: 'p', state: 'done', gate: { status: 'PASS' }, mergeRequest: { round: 1 }, runs: [{ vendor: 'gemini', wallMs: 10, tokens: { total: 5 }, startedAt: 'b' }] },
    { id: 'c2', project: 'q', state: 'done', runs: [{ vendor: 'gemini', wallMs: 20, startedAt: 'a' }] },
  ]);
  assert.deepEqual(modelRunSummary(rows), [{ vendor: 'gemini', runs: 2, wallMsTotal: 30, tokensTotal: 5, costUsdTotal: 0, gatePass: 1, mergeRoundsTotal: 1 }]);
  assert.equal(modelRunRows([{ id: 'c1', project: 'p', runs: [{}] }], { project: 'q' }).length, 0);
});
