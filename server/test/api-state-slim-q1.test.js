// the slim state used by the shell's periodic refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSlimState, pickFields, SLIM_ENDED_SESSIONS, SLIM_HISTORY } from '../lib/state-slim.js';
import { startServer } from '../server.js';

const bytes = (o) => Buffer.byteLength(JSON.stringify(o));

// Live-shaped store: 1,908 sessions (3 live), history of the same size, and
// inventory/usage blobs of the measured ~250 KB each.
function synthetic() {
  const sessions = [];
  for (let i = 0; i < 1908; i++) {
    sessions.push({
      id: `sess-${i}`, tool: 'claude-code', format: null, cwd: `D:\\proj\\p${i % 40}`, title: `Session title number ${i} about some task`,
      live: i < 3, state: i < 3 ? 'working' : 'ended', lastTs: 1_790_000_000_000 - i * 60_000,
      skillsUsed: ['superpowers:systematic-debugging', 'superpowers:writing-plans', 'superpowers:test-driven-development'],
      status: { model: { id: 'claude-fable-5-1', displayName: 'Fable 5.1' }, context: { usedPercent: 18 }, cost: { totalUsd: 9.01 },
        rateLimits: { five_hour: { used_percentage: 36, resets_at: 1789159800 }, seven_day: { used_percentage: 29, resets_at: 1789624800 } }, sessionName: 'x'.repeat(120) },
    });
  }
  const history = sessions.map((s) => ({ ...s, agentsUsed: [{ name: 'ui-designer', model: 'sonnet', count: 2 }], firstTs: s.lastTs - 3_600_000, prompt: 'p'.repeat(150) }));
  const blob = (n) => ({ rows: Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, name: `capability ${i}`, path: `C:\\Users\\x\\.claude\\skills\\item-${i}`, used: i % 3 })) });
  const board = { stages: [1, 2, 3, 4].map((n) => ({ n, name: `Stage ${n}` })), rows: sessions.slice(0, 3).map((s) => ({ id: s.id, project: 'p', stage: 1, phase: { phase: 'idle' } })), vitals: { active: 3 } };
  return {
    full: { sessions, inventory: blob(2000), usage: blob(2000), history, tools: [{ id: 'claude-code', sessionsFound: 1908, displayName: 'Claude Code' }], adapterHealth: {}, board },
    parts: { sessions, history, tools: [{ id: 'claude-code', sessionsFound: 1908, displayName: 'Claude Code' }], adapterHealth: {}, board },
  };
}

test('slim state on live-size data is under 100 KB and far smaller than the full payload', () => {
  const { full, parts } = synthetic();
  const slim = buildSlimState(parts);
  const fullB = bytes(full);
  const slimB = bytes(slim);
  console.log(`state sizes: full ${fullB} B, slim ${slimB} B, ratio ${(fullB / slimB).toFixed(1)}x`);
  assert.ok(fullB > 2_000_000, `synthetic full payload is live-sized (${fullB})`);
  assert.ok(slimB < 100_000, `slim is ${slimB} B`);
  assert.ok(fullB / slimB > 20);
  assert.equal(slim.slim, true);
  assert.equal(slim.inventory, undefined);
  assert.equal(slim.usage, undefined);
});

test('slim keeps every live session, the most recent ended ones, and the fields the shell reads', () => {
  const { parts } = synthetic();
  const slim = buildSlimState(parts);
  assert.equal(slim.sessions.filter((s) => s.live).length, 3);
  assert.equal(slim.sessions.length, 3 + SLIM_ENDED_SESSIONS);
  assert.deepEqual(slim.sessions.filter((s) => !s.live).map((s) => s.id), parts.sessions.slice(3, 3 + SLIM_ENDED_SESSIONS).map((s) => s.id));
  assert.equal(slim.history.length, SLIM_HISTORY);
  assert.equal(slim.history[0].id, parts.history[0].id);
  assert.equal(slim.board, parts.board);
  assert.equal(slim.tools, parts.tools);
  assert.equal(slim.adapterHealth, parts.adapterHealth);
});

test('include keeps one extra ended session (the session page summary)', () => {
  const { parts } = synthetic();
  const slim = buildSlimState(parts, { include: 'sess-1500' });
  assert.ok(slim.sessions.some((s) => s.id === 'sess-1500'));
  assert.equal(slim.sessions.length, 3 + SLIM_ENDED_SESSIONS + 1);
  assert.equal(buildSlimState(parts, { include: 'nope' }).sessions.length, 3 + SLIM_ENDED_SESSIONS);
});

test('pickFields keeps only the named keys that exist', () => {
  assert.deepEqual(pickFields({ a: 1, b: 2, c: 3 }, ['a', 'c', 'zzz']), { a: 1, c: 3 });
});

test('GET /api/state?slim=1 and ?fields= boot against the real route', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-slim-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'g'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'v'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'a'),
    GLMPS_CODEX_DIR: path.join(tmp, 'c'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'cp'), GLMPS_HERMES_DIR: path.join(tmp, 'h'), GLMPS_OPENCODE_DIR: path.join(tmp, 'o') };
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const slim = await (await fetch(`${base}/api/state?slim=1`)).json();
    assert.deepEqual(Object.keys(slim).sort(), ['adapterHealth', 'board', 'history', 'sessions', 'slim', 'tools']);
    const full = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(Object.keys(full).sort(), ['adapterHealth', 'board', 'history', 'inventory', 'sessions', 'tools', 'usage']);
    const some = await (await fetch(`${base}/api/state?fields=history,tools`)).json();
    assert.deepEqual(Object.keys(some).sort(), ['history', 'tools']);
  } finally { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
