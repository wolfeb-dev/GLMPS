import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

test('GET /api/learning/outcome-metrics returns four tagged metrics; days is validated', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-'));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/learning/outcome-metrics`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.windowDays, 30);
    assert.deepEqual(body.metrics.map((m) => m.id), ['first-pass-ci', 'merged-first-pass', 'time-to-first-review', 'breach-to-card']);
    for (const m of body.metrics) { assert.ok('evidence' in m.value); assert.ok('n' in m.value); }
    const bad = await fetch(`http://127.0.0.1:${h.port}/api/learning/outcome-metrics?days=0`);
    assert.equal(bad.status, 400);
    const seven = await (await fetch(`http://127.0.0.1:${h.port}/api/learning/outcome-metrics?days=7`)).json();
    assert.equal(seven.windowDays, 7);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
