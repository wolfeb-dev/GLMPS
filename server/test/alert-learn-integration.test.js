// server/test/alert-learn-integration.test.js
// End-to-end: alerts-into-the-evaluation-loop (glmps feat/alerts-into-evaluation-loop).
// A real session transcript trips the egress alert (a secret file touched by an
// agent), driven through the real GET /api/alerts route, primes the real
// learning-store + shadow-arm wiring - exercising the actual server.js wiring
// (collectCurrentAlerts / primeAlertsIntoLearning / alertsToGaps /
// upsertGapAndApply), not just the pure units. Mirrors the pattern in
// gap-shadow-integration.test.js.
//
// Guard proposer cutover: the autoApplyGaps-ON scenarios that used
// to live here (a template-seeded proposedGuard auto-applying through the
// reflex gate) are deleted along with the auto-apply-with-template branch -
// an alert-derived gap item's proposedGuard is always null now, so there is
// nothing left to auto-apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const SID = 'sess-egress-1';

// A Read tool_use on a .env file, with no Skill event at all -> detectEgress
// (server/lib/governance/egress-detect.js's isSecretPath) fires the egress
// alert (source:'egress', target: {view:'sessions', id: SID, path: ...}).
const ENV_READ_LINE = JSON.stringify({
  type: 'assistant', timestamp: '2026-07-09T10:00:00Z',
  message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit',
    input: { file_path: 'D:\\proj\\.env', old_string: 'a', new_string: 'b' } }] },
});

function mkClaudeEnv() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-alertlearn-'));
  const claudeDir = path.join(t, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'D--proj');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, `${SID}.jsonl`);
  fs.writeFileSync(transcript, ENV_READ_LINE + '\n');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify([
    { sessionId: SID, ppid: process.pid, cwd: 'D:\\proj', transcriptPath: transcript, ts: Date.now() },
  ]));
  return { tmpRoot: t, claudeDir };
}

