import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/orchestration/backlog-store.js';

// glmps-2-0-171 D1: adopt makes a card the host of existing cards.
const card = (id, extra = {}) => ({ id, project: 'p', title: id, state: 'held', ...extra });
const stateOf = (...items) => ({ ...store.emptyState(), items });

test('adoptItem sets the child parent, writes a devlog on both cards', () => {
  const r = store.adoptItem(stateOf(card('h-1', { state: 'in_progress' }), card('c-1', { parentId: 'old-1' }), card('old-1', { state: 'done' })), 'h-1', ['c-1']);
  assert.deepEqual(r.adopted, ['c-1']);
  assert.deepEqual(r.refused, []);
  const child = r.state.items.find((i) => i.id === 'c-1');
  const host = r.state.items.find((i) => i.id === 'h-1');
  assert.equal(child.parentId, 'h-1');
  assert.match(child.devLog.at(-1).text, /adopted by h-1/);
  assert.match(host.devLog.at(-1).text, /adopted c-1/);
});

test('adoptItem unknown host is an error with no change', () => {
  const s = stateOf(card('c-1'));
  const r = store.adoptItem(s, 'nope-1', ['c-1']);
  assert.equal(r.error, 'host not found');
  assert.equal(r.state, s);
});

test('adoptItem refuses per id with a reason', () => {
  const s = stateOf(
    card('h-1', { state: 'in_progress' }),
    card('closed-1', { state: 'done' }),
    card('other-host', { state: 'in_progress' }),
    card('owned-1', { parentId: 'other-host' }),
    card('gone-parent-1', { parentId: 'missing-9' }),
    card('top-1', { state: 'in_progress' }),
  );
  s.items.find((i) => i.id === 'h-1').parentId = 'top-1';
  const r = store.adoptItem(s, 'h-1', ['h-1', 'closed-1', 'owned-1', 'gone-parent-1', 'top-1', 'ghost-1']);
  assert.deepEqual(r.adopted, ['gone-parent-1']);
  const why = Object.fromEntries(r.refused.map((x) => [x.id, x.reason]));
  assert.match(why['h-1'], /host/);
  assert.match(why['closed-1'], /closed/);
  assert.match(why['owned-1'], /other-host/);
  assert.match(why['top-1'], /ancestor/);
  assert.match(why['ghost-1'], /not found/);
});

test('adoptItem refuses when the host is closed', () => {
  const r = store.adoptItem(stateOf(card('h-1', { state: 'done' }), card('c-1')), 'h-1', ['c-1']);
  assert.deepEqual(r.adopted, []);
  assert.match(r.refused[0].reason, /host is closed/);
});

test('adoptItem leaves parentId out of PATCHABLE', () => {
  const s = stateOf(card('c-1'));
  const r = store.updateItem(s, 'c-1', { parentId: 'h-1' });
  assert.notEqual(r.item?.parentId, 'h-1');
});

test('adoptItemIn persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-adopt-'));
  store.save(dir, stateOf(card('h-1', { state: 'in_progress' }), card('c-1')));
  const r = store.adoptItemIn(dir, 'h-1', ['c-1']);
  assert.deepEqual(r.adopted, ['c-1']);
  assert.equal(store.load(dir).items.find((i) => i.id === 'c-1').parentId, 'h-1');
  store.dropCache(dir);
});

test('POST /api/backlog/:id/adopt adopts, refuses per id, and 404s an unknown host', async () => {
  const { startServer } = await import('../server.js');
  const { claudeTmp } = await import('./fixtures/claude-dir.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-adoptroute-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const call = async (method, p, obj) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const host = (await call('POST', '/api/backlog', { title: 'host card', acceptanceCriteria: ['x'] })).body;
    const kid = (await call('POST', '/api/backlog', { title: 'kid card', acceptanceCriteria: ['x'] })).body;
    const r = await call('POST', `/api/backlog/${host.id}/adopt`, { ids: [kid.id, 'ghost-9'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.adopted, [kid.id]);
    assert.equal(r.body.refused[0].id, 'ghost-9');
    assert.equal(store.load(stateDir).items.find((i) => i.id === kid.id).parentId, host.id);
    assert.equal((await call('POST', '/api/backlog/nope-1/adopt', { ids: [kid.id] })).status, 404);
    assert.equal((await call('POST', `/api/backlog/${host.id}/adopt`, { ids: 'x' })).status, 400);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
