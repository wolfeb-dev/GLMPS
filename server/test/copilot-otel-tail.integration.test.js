// server/test/copilot-otel-tail.integration.test.js
// End-to-end: a Copilot OTel file-exporter JSONL under GLMPS_COPILOT_OTEL_DIR is
// tailed by the poll loop -> per-session usage snapshots (Analytics) + a
// kind:'tokens' feed event, keyed by copilot-cli:<conversationId>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'copilot-otel', 'otel.jsonl');
const S2 = 'copilot-cli:a5962e0a-dbe2-4fe5-a7ab-ff1893a3aee6';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-copotel-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const otelDir = path.join(tmp, 'otel');
  fs.mkdirSync(otelDir, { recursive: true });
  fs.copyFileSync(FIX, path.join(otelDir, 'copilot.jsonl'));
  return {
    stateDir: path.join(tmp, 'state'),
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
           GLMPS_STATE_DIR: path.join(tmp, 'state'),
           GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
           GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
           GLMPS_COPILOT_OTEL_DIR: otelDir,
           GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
           GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
           GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') },
  };
}

function readUsageNdjson(stateDir) {
  const dir = path.join(stateDir, 'usage');
  const recs = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ndjson'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      try { recs.push(JSON.parse(t)); } catch {}
    }
  }
  return recs;
}

test('Copilot OTel usage bridges into the usage store (Analytics)', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    await new Promise(r => setTimeout(r, 300)); // let poll tail the OTel file
    const usage = await (await fetch(`http://127.0.0.1:${srv.port}/api/usage`)).json();
    const row = (usage.perSession ?? []).find(r => r.sid === S2);
    assert.ok(row, 'copilot session present in usage perSession');
    assert.equal(row.model, 'claude-haiku-4.5');
    assert.equal(row.input, 19725);
    assert.equal(row.output, 44);
    assert.equal(row.costUsd, null);
    assert.ok(usage.totals.inputTokens > 0);
  } finally { await srv.close(); }
});

test('the written usage record carries tool + credits (rich Copilot fields)', async () => {
  const { env, stateDir } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    await new Promise(r => setTimeout(r, 300));
    const recs = readUsageNdjson(stateDir);
    const rec = recs.find(r => r.sid === S2);
    assert.ok(rec, 'copilot usage record written to ndjson');
    assert.equal(rec.tool, 'copilot-cli');
    assert.equal(rec.credits, 0.33);
    assert.equal(rec.latencyMs, 1967);
    // invoke_agent twin must NOT double-count
    assert.equal(rec.input, 19725);
  } finally { await srv.close(); }
});

test('Copilot OTel emits a kind:tokens feed event on the joined session', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    await new Promise(r => setTimeout(r, 300));
    const detail = await (await fetch(`http://127.0.0.1:${srv.port}/api/state?session=${encodeURIComponent(S2)}`)).json();
    assert.ok((detail.events ?? []).some(e => e.kind === 'tokens'), 'tokens event present on copilot session');
  } finally { await srv.close(); }
});
