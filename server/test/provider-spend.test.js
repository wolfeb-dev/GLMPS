// Card glmps-2-0-63 R3, AC-8 server: per-provider spend split from the
// existing usage records. Fixtures only, no new data collection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerOf, computeProviderSpend, readProviderSpend } from '../lib/observability/provider-spend.js';
import { startServer } from '../server.js';

const H = 3600 * 1000;
const NOW = Date.parse('2026-10-19T12:00:00Z');

const rec = (sid, hoursAgo, o = {}) => ({
  sid, capturedAt: NOW - hoursAgo * H, ts: NOW - hoursAgo * H,
  model: 'claude-opus-4-8', costUsd: null, input: 0, output: 0, ...o,
});

test('providerOf: model wins, tool is the fallback, unknown is other', () => {
  assert.equal(providerOf({ model: 'claude-opus-4-8[1m]' }), 'anthropic');
  assert.equal(providerOf({ model: 'gemini-3-pro', tool: 'antigravity' }), 'google');
  assert.equal(providerOf({ model: 'gpt-5-codex' }), 'openai');
  assert.equal(providerOf({ tool: 'claude-code' }), 'anthropic');
  assert.equal(providerOf({ tool: 'codex-cli' }), 'openai');
  assert.equal(providerOf({ tool: 'antigravity' }), 'google');
  assert.equal(providerOf({ tool: 'gemini-cli' }), 'google');
  assert.equal(providerOf({ tool: 'copilot-cli', model: 'auto' }), 'other');
  assert.equal(providerOf({}), 'anthropic', 'untagged records are the Claude Code statusline tap');
});

test('computeProviderSpend: windowed deltas of cumulative values, split by provider', () => {
  const records = [
    // anthropic session: 1.0 before the window, 3.5 at the end => 2.5 inside
    rec('a', 300, { costUsd: 1.0, input: 100, output: 10 }),
    rec('a', 50, { costUsd: 2.0, input: 400, output: 50 }),
    rec('a', 2, { costUsd: 3.5, input: 1000, output: 100 }),
    // google session: no cost anywhere, tokens only
    rec('g', 30, { tool: 'antigravity', model: 'gemini-3-pro', input: 500, output: 50 }),
    rec('g', 1, { tool: 'antigravity', model: 'gemini-3-pro', input: 900, output: 90 }),
    // openai session
    rec('o', 10, { tool: 'codex-cli', model: 'gpt-5-codex', costUsd: 0.5, input: 200, output: 20 }),
    // unknown tool and model
    rec('x', 5, { tool: 'mystery', model: 'zzz', input: 7, output: 3 }),
    // outside the window and never seen again: not counted
    rec('old', 400, { costUsd: 9, input: 9999, output: 1 }),
  ];
  const out = computeProviderSpend(records, { from: NOW - 168 * H, to: NOW });
  const by = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(by).sort(), ['anthropic', 'google', 'openai', 'other']);
  assert.equal(by.anthropic.spendUsd, 2.5);
  assert.equal(by.anthropic.tokens, 1100 - 110);
  assert.equal(by.anthropic.sessions, 1);
  assert.equal(by.anthropic.label, 'Anthropic');
  assert.equal(by.google.spendUsd, null, 'no cost in the records means null, not 0');
  assert.equal(by.google.tokens, 990, 'first in-window value counts in full when nothing precedes it');
  assert.equal(by.openai.spendUsd, 0.5);
  assert.equal(by.other.spendUsd, null);
  assert.equal(by.other.tokens, 10);
  assert.equal(by.other.label, 'Other');
  assert.deepEqual(out.map((p) => p.id), ['anthropic', 'openai', 'google', 'other'], 'spend desc, then tokens desc');
});

test('computeProviderSpend: empty and malformed input answer an empty list', () => {
  assert.deepEqual(computeProviderSpend([], { from: 0, to: NOW }), []);
  assert.deepEqual(computeProviderSpend([{ sid: 'z' }, null, { capturedAt: 1 }], { from: 0, to: NOW }), []);
});

function writeUsage(stateDir, name, records) {
  const d = path.join(stateDir, 'usage');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), records.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
}

test('readProviderSpend: reads the usage ndjson, answers from/to, fails open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pspend-'));
  try {
    assert.deepEqual(readProviderSpend(dir, { hours: 168, now: NOW }).providers, [], 'no usage dir');
    writeUsage(dir, '2026-10-18.ndjson', [rec('a', 20, { costUsd: 1, input: 10, output: 5 }), rec('a', 3, { costUsd: 4, input: 30, output: 5 })]);
    const r = readProviderSpend(dir, { hours: 168, now: NOW });
    assert.equal(r.to, new Date(NOW).toISOString());
    assert.equal(r.from, new Date(NOW - 168 * H).toISOString());
    assert.equal(r.providers.length, 1);
    assert.equal(r.providers[0].spendUsd, 4);
    assert.equal(r.providers[0].tokens, 35);
    const narrow = readProviderSpend(dir, { hours: 10, now: NOW });
    assert.equal(narrow.providers[0].spendUsd, 3, 'baseline is the last record before the window');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/usage/providers answers the contract through the shared JSON writer', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pspend-route-'));
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({}));
  const now = Date.now();
  writeUsage(stateDir, '2026-10-19.ndjson', [
    { sid: 'a', capturedAt: now - H, ts: now - H, model: 'claude-opus-4-8', costUsd: 2, input: 10, output: 5 },
    ...Array.from({ length: 60 }, (_, i) => ({ sid: `p${i}`, capturedAt: now - H, ts: now - H, tool: 'codex-cli', model: 'gpt-5-codex', costUsd: 1, input: 1000, output: 100 })),
  ]);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile });
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/usage/providers?hours=168`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.deepEqual(Object.keys(j).sort(), ['actions', 'from', 'providers', 'to']);
    assert.equal(j.actions.allowance, 2000, 'GitHub Actions minutes ride along (glmps-2-0-73)');
    assert.equal(j.actions.billed, 0);
    assert.deepEqual(Object.keys(j.providers[0]).sort(), ['id', 'label', 'sessions', 'spendUsd', 'tokens']);
    assert.equal(j.providers.find((p) => p.id === 'anthropic').spendUsd, 2);
    assert.equal(j.providers.find((p) => p.id === 'openai').sessions, 60);
    const plain = await (await fetch(`http://127.0.0.1:${h.port}/api/usage/providers`)).json();
    assert.ok(Array.isArray(plain.providers), 'hours defaults to 168');
  } finally {
    await h.close?.();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
