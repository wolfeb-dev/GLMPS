// server/test/project-param-allowlist.test.js
// F7/F9/F12/F13: a raw ?project= reached existsSync, readFileSync and git's
// cwd, so a \\host\share value leaked the operator's NTLM hash and any local
// directory's graph or wiki manifest could be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-projparam-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const registered = path.join(tmp, 'registered'); fs.mkdirSync(registered);
  const unregistered = path.join(tmp, 'unregistered'); fs.mkdirSync(unregistered);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [registered.replace(/\\/g, '/')] } }));
  return { registered, unregistered, env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gt'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vs'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'),
    GLMPS_CODEX_DIR: path.join(tmp, 'cx'), GLMPS_HERMES_DIR: path.join(tmp, 'hm'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'oc'), GLMPS_UNMERGED_SCAN: 'off' } };
}

const UNC = ['\\\\attacker.example\\share', '//attacker.example/share', '\\\\?\\C:\\x'];

test('F7/F9: GET /api/graph refuses UNC/device (400) and unlisted (403) projects; a listed one still answers', async () => {
  const { registered, unregistered, env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    for (const p of UNC) {
      const r = await fetch(`${base}/api/graph?project=${encodeURIComponent(p)}`);
      assert.equal(r.status, 400, p);
      assert.match((await r.json()).error, /UNC or device/);
    }
    assert.equal((await fetch(`${base}/api/graph?project=${encodeURIComponent(unregistered)}`)).status, 403);
    assert.equal((await fetch(`${base}/api/graph?project=relative/dir`)).status, 400);
    const ok = await fetch(`${base}/api/graph?project=${encodeURIComponent(registered)}`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).project, registered);
  } finally { await srv.close(); }
});

test('F12/F13: GET /api/wiki refuses UNC/device and unlisted projects', async () => {
  const { unregistered, env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    for (const p of UNC) assert.equal((await fetch(`${base}/api/wiki?project=${encodeURIComponent(p)}`)).status, 400, p);
    assert.equal((await fetch(`${base}/api/wiki?project=${encodeURIComponent(unregistered)}`)).status, 403);
  } finally { await srv.close(); }
});

test('F12: POST /api/wiki/ask refuses a UNC or unlisted body.project before any backend is chosen', async () => {
  const { unregistered, env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const ask = (project) => fetch(`http://127.0.0.1:${srv.port}/api/wiki/ask`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'what?', project }) });
    assert.equal((await ask('\\\\attacker.example\\share')).status, 400);
    assert.equal((await ask(unregistered)).status, 403);
  } finally { await srv.close(); }
});
