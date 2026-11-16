// Kernel start reasons through a real server (card glmps-2-0-85): the restart
// route records who asked, and the next boot on the same state reports it on
// /healthz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { waitFor } from './helpers/wait-for.js';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-start-srv-'));
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

// Waits for this boot's own record: the start is classified once the version
// read resolves, so an earlier boot's record shows first.
function lastStart(port, starts) {
  return waitFor(async () => {
    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    return h.last_start && Object.values(h.starts_24h).reduce((x, y) => x + y, 0) === starts ? h : null;
  }, { message: `start ${starts} on /healthz` });
}

test('a browser-requested restart is the next start\'s reason, and /healthz shows it', async () => {
  const env = mkEnv();
  const a = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    const h = await lastStart(a.port, 1);
    assert.equal(h.last_start.reason, 'first recorded start');
    assert.deepEqual(h.shell.pickup, { last_ms: null, median_ms: null, max_ms: null, n: 0 });
    const r = await fetch(`http://127.0.0.1:${a.port}/api/restart`, {
      method: 'POST', headers: { 'x-glmps-local-session': a.localSession, 'user-agent': 'Mozilla/5.0 Chrome/155', referer: `http://127.0.0.1:${a.port}/settings` },
    });
    assert.equal(r.status, 200);
  } finally { await a.close(); }
  const b = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    const h = await lastStart(b.port, 2);
    assert.equal(h.last_start.reason, 'requested restart');
    assert.deepEqual(h.starts_24h, { 'first recorded start': 1, 'requested restart': 1 });
  } finally { await b.close(); }
  const c = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    assert.equal((await lastStart(c.port, 3)).last_start.reason, 'stop', 'a plain close is a clean stop');
    // The documented deploy: new code pulled, then Restart server. Stand in
    // for the pull by making the running process's boot version an old one.
    const file = path.join(env.GLMPS_STATE_DIR, 'kernel', 'starts.json');
    const ring = JSON.parse(fs.readFileSync(file, 'utf8'));
    ring.at(-1).version = '0.0.0+0ld0000';
    fs.writeFileSync(file, JSON.stringify(ring));
    const r = await fetch(`http://127.0.0.1:${c.port}/api/restart`, { method: 'POST', headers: { 'x-glmps-local-session': c.localSession, 'user-agent': 'Mozilla/5.0 Chrome/155' } });
    assert.equal(r.status, 200);
  } finally { await c.close(); }
  const d = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    const h = await lastStart(d.port, 4);
    assert.equal(h.last_start.reason, 'deploy', 'a Restart server across a version change is a deploy');
    assert.equal(h.starts_24h['requested restart'], 1, 'and is not counted as a requested restart');
  } finally { await d.close(); }
});
