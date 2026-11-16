// server/test/api-promotion-shadow.test.js
// GET /api/promotion/shadow - thin route over shadow-arm.js's shadowRates(),
// beside the existing GET /api/promotion. Route-level (seeded file) coverage;
// see gap-shadow-integration.test.js for the real gap-detect -> shadow wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { recordShadow } from '../lib/evaluation/shadow-arm.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('GET /api/promotion/shadow returns empty rates with no shadow log yet', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/promotion/shadow`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { byClass: {} });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

test('GET /api/promotion/shadow returns seeded fire/counterfactual rates by taskClass', async () => {
  const stateDir = tmp('mc-state-');
  // Seed directly via the real writer (same module the wiring calls) so this
  // test exercises the exact on-disk shape the route reads.
  recordShadow(stateDir, { taskClass: 'ui-without-frontend-design', wouldFire: true, fired: true, sid: 's1' });
  recordShadow(stateDir, { taskClass: 'ui-without-frontend-design', wouldFire: true, fired: false, sid: 's2' });
  recordShadow(stateDir, { taskClass: 'ui-without-frontend-design', wouldFire: true, fired: false, sid: 's3' });
  recordShadow(stateDir, { taskClass: 'ui-without-frontend-design', wouldFire: false, fired: false, sid: 's4' });

  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/promotion/shadow`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const cls = body.byClass['ui-without-frontend-design'];
    assert.ok(cls, 'taskClass bucket present');
    assert.equal(cls.n, 4);
    assert.equal(cls.counterfactualRate, 0.75);
    assert.equal(cls.fireRate, 0.25);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
