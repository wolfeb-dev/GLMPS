// server/test/api-alerts-ack.test.js
// glmps-70: persisted operator acknowledge/dismiss for /api/alerts. Uses two
// poison-quarantined backlog fixtures sharing the SAME title but different
// ticket ids, so both alerts share source+title but derive DIFFERENT dedup
// ids (the target JSON embeds the ticket id) - proving that acking one does
// not suppress the other (fresh evidence / a different occurrence re-alerts).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ack-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const stateDir = path.join(tmp, 'state');
  // Two quarantined backlog items, identical title, different id -> same
  // (source, title), different target -> different alert dedup id.
  fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog', 'store.json'), JSON.stringify({
    items: [
      { id: 'fix-1', title: 'Reviewed egress finding', quarantined: true, provenance: { flags: ['x'] }, updatedTs: 1 },
      { id: 'fix-2', title: 'Reviewed egress finding', quarantined: true, provenance: { flags: ['x'] }, updatedTs: 2 },
    ],
    seq: 0, seqs: {},
  }));
  return { env: {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: stateDir,
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
  }, stateDir };
}

async function getJson(url) { return (await fetch(url)).json(); }
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

let sharedEnv;
let sharedStateDir;
let srv;

before(async () => {
  ({ env: sharedEnv, stateDir: sharedStateDir } = mkEnv());
  srv = await startServer({ port: 0, pollMs: 1000, env: sharedEnv });
});

beforeEach(() => {
  if (sharedStateDir) {
    fs.rmSync(path.join(sharedStateDir, 'state', 'alert-acks.json'), { force: true });
  }
});

after(async () => {
  await srv?.close();
});

test('POST /api/alerts/ack: ack excludes from default GET, ?all=1 includes it acknowledged, undo restores', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  const before = await getJson(`${base}/api/alerts`);
  const poisonAlerts = before.alerts.filter(a => a.source === 'poison' && a.title === 'Quarantined: Reviewed egress finding');
  assert.equal(poisonAlerts.length, 2, 'both quarantined tickets raise an alert');
  const [a1, a2] = poisonAlerts;
  assert.notEqual(a1.id, a2.id, 'same source+title, different target -> different dedup id');
  assert.equal(a1.acknowledged, false);
  assert.equal(a2.acknowledged, false);

  // Ack the first.
  const ackRes = await postJson(`${base}/api/alerts/ack`, { id: a1.id });
  assert.equal(ackRes.status, 200);
  assert.deepEqual(ackRes.body, { acknowledged: true, id: a1.id });

  // Default GET now excludes a1 but still carries a2 (fresh-evidence / different
  // occurrence is not suppressed by acking the sibling alert).
  const after = await getJson(`${base}/api/alerts`);
  const ids = after.alerts.map(x => x.id);
  assert.ok(!ids.includes(a1.id), 'acked alert excluded by default');
  assert.ok(ids.includes(a2.id), 'sibling alert (different target) still visible');

  // ?all=1 includes both, a1 stamped acknowledged:true, a2 still false.
  const all = await getJson(`${base}/api/alerts?all=1`);
  const byId = Object.fromEntries(all.alerts.map(x => [x.id, x]));
  assert.equal(byId[a1.id].acknowledged, true);
  assert.equal(byId[a2.id].acknowledged, false);

  // Topbar-style summary is derived from the already-filtered default list,
  // so the acked alert drops out of the count automatically.
  assert.equal(after.summary.total, before.summary.total - 1);
  assert.equal(after.alerts.some(x => x.id === a1.id), false);

  // Undo restores it to the default view.
  const undoRes = await postJson(`${base}/api/alerts/ack`, { id: a1.id, undo: true });
  assert.equal(undoRes.status, 200);
  assert.deepEqual(undoRes.body, { acknowledged: false, id: a1.id });
  const restored = await getJson(`${base}/api/alerts`);
  assert.ok(restored.alerts.some(x => x.id === a1.id), 'undo brings the alert back to the default view');
});

test('POST /api/alerts/ack: 400 when id is missing/blank', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  const r1 = await postJson(`${base}/api/alerts/ack`, {});
  assert.equal(r1.status, 400);
  const r2 = await postJson(`${base}/api/alerts/ack`, { id: '   ' });
  assert.equal(r2.status, 400);
});

test('ack persists to the alertAcksFile on disk (survives a fresh server against the same state dir)', async () => {
  const { env, stateDir } = mkEnv();
  const srv1 = await startServer({ port: 0, pollMs: 1000, env });
  let alertId;
  try {
    const base1 = `http://127.0.0.1:${srv1.port}`;
    const list = await getJson(`${base1}/api/alerts`);
    alertId = list.alerts.find(a => a.source === 'poison').id;
    await postJson(`${base1}/api/alerts/ack`, { id: alertId });
  } finally { await srv1.close(); }

  assert.ok(fs.existsSync(path.join(stateDir, 'state', 'alert-acks.json')), 'ack store written to disk');

  const srv2 = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base2 = `http://127.0.0.1:${srv2.port}`;
    const list2 = await getJson(`${base2}/api/alerts`);
    assert.ok(!list2.alerts.some(a => a.id === alertId), 'ack survives a server restart against the same state dir');
  } finally { await srv2.close(); }
});
