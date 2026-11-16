// server/test/signal-producer-integration.test.js
// Regression guard for the Coordination Contract's signal-producer seam:
// collectCurrentAlerts() (server.js) must read every registered producer via
// signal-producer.js's collectSignals(), not a hardcoded splice (that was
// Build A's Task-8 attestation-channel stopgap). Proves the seam is real by
// registering a producer from OUTSIDE server.js and confirming its row
// surfaces through GET /api/alerts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { registerProducer } from '../lib/evaluation/signal-producer.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

let stateDir1;
let claudeDir1;
let h1;

before(async () => {
  stateDir1 = tmp('mc-state-');
  claudeDir1 = tmp('mc-claude-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir1, GLMPS_CLAUDE_DIR: claudeDir1 };
  h1 = await startServer({ port: 0, env, configFile: path.join(stateDir1, 'no-config.json') });
});

after(async () => {
  await h1?.close?.();
  fs.rmSync(stateDir1, { recursive: true, force: true });
  fs.rmSync(claudeDir1, { recursive: true, force: true });
});

test('GET /api/alerts includes a row from an externally-registered signal producer', async () => {
  registerProducer(() => [{
    source: 'test-seam-probe', severity: 'warn', title: 'seam probe', detail: 'proves the registry seam',
    target: { view: 'governance' }, ts: 0,
  }]);
  const r = await fetch(`http://127.0.0.1:${h1.port}/api/alerts`);
  assert.equal(r.status, 200);
  const body = await r.json();
  const probe = body.alerts.find(a => a.source === 'test-seam-probe');
  assert.ok(probe, 'expected the externally-registered producer row to reach GET /api/alerts');
});

test('startServer() resets the registry, so a second server does not double-count a prior producer', async () => {
  registerProducer(() => [{ source: 'first-server-probe', severity: 'info', title: 'x', detail: '', target: null, ts: 0 }]);

  const stateDir2 = tmp('mc-state-');
  const claudeDir2 = tmp('mc-claude-');
  const h2 = await startServer({ port: 0, env: { ...process.env, GLMPS_STATE_DIR: stateDir2, GLMPS_CLAUDE_DIR: claudeDir2 }, configFile: path.join(stateDir2, 'no-config.json') });
  try {
    const body = await (await fetch(`http://127.0.0.1:${h2.port}/api/alerts`)).json();
    assert.ok(!body.alerts.some(a => a.source === 'first-server-probe'), 'a producer registered against the first server must not leak into the second');
  } finally {
    await h2.close?.();
    fs.rmSync(stateDir2, { recursive: true, force: true });
    fs.rmSync(claudeDir2, { recursive: true, force: true });
  }
});
