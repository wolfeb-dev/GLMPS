// server/test/api-measurables.test.js
// GET/POST /api/measurables* - C1's durable-measurables surface, and the
// /api/state?session= `fitness` field (Coordination Contract: C1's additive
// key, computed in a fail-open block sibling to Build A's `workspace` key).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { upsertMeasurable } from '../lib/evaluation/measurables-store.js';
import { appendEvent } from '../lib/observability/event-log.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const SID = 'sess-fitness-1';
let stateDir;
let claudeDir;
let h;

before(async () => {
  stateDir = tmp('mc-state-');
  claudeDir = claudeTmp();
  const projDir = path.join(claudeDir, 'projects', 'D--proj');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, `${SID}.jsonl`);
  const TRIVIAL_LINE = JSON.stringify({ type: 'user', timestamp: '2026-07-09T10:00:00Z', message: { content: [{ type: 'text', text: 'hello' }] } });
  fs.writeFileSync(transcript, TRIVIAL_LINE + '\n');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify([
    { sessionId: SID, ppid: process.pid, cwd: 'D:\\proj', transcriptPath: transcript, ts: Date.now() },
  ]));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
});

after(async () => {
  await h?.close?.();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(stateDir, 'measurables'), { recursive: true, force: true });
});

test('GET /api/measurables on an empty state dir returns an empty, honest scoreboard', async () => {
  const body = await (await fetch(`http://127.0.0.1:${h.port}/api/measurables`)).json();
  assert.deepEqual(body, { measurables: [], scoreboard: { tracked: 0, byKind: {}, approved: 0, rejected: 0, pruned: 0, unlabeled: 0, northStar: null } });
});

// Review round 1, item 1 (test isolation): the boot-time skill-retire scan
// must read ONLY the GLMPS_CLAUDE_DIR a test explicitly configures, never an
// ambient one inherited through `{ ...process.env }`. RED before the fix:
// with the override below removed, this test fails (the ambient skill leaks
// into an otherwise-empty state dir's measurables), exactly like
// api-changes.test.js and api-measurables.test.js's now-fixed "empty state
// dir" assertions did in the full-suite run this review is fixing.
test('boot-time skill-retire scan reads only this test\'s own GLMPS_CLAUDE_DIR, never an ambient one', async () => {
  // Stand-in for "whatever is really installed on the machine running the
  // suite": one skill last used 200 days ago, well past DEFAULT_RETIRE_DAYS
  // (90) - the exact shape of the leak the round-1 review found for real.
  const ambientClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ambient-claude-'));
  const skillDir = path.join(ambientClaudeDir, 'skills', 'fixture-stale-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: fixture-stale-skill\ndescription: fixture\n---\nFixture skill for the isolation regression test.\n');

  const bootStateDir = tmp('mc-state-');
  const staleTs = new Date(Date.now() - 200 * 86400000).toISOString();
  appendEvent(bootStateDir, { kind: 'skill', label: 'fixture-stale-skill', ts: staleTs });

  const prevAmbient = process.env.GLMPS_CLAUDE_DIR;
  process.env.GLMPS_CLAUDE_DIR = ambientClaudeDir; // what a leaky test inherits via `...process.env`
  try {
    const isolatedClaudeDir = claudeTmp();
    // The fix under test: an explicit GLMPS_CLAUDE_DIR override placed AFTER the
    // `...process.env` spread, so it wins over whatever is ambiently set.
    const env = { ...process.env, GLMPS_STATE_DIR: bootStateDir, GLMPS_CLAUDE_DIR: isolatedClaudeDir };
    const srv = await startServer({ port: 0, env, configFile: path.join(bootStateDir, 'no-config.json') });
    try {
      const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/measurables`)).json();
      assert.deepEqual(body.measurables, [], 'an explicitly isolated GLMPS_CLAUDE_DIR must never surface the ambient stale skill');
    } finally {
      await srv.close?.();
      fs.rmSync(isolatedClaudeDir, { recursive: true, force: true });
    }
  } finally {
    if (prevAmbient === undefined) delete process.env.GLMPS_CLAUDE_DIR; else process.env.GLMPS_CLAUDE_DIR = prevAmbient;
    fs.rmSync(ambientClaudeDir, { recursive: true, force: true });
    fs.rmSync(bootStateDir, { recursive: true, force: true });
  }
});

test('GET /api/measurables/:id, then POST label - approve/reject/prune round-trip', async () => {
  upsertMeasurable(stateDir, { id: 'guard-retire:x', kind: 'guard-retire', title: 'Guard retire candidate: x', detail: 'never fired', evidence: { sessionId: null, ref: 'x' }, metric: { n: 20 }, ts: 100 });
  const base = `http://127.0.0.1:${h.port}`;
  const got = await (await fetch(`${base}/api/measurables/${encodeURIComponent('guard-retire:x')}`)).json();
  assert.equal(got.title, 'Guard retire candidate: x');

  const missing = await fetch(`${base}/api/measurables/${encodeURIComponent('nope')}`);
  assert.equal(missing.status, 404);

  const badDecision = await fetch(`${base}/api/measurables/${encodeURIComponent('guard-retire:x')}/label`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'bogus' }),
  });
  assert.equal(badDecision.status, 400);

  const labelOnMissing = await fetch(`${base}/api/measurables/${encodeURIComponent('nope')}/label`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(labelOnMissing.status, 404);

  // glmps-102: existence wins over decision validity - an unknown id with
  // an ALSO-bogus decision must 404, not 400 (previously the decision
  // check ran first and masked the 404 behind a 400 for this combination).
  const labelOnMissingBadDecision = await fetch(`${base}/api/measurables/${encodeURIComponent('nope')}/label`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'bogus' }),
  });
  assert.equal(labelOnMissingBadDecision.status, 404);

  const ok = await fetch(`${base}/api/measurables/${encodeURIComponent('guard-retire:x')}/label`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', by: 'operator' }),
  });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.measurable.labels.at(-1).decision, 'approve');

  const list = await (await fetch(`${base}/api/measurables`)).json();
  assert.equal(list.scoreboard.approved, 1);
  assert.equal(list.scoreboard.unlabeled, 0);
});

