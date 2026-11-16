// Routes under test: server/lib/routes/guards-routes.js
// Guard refusals are recorded with the session that hit them and joined onto
// the per-session response (card glmps-2-0-runtime-59, session-detail spec
// section 8 item 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { sessionRefusals } from '../lib/governance/session-refusals.js';

const mine = { ts: 3, hook: 'plan-gate', cardId: 'c-1', sessionId: 's-1', tool: 'Edit', path: 'a.js', reason: 'no plan', failOpen: false };
const mineOpen = { ts: 4, hook: 'test-file-guard', cardId: 'c-1', sessionId: 's-1', tool: 'Write', path: 'x.test.js', reason: 'board down', failOpen: true };
const legacy = { ts: 1, hook: 'plan-gate', cardId: 'c-1', tool: 'Edit', path: 'b.js', reason: 'old', failOpen: false };
const sibling = { ts: 2, hook: 'plan-gate', cardId: 'c-1', sessionId: 's-0', tool: 'Edit', path: 'c.js', reason: 'earlier run', failOpen: false };
const other = { ts: 5, hook: 'plan-gate', cardId: 'c-9', sessionId: 's-9', tool: 'Edit', path: 'd.js', reason: 'x', failOpen: false };

test('sessionRefusals joins by session id, and by card only for records that carry no session', () => {
  const out = sessionRefusals([legacy, sibling, mine, mineOpen, other], 's-1', 'c-1');
  assert.deepEqual(out.items.map((r) => [r.path, r.by]), [['b.js', 'card'], ['a.js', 'session'], ['x.test.js', 'session']]);
  assert.equal(out.count, 3);
  assert.equal(out.refused, 2);
  assert.equal(out.failOpen, 1);
  assert.equal(out.items[1].sessionId, 's-1');
  assert.equal(out.items[0].sessionId, null);
});

test('a session with no card gets only its own records', () => {
  const out = sessionRefusals([legacy, mine, other], 's-1', null);
  assert.deepEqual(out.items.map((r) => r.path), ['a.js']);
  assert.deepEqual(sessionRefusals([legacy, other], 's-none', null), { items: [], count: 0, refused: 0, failOpen: 0 });
});

test('a malformed record is skipped, not thrown on', () => {
  const out = sessionRefusals([null, 'x', { sessionId: 's-1' }, mine], 's-1', null);
  assert.equal(out.count, 2);
});

function envFor(tmp, stateDir) {
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: stateDir,
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
  };
}

test('POST /api/guards/refusal stores sessionId, and GET /api/state?session= carries the joined refusals', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-session-refusals-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog', 'store.json'),
    JSON.stringify({ items: [{ id: 'c-1', title: 'Card', runSession: { sessionId: 's-1' } }] }));
  fs.mkdirSync(path.join(stateDir, 'guards'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'guards', 'refusals.ndjson'), `${JSON.stringify(legacy)}\n${JSON.stringify(sibling)}\n`);
  const srv = await startServer({ port: 0, pollMs: 1000, env: envFor(tmp, stateDir) });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (obj) => fetch(`${base}/api/guards/refusal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    assert.equal((await post({ hook: 'plan-gate', cardId: 'c-1', sessionId: 's-1', tool: 'Edit', path: 'a.js', reason: 'no plan' })).status, 204);
    assert.equal((await post({ hook: 'plan-gate', sessionId: 'x'.repeat(129), reason: 'r' })).status, 400);
    assert.equal((await post({ hook: 'plan-gate', sessionId: 7, reason: 'r' })).status, 400);

    const listed = await (await fetch(`${base}/api/guards/refusals`)).json();
    assert.ok(listed.recent.some((r) => r.sessionId === 's-1' && r.path === 'a.js'));

    const one = await (await fetch(`${base}/api/state?session=s-1`)).json();
    assert.deepEqual(one.refusals.items.map((r) => [r.path, r.by]), [['b.js', 'card'], ['a.js', 'session']]);
    assert.equal(one.refusals.refused, 2);
    const none = await (await fetch(`${base}/api/state?session=s-none`)).json();
    assert.deepEqual(none.refusals, { items: [], count: 0, refused: 0, failOpen: 0 });
  } finally {
    await srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
