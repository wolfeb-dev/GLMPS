// server/test/watch-loop-resilience.test.js
// glmps-47 frozen acceptance: inject a throwing read on one source and assert
// the watch loop survives and keeps extracting the other sources.
//
// The poison fixture is a REAL crash vector shaped like on-disk data: an
// assistant tool_use line with input:null used to throw inside
// extractClaudeEvents, propagate through tailOne -> poll() -> setInterval,
// and kill the entire capture process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const POISON_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-07-01T10:00:00Z',
  message: { content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: null }] },
});
const VALID_SKILL_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-07-01T10:00:01Z',
  message: { content: [{ type: 'tool_use', id: 'p2', name: 'Skill', input: { skill: 'x:y' } }] },
});
const VALID_EDIT_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-07-01T10:00:02Z',
  message: { content: [{ type: 'tool_use', id: 'h1', name: 'Edit', input: { file_path: 'D:\\proj\\a.js', old_string: 'x', new_string: 'y' } }] },
});

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-resil-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'D--test');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const poison = path.join(projDir, 'sess-poison.jsonl');
  const healthy = path.join(projDir, 'sess-healthy.jsonl');
  // poison source: a throwing line FOLLOWED by a valid line (per-line skip must
  // keep extracting the rest of the same source too)
  fs.writeFileSync(poison, POISON_LINE + '\n' + VALID_SKILL_LINE + '\n');
  fs.writeFileSync(healthy, VALID_EDIT_LINE + '\n');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify([
    { sessionId: 'sess-poison', ppid: process.pid, cwd: 'D:\\test', transcriptPath: poison, ts: Date.now() },
    { sessionId: 'sess-healthy', ppid: process.pid, cwd: 'D:\\test', transcriptPath: healthy, ts: Date.now() },
  ]));
  return { env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') } };
}

test('watch loop survives a throwing source and keeps extracting the others', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await new Promise(r => setTimeout(r, 400)); // several poll ticks over the poison source

    // the loop is alive
    assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);

    // the healthy source kept extracting
    const healthy = await (await fetch(`${base}/api/state?session=sess-healthy`)).json();
    assert.ok(healthy.events.some(e => e.kind === 'file-edit'), 'healthy source extracted');

    // the poison source skipped the bad line but extracted the valid one after it
    const poison = await (await fetch(`${base}/api/state?session=sess-poison`)).json();
    assert.ok(poison.events.some(e => e.kind === 'skill'), 'valid line after the poison line extracted');
  } finally { await srv.close(); }
});
