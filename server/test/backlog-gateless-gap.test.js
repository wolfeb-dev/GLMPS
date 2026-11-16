// mc-15 loop completion: closing a ticket 'done' without a PASS/WAIVED gate must
// feed the capability learning loop as a 'ticket-closed-without-gate' gap (the
// queue-runner seed doc's "mined by the learning loop", now real). A PASS/WAIVED
// close must NOT emit. Boots the real server and inspects the learning store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gl-')); }
const H = { 'content-type': 'application/json' };

async function boot() {
  const stateDir = tmp();
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const jpost = async (p, obj) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(obj) })).json();
  const jpatch = async (p, obj) => (await fetch(base + p, { method: 'PATCH', headers: H, body: JSON.stringify(obj) })).json();
  const cleanup = async () => { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); fs.rmSync(claudeDir, { recursive: true, force: true }); };
  return { stateDir, jpost, jpatch, cleanup };
}

const gapCode = (stateDir) => (learningStore.load(stateDir).items || []).find((it) => it.code === 'ticket-closed-without-gate');

test('closing a ticket done WITHOUT a gate emits a ticket-closed-without-gate learning gap', async () => {
  const { stateDir, jpost, jpatch, cleanup } = await boot();
  try {
    const created = await jpost('/api/backlog', { title: 'do a thing' });
    const id = created.id ?? created.item?.id;
    assert.ok(id, 'ticket created');
    const patched = await jpatch(`/api/backlog/${id}`, { labels: ['agent:done'] });
    assert.equal(patched.state, 'done');
    assert.ok(gapCode(stateDir), 'gate-less close fed a ticket-closed-without-gate gap into the learning store');
  } finally { await cleanup(); }
});

test('closing a ticket done WITH a PASS gate does not emit the gap', async () => {
  const { stateDir, jpost, jpatch, cleanup } = await boot();
  try {
    const created = await jpost('/api/backlog', { title: 'do a thing' });
    const id = created.id ?? created.item?.id;
    await jpost(`/api/backlog/${id}/gate`, { status: 'PASS', evidence: ['tests green'], risk: 'P2' });
    await jpatch(`/api/backlog/${id}`, { labels: ['agent:done'] });
    assert.ok(!gapCode(stateDir), 'a PASS-gated close does not feed the gate-less gap');
  } finally { await cleanup(); }
});

test('a comment-only PATCH (no done label) does not emit the gap', async () => {
  const { stateDir, jpost, jpatch, cleanup } = await boot();
  try {
    const created = await jpost('/api/backlog', { title: 'do a thing' });
    const id = created.id ?? created.item?.id;
    await jpatch(`/api/backlog/${id}`, { comment: 'just a note' });
    assert.ok(!gapCode(stateDir), 'a non-closing PATCH never emits');
  } finally { await cleanup(); }
});
