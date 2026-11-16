// glmps-2-0-runtime-86 AC-2: the session summaries (a stat per transcript,
// ~2,200 on the live box) are computed at most once per poll tick and shared
// by every caller in that tick, then recomputed after the next poll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { waitFor } from './helpers/wait-for.js';

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sumtick-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  const proj = path.join(claudeDir, 'projects', 'D--proj');
  fs.mkdirSync(proj, { recursive: true });
  const id = '11111111-2222-3333-4444-555555555555';
  const transcript = path.join(proj, `${id}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: id, cwd: 'D:\\proj', message: { role: 'user', content: 'hi' } }) + '\n');
  const old = new Date(Date.now() - 3 * 86_400_000);
  fs.utimesSync(transcript, old, old);
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'g'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'v'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'a'),
    GLMPS_CODEX_DIR: path.join(tmp, 'c'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'cp'), GLMPS_HERMES_DIR: path.join(tmp, 'h'), GLMPS_OPENCODE_DIR: path.join(tmp, 'o'),
    GLMPS_UNMERGED_SCAN: 'off' };
  return { tmp, env, id, transcript, oldMs: old.getTime() };
}

const lastTsOf = async (base, id) => {
  const st = await (await fetch(`${base}/api/state?fields=sessions`)).json();
  return st.sessions.find((s) => s.id === id)?.lastTs;
};

test('callers within one poll tick share one summaries computation', async () => {
  const f = fixture();
  const srv = await startServer({ port: 0, pollMs: 600_000, env: f.env, configFile: path.join(f.tmp, 'none.json') });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const first = await lastTsOf(base, f.id);
    assert.ok(Math.abs(first - f.oldMs) < 2000, `first read sees the transcript mtime (${first})`);
    const fresh = new Date();
    fs.utimesSync(f.transcript, fresh, fresh);
    assert.equal(await lastTsOf(base, f.id), first, 'no poll has run, so the second caller reuses the tick\'s summaries');
  } finally { await srv.close(); fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('the next poll tick recomputes the summaries', async () => {
  const f = fixture();
  const srv = await startServer({ port: 0, pollMs: 50, env: f.env, configFile: path.join(f.tmp, 'none.json') });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const first = await lastTsOf(base, f.id);
    const fresh = new Date();
    fs.utimesSync(f.transcript, fresh, fresh);
    const seen = await waitFor(async () => { const t = await lastTsOf(base, f.id); return t !== first && t; },
      { intervalMs: 50, message: 'a poll to refresh the summaries' });
    assert.ok(Math.abs(seen - fresh.getTime()) < 2000, `after a poll the new mtime shows (${seen})`);
  } finally { await srv.close(); fs.rmSync(f.tmp, { recursive: true, force: true }); }
});