function baseEnv(stateDir, claudeDir, extra = {}) {
  return {
    GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_ANTIGRAVITY_DIR: path.join(stateDir, 'ag'),
    GLMPS_GEMINI_TMP_DIR: path.join(stateDir, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(stateDir, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(stateDir, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(stateDir, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(stateDir, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(stateDir, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(stateDir, 'opencode'),
    ...extra,
  };
}

async function getJson(url) { return (await fetch(url)).json(); }
async function postJson(url, body = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('egress alert -> pending learning item (no auto-populated proposedGuard) + exactly one shadow occurrence, not double-counted across polls', async () => {
  const { tmpRoot, claudeDir } = mkClaudeEnv();
  const stateDir = tmp('mc-state-');
  const env = { ...process.env, ...baseEnv(stateDir, claudeDir) };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    // Seed eventLog for the session (same replay-if-empty mechanism /api/state uses).
    await fetch(`${base}/api/state?session=${SID}`);

    // First poll of /api/alerts: the egress alert exists and auto-primes the learning loop.
    const first = await getJson(`${base}/api/alerts`);
    const egressAlert = first.alerts.find(a => a.source === 'egress');
    assert.ok(egressAlert, 'egress alert present');
    assert.equal(egressAlert.target.view, 'sessions');
    assert.equal(egressAlert.target.id, SID);

    // It becomes a pending learning item. Guard proposer cutover:
    // no template auto-populates proposedGuard any more - proposing the rule
    // text is the GEPA plugin's job.
    const learning = await getJson(`${base}/api/learning`);
    const egressItems = learning.items.filter(i => i.code === 'egress');
    assert.equal(egressItems.length, 1, 'exactly one egress learning item');
    assert.equal(egressItems[0].status, 'pending', 'autoApplyGaps is off by default');
    assert.equal(egressItems[0].proposedGuard, null);

    // Exactly one shadow occurrence recorded under taskClass 'egress'.
    const shadow1 = await getJson(`${base}/api/promotion/shadow`);
    assert.ok(shadow1.byClass.egress, 'shadow bucket present for egress');
    assert.equal(shadow1.byClass.egress.n, 1);
    assert.equal(shadow1.byClass.egress.fireRate, 0, 'not applied yet -> did not actually fire');
    assert.equal(shadow1.byClass.egress.counterfactualRate, null, 'the alert-priming writer no longer fabricates a counterfactual');

    // Poll /api/alerts AGAIN - the SAME standing alert (same session/path -> same
    // dedup id) must NOT record a second shadow occurrence.
    await fetch(`${base}/api/alerts`);
    const shadow2 = await getJson(`${base}/api/promotion/shadow`);
    assert.equal(shadow2.byClass.egress.n, 1, 'exactly one shadow entry despite two /api/alerts polls');

    // /api/changes surfaces the guard row with measuredEffect joined by code.
    const changes = await getJson(`${base}/api/changes`);
    const guardRow = changes.changes.find(c => c.type === 'guard' && c.id === `guard-${egressItems[0].id}`);
    assert.ok(guardRow, 'guard row present in the unified ledger');
    assert.equal(guardRow.status, 'proposed');
    assert.deepEqual(guardRow.measuredEffect, {
      fireCount: shadow2.byClass.egress.fireCount,
      episodes: shadow2.byClass.egress.episodeCount,
      evidence: 'exercised',
    });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('informational alert (unmerged-branch) never produces a learning item', async () => {
  const stateDir = tmp('mc-state-');
  const env = { ...process.env, ...baseEnv(stateDir, path.join(stateDir, 'claude'), { GLMPS_UNMERGED_SCAN: 'off' }) };
  fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
  // A poison-quarantined ticket -> alert source:'poison' (informational, not wired
  // into ALERT_CODE_MAP) - must never become a learning item.
  fs.writeFileSync(path.join(stateDir, 'backlog', 'store.json'), JSON.stringify({
    items: [{ id: 'q-1', title: 'Quarantined thing', quarantined: true, provenance: { flags: ['x'] }, updatedTs: 1 }],
    seq: 0, seqs: {},
  }));
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const alerts = await getJson(`${base}/api/alerts`);
    assert.ok(alerts.alerts.some(a => a.source === 'poison'), 'the poison alert fires');

    const learning = await getJson(`${base}/api/learning`);
    assert.deepEqual(learning.items, [], 'no learning item is created for a non-learnable alert source');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('POST /api/alerts/prime: primes from cold (no prior GET /api/alerts), idempotent on repeat calls', async () => {
  const { tmpRoot, claudeDir } = mkClaudeEnv();
  const stateDir = tmp('mc-state-');
  const env = { ...process.env, ...baseEnv(stateDir, claudeDir) };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    await fetch(`${base}/api/state?session=${SID}`); // seed eventLog only - no GET /api/alerts yet

    const p1 = await postJson(`${base}/api/alerts/prime`);
    assert.equal(p1.status, 200);
    assert.equal(p1.body.ok, true);
    assert.equal(p1.body.primed, 1, 'primes the one egress alert from cold');

    const learning = await getJson(`${base}/api/learning`);
    assert.equal(learning.items.filter(i => i.code === 'egress').length, 1);
    const shadow = await getJson(`${base}/api/promotion/shadow`);
    assert.equal(shadow.byClass.egress.n, 1);

    // Run it again: same alert id, already in the seen-set -> no-op.
    const p2 = await postJson(`${base}/api/alerts/prime`);
    assert.equal(p2.body.primed, 0, 'second run primes nothing new');

    const learning2 = await getJson(`${base}/api/learning`);
    assert.equal(learning2.items.filter(i => i.code === 'egress').length, 1, 'no duplicate learning item');
    const shadow2 = await getJson(`${base}/api/promotion/shadow`);
    assert.equal(shadow2.byClass.egress.n, 1, 'no duplicate shadow occurrence');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
