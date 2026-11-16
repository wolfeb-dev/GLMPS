// The per-session response carries the full card the session ran for
// (card glmps-2-0-runtime-54, session-detail spec section 8 item 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { sessionCardDetail, createSessionCardLookup, withCards } from '../lib/orchestration/session-cards.js';

const gated = {
  id: 'c-1', title: 'Gated card', state: 'held', runSession: { sessionId: 's-1' },
  acceptanceCriteria: [{ text: 'AC one', done: true }, { text: 'AC two', done: false }],
  gate: { status: 'PASS', risk: 'P2', evidence: ['AC-1 ok', 'AC-2 ok'], ts: '2026-10-26T10:00:00.000Z', by: 'agent' },
  prUrl: null,
  mergeRequest: { prUrl: 'https://github.com/acme/w/pull/7', number: 7, stage: 'reviewing', round: 1, interim: false, covers: [1], final: false, history: [{}], tests: null, review: null, mergeSha: null },
};
const bare = { id: 'c-2', title: 'Bare card', state: 'queued', runSession: { sessionId: 's-2' } };

test('sessionCardDetail exposes id, title, ACs, gate summary, PR and merge-queue state', () => {
  assert.deepEqual(sessionCardDetail(gated), {
    id: 'c-1', title: 'Gated card', state: 'held',
    acceptanceCriteria: [{ text: 'AC one', done: true }, { text: 'AC two', done: false }],
    gate: { status: 'PASS', risk: 'P2', evidenceCount: 2, ts: '2026-10-26T10:00:00.000Z' },
    prUrl: 'https://github.com/acme/w/pull/7',
    mergeQueue: { stage: 'reviewing', round: 1, prUrl: 'https://github.com/acme/w/pull/7', number: 7, interim: false, covers: [1], final: false, mergeSha: null },
  });
  assert.deepEqual(sessionCardDetail(bare), {
    id: 'c-2', title: 'Bare card', state: 'queued', acceptanceCriteria: [], gate: null, prUrl: null, mergeQueue: null,
  });
});

test('the lookup answers the full card by session id and keeps list rows slim', () => {
  const lookup = createSessionCardLookup('/state', { load: () => ({ items: [gated, bare] }), stat: () => ({ mtimeMs: 1, size: 1 }) });
  assert.deepEqual(lookup().get('s-1'), { id: 'c-1', title: 'Gated card', gate: 'PASS' });
  assert.equal(lookup.detail('s-1').mergeQueue.stage, 'reviewing');
  assert.equal(lookup.detail('nope'), null);
});

test('an earlier session of a relaunched card still resolves to the card, in lists and detail (glmps-190)', () => {
  const relaunched = { id: 'c-3', title: 'Relaunched card', state: 'held', runSession: { sessionId: 's-3b', previousSessionIds: ['s-3a'] } };
  // Another card's current session beats this card's history on a shared id.
  const other = { id: 'c-4', title: 'Other card', runSession: { sessionId: 's-shared' } };
  const stale = { id: 'c-5', title: 'Stale card', runSession: { sessionId: 's-5', previousSessionIds: ['s-shared'] } };
  const lookup = createSessionCardLookup('/state', { load: () => ({ items: [relaunched, stale, other] }), stat: () => ({ mtimeMs: 1, size: 1 }) });
  assert.equal(lookup().get('s-3a').id, 'c-3');
  assert.equal(lookup().get('s-3b').id, 'c-3');
  assert.equal(lookup.detail('s-3a').id, 'c-3');
  assert.equal(lookup.detail('s-3b').title, 'Relaunched card');
  assert.equal(lookup().get('s-shared').id, 'c-4');
  assert.equal(lookup.detail('s-shared').id, 'c-4');
  const rows = withCards([{ id: 's-3a' }, { id: 's-3b' }, { id: 's-x' }], lookup());
  assert.deepEqual(rows.map((r) => r.card?.id ?? null), ['c-3', 'c-3', null]);
});

test('GET /api/state?session= carries the card; a session with no card answers card null', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-card-detail-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog', 'store.json'), JSON.stringify({ items: [gated, bare], seq: 0, seqs: {} }));
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
    assert.equal(one.card.id, 'c-1');
    assert.equal(one.card.gate.evidenceCount, 2);
    assert.equal(one.card.mergeQueue.stage, 'reviewing');
    assert.equal(one.card.acceptanceCriteria.length, 2);
    const none = await (await fetch(base + 's-none')).json();
    assert.equal(none.card, null);
  } finally {
    await srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
