// Endpoints for session control: stop (glmps-28) and approval gates
// (glmps-29). Booted against an isolated state dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { readControl, openGate } from '../lib/orchestration/control-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-ctl-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed = null;
    try { parsed = await r.json(); } catch {}
    return { status: r.status, body: parsed };
  };
  try {
    await fn({ call, stateDir, port: h.port });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
}


test('POST /api/sessions/:id/stop records a stop the hook can see', async () => {
  await withServer(async ({ call, stateDir }) => {
    const r = await call('POST', '/api/sessions/sess-1/stop', { reason: 'wrong branch', from: 'operator' });
    assert.equal(r.status, 200);
    const rec = readControl(stateDir, 'sess-1');
    assert.equal(rec.stop.reason, 'wrong branch');
    assert.equal(rec.stop.from, 'operator');
  });
});

test('DELETE /api/sessions/:id/stop lifts it', async () => {
  await withServer(async ({ call, stateDir }) => {
    await call('POST', '/api/sessions/sess-1/stop', { reason: 'halt' });
    const r = await call('DELETE', '/api/sessions/sess-1/stop');
    assert.equal(r.status, 200);
    assert.equal(readControl(stateDir, 'sess-1').stop, null);
  });
});

test('a stop with no reason still records a usable default', async () => {
  await withServer(async ({ call, stateDir }) => {
    await call('POST', '/api/sessions/sess-1/stop', {});
    assert.ok(readControl(stateDir, 'sess-1').stop.reason.length > 0);
  });
});


test('gate open -> poll pending -> decide approved -> poll approved', async () => {
  await withServer(async ({ call, stateDir }) => {
    const open = await call('POST', '/api/control/gate', { sessionId: 's1', tool: 'Bash', summary: 'deploy' });
    assert.equal(open.status, 200);
    const id = open.body.id;
    assert.ok(id, 'server mints the gate id');

    const pending = await call('GET', `/api/control/gate/${id}?session=s1`);
    assert.equal(pending.body.decision, 'pending');

    const decided = await call('POST', `/api/control/gate/${id}/decision`, { decision: 'approved', by: 'U1' });
    assert.equal(decided.status, 200);

    const after = await call('GET', `/api/control/gate/${id}?session=s1`);
    assert.equal(after.body.decision, 'approved');
    assert.equal(after.body.by, 'U1');
    assert.equal(readControl(stateDir, 's1').gate.decision, 'approved');
  });
});

test('a denial carries the operator reason back to the poller', async () => {
  await withServer(async ({ call }) => {
    const id = (await call('POST', '/api/control/gate', { sessionId: 's1', tool: 'Bash', summary: 'x' })).body.id;
    await call('POST', `/api/control/gate/${id}/decision`, { decision: 'denied', by: 'U1', reason: 'not on main' });
    const after = await call('GET', `/api/control/gate/${id}?session=s1`);
    assert.equal(after.body.decision, 'denied');
    assert.equal(after.body.reason, 'not on main');
  });
});

test('a second decision on the same gate is refused (idempotent, not flippable)', async () => {
  await withServer(async ({ call }) => {
    const id = (await call('POST', '/api/control/gate', { sessionId: 's1', tool: 'Bash', summary: 'x' })).body.id;
    await call('POST', `/api/control/gate/${id}/decision`, { decision: 'denied', by: 'U1' });
    const second = await call('POST', `/api/control/gate/${id}/decision`, { decision: 'approved', by: 'U2' });
    assert.equal(second.status, 409);
    const after = await call('GET', `/api/control/gate/${id}?session=s1`);
    assert.equal(after.body.decision, 'denied', 'the first decision stands');
  });
});

test('deciding an unknown gate is a 404, not a silent success', async () => {
  await withServer(async ({ call }) => {
    const r = await call('POST', '/api/control/gate/g-nope/decision', { decision: 'approved', by: 'U1' });
    assert.equal(r.status, 404);
  });
});

test('the gate id is server-minted, so a session cannot claim another session\'s id', async () => {
  await withServer(async ({ call, stateDir }) => {
    // A client-supplied id must be ignored: otherwise session B could open a
    // gate under an id session A is polling and have A released by B's approval.
    openGate(stateDir, 'victim', { id: 'g-forged', tool: 'Bash', summary: 'victim work', ts: 1 });
    const open = await call('POST', '/api/control/gate', { sessionId: 'attacker', tool: 'Bash', summary: 'x', id: 'g-forged' });
    assert.notEqual(open.body.id, 'g-forged');
    assert.equal(readControl(stateDir, 'victim').gate.decision, 'pending', 'the victim gate is untouched');
  });
});

test('polling an unknown gate reports unknown rather than pending forever', async () => {
  await withServer(async ({ call }) => {
    const r = await call('GET', '/api/control/gate/g-nope?session=s1');
    assert.equal(r.status, 404);
  });
});

//
// A gate nobody can see is worse than no gate: the agent blocks for the full
// budget and is then denied, with no explanation anywhere. Most sessions are
// started at the desk and never bind a Slack thread, so the room post cannot be
// the only channel.

test('a pending gate surfaces on /api/alerts', async () => {
  await withServer(async ({ call }) => {
    const id = (await call('POST', '/api/control/gate', { sessionId: 's1', tool: 'Write', summary: 'Write D:/glmps_prod/x' })).body.id;
    const alerts = (await call('GET', '/api/alerts')).body.alerts ?? [];
    const mine = alerts.find(a => a.source === 'control-gate' && a.detail.includes(id));
    assert.ok(mine, 'a blocked agent must be visible somewhere other than Slack');
    assert.match(mine.title, /waiting for approval/i);
  });
});

test('a decided gate stops alerting', async () => {
  await withServer(async ({ call }) => {
    const id = (await call('POST', '/api/control/gate', { sessionId: 's1', tool: 'Write', summary: 'x' })).body.id;
    await call('POST', `/api/control/gate/${id}/decision`, { decision: 'approved', by: 'U1' });
    const alerts = (await call('GET', '/api/alerts')).body.alerts ?? [];
    assert.ok(!alerts.some(a => a.source === 'control-gate' && a.detail.includes(id)),
      'an answered gate is not still pending');
  });
});
