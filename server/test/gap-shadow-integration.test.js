// server/test/gap-shadow-integration.test.js
// End-to-end: a real session transcript that trips the ui-without-frontend-design
// gap, driven through the real /api/state route, records into the real shadow-arm
// NDJSON log - exercising the actual wiring in server.js (not just the pure
// units), then read back via GET /api/promotion/shadow.
//
// Guard proposer cutover: the autoApplyGaps-ON scenarios that used
// to live here (a template-seeded proposedGuard auto-applying through the
// reflex gate) are deleted along with the auto-apply-with-template branch -
// a gap item's proposedGuard is always null now, so there is nothing left to
// auto-apply. Only the observation-only arm remains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const SID = 'sess-shadow-1';

// An Edit tool_use on a .css file, with no Skill event at all -> detectGaps
// fires 'ui-without-frontend-design' (see server/lib/observability/gap-detect.js).
const UI_EDIT_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-07-09T10:00:00Z',
  message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit',
    input: { file_path: 'D:\\proj\\styles.css', old_string: 'a', new_string: 'b' } }] },
});

function mkClaudeEnv() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gapshadow-'));
  const claudeDir = path.join(t, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'D--proj');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, `${SID}.jsonl`);
  fs.writeFileSync(transcript, UI_EDIT_LINE + '\n');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify([
    { sessionId: SID, ppid: process.pid, cwd: 'D:\\proj', transcriptPath: transcript, ts: Date.now() },
  ]));
  return { tmpRoot: t, claudeDir };
}

function baseEnv(stateDir, claudeDir, extra = {}) {
  return {
    GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir,
    // An inherited GLMPS_ASSETS_DIR would hand the server the real guard file,
    // which marks the test's gap code as covered (glmps-2-0-82).
    GLMPS_ASSETS_DIR: path.join(stateDir, 'assets'),
    GLMPS_ANTIGRAVITY_DIR: path.join(stateDir, 'ag'),
    GLMPS_GEMINI_TMP_DIR: path.join(stateDir, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(stateDir, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(stateDir, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(stateDir, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(stateDir, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(stateDir, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(stateDir, 'opencode'),
    ...extra,
  };
}

test('gap-detect observation arm: autoApplyGaps OFF records fired:false once, not on re-poll', async () => {
  const { tmpRoot, claudeDir } = mkClaudeEnv();
  const stateDir = tmp('mc-state-');
  const env = { ...process.env, ...baseEnv(stateDir, claudeDir) };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    // First poll: gap is new -> counterfactual shadow recorded.
    const first = await (await fetch(`${base}/api/state?session=${SID}`)).json();
    assert.ok(first.gaps.some(g => g.code === 'ui-without-frontend-design'), 'gap detected on first poll');

    // Second poll of the SAME standing gap must NOT re-fire the shadow log.
    await fetch(`${base}/api/state?session=${SID}`);

    const shadow = await (await fetch(`${base}/api/promotion/shadow`)).json();
    const cls = shadow.byClass['ui-without-frontend-design'];
    assert.ok(cls, 'shadow bucket present for the gap code');
    assert.equal(cls.n, 1, 'exactly one shadow entry despite two /api/state polls');
    assert.equal(cls.fireRate, 0, 'not auto-applied -> did not actually fire');
    assert.equal(cls.counterfactualRate, null, 'gap-pipeline.js no longer fabricates a counterfactual');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

