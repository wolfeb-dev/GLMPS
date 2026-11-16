// Routes under test: server/lib/routes/workspace-routes.js
// server/test/workspace-dirty-check.test.js
// glmps-100 item 1: computeWorkspaceForSession() runs for every LIVE session
// on every poll tick (glmps-98), so an unconditional writeObserved/
// writeDivergence + broadcastWorkspace on every tick is fleet-wide disk-write
// + client-refresh amplification even when nothing changed. The fix gates
// each write behind a JSON-equality check against the persisted snapshot.
//
// This proves the invariant at the file-system level: writeJson() always
// physically rewrites+renames the file, which bumps its mtime regardless of
// content - so "the workspace file's mtime stops advancing once the computed
// observed/divergence stop changing" is exactly the signal a regression
// (reverting to the old unconditional-write behavior) would flip back on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const USER_LINE = JSON.stringify({
  type: 'user', timestamp: '2026-07-16T10:00:00Z',
  message: { content: 'Improve the dashboard styling module' },
});
const WRITE_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-07-16T10:00:01Z',
  message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write',
    input: { file_path: 'D:/test/prod/secret.txt', content: 'x' } }] },
});

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wsdirty-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'D--test');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, 'sess1.jsonl');
  fs.writeFileSync(transcript, USER_LINE + '\n' + WRITE_LINE + '\n');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    JSON.stringify([{ sessionId: 'sess1', ppid: process.pid, cwd: 'D:\\test', transcriptPath: transcript, ts: Date.now() }]));
  const stateDir = path.join(tmp, 'state');
  return {
    stateDir,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
      GLMPS_STATE_DIR: stateDir,
      GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
      GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
      GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
      GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
      GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
      GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
      GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') },
  };
}

async function pollUntil(fn, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise(res => setTimeout(res, stepMs));
  }
}

test('an unchanged live session does not get its workspace file rewritten on later poll ticks', async () => {
  const { env, stateDir } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const wsFile = path.join(stateDir, 'workspace', 'sess1.json');

    // Wait for the first computed workspace (divergence present -> file exists).
    await pollUntil(async () => {
      const r = await (await fetch(`${base}/api/workspace`)).json();
      const s = r.sessions.find(x => x.sessionId === 'sess1');
      return s?.divergence ? s : null;
    });
    assert.ok(fs.existsSync(wsFile), 'workspace file written after the first compute');
    const mtime1 = fs.statSync(wsFile).mtimeMs;

    // No new transcript content arrives - several more poll ticks pass (pollMs=50).
    await new Promise(r => setTimeout(r, 400));
    const mtime2 = fs.statSync(wsFile).mtimeMs;
    assert.equal(mtime2, mtime1, 'workspace file must not be rewritten when observed/divergence are unchanged (dirty-check)');
  } finally { await srv.close(); }
});
