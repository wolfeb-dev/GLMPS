// /api/timeline builder and route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTimeline, clampHours, MAX_EVENTS } from '../lib/timeline.js';
import { startServer } from '../server.js';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();

test('clampHours defaults to 24 and caps at 72', () => {
  assert.equal(clampHours(undefined), 24);
  assert.equal(clampHours('abc'), 24);
  assert.equal(clampHours('-3'), 24);
  assert.equal(clampHours('6'), 6);
  assert.equal(clampHours('500'), 72);
});

test('merges the five sources ascending and drops events outside the window', () => {
  const t = buildTimeline({
    now: NOW,
    hours: 24,
    eventsBySession: new Map([
      ['s1', [
        { kind: 'file-edit', path: 'a.js', ts: NOW - 2 * H },
        { kind: 'file-edit', path: 'old.js', ts: NOW - 30 * H },
        { kind: 'tool', ts: NOW - H },
        { kind: 'file-edit', path: null, ts: NOW - H },
      ]],
    ]),
    cardOf: (id) => (id === 's1' ? { id: 'glmps-1', title: 'Card one' } : undefined),
    cards: [{
      id: 'glmps-1', title: 'Card one', state: 'in_progress', updatedAt: iso(NOW - 3 * H),
      activity: [{ ts: iso(NOW - 3 * H), text: 'runner: launched' }, { ts: iso(NOW - 40 * H), text: 'ancient' }],
      gate: { status: 'PASS', ts: iso(NOW - 90 * 60_000) },
    }],
    alerts: [{ ts: NOW - 4 * H, title: 'Drift', severity: 'warn' }, { ts: NOW + H, title: 'future', severity: 'warn' }],
    loops: { 'nightly-run': { lastRunTs: NOW - 5 * H, lastOutcome: 'done', recentFailures: [{ ts: NOW - 6 * H, reason: 'x' }] } },
  });
  assert.equal(t.hours, 24);
  assert.equal(t.to, NOW);
  assert.equal(t.from, NOW - 24 * H);
  assert.equal(t.truncated, false);
  assert.deepEqual(t.events.map((e) => e.kind), ['loop', 'loop', 'alert', 'card', 'edit', 'gate']);
  const ts = t.events.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  const edit = t.events.find((e) => e.kind === 'edit');
  assert.deepEqual(edit, { ts: NOW - 2 * H, kind: 'edit', sessionId: 's1', path: 'a.js', cardId: 'glmps-1', cardTitle: 'Card one' });
  const card = t.events.filter((e) => e.kind === 'card');
  assert.equal(card.length, 1, 'updatedAt covered by the activity line is not doubled');
  assert.equal(card[0].state, 'in_progress');
  assert.equal(card[0].title, 'runner: launched');
  assert.equal(t.events.find((e) => e.kind === 'gate').state, 'PASS');
  assert.deepEqual(t.events.filter((e) => e.kind === 'loop').map((e) => e.outcome), ['failed', 'done']);
});

test('a card with no activity in the window still yields its updatedAt state change', () => {
  const t = buildTimeline({ now: NOW, cards: [{ id: 'c', title: 'T', state: 'done', updatedAt: iso(NOW - H), activity: [] }] });
  assert.deepEqual(t.events, [{ ts: NOW - H, kind: 'card', cardId: 'c', cardTitle: 'T', state: 'done' }]);
});

test('caps at 5000 events, keeps the newest, and says so', () => {
  const edits = [];
  for (let i = 0; i < MAX_EVENTS + 100; i++) edits.push({ kind: 'file-edit', path: `f${i}`, ts: NOW - 23 * H + i * 1000 });
  const t = buildTimeline({ now: NOW, eventsBySession: [['s', edits]] });
  assert.equal(t.truncated, true);
  assert.equal(t.events.length, MAX_EVENTS);
  assert.equal(t.events.at(-1).path, `f${MAX_EVENTS + 99}`);
  assert.equal(t.events[0].path, 'f100');
});

test('hours beyond 72 are clamped in the result', () => {
  assert.equal(buildTimeline({ now: NOW, hours: 500 }).hours, 72);
});

test('GET /api/timeline boots and returns the contract shape', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tl-'));
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
    const r = await fetch(`${base}/api/timeline?hours=500`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.hours, 72);
    assert.equal(typeof j.from, 'number');
    assert.equal(typeof j.to, 'number');
    assert.equal(j.truncated, false);
    assert.ok(Array.isArray(j.events));
    const d = await (await fetch(`${base}/api/timeline`)).json();
    assert.equal(d.hours, 24);
  } finally { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
