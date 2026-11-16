// Card glmps-2-0-128: an agent-filed follow-up (source deferred + parentId) is
// refused over HTTP unless the operator approved it and a reason is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import * as store from '../lib/orchestration/backlog-store.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-state-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };
  try {
    await fn({ post, stateDir });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
}

const OPT = { requireFollowUpApproval: true };
const base = { title: 'follow up', source: 'deferred', parentId: 'glmps-2-0-5' };
const empty = () => ({ items: [], seq: 0, seqs: {} });

test('store: deferred + parentId without approval is refused as ask-first', () => {
  const r = store.addItem(empty(), base, OPT);
  assert.equal(r.item, null);
  assert.equal(r.status, 409);
  assert.equal(r.error, 'ask-first');
  assert.match(r.hint, /Do not file follow-ups yourself/);
  assert.match(r.hint, /glmps-2-0-5/);
  assert.equal(r.state.items.length, 0);
});

test('store: approved but no outOfScope is refused with a 400', () => {
  for (const outOfScope of [undefined, '', '   ', 5]) {
    const r = store.addItem(empty(), { ...base, operatorApproved: true, outOfScope }, OPT);
    assert.equal(r.item, null);
    assert.equal(r.status, 400);
    assert.equal(r.error, 'say why this is not part of glmps-2-0-5');
  }
});

test('store: operatorApproved must be exactly true', () => {
  const r = store.addItem(empty(), { ...base, operatorApproved: 'true', outOfScope: 'x' }, OPT);
  assert.equal(r.status, 409);
});

test('store: approved with a reason is filed and stores outOfScope', () => {
  const r = store.addItem(empty(), { ...base, operatorApproved: true, outOfScope: ' different repo ' }, OPT);
  assert.ok(r.item);
  assert.equal(r.item.outOfScope, 'different repo');
});

test('store: deferred without parentId is unchanged', () => {
  const r = store.addItem(empty(), { title: 'x', source: 'deferred' }, OPT);
  assert.ok(r.item);
  assert.equal(r.item.outOfScope, undefined);
});

test('store: non-deferred source with parentId is unchanged', () => {
  const r = store.addItem(empty(), { title: 'x', source: 'manual', parentId: 'glmps-2-0-5' }, OPT);
  assert.ok(r.item);
});

test('store: without the option (internal callers) nothing is refused', () => {
  const r = store.addItem(empty(), base);
  assert.ok(r.item);
});

test('HTTP: unapproved follow-up gets 409 ask-first and nothing is filed', async () => {
  await withServer(async ({ post, stateDir }) => {
    const r = await post('/api/backlog', { ...base, project: 'glmps-2.0-runtime' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ask-first');
    assert.match(r.body.hint, /operatorApproved:true and outOfScope/);
    assert.equal(store.load(stateDir).items.length, 0);
  });
});

test('HTTP: approved without a reason gets 400', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/backlog', { ...base, operatorApproved: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /say why this is not part of glmps-2-0-5/);
  });
});

test('HTTP: approved with a reason is filed with outOfScope stored', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/backlog', { ...base, operatorApproved: true, outOfScope: 'different repo' });
    assert.equal(r.status, 201);
    assert.equal(r.body.outOfScope, 'different repo');
  });
});

test('HTTP: a plain deferred card with no parentId is still filed', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/backlog', { title: 'solo', source: 'deferred' });
    assert.equal(r.status, 201);
  });
});
