// server/test/opencode-parity.integration.test.js
// Card glmps-2-0-runtime-132: an OpenCode session's id in /api/state carries no
// local path, and the events read for it carry that same id, across the real
// discover -> pollSnapshot -> /api/state path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { waitFor } from './helpers/wait-for.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-oc-parity-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  const storage = path.join(tmp, 'opencode', 'storage');
  const now = Date.now();
  writeJson(path.join(storage, 'project', 'proj1.json'), { id: 'proj1', worktree: 'D:\\proj' });
  writeJson(path.join(storage, 'session', 'proj1', 'ses001.json'), { id: 'ses001', title: 'Fix the parser', time: { created: now, updated: now } });
  writeJson(path.join(storage, 'message', 'ses001', 'msg001.json'), { id: 'msg001', role: 'user', time: { created: now } });
  writeJson(path.join(storage, 'part', 'msg001', 'prt001.json'), { type: 'text', text: 'Please fix the parser' });
  writeJson(path.join(storage, 'message', 'ses001', 'msg002.json'), { id: 'msg002', role: 'assistant', time: { created: now + 1 } });
  writeJson(path.join(storage, 'part', 'msg002', 'prt001.json'), { type: 'tool', tool: 'bash', state: { input: { command: 'git commit -m "fix: parser"' } } });
  return {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'), GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
  };
}

const SID = 'opencode:proj1:ses001';

test('opencode session id has no path in it and matches its events sessionId', async () => {
  const srv = await startServer({ port: 0, pollMs: 50, env: mkEnv() });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const sessions = await waitFor(async () => {
      const found = (await (await fetch(`${base}/api/state`)).json()).sessions.filter((x) => x.tool === 'opencode');
      return found.length ? found : null;
    }, { intervalMs: 50, message: 'the opencode session in /api/state' });
    assert.deepEqual(sessions.map((s) => s.id), [SID]);

    const detail = await (await fetch(`${base}/api/state?session=${encodeURIComponent(SID)}`)).json();
    assert.ok(detail.events.some((e) => e.kind === 'git'), 'git event read from the parts on disk');
    assert.ok(detail.events.length > 0 && detail.events.every((e) => e.sessionId === SID), 'every event carries the session row id');
  } finally { await srv.close(); }
});

// Card glmps-2-0-runtime-133, review finding 3: an index written before card 132
// holds the path-bearing descriptor id. It must come back as the one public id,
// not as a second session that carries a local path.
test('a legacy path-bearing opencode index row is migrated to the public id on load', async () => {
  const env = mkEnv();
  const legacyId = `${SID}|@dir@|${path.join(env.GLMPS_OPENCODE_DIR, 'storage', 'message', 'ses001')}`;
  const legacyRow = { id: legacyId, tool: 'opencode', cwd: 'D:\\proj', lastTs: Date.now() - 60_000, title: 'Fix the parser', skillsUsed: [], agentsUsed: [], eventCount: 0 };
  // Card glmps-2-0-runtime-139: an unescaped backslash here reads as the
  // drive-relative 'D:proj', which no real index row holds.
  assert.equal(path.win32.isAbsolute(legacyRow.cwd), true, 'the fixture cwd is an absolute Windows path');
  writeJson(path.join(env.GLMPS_STATE_DIR, 'state', 'index.json'), [legacyRow]);
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const ids = await waitFor(async () => {
      const st = await (await fetch(`${base}/api/state`)).json();
      const seen = [...st.sessions, ...st.history].filter((x) => x.tool === 'opencode').map((s) => s.id);
      const detail = await (await fetch(`${base}/api/state?session=${encodeURIComponent(SID)}`)).json();
      return detail.events?.length ? seen : null;
    }, { intervalMs: 50, message: 'events for the migrated opencode session' });
    assert.deepEqual([...new Set(ids)], [SID], 'one session, no local path in its id');
  } finally { await srv.close(); }
});
