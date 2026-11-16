// POST /api/replay/run validation surface (glmps-68). The actual headless
// launch is covered in replay-launch.test.js with injected fakes; these tests
// only exercise the endpoint's guards, so no claude process can ever spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { addReplayTask } from '../lib/evaluation/replay-set.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

async function boot() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replayrun-'));
  const claudeDir = claudeTmp();
  tmpDirs.push(stateDir, claudeDir);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  return { h, stateDir, url: `http://127.0.0.1:${h.port}` };
}

test('POST /api/replay/run rejects an argv-hostile model id', async () => {
  const { h, url } = await boot();
  try {
    const res = await fetch(`${url}/api/replay/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x && calc.exe' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /model/i);
  } finally { await h.close(); }
});

test('POST /api/replay/run with an empty replay set is a 400, not a silent no-op', async () => {
  const { h, url } = await boot();
  try {
    const res = await fetch(`${url}/api/replay/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no replay tasks/i);
  } finally { await h.close(); }
});

test('GET /api/replay exposes the run status field', async () => {
  const { h, url, stateDir } = await boot();
  try {
    addReplayTask(stateDir, { id: 'rt1', promptFile: null });
    const res = await fetch(`${url}/api/replay`);
    const body = await res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.run, null);
  } finally { await h.close(); }
});

test('POST /api/replay/run filters to unknown taskIds -> 400', async () => {
  const { h, url, stateDir } = await boot();
  try {
    addReplayTask(stateDir, { id: 'rt1', promptFile: null });
    const res = await fetch(`${url}/api/replay/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', taskIds: ['nope'] }),
    });
    assert.equal(res.status, 400);
  } finally { await h.close(); }
});
