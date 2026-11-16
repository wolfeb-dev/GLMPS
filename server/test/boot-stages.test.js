// Card glmps-2-0-runtime-93: the boot's post-listen work (first poll,
// inventory scan, measurables, first worktree sweep) runs in its own loop
// turns, and the boot trace names every span from process start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { startServer } from '../server.js';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-boot-stages-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    ...process.env,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_SCUT: 'off',
  };
}

test('boot trace names each boot span from process start, ending with the staged work', async () => {
  const srv = await startServer({ port: 0, env: mkEnv() });
  try {
    const spans = srv.bootTrace();
    assert.equal(spans[0].name, 'import');
    assert.equal(spans[0].endMs, spans[0].ms, 'the first span starts at process start');
    const names = spans.filter((s) => !s.name.startsWith('before ')).map((s) => s.name);
    assert.deepEqual(names, ['import', 'setup', 'pre-plugin setup', 'plugin load', 'routes and loops', 'listen',
      'first poll', 'inventory', 'measurables', 'worktree sweep start']);
    assert.equal(spans.find((s) => s.name === 'inventory').waited, true, 'the boot inventory scan is async');
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i].endMs >= spans[i - 1].endMs);
  } finally { await srv.close(); }
});

test('a timer runs between the listen continuation and the first poll, so they are separate blocks', async () => {
  const ticks = [];
  const timer = setInterval(() => ticks.push(performance.now()), 1);
  let srv;
  try {
    srv = await startServer({ port: 0, env: mkEnv() });
  } finally { clearInterval(timer); }
  try {
    const spans = srv.bootTrace();
    const routesEnd = spans.find((s) => s.name === 'routes and loops').endMs;
    const poll = spans.find((s) => s.name === 'first poll');
    const pollStart = poll.endMs - poll.ms;
    assert.ok(ticks.some((t) => t >= routesEnd - 1 && t <= pollStart + 1),
      `no timer tick between routes end ${routesEnd} ms and first poll start ${pollStart} ms`);
  } finally { await srv.close(); }
});
