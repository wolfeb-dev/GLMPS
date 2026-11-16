// Card glmps-2-0-201: the operator switch, the auto-approval listing and the
// revert route, on a throwaway server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGuardAutoApprove, saveGuardAutoApprove, loadOperatorSettings, saveOperatorTimeZone } from '../lib/operator-settings.js';
import { startServer } from '../server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-autoapprove-'));

test('the switch is on by default, persists when turned off, and keeps the saved timezone', () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadGuardAutoApprove(dir), { enabled: true, source: 'default' });
    saveOperatorTimeZone(dir, 'Europe/Berlin');
    assert.deepEqual(saveGuardAutoApprove(dir, false), { ok: true, enabled: false, source: 'saved' });
    assert.deepEqual(loadGuardAutoApprove(dir), { enabled: false, source: 'saved' });
    assert.equal(loadOperatorSettings(dir).timeZone, 'Europe/Berlin');
    assert.equal(saveGuardAutoApprove(dir, 'no').ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET/POST /api/settings/guard-auto-approve, GET /api/learning/auto-approvals, revert of an unknown code is 404, loop is registered', async () => {
  const base = tmp();
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off', GLMPS_ALLOW_ACT: '1' };
  const h = await startServer({ port: 0, env });
  const url = (p) => `http://127.0.0.1:${h.port}${p}`;
  const post = (p, body) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(url('/api/settings/guard-auto-approve'))).json(), { enabled: true, source: 'default' });
    assert.equal((await post('/api/settings/guard-auto-approve', { enabled: 'yes' })).status, 400);
    const off = await post('/api/settings/guard-auto-approve', { enabled: false });
    assert.deepEqual(await off.json(), { enabled: false, source: 'saved' });

    const list = await (await fetch(url('/api/learning/auto-approvals'))).json();
    assert.equal(list.enabled, false);
    assert.equal(list.policy.minSessions, 5);
    assert.deepEqual(list.records, []);

    assert.equal((await post('/api/learning/auto-approvals/sleep-poll/revert', {})).status, 404);

    const loops = (await (await fetch(url('/api/loops/catalog'))).json()).loops;
    assert.ok(loops.some((l) => l.name === 'guard-auto-approve' && l.about), 'the loop is registered and described');
  } finally {
    await h.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
