// server/test/judge-plugin.test.js
//
// The judge cutover (D23/D24, glmps-159 task 8): every finished session gets
// a classification and an independent verdict from the judge plugin, a
// different actor from the session that did the work. The judge never
// writes item.gate - that stays an operator/critic action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  eventsToTrajectory, judgeSession, readVerdicts, judgeSummary, getJudgeConfig, JUDGE_DEFAULTS,
} from '../lib/plugins/judge-plugin.js';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-judge-'));
const events = [
  { kind: 'prompt', tool: 'user', label: 'Fix the login test' },
  { kind: 'tool', tool: 'Edit', label: 'fixtures/user.js' },
];
const judge = {
  classify: async () => ({ taskClass: 'debug', outcome: 'succeeded', reason: 'fixed', by: 'openevals:task-completion' }),
  verdict: async () => ({ pass: true, comment: 'sound', by: 'openevals:trajectory-accuracy' }),
};

test('trajectory: prompts are user turns, actions are assistant lines', () => {
  const t = eventsToTrajectory(events);
  assert.equal(t[0].role, 'user');
  assert.match(t[1].content, /Edit fixtures\/user\.js/);
});

test('judges, updates the row, records the verdict, writes a devlog line', async () => {
  const stateDir = tmp();
  const updates = [];
  const devlog = [];
  const r = await judgeSession({
    judge, stateDir, row: { id: 'r1' }, events, firstPrompt: 'Fix', ticketId: 'mc-1',
    update: (d, id, p) => updates.push([id, p]),
    appendDevlog: (id, t) => devlog.push([id, t]),
    now: () => 5,
  });
  assert.deepEqual(r, { taskClass: 'debug', outcome: 'succeeded', pass: true });
  assert.equal(updates[0][1].taskClass, 'debug');
  assert.equal(updates[0][1].extra.outcomeClass, 'succeeded');
  assert.equal(readVerdicts(stateDir)[0].pass, true);
  assert.match(devlog[0][1], /^Independent review \(openevals:trajectory-accuracy\): PASS/);
  assert.equal(judgeSummary(stateDir).n, 1);
});

// a coerced classification (an out-of-enum
// taskClass/outcome the judge plugin already coerces to 'other'/'partial')
// must be distinguishable from a genuine one, in both the row's extra.judge
// and the independent verdict ledger line.
test('a coerced classification records coerced:true and the raw values in both the row extra and the verdict ledger', async () => {
  const stateDir = tmp();
  const updates = [];
  const coercedJudge = {
    classify: async () => ({
      taskClass: 'other', outcome: 'partial', reason: 'r', by: 'openevals:task-completion', coerced: true, raw: { taskClass: 'party', outcome: 'meh' },
    }),
    verdict: async () => ({ pass: false, comment: 'unclear', by: 'openevals:trajectory-accuracy' }),
  };
  await judgeSession({
    judge: coercedJudge, stateDir, row: { id: 'r2' }, events, firstPrompt: 'Fix',
    update: (d, id, p) => updates.push([id, p]),
    now: () => 9,
  });
  assert.equal(updates[0][1].extra.judge.coerced, true);
  assert.deepEqual(updates[0][1].extra.judge.raw, { taskClass: 'party', outcome: 'meh' });
  const [verdict] = readVerdicts(stateDir);
  assert.equal(verdict.coerced, true);
  assert.deepEqual(verdict.raw, { taskClass: 'party', outcome: 'meh' });
});

test('a judge failure propagates and changes nothing', async () => {
  const stateDir = tmp();
  const updates = [];
  await assert.rejects(
    judgeSession({
      judge: { ...judge, verdict: async () => { throw new Error('model timed out'); } },
      stateDir, row: { id: 'r1' }, events, firstPrompt: 'x',
      update: (...a) => updates.push(a),
    }),
    /timed out/,
  );
  assert.equal(updates.length, 0);
  assert.equal(readVerdicts(stateDir).length, 0);
});

test('summary with no verdicts is absent, not zero', () => {
  assert.equal(judgeSummary(tmp()).passRate.evidence, 'absent');
});

