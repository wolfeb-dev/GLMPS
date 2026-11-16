// The per-session response carries the learning items and lessons joined by
// session id, plus a summary line that counts the fitness measurables (card
// glmps-2-0-runtime-56, session-detail spec section 8 item 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { sessionLearning, createSessionLearningLookup } from '../lib/evaluation/session-learning.js';

const filed = { id: 'g1', source: 'gap', code: 'skill-unused', title: 'Skill unused', status: 'pending', severity: 'warn', sessionId: 's-1', lastSessionId: 's-1', count: 1, proposedGuard: null };
const recurred = { id: 'g2', source: 'gap', code: 'plan-skipped', title: 'Plan skipped', status: 'applied', sessionId: 's-0', lastSessionId: 's-1', count: 2, proposedGuard: { rule: 'Plan first.' }, applyCommit: 'abc123' };
const other = { id: 'g3', source: 'gap', code: 'x', title: 'Other', status: 'pending', sessionId: 's-9', lastSessionId: 's-9' };
const proposal = { id: 'p1', source: 'gepa', code: 'gepa-proposal', title: 'Proposal', status: 'pending', sessionId: null, derivedFrom: ['g1'], proposedGuard: { rule: 'Use the skill.' } };
const lessonByItem = { lessonId: 'legacy:g2', kind: 'guard', title: 'Plan skipped', status: 'active', reflex: true, strength: 1, scope: 'global', provenance: { sourceEventIds: ['learning-store:g2'] } };
const lessonBySession = { lessonId: 'L9', kind: 'memory', title: 'From events', status: 'dormant', reflex: false, strength: 0.5, provenance: { sourceEventIds: ['session:s-1'] } };
const lessonOther = { lessonId: 'legacy:g3', kind: 'guard', title: 'Other', status: 'active', provenance: { sourceEventIds: ['session:s-9'] } };

test('sessionLearning joins items on first or latest session, proposals through derivedFrom, and lessons both ways', () => {
  const out = sessionLearning('s-1', {
    items: [filed, recurred, other, proposal],
    lessons: [lessonByItem, lessonBySession, lessonOther],
    fitness: { tracked: 3 },
  });
  assert.deepEqual(out.items.map((i) => i.id), ['g1', 'g2', 'p1']);
  assert.equal(out.items[0].firstSession, true);
  assert.equal(out.items[1].firstSession, false);
  assert.equal(out.items[1].rule, 'Plan first.');
  assert.equal(out.items[2].rule, 'Use the skill.');
  assert.deepEqual(out.lessons.map((l) => l.lessonId), ['legacy:g2', 'L9']);
  assert.deepEqual(out.summary, {
    gaps: 2, gapsByStatus: { pending: 1, applied: 1 }, guardsProposed: 1, guardsLanded: 1, lessons: 2, measurables: 3,
  });
});

test('a discarded rule is neither proposed nor landed', () => {
  const dropped = { ...filed, status: 'discarded', proposedGuard: { rule: 'Dropped.' } };
  const out = sessionLearning('s-1', { items: [dropped] });
  assert.equal(out.summary.guardsProposed, 0);
  assert.equal(out.summary.guardsLanded, 0);
  assert.equal(out.items[0].rule, 'Dropped.');
});

test('a session that learned nothing answers empty lists and a zero summary', () => {
  const out = sessionLearning('s-none', { items: [filed, other], lessons: [lessonOther], fitness: null });
  assert.deepEqual(out, {
    items: [], lessons: [],
    summary: { gaps: 0, gapsByStatus: {}, guardsProposed: 0, guardsLanded: 0, lessons: 0, measurables: 0 },
  });
});

test('the lookup refolds the ledger only when it changes and misses an empty id with null', () => {
  let reads = 0;
  let size = 1;
  const rows = [{ type: 'created', lessonId: 'L9', kind: 'memory', title: 't', provenance: { sourceEventIds: ['session:s-1'] }, createdAt: 1 }];
  const lookup = createSessionLearningLookup('/state', { read: () => { reads++; return rows; }, stat: () => ({ mtimeMs: 1, size }) });
  assert.equal(lookup('s-1', { items: [] }).lessons[0].lessonId, 'L9');
  assert.equal(lookup('s-2', { items: [] }).lessons.length, 0);
  assert.equal(lookup(''), null);
  assert.equal(reads, 1);
  size = 2;
  lookup('s-1', { items: [] });
  assert.equal(reads, 2);
});

test('GET /api/state?session= carries learning; a session with nothing answers empty lists', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-learning-detail-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(stateDir, 'learning'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'learning', 'store.json'), JSON.stringify({ seq: 0, items: [filed, recurred, other, proposal] }));
  fs.mkdirSync(path.join(stateDir, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'lessons', 'ledger.ndjson'),
    JSON.stringify({ type: 'created', lessonId: 'legacy:g2', kind: 'guard', title: 'Plan skipped', provenance: { scope: 'global', sourceEventIds: ['learning-store:g2'] }, createdAt: 1 }) + '\n');
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
    assert.deepEqual(one.learning.items.map((i) => i.id), ['g1', 'g2', 'p1']);
    assert.deepEqual(one.learning.lessons.map((l) => l.lessonId), ['legacy:g2']);
    assert.equal(one.learning.summary.guardsLanded, 1);
    assert.equal(one.learning.summary.measurables, one.fitness?.tracked ?? 0);
    const none = await (await fetch(base + 's-none')).json();
    assert.deepEqual(none.learning.items, []);
    assert.deepEqual(none.learning.lessons, []);
  } finally {
    await srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
