// The baseline report route once read an `attestation` local that the
// guardrail-attestation removal (upgrade item 18) deleted, so the route threw
// on every request while no test exercised it end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

test('GET /api/report/baseline renders the report without a guardrail attestation section', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-report-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/report/baseline`);
    const html = await r.text();
    assert.equal(r.status, 200, html.slice(0, 300));
    assert.match(html, /Roadmap/);
    assert.doesNotMatch(html, /Guardrail Attestation/);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
