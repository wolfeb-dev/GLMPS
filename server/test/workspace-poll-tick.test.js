// Routes under test: server/lib/routes/workspace-routes.js
// server/test/workspace-poll-tick.test.js
// glmps-98: the agent-workspace observe+divergence compute must run inside
// pollCore() for every live session, every tick - fleet-wide, even with NO
// dashboard open. Before this ticket the compute lived ONLY inside the
// GET /api/state?session= handler (compute-on-read), so an unattended
// overnight queue-runner job editing a FROZEN/prod path would never raise a
// divergence Signal unless someone happened to load that session in the
// dashboard. This test proves the fix by NEVER calling
// /api/state?session=... - only the poll tick (pollMs) and two endpoints
// that read already-computed state (GET /api/workspace, GET /api/alerts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// First user turn -> becomes the session title -> seeds declared.goal
// (workspace-observe.js's one-time title fallback). No token here overlaps
// "prod", so the frozen/prod-zone divergence branch fires.
const USER_LINE = JSON.stringify({
  type: 'user', timestamp: '2026-07-16T10:00:00Z',
  message: { content: 'Improve the dashboard styling module' },
});
// A Write into a path with a "prod" segment -> classifyPath marks it
// protected/env:prod -> scopeZone() returns the 'prod' token -> computeDivergence's
// high branch fires because the declared goal never named "prod".
const WRITE_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-07-16T10:00:01Z',
  message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write',
    input: { file_path: 'D:/test/prod/secret.txt', content: 'x' } }] },
});

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wspoll-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'D--test');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, 'sess1.jsonl');
  fs.writeFileSync(transcript, USER_LINE + '\n' + WRITE_LINE + '\n');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    JSON.stringify([{ sessionId: 'sess1', ppid: process.pid, cwd: 'D:\\test', transcriptPath: transcript, ts: Date.now() }]));
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

async function pollUntil(fn, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > deadline) throw new Error('pollUntil: timed out');
    await new Promise(res => setTimeout(res, stepMs));
  }
}

test('poll tick alone (no /api/state?session= call) computes divergence + raises a workspace Signal', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;

    // GET /api/workspace reads already-computed state (readWorkspace), never
    // recomputes - proves the compute happened inside the poll tick itself.
    const ws = await pollUntil(async () => {
      const r = await (await fetch(`${base}/api/workspace`)).json();
      const s = r.sessions.find(x => x.sessionId === 'sess1');
      return s?.divergence ? s : null;
    });
    assert.equal(ws.divergence.level, 'high', JSON.stringify(ws));
    assert.ok(ws.declared?.goal?.includes('dashboard'), 'declared goal seeded from the session title');
    assert.ok(ws.observed?.activePaths?.some(p => p.includes('prod')), 'observed captured the prod-path edit');

    // GET /api/alerts reads the in-memory workspaceSignals list via the
    // registered signal-producer seam - also never touches /api/state?session=.
    const alerts = await pollUntil(async () => {
      const r = await (await fetch(`${base}/api/alerts`)).json();
      const a = r.alerts.find(x => x.source === 'workspace-divergence' && x.target?.id === 'sess1');
      return a ?? null;
    });
    assert.equal(alerts.source, 'workspace-divergence');
    assert.equal(alerts.severity, 'warn');
  } finally { await srv.close(); }
});
