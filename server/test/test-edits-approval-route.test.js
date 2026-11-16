// The operator-only testEditsApproved field on PATCH /api/backlog/:id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function withServer(fn, extraEnv = {}) {
  const stateDir = tmp('mc-teapprove-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeTmp(), GLMPS_UNMERGED_SCAN: 'off', ...extraEnv };
  const h = await startServer({ port: 0, env });
  const base = `http://127.0.0.1:${h.port}`;
  const call = async (method, p, obj, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: obj === undefined ? undefined : JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };
  const operator = { 'x-glmps-local-session': h.localSession };
  try {
    const created = await call('POST', '/api/backlog', { project: 'nq', title: 'Fix the broken thing', prompt: 'Fix the broken thing' }, operator);
    await fn({ call, id: created.body.id, operator, h });
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('a non-operator PATCH of testEditsApproved is refused', async () => {
  await withServer(async ({ call, id, operator }) => {
    const r = await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: true, title: 'sneaky' });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'operator-only', field: 'testEditsApproved' });
    const item = (await call('GET', `/api/backlog/${id}`, undefined, operator)).body;
    assert.equal(item.testEditsApproved ?? null, null);
    assert.equal(item.title, 'Fix the broken thing', 'other keys in the refused body are not applied');
  });
});

test('an operator PATCH with the local-session proof records by and at stamped by the server', async () => {
  await withServer(async ({ call, id, operator }) => {
    const before = Date.now();
    const r = await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: { note: 'Slack ok', by: 'agent', at: '1999-01-01T00:00:00.000Z' }, title: 'renamed' }, operator);
    assert.equal(r.status, 200);
    const a = r.body.testEditsApproved;
    assert.equal(a.by, 'operator');
    assert.equal(a.note, 'Slack ok');
    assert.ok(Date.parse(a.at) >= before - 1000, 'at is the server clock, not the client value');
    assert.equal(r.body.title, 'renamed', 'other keys still apply');
    const t = await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: true }, operator);
    assert.equal(t.body.testEditsApproved.note, null);
  });
});

test('the access token is accepted as operator proof', async () => {
  await withServer(async ({ call, id }) => {
    const r = await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: true }, { authorization: 'Bearer tok-123' });
    assert.equal(r.status, 200);
    assert.equal(r.body.testEditsApproved.by, 'operator');
    const bad = await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: false }, { authorization: 'Bearer wrong' });
    assert.equal(bad.status, 403);
  }, { GLMPS_ACCESS_TOKEN: 'tok-123' });
});

test('clearing with null (or false) removes the approval', async () => {
  await withServer(async ({ call, id, operator }) => {
    await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: true }, operator);
    const r = await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: null }, operator);
    assert.equal(r.status, 200);
    assert.equal(r.body.testEditsApproved, null);
    await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: true }, operator);
    assert.equal((await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: false }, operator)).body.testEditsApproved, null);
  });
});

test('GET /api/backlog/:id/chain returns testEditsApproved', async () => {
  await withServer(async ({ call, id, operator }) => {
    assert.equal((await call('GET', `/api/backlog/${id}/chain`, undefined, operator)).body.testEditsApproved, null);
    await call('PATCH', `/api/backlog/${id}`, { testEditsApproved: { note: 'n' } }, operator);
    const c = await call('GET', `/api/backlog/${id}/chain`, undefined, operator);
    assert.equal(c.body.testEditsApproved.by, 'operator');
    assert.equal(c.body.testEditsApproved.note, 'n');
  });
});

test('a generic PATCH without the key still works without proof', async () => {
  await withServer(async ({ call, id }) => {
    const r = await call('PATCH', `/api/backlog/${id}`, { title: 'plain edit' });
    assert.equal(r.status, 200);
    assert.equal(r.body.title, 'plain edit');
  });
});

test('an agent (no operator proof) may declare test edits; the server stamps by/at and posts a devlog notice', async () => {
  await withServer(async ({ call, id, operator }) => {
    const r = await call('PATCH', `/api/backlog/${id}`, { testEditsDeclared: { reason: '  the old assertion pins the bug  ', by: 'operator', at: '1999-01-01T00:00:00.000Z' } });
    assert.equal(r.status, 200);
    const d = r.body.testEditsDeclared;
    assert.equal(d.reason, 'the old assertion pins the bug');
    assert.equal(d.by, 'agent');
    assert.ok(Date.parse(d.at) > Date.parse('2000-01-01'));
    const item = (await call('GET', `/api/backlog/${id}`, undefined, operator)).body;
    const last = item.devLog[item.devLog.length - 1];
    assert.equal(last.text, "Editing existing tests on this bug-fix card. Reason given: the old assertion pins the bug. No reply needed; reply in this thread if you want the existing tests left alone.");
    assert.equal(item.testEditsApproved ?? null, null, 'declaring is not the operator approval');
  });
});

test('a declaration with an empty, blank, non-string or oversized reason is a 400 and stores nothing', async () => {
  await withServer(async ({ call, id, operator }) => {
    for (const v of [{ reason: '' }, { reason: '   ' }, { reason: 5 }, {}, 'why', true, { reason: 'x'.repeat(501) }]) {
      const r = await call('PATCH', `/api/backlog/${id}`, { testEditsDeclared: v });
      assert.equal(r.status, 400, JSON.stringify(v));
    }
    assert.equal((await call('GET', `/api/backlog/${id}`, undefined, operator)).body.testEditsDeclared ?? null, null);
  });
});

test('null clears a declaration, and the chain exposes it', async () => {
  await withServer(async ({ call, id, operator }) => {
    await call('PATCH', `/api/backlog/${id}`, { testEditsDeclared: { reason: 'r' } });
    const c = await call('GET', `/api/backlog/${id}/chain`, undefined, operator);
    assert.equal(c.body.testEditsDeclared.reason, 'r');
    const r = await call('PATCH', `/api/backlog/${id}`, { testEditsDeclared: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.testEditsDeclared, null);
  });
});
