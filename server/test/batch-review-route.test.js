// Routes under test: server/lib/routes/merge-queue-routes.js
// Card glmps-2-0-runtime-126: the batched reviewer's one findings call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { saveState, loadState, hashNonce } from '../lib/orchestration/batch-review.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-batch-review-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return {
    GLMPS_TEST: '1', GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
  };
}

const KEY = 'acme/w@main';
const running = {
  from: 'a'.repeat(40), to: 'b'.repeat(40), shas: [], merges: 5, cards: ['c-1', 'c-5'], trigger: 'c-5',
  project: 'glmps', repo: 'acme/w', base: 'main', jobId: 'batch-acme_w_main-review-r1',
  nonceHash: hashNonce('the-nonce'), launchedAt: new Date().toISOString(), model: 'sonnet',
};
const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/merge-queue/batch-review`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// A test server never registers the loop by default, which hid a boot crash
// (no sla) that every production start would have hit.
test('the server boots with the batched review loop registered', async () => {
  const env = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env, batchReviewInTest: true });
  try {
    const loops = await (await fetch(`http://127.0.0.1:${srv.port}/api/loops`)).json();
    assert.ok(loops['merge-queue-batch-review'], Object.keys(loops).join(', '));
    assert.equal(loops['merge-queue-batch-review'].trigger.everyMs, 10 * 60_000);
  } finally { await srv.close(); }
});

test('AC-1: findings posted with the launch nonce file one card and advance the reviewed sha; a wrong nonce is refused', async () => {
  const env = mkEnv();
  saveState(env.GLMPS_STATE_DIR, { [KEY]: { lastReviewedSha: running.from, round: 1, running } });
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const bad = await post(srv.port, { key: KEY, nonce: 'guess', findings: ['x'] });
    assert.equal(bad.status, 403);

    const r = await post(srv.port, { key: KEY, nonce: 'the-nonce', findings: ['c-5 AC-2 has no test', 'c-1 leaks a timer'], summary: 'two problems' });
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    assert.ok(body.cardId, 'a card id comes back');

    const items = await (await fetch(`http://127.0.0.1:${srv.port}/api/backlog`)).json();
    const list = items.items ?? items;
    const filed = list.filter((c) => /Batched review of main/.test(c.title));
    assert.equal(filed.length, 1);
    assert.match(filed[0].prompt, /c-5 AC-2 has no test/);

    const rec = loadState(env.GLMPS_STATE_DIR)[KEY];
    assert.equal(rec.lastReviewedSha, running.to);
    assert.equal(rec.running, null);
    assert.equal(rec.lastCardId, body.cardId);
    assert.equal((await post(srv.port, { key: KEY, nonce: 'the-nonce', findings: [] })).status, 403, 'the nonce is spent');
  } finally { await srv.close(); }
});
