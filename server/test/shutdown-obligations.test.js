// server/test/shutdown-obligations.test.js
// glmps-2-0-65: close() closed the obligations db (kernel.db) while a loop run
// was still in flight and before HTTP handlers stopped, so a late onOk and an
// alerts read hit "statement has been finalized". These drive both across
// close() and check the db is never used after it is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { openObligationStore } from '../lib/kernel/obligations.js';
import { dbFileFor } from '../lib/state-dir.js';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shutobl-'));
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
  };
}

function captureErrors() {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); };
  return { lines, restore: () => { console.error = orig; } };
}

test('a loop run finishing after close() starts still closes and reopens its freshness row', async () => {
  const env = mkEnv();
  const srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  let release;
  const gate = new Promise((r) => { release = r; });
  srv.loopRegistry.registerLoop({
    name: 'shutdown-probe', trigger: { onEvent: 'shutdown-probe' },
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 60_000 },
    sla: { maxAgeMs: 3_600_000 },
    maker: async () => { await gate; return { outcome: 'done', result: 1 }; },
    checker: async () => ({ ok: true, verifierRef: 'probe-check' }),
  });
  const before = srv.obligationStore.findOpen({ kind: 'loop.freshness', subject: 'shutdown-probe' });
  assert.ok(before, 'registering the loop opened its freshness row');

  const errs = captureErrors();
  let runResult;
  try {
    const running = srv.loopRegistry.runNow('shutdown-probe');
    // The run outlives close()'s bounded wait: it only finishes once close()
    // has returned, well past the point where it used to close the db.
    await srv.close();
    release();
    runResult = await running;
    // A deferred db close runs once the last in-flight run settles.
    await new Promise((r) => setImmediate(r));
  } finally { errs.restore(); }

  assert.equal(runResult.outcome, 'done');
  const finalized = errs.lines.filter((l) => /statement has been finalized|database is not open/i.test(l));
  assert.deepEqual(finalized, [], 'no use of a closed obligations db');

  const store = openObligationStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try {
    const old = store.get(before.id);
    assert.equal(old.closer, 'verified.done', 'the run that finished during shutdown closed its row');
    assert.equal(old.verifierRef, 'probe-check');
    const next = store.findOpen({ kind: 'loop.freshness', subject: 'shutdown-probe' });
    assert.ok(next && next.id !== before.id, 'and reopened the next freshness row');
  } finally { store.closeDb(); }
});

test('a request whose body arrives after close() starts never writes a closed db', async () => {
  const env = mkEnv();
  const srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  // One keep-alive socket for both requests, so the gate request rides a
  // connection the server has already accepted before close() begins.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const post = (p, payload, { holdBody = false } = {}) => {
    const data = JSON.stringify(payload);
    const req = http.request({ agent, host: '127.0.0.1', port: srv.port, method: 'POST', path: p,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } });
    const answered = new Promise((resolve, reject) => {
      req.on('response', (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
    });
    if (holdBody) { req.flushHeaders(); return { answered, sendBody: () => req.end(data) }; }
    req.end(data);
    return { answered };
  };
  const created = JSON.parse((await post('/api/backlog', { title: 'shutdown gate target' }).answered).text);
  // A run still in flight holds close() in its drain phase, so the gate
  // handler (which runs once its body lands) is served mid-shutdown.
  let release;
  const gate = new Promise((r) => { release = r; });
  srv.loopRegistry.registerLoop({
    name: 'shutdown-hold', trigger: { onEvent: 'shutdown-hold' },
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 60_000 },
    sla: { maxAgeMs: 3_600_000 },
    maker: async () => { await gate; return { outcome: 'nothing-to-do' }; },
    checker: async () => ({ ok: true }),
  });
  const errs = captureErrors();
  let status;
  try {
    const running = srv.loopRegistry.runNow('shutdown-hold');
    const gateReq = post(`/api/backlog/${created.id}/gate`, { status: 'PASS', evidence: ['green'], by: 'reviewer' }, { holdBody: true });
    const closing = srv.close();
    gateReq.sendBody();
    status = (await gateReq.answered).status;
    release();
    await running;
    await closing;
    await new Promise((r) => setImmediate(r));
  } finally { errs.restore(); agent.destroy(); }

  assert.equal(status, 200);
  const failed = errs.lines.filter((l) => /statement has been finalized|database is not open/i.test(l));
  assert.deepEqual(failed, [], 'the gate request served during shutdown did not hit a closed db');
  const store = openObligationStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try {
    assert.ok(store.findOpen({ kind: 'gate.independent-verdict', subject: created.id }), 'its obligation was written');
  } finally { store.closeDb(); }
});