test('a devlog write is skipped without a ticketId (no card to write to)', async () => {
  const stateDir = tmp();
  let devlogCalled = false;
  await judgeSession({
    judge, stateDir, row: { id: 'r2' }, events, firstPrompt: 'Fix',
    appendDevlog: () => { devlogCalled = true; },
  });
  assert.equal(devlogCalled, false);
});

// the ORIGINAL empty-trajectory short-circuit
// returned {other/abandoned} WITHOUT ever calling update() - the finalize
// route treats that resolved promise as success (pluginHealth.ok('judge'),
// no retry queued), so a row that reached the judge with zero events was
// left at its initial 'pending' taskClass forever, with nothing left to
// ever revisit it. update() must be called here too, marking the row
// 'other'/'abandoned' with a judge record that says WHY (skipped:
// 'no-events'), so 'pending' is never a permanent state.
test('an empty trajectory (no events) marks the row abandoned via update(), never leaves it pending, and calls no model or verdict write', async () => {
  const stateDir = tmp();
  let judgeCalled = false;
  const updates = [];
  const r = await judgeSession({
    judge: { classify: async () => { judgeCalled = true; }, verdict: async () => { judgeCalled = true; } },
    stateDir, row: { id: 'r3' }, events: [], firstPrompt: '',
    update: (d, id, p) => updates.push([id, p]),
    now: () => 7,
  });
  assert.deepEqual(r, { taskClass: 'other', outcome: 'abandoned', pass: false, skipped: true });
  assert.equal(judgeCalled, false);
  assert.equal(readVerdicts(stateDir).length, 0, 'no verdict line - there was nothing to verdict');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], [
    'r3',
    { taskClass: 'other', extra: { outcomeClass: 'abandoned', judge: { skipped: 'no-events', ts: 7 } } },
  ]);
});

test('getJudgeConfig defaults to enabled with a 20-minute idle delay', () => {
  assert.deepEqual(getJudgeConfig({}), JUDGE_DEFAULTS);
  assert.equal(JUDGE_DEFAULTS.enabled, true);
  assert.equal(JUDGE_DEFAULTS.idleMs, 20 * 60 * 1000);
});

test('getJudgeConfig honours a partial override without dropping the other default', () => {
  assert.deepEqual(getJudgeConfig({ plugins: { judge: { idleMs: 500 } } }), { enabled: true, idleMs: 500 });
  assert.deepEqual(getJudgeConfig({ plugins: { judge: { enabled: false } } }), { enabled: false, idleMs: JUDGE_DEFAULTS.idleMs });
});

