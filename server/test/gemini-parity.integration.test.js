// server/test/gemini-parity.integration.test.js
// glmps-51 frozen acceptance, end to end: a Gemini CLI session shows the model
// chip + context % on its card and appears in /api/usage perSession.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const SESSION = {
  sessionId: 'abc123', projectHash: 'proj1',
  startTime: 1751400000000, lastUpdated: 1751400010000,
  messages: [
    { id: 'm1', timestamp: 1751400000000, type: 'user', content: 'Add cumulative token parity' },
    { id: 'm2', timestamp: 1751400005000, type: 'gemini', model: 'gemini-2.5-pro', content: 'ok',
      tokens: { input: 6034, output: 79, cached: 0, thoughts: 300, tool: 0, total: 6413 } },
    { id: 'm3', timestamp: 1751400010000, type: 'gemini', model: 'gemini-2.5-pro', content: 'done',
      tokens: { input: 6258, output: 90, cached: 5294, thoughts: 1891, tool: 0, total: 8239 } },
  ],
};

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gempar-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const gem = path.join(tmp, 'gemini-tmp');
  const chats = path.join(gem, 'proj1', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(gem, 'proj1', '.project_root'), 'D:\\proj');
  fs.writeFileSync(path.join(chats, 'session-test1.json'), JSON.stringify(SESSION));
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'), GLMPS_GEMINI_TMP_DIR: gem,
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') };
}

const SID = 'gemini:proj1:session-test1';

test('gemini session surfaces model chip + context % and lands in usage analytics', async () => {
  const srv = await startServer({ port: 0, pollMs: 50, env: mkEnv() });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await new Promise(r => setTimeout(r, 400)); // let poll discover + parse the snapshot

    const state = await (await fetch(`${base}/api/state`)).json();
    const s = state.sessions.find(x => x.id === SID);
    assert.ok(s, 'gemini session listed');
    assert.equal(s.cwd, 'D:\\proj');
    assert.ok(s.status, 'status synthesized');
    assert.equal(s.status.model.id, 'gemini-2.5-pro', 'model chip');
    // ctx% = lastTurnTokens / contextWindow = 8239 / 1048576 -> 1%
    assert.equal(s.status.context.usedPercent, Math.round(100 * 8239 / 1048576), 'context %');

    const usage = await (await fetch(`${base}/api/usage`)).json();
    const row = (usage.perSession ?? []).find(r => r.sid === SID);
    assert.ok(row, 'gemini session present in usage perSession');
    assert.equal(row.model, 'gemini-2.5-pro');
    assert.equal(row.input, 6034 + 6258);
    assert.equal(row.output, 79 + 90);
    assert.equal(row.cacheRead, 5294);
  } finally { await srv.close(); }
});
