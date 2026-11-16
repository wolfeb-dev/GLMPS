// glmps-2-0-171 D3: when the last hosted card closes, the host is told once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { load, save } from '../lib/orchestration/backlog-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

test('closing the last hosted card writes one notice on the host; an earlier close does not', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hostnote-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const call = async (method, p, obj) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };
  const file = async (title) => (await call('POST', '/api/backlog', { title, acceptanceCriteria: ['x'] })).body;
  const notices = (id) => (load(stateDir).items.find((i) => i.id === id).devLog ?? []).filter((d) => d.text.startsWith('all hosted cards are closed; this card can close'));
  try {
    const host = await file('host card');
    const a = await file('kid a');
    const b = await file('kid b');
    assert.equal((await call('POST', `/api/backlog/${host.id}/adopt`, { ids: [a.id, b.id] })).status, 200);
    assert.equal((await call('PATCH', `/api/backlog/${a.id}`, { labels: ['agent:done'] })).status, 200);
    assert.equal(notices(host.id).length, 0, 'one hosted card is still open');
    assert.equal((await call('PATCH', `/api/backlog/${b.id}`, { labels: ['agent:done'] })).status, 200);
    assert.equal(notices(host.id).length, 1);
    assert.equal((await call('PATCH', `/api/backlog/${host.id}`, { comment: 'again' })).status, 200);
    assert.equal(notices(host.id).length, 1, 'no repeat');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
