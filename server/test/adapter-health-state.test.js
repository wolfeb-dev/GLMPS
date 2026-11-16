// server/test/adapter-health-state.test.js
// glmps-45: adapter health is threaded into the global /api/state response so
// the UI can show which capture source is degraded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { reportMiss, resetAdapterHealth } from '../lib/adapters/health.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-health-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') };
}

test('global /api/state carries adapterHealth with degraded adapters', async () => {
  resetAdapterHealth();
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv() });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    let state = await (await fetch(`${base}/api/state`)).json();
    // whether the worktree sweep's test-write guard
    // has reported by now depends on the environment (it fires only when a
    // test-process signal is present and a real root is found), so its key
    // is removed before comparing - this test is about gemini-cli's own
    // miss, not the sweep's.
    const initial = { ...state.adapterHealth };
    delete initial['sweep-worktrees-test-guard'];
    assert.deepEqual(initial, {});

    reportMiss('gemini-cli', 'messages array missing');
    state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.adapterHealth['gemini-cli'].degraded, true);
    assert.equal(state.adapterHealth['gemini-cli'].lastReason, 'messages array missing');
  } finally {
    resetAdapterHealth();
    await srv.close();
  }
});
