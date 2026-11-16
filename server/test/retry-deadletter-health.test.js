// server/test/retry-deadletter-health.test.js
//
// the round-3 I5 dead-letter test
// in plugin-loops.test.js only drove health.js directly (reportMiss /
// clearMiss on hand-picked ids), so it passed against the pre-fix code too.
// This drives the REAL server.js wiring end to end: a dead-letter file that
// cannot be read (here a directory, so readFileSync fails with EISDIR, not
// ENOENT) must surface through GET /api/alerts as its own
// "Kernel health: retry-queue-deadletter" alert, and an unrelated clean read
// of the retry queue file (the finalize sweep's own take()) must not clear it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { resetAdapterHealth } from '../lib/adapters/health.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

test('an unreadable dead-letter file raises its own Kernel health alert through the real server, and a clean queue read does not clear it', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-deadletter-'); const claudeDir = tmp('mc-deadletter-claude-');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const pluginsDir = path.join(stateDir, 'plugins');
  fs.mkdirSync(path.join(pluginsDir, 'retry-dead.ndjson'), { recursive: true }); // a directory: a real read failure, not ENOENT
  fs.writeFileSync(path.join(pluginsDir, 'retry.ndjson'), ''); // a clean (empty) queue file, so a queue read reaches onOk
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'config.json') });
  const titles = async () => (await (await fetch(`http://127.0.0.1:${h.port}/api/alerts`)).json()).alerts.map((a) => a.title);
  try {
    await titles(); // computes kernel health once: the dead-letter read fails and is reported
    h.finalizeSweepTick(); // an unrelated, clean read of the retry queue file
    const after = await titles();
    assert.ok(
      after.includes('Kernel health: retry-queue-deadletter'),
      `the dead-letter read failure must render as its own alert and survive an unrelated clean queue read, got: ${JSON.stringify(after)}`,
    );
  } finally {
    await h.close?.();
    resetAdapterHealth();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
