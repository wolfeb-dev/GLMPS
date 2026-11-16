// Card glmps-2-0-163 AC-1: an agent close of a host card while a card it
// spawned is still open is refused, naming the open cards, so a host can no
// longer close and leave its children running headless with nobody managing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { load, save } from '../lib/orchestration/backlog-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const H = { 'content-type': 'application/json' };

async function boot() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hostclose-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const call = async (method, p, obj, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...headers }, body: JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };
  const cleanup = async () => { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); fs.rmSync(claudeDir, { recursive: true, force: true }); };
  return { stateDir, call, cleanup, h };
}

const file = async (call, title, over = {}) => (await call('POST', '/api/backlog', { title, acceptanceCriteria: ['x'], ...over })).body;
// The intake refuses a parentId without operator approval, so lineage is set on the store.
function setCard(stateDir, id, patch) {
  const st = load(stateDir);
  save(stateDir, { ...st, items: st.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
}
const stateOf = (stateDir, id) => load(stateDir).items.find((i) => i.id === id)?.state;

test('agent:done on a host with an open spawned card is refused with 409 naming the card, and the host stays open', async () => {
  const { stateDir, call, cleanup } = await boot();
  try {
    const host = await file(call, 'host card');
    const child = await file(call, 'child card');
    const doneChild = await file(call, 'finished child');
    setCard(stateDir, child.id, { parentId: host.id, state: 'held' });
    setCard(stateDir, doneChild.id, { parentId: host.id, state: 'done' });
    const r = await call('PATCH', `/api/backlog/${host.id}`, { labels: ['agent:done'] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'open-spawned-cards');
    assert.deepEqual(r.body.openChildren, [child.id], 'only the open child is named');
    assert.match(r.body.reason, new RegExp(child.id));
    assert.notEqual(stateOf(stateDir, host.id), 'done');
  } finally { await cleanup(); }
});

test('once every spawned card is closed the host closes normally', async () => {
  const { stateDir, call, cleanup } = await boot();
  try {
    const host = await file(call, 'host card');
    const child = await file(call, 'child card');
    setCard(stateDir, child.id, { parentId: host.id, state: 'cancelled' });
    const r = await call('PATCH', `/api/backlog/${host.id}`, { labels: ['agent:done'] });
    assert.equal(r.status, 200);
    assert.equal(stateOf(stateDir, host.id), 'done');
  } finally { await cleanup(); }
});

test('a non-closing PATCH of a host with open children is not refused', async () => {
  const { stateDir, call, cleanup } = await boot();
  try {
    const host = await file(call, 'host card');
    const child = await file(call, 'child card');
    setCard(stateDir, child.id, { parentId: host.id, state: 'in_progress' });
    assert.equal((await call('PATCH', `/api/backlog/${host.id}`, { comment: 'still going' })).status, 200);
    assert.equal((await call('PATCH', `/api/backlog/${host.id}`, { labels: ['agent:backlog'] })).status, 200);
  } finally { await cleanup(); }
});

// Card glmps-2-0-173: the guard is on the state the PATCH produces, not on one label.
test('every agent route to a closed state is refused while a spawned card is open; the operator close promotes instead', async () => {
  const { stateDir, call, cleanup, h } = await boot();
  try {
    const routes = [{ state: 'done' }, { state: 'cancelled' }, { state: 'archived' }, { labels: ['merged-unverified'] }];
    for (const body of routes) {
      const host = await file(call, `host ${JSON.stringify(body)}`);
      const child = await file(call, `child ${JSON.stringify(body)}`);
      setCard(stateDir, child.id, { parentId: host.id, state: 'held' });
      const r = await call('PATCH', `/api/backlog/${host.id}`, body);
      assert.equal(r.status, 409, `${JSON.stringify(body)} is refused`);
      assert.deepEqual(r.body.openChildren, [child.id]);
      assert.equal(stateOf(stateDir, host.id), 'queued', `${JSON.stringify(body)} left the host open`);
    }
    const host = await file(call, 'operator host');
    const child = await file(call, 'operator child');
    setCard(stateDir, child.id, { parentId: host.id, state: 'held' });
    const r = await call('PATCH', `/api/backlog/${host.id}`, { state: 'done' }, { 'x-glmps-local-session': h.localSession });
    assert.equal(r.status, 200, 'the operator may close a host');
    assert.equal(stateOf(stateDir, host.id), 'done');
    const devlog = load(stateDir).items.find((i) => i.id === host.id).devLog ?? [];
    assert.ok(devlog.some((d) => d.text.includes(child.id) && /promoted/.test(d.text)), 'the host names the promoted card');
  } finally { await cleanup(); }
});
