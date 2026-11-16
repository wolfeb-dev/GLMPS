// The card-handling routes as a module (card glmps-2-0-220): their rules are
// reachable without booting a server, and the client ownership check covers
// every card route a paired client may write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerBacklogRoutes } from '../lib/routes/backlog-routes.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { CLIENT_WRITE_SCOPE } from '../lib/governance/access-guard.js';
import { listRoutes } from '../lib/observability/route-registry.js';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function harness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-backlog-routes-'));
  const routes = new Map();
  let broadcasts = 0;
  registerBacklogRoutes((r) => routes.set(`${r.method} ${r.pattern}`, r), {
    P: { stateDir, worktreesDir: path.join(stateDir, 'worktrees') },
    cfg: {}, actors: [], accessToken: null,
    readBody: async (req) => req.body ?? '',
    CLIENT_BACKLOG_STATES: new Set(['held', 'idle']),
    clientPatchRefusal: () => null,
    broadcastBacklog: () => { broadcasts++; },
    haltMergeQueue: () => {}, promoteAfterClose: async () => {}, recordGate: () => ({ error: 'unused' }),
    removeWorktree: async () => false, repoForProject: () => null,
    resolveActor: () => 'local', resolveProjectName: (p) => p, runJobNow: async () => ({ status: 200 }),
    runRecipe: async () => ({ status: 1, stderr: 'unused' }), sessionSummaries: () => [],
    getScut: () => null, getLocalSessionExpected: () => null,
  });
  const call = async (method, pattern, { params = {}, body, clientId = null, headers = {} } = {}) => {
    const route = routes.get(`${method} ${pattern}`);
    assert.ok(route, `${method} ${pattern} is registered`);
    let out;
    const send = (code, obj) => { out = { code, body: obj }; };
    await route.handle({ body: body == null ? '' : JSON.stringify(body), headers }, null, {
      params, send, url: new URL(`http://x${pattern}`), access: { clientId },
    });
    return out;
  };
  return { stateDir, routes, call, broadcasts: () => broadcasts, done: () => fs.rmSync(stateDir, { recursive: true, force: true }) };
}

test('all 12 card routes register, and exactly the card writes are client-owned', () => {
  const h = harness();
  try {
    assert.equal(h.routes.size, 12);
    const owned = [...h.routes.values()].filter((r) => r.clientOwnsCard).map((r) => `${r.method} ${r.pattern}`).sort();
    assert.deepEqual(owned, ['PATCH /api/backlog/:id', 'POST /api/backlog/:id/devlog', 'POST /api/backlog/:id/gate', 'POST /api/backlog/:id/progress']);
  } finally { h.done(); }
});

test('a paired client files a held, deferred card attributed to it; an empty title is refused', async () => {
  const h = harness();
  try {
    const r = await h.call('POST', '/api/backlog', { clientId: 'c1', body: { title: ' Fix it ', project: 'harbor-app', acceptanceCriteria: ['works'] } });
    assert.equal(r.code, 201);
    assert.deepEqual([r.body.title, r.body.source, r.body.state, r.body.actor], ['Fix it', 'deferred', 'held', 'client:c1']);
    assert.equal(h.broadcasts(), 1);
    const refused = await h.call('POST', '/api/backlog', { clientId: 'c1', body: { title: 'x', state: 'queued' } });
    assert.deepEqual([refused.code, refused.body.error, refused.body.field], [403, 'client-scope', 'state']);
    assert.deepEqual((await h.call('POST', '/api/backlog', { body: { title: '  ' } })), { code: 400, body: { error: 'empty title' } });
  } finally { h.done(); }
});

test('a devlog on a missing card is 404; on a real card it is stored', async () => {
  const h = harness();
  try {
    assert.equal((await h.call('POST', '/api/backlog/:id/devlog', { params: { id: 'nope-1' }, body: { by: 'agent', text: 'hi' } })).code, 404);
    const { item } = backlogStore.addItemTo(h.stateDir, { title: 'Card', project: 'harbor-app' });
    const r = await h.call('POST', '/api/backlog/:id/devlog', { params: { id: item.id }, body: { by: 'agent', text: 'progress' } });
    assert.equal(r.code, 200);
    assert.equal(r.body.devLog.at(-1).text, 'progress');
  } finally { h.done(); }
});

test('closing a card with an open spawned card is refused for a non-operator', async () => {
  const h = harness();
  try {
    const parent = backlogStore.addItemTo(h.stateDir, { title: 'Host', project: 'harbor-app' }).item;
    backlogStore.addItemTo(h.stateDir, { title: 'Child', project: 'harbor-app', parentId: parent.id });
    const r = await h.call('PATCH', '/api/backlog/:id', { params: { id: parent.id }, body: { labels: ['agent:done'] } });
    assert.equal(r.code, 409);
    assert.equal(r.body.error, 'open-spawned-cards');
  } finally { h.done(); }
});

test('every client-writable card route is flagged client-owned on a running server', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-backlog-routes-srv-'));
  const claudeDir = claudeTmp();
  const srv = await startServer({ port: 0, env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' }, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const flagged = new Set(listRoutes().filter((r) => r.clientOwnsCard).map((r) => `${r.method} ${r.pattern}`));
    const cardWrites = CLIENT_WRITE_SCOPE.filter((s) => s.path.startsWith('/api/backlog/:id')).map((s) => `${s.method} ${s.path}`);
    assert.ok(cardWrites.length >= 5);
    for (const w of cardWrites) assert.ok(flagged.has(w), `${w} is in the client write scope but not flagged clientOwnsCard`);
  } finally {
    await srv.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