test('GET /api/measurables?kind= filters', async () => {
  upsertMeasurable(stateDir, { id: 'guard-retire:a', kind: 'guard-retire', title: 'a', ts: 1 });
  upsertMeasurable(stateDir, { id: 'skill-retire:b', kind: 'skill-retire', title: 'b', ts: 2 });
  const body = await (await fetch(`http://127.0.0.1:${h.port}/api/measurables?kind=guard-retire`)).json();
  assert.equal(body.measurables.length, 1);
  assert.equal(body.measurables[0].id, 'guard-retire:a');
});

test('/api/state?session= gains a `fitness` rollup scoped to that session\'s measurables', async () => {
  upsertMeasurable(stateDir, { id: 'workspace-divergence:sess-fitness-1::x', kind: 'workspace-divergence', title: 't', detail: 'x', evidence: { sessionId: SID, ref: null }, metric: null, ts: 10 });
  upsertMeasurable(stateDir, { id: 'guard-retire:other', kind: 'guard-retire', title: 'other', evidence: { sessionId: null, ref: 'other' }, ts: 10 }); // different session -> excluded

  const base = `http://127.0.0.1:${h.port}`;
  const first = await (await fetch(`${base}/api/state?session=${SID}`)).json();
  assert.equal(first.fitness.tracked, 1);
  assert.equal(first.fitness.unlabeled, 1);

  await fetch(`${base}/api/measurables/${encodeURIComponent('workspace-divergence:sess-fitness-1::x')}/label`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }),
  });
  const second = await (await fetch(`${base}/api/state?session=${SID}`)).json();
  assert.equal(second.fitness.approved, 1);
  assert.equal(second.fitness.unlabeled, 0);
});
