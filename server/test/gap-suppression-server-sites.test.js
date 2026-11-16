// server/test/gap-suppression-server-sites.test.js
// glmps-97 (server.js half): capability-feed-core.js already exported
// filterDispatchedWorktreeGaps/isDispatchedWorktreeCwd, but server.js had two
// direct detectGaps(...) call sites that bypassed the Stop-hook path and kept
// false-positive-ing skill-gated gap codes for dispatched
// Agent(isolation:"worktree") sessions:
//   1. the dashboard gapCount badge (/api/state sessions[].gapCount)
//   2. the learning-store upsertGapAndApply loop (persists into /api/learning)
// This test proves both sites now suppress ui-without-frontend-design for a
// session whose cwd lives under .claude/worktrees/lane-*|agent-*, while an
// identical transcript from a normal cwd still flags/persists it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gap-sites-'));
  tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });

  // Dispatched-worktree session: cwd under .claude/worktrees/lane-*
  const dispatchedCwd = path.join(tmp, 'repo', '.claude', 'worktrees', 'lane-g97test');
  const dispatchedProjDir = path.join(claudeDir, 'projects', 'D--dispatched');
  fs.mkdirSync(dispatchedProjDir, { recursive: true });
  const dispatchedTranscript = path.join(dispatchedProjDir, 'sessDispatched.jsonl');

  // Normal session: plain repo cwd, no worktree segment.
  const normalCwd = path.join(tmp, 'repo');
  const normalProjDir = path.join(claudeDir, 'projects', 'D--normal');
  fs.mkdirSync(normalProjDir, { recursive: true });
  const normalTranscript = path.join(normalProjDir, 'sessNormal.jsonl');

  // Identical payload for both: an Edit on a UI/style file, no Skill tool_use.
  const uiEditLine = JSON.stringify({
    type: 'assistant', timestamp: '2026-07-16T10:00:00Z',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit',
      input: { file_path: 'web/styles.css', old_string: 'a', new_string: 'b' } }] },
  }) + '\n';
  fs.writeFileSync(dispatchedTranscript, uiEditLine);
  fs.writeFileSync(normalTranscript, uiEditLine);

  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify([
    { sessionId: 'sessDispatched', ppid: process.pid, cwd: dispatchedCwd, transcriptPath: dispatchedTranscript, ts: Date.now() },
    { sessionId: 'sessNormal', ppid: process.pid, cwd: normalCwd, transcriptPath: normalTranscript, ts: Date.now() },
  ]));

  return {
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
           GLMPS_STATE_DIR: path.join(tmp, 'state'),
           GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
           GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
           GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
           GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
           GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') },
  };
}

test('site 1 (gapCount badge): dispatched-worktree session suppresses ui-without-frontend-design, normal session still flags it', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const state = await (await fetch(`${base}/api/state`)).json();
    const dispatched = state.sessions.find(s => s.id === 'sessDispatched');
    const normal = state.sessions.find(s => s.id === 'sessNormal');
    assert.ok(dispatched, 'dispatched session present');
    assert.ok(normal, 'normal session present');
    assert.equal(dispatched.gapCount, 0, 'dispatched-worktree session must not count the skill-gated gap');
    assert.equal(normal.gapCount, 1, 'normal session must still surface ui-without-frontend-design');
  } finally { await srv.close(); }
});

test('site 2 (learning-store upsert loop): dispatched-worktree gap is never persisted; normal session\'s is', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    // Hit /api/state at least once so the per-session gap loop (which runs
    // inside the /api/state handler) has a chance to persist into the store.
    await fetch(`${base}/api/state`);
    await fetch(`${base}/api/state?session=sessDispatched`);
    await fetch(`${base}/api/state?session=sessNormal`);

    const learning = await (await fetch(`${base}/api/learning`)).json();
    const uiGapItems = learning.items.filter(i => i.code === 'ui-without-frontend-design');
    assert.equal(uiGapItems.length, 1, 'exactly one persisted ui-without-frontend-design item (from the normal session only)');
    assert.equal(uiGapItems[0].sessionId, 'sessNormal', 'the persisted item must trace back to the normal (non-dispatched) session');
  } finally { await srv.close(); }
});
