// The per-session response carries the judge verdict and the revert marker
// from the outcome row session-<id> (card glmps-2-0-runtime-55,
// session-detail spec section 8 item 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { sessionOutcomeDetail, createSessionOutcomeLookup } from '../lib/evaluation/session-outcome.js';

const judged = {
  id: 'session-s-1', unit: 'session', taskClass: 'feature', revertedLater: true, turns: 9,
  extra: { readEditRatio: 2, outcomeClass: 'success', judge: { by: 'openevals:trajectory-accuracy', pass: true, comment: 'Coherent arc', reason: 'built it', ts: 1000 } },
};
const pending = { id: 'session-s-2', unit: 'session', taskClass: 'pending', revertedLater: null, extra: { readEditRatio: null } };
const skipped = { id: 'session-s-3', unit: 'session', taskClass: 'other', revertedLater: false, extra: { outcomeClass: 'abandoned', judge: { skipped: 'no-events', ts: 5 } } };

test('sessionOutcomeDetail exposes the judge verdict, task class and revert marker', () => {
  assert.deepEqual(sessionOutcomeDetail(judged), {
    taskClass: 'feature', outcomeClass: 'success', revertedLater: true,
    judge: { status: 'pass', by: 'openevals:trajectory-accuracy', pass: true, comment: 'Coherent arc', reason: 'built it', ts: 1000, skipped: null, coerced: false },
  });
  assert.deepEqual(sessionOutcomeDetail(pending), {
    taskClass: 'pending', outcomeClass: null, revertedLater: null, judge: { status: 'pending' },
  });
  assert.equal(sessionOutcomeDetail(skipped).judge.status, 'skipped');
  assert.equal(sessionOutcomeDetail(skipped).judge.skipped, 'no-events');
  assert.equal(sessionOutcomeDetail({ ...judged, extra: { judge: { ...judged.extra.judge, pass: false } } }).judge.status, 'concerns');
});

test('the lookup answers by session id, rereads only when the file changes, and misses with null', () => {
  let reads = 0;
  let size = 1;
  const lookup = createSessionOutcomeLookup('/state', { read: () => { reads++; return [judged, pending]; }, stat: () => ({ mtimeMs: 1, size }) });
  assert.equal(lookup('s-1').judge.status, 'pass');
  assert.equal(lookup('s-2').judge.status, 'pending');
  assert.equal(lookup('nope'), null);
  assert.equal(lookup(''), null);
  assert.equal(reads, 1);
  size = 2;
  lookup('s-1');
  assert.equal(reads, 2);
});

test('GET /api/state?session= carries the outcome; a session with no row answers outcome null', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outcome-detail-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(stateDir, 'outcomes'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'outcomes', 'rows.ndjson'), [judged, pending].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const env = {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: stateDir,
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
  };
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}/api/state?session=`;
    const one = await (await fetch(base + 's-1')).json();
    assert.equal(one.outcome.judge.status, 'pass');
    assert.equal(one.outcome.judge.comment, 'Coherent arc');
    assert.equal(one.outcome.revertedLater, true);
    const two = await (await fetch(base + 's-2')).json();
    assert.equal(two.outcome.judge.status, 'pending');
    const none = await (await fetch(base + 's-none')).json();
    assert.equal(none.outcome, null);
  } finally {
    await srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