// Route-level: both are a thin GET wrapper over readVerdicts/judgeSummary,
// already exhaustively unit-tested above - this proves the wiring (path,
// method, response shape), not the logic underneath it again.
async function withServer(fn, { configExtra = null } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-judge-http-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const configFile = path.join(stateDir, configExtra ? 'config.json' : 'no-config.json');
  if (configExtra) fs.writeFileSync(configFile, JSON.stringify(configExtra));
  const h = await startServer({ port: 0, env, configFile });
  const base = `http://127.0.0.1:${h.port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, obj) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); return { status: r.status, body: await r.json() }; };
  try { await fn({ get, post, stateDir, h }); } finally { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(claudeDir, { recursive: true, force: true }); }
}

test('GET /api/judge/verdicts returns the seeded verdict ledger', async () => {
  await withServer(async ({ get, stateDir }) => {
    const before = await get('/api/judge/verdicts');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.verdicts, []);
    const judgeDir = path.join(stateDir, 'judge');
    fs.mkdirSync(judgeDir, { recursive: true });
    fs.writeFileSync(path.join(judgeDir, 'verdicts.ndjson'),
      JSON.stringify({ rowId: 'session-x', ticketId: 'mc-1', taskClass: 'debug', outcome: 'succeeded', pass: true, comment: 'sound', by: 'openevals:trajectory-accuracy', ts: 1 }) + '\n');
    const after = await get('/api/judge/verdicts');
    assert.equal(after.status, 200);
    assert.equal(after.body.verdicts.length, 1);
    assert.equal(after.body.verdicts[0].rowId, 'session-x');
  });
});

test('GET /api/judge/summary reports absent with no verdicts, then a measured pass rate once one exists', async () => {
  await withServer(async ({ get, stateDir }) => {
    const before = await get('/api/judge/summary');
    assert.equal(before.status, 200);
    assert.equal(before.body.n, 0);
    assert.equal(before.body.passRate.evidence, 'absent');
    const judgeDir = path.join(stateDir, 'judge');
    fs.mkdirSync(judgeDir, { recursive: true });
    fs.writeFileSync(path.join(judgeDir, 'verdicts.ndjson'),
      JSON.stringify({ rowId: 'session-x', pass: true }) + '\n');
    const after = await get('/api/judge/summary');
    assert.equal(after.body.n, 1);
    assert.equal(after.body.passRate.value, 1);
  });
});

// The finalize route no longer calls the judge inline - it upserts one
// durable judge.session job per session (server.js), and the registered
// plugin-retry loop (K Task 6, driven directly in tests via
// h.loopRegistry.runNow('plugin-retry')) is the only place a judge call is
// ever made, once the job's notBefore has passed.
// Reads every job regardless of notBefore - take() deliberately hides a
// not-due job (B4), which is exactly what these tests need to see past.
function readRetryJobs(stateDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(stateDir, 'plugins', 'retry.ndjson'), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('finalize upserts one judge.session job per session; a second ping pushes notBefore forward instead of duplicating', async () => {
  await withServer(async ({ post, stateDir }) => {
    const r1 = await post('/api/outcomes/finalize', { session: 'pinged' });
    assert.equal(r1.status, 200);
    const [job1] = readRetryJobs(stateDir).filter((j) => j.kind === 'judge.session' && j.sessionId === 'pinged');
    assert.ok(job1, 'a job was created on the first ping');

    const r2 = await post('/api/outcomes/finalize', { session: 'pinged' });
    assert.equal(r2.status, 200);
    const jobs2 = readRetryJobs(stateDir).filter((j) => j.kind === 'judge.session' && j.sessionId === 'pinged');
    assert.equal(jobs2.length, 1, 'still exactly one job, not two');
    assert.equal(jobs2[0].id, job1.id, 'the same job, updated in place');
    assert.ok(jobs2[0].notBefore >= job1.notBefore, 'notBefore pushed forward (or held, on a same-millisecond tick)');
  });
});

test('plugins.judge.enabled:false means finalize never queues a judge job', async () => {
  await withServer(async ({ post, stateDir }) => {
    const r = await post('/api/outcomes/finalize', { session: 'nodisabled' });
    assert.equal(r.status, 200);
    const jobs = readRetryJobs(stateDir).filter((j) => j.kind === 'judge.session');
    assert.deepEqual(jobs, []);
  }, { configExtra: { plugins: { judge: { enabled: false } } } });
});

// Fix round 1, finding 1, end to end: a session finalized with truly no
// events anywhere must never leave its row stuck at 'pending' once its
// judge.session job comes due. idleMs:0 plus a manually-triggered
// plugin-retry loop run makes this deterministic instead of waiting the real
// 20-minute default. Safe to do without a network call because an empty
// trajectory never reaches judge.classify/judge.verdict (judge-plugin.js's
// own no-events short-circuit, proven above).
test('finalize never leaves a row pending when a session has no events anywhere - no model call, health stays clean', async () => {
  await withServer(async ({ post, get, h }) => {
    const r = await post('/api/outcomes/finalize', { session: 'trulyempty' });
    assert.equal(r.status, 200);
    assert.equal(r.body.appended, true);
    await h.loopRegistry.runNow('plugin-retry');
    const outcomes = (await get('/api/outcomes')).body.outcomes;
    const row = outcomes.find((o) => o.id === 'session-trulyempty');
    assert.ok(row, 'the row exists');
    assert.equal(row.taskClass, 'other');
    assert.equal(row.extra.outcomeClass, 'abandoned');
    assert.equal(row.extra.judge.skipped, 'no-events');
    // No verdict was ever written either - there was nothing to verdict.
    assert.deepEqual((await get('/api/judge/verdicts')).body.verdicts, []);
  }, { configExtra: { plugins: { judge: { idleMs: 0 } } } });
});
