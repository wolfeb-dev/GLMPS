// server/test/api-coverage-alerts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cov-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { env: {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
  } };
}

test('GET /api/coverage: registry-based capture surface', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const cov = await (await fetch(`http://127.0.0.1:${srv.port}/api/coverage`)).json();
    assert.equal(cov.reference, 'claude-code');
    const byId = Object.fromEntries(cov.tools.map(t => [t.id, t]));
    assert.ok(byId['claude-code'].hasAdapter && byId['claude-code'].reference);
    assert.ok(byId['copilot-chat'].hasAdapter, 'copilot chat covered');
    assert.ok(byId['copilot-cli'].hasAdapter, 'copilot cli now covered');
    assert.equal(byId['cursor-native'].hasAdapter, false, 'cursor-native uncovered');
    assert.ok(cov.uncovered.includes('cursor-native') && !cov.uncovered.includes('copilot-cli'));
    for (const id of ['cline', 'opencode', 'openclaw', 'cursor-cli', 'grok', 'pi', 'droid']) {
      assert.ok(byId[id].hasAdapter && !cov.uncovered.includes(id), `${id} covered`);
    }
    for (const id of ['cursor-cli', 'droid', 'openclaw']) assert.equal(byId[id].speculative, true, `${id} flagged speculative`);
    assert.equal(byId['claude-code'].speculative, false);
    assert.ok(cov.covered >= 7);
  } finally { await srv.close(); }
});

test('GET /api/alerts: uncovered high-popularity tools raise capture flags + summary', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const { alerts, summary } = await (await fetch(`http://127.0.0.1:${srv.port}/api/alerts`)).json();
    assert.ok(Array.isArray(alerts));
    assert.ok(summary.total >= 1);
    const capture = alerts.filter(a => a.source === 'capture');
    assert.ok(capture.some(a => a.title.includes('No capture adapter')));
    // uncovered high-pop tools (Cursor-native) should be flagged; long-tail not
    const titles = capture.map(a => a.title).join(' ');
    assert.ok(/cursor-native/.test(titles));
    // shape checks
    for (const a of alerts) { assert.ok(a.id && a.severity && a.title); }
  } finally { await srv.close(); }
});
