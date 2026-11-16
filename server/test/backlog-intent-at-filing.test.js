// Card glmps-2-0-runtime-79 (gap 18): the intent check runs at filing, not
// only at launch, for cards filed by hand or by script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import * as store from '../lib/orchestration/backlog-store.js';
import * as qr from '../lib/orchestration/queue-runner.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-state-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const send = (method) => (p, obj) => j(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    await fn({ post: send('POST'), patch: send('PATCH') });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
}

test('needsIntentAtFiling: flags a card without criteria, exempts Slack-born and loop-diagnosis cards', () => {
  assert.equal(store.needsIntentAtFiling({ title: 't' }), true);
  assert.equal(store.needsIntentAtFiling({ title: 't', source: 'deferred', acceptanceCriteria: [] }), true);
  assert.equal(store.needsIntentAtFiling({ title: 't', acceptanceCriteria: ['  '] }), true, 'blank criteria are no criteria');
  assert.equal(store.needsIntentAtFiling({ title: 't', acceptanceCriteria: ['does X'] }), false);
  assert.equal(store.needsIntentAtFiling({ title: 't', origin: { via: 'slack', channel: 'C1', thread_ts: '1.2' } }), false);
  assert.equal(store.needsIntentAtFiling({ title: 't', source: 'scut' }), false);
  assert.equal(store.needsIntentAtFiling({ title: 't', source: 'loop-diagnosis', origin: { via: 'loop-diagnosis' } }), false);
});

test('addItem flags only when the caller opts in, and a criteria patch clears the flag', () => {
  const plain = store.addItem(store.emptyState(), { title: 'internal' });
  assert.equal(plain.item.needsIntent, false, 'internal callers are unchanged');
  let { state, item } = store.addItem(store.emptyState(), { title: 'by hand' }, { requireIntent: true });
  assert.equal(item.needsIntent, true);
  state = store.updateItem(state, item.id, { needsIntent: false }).state;
  assert.equal(state.items[0].needsIntent, true, 'the flag is not patchable');
  state = store.updateItem(state, item.id, { acceptanceCriteria: [] }).state;
  assert.equal(state.items[0].needsIntent, true, 'empty criteria do not clear it');
  state = store.updateItem(state, item.id, { acceptanceCriteria: ['does X'] }).state;
  assert.equal(state.items[0].needsIntent, false);
});

test('the runner never launches a needs-intent card, holds it visibly, and releases it once criteria land', () => {
  const items = [
    { id: 'n', state: 'queued', order: 1, needsIntent: true },
    { id: 'ok', state: 'queued', order: 2 },
  ];
  assert.equal(qr.pickNextJob(items).id, 'ok');
  assert.equal(qr.pickNextJob([items[0]]), null);
  assert.deepEqual(qr.blockedQueued(items), [{ id: 'n', blockers: ['acceptance criteria (filed without them)'], forBlockers: true }]);
  assert.deepEqual(qr.releasableHeld([{ id: 'n', state: 'held', autoHeldForBlockers: true, needsIntent: true }]), []);
  assert.deepEqual(qr.releasableHeld([{ id: 'n', state: 'held', autoHeldForBlockers: true, needsIntent: false }]), [{ id: 'n', resolved: [] }]);
});

test('AC-1: POST /api/backlog without criteria marks the card needs-intent; adding criteria clears it', async () => {
  await withServer(async ({ post, patch }) => {
    const hand = await post('/api/backlog', { title: 'filed by hand', prompt: 'do a thing' });
    assert.equal(hand.status, 201);
    assert.equal(hand.body.needsIntent, true);
    const script = await post('/api/backlog', { title: 'filed by script', source: 'deferred' });
    assert.equal(script.body.needsIntent, true);
    const withAc = await post('/api/backlog', { title: 'has intent', acceptanceCriteria: ['does X'] });
    assert.equal(withAc.body.needsIntent, false);
    const fixed = await patch(`/api/backlog/${hand.body.id}`, { acceptanceCriteria: ['does the thing'] });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.needsIntent, false);
  });
});

test('AC-2: Slack-born and loop-diagnosis cards filed over HTTP are not flagged', async () => {
  await withServer(async ({ post }) => {
    const slack = await post('/api/backlog', { title: 'from slack', origin: { via: 'slack', channel: 'C1', thread_ts: '1.2', user: 'U1' } });
    assert.equal(slack.body.needsIntent, false);
    const diag = await post('/api/backlog', { title: 'loop x failed', source: 'loop-diagnosis', origin: { via: 'loop-diagnosis', loop: 'x' } });
    assert.equal(diag.body.needsIntent, false);
  });
});

test('AC-1: Run now refuses a needs-intent card until criteria are added', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const call = async (method, p, obj) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });
    return { status: r.status, body: await r.json() };
  };
  try {
    await call('POST', '/api/backlog', { title: 'bare', prompt: 'do a' });
    const refused = await call('POST', '/api/runner/run/glmps-1');
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /acceptance criteria/);
    await call('PATCH', '/api/backlog/glmps-1', { acceptanceCriteria: ['does a'] });
    const ok = await call('POST', '/api/runner/run/glmps-1');
    assert.equal(ok.status, 200);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
