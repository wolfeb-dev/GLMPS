import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { getPaths } from '../lib/paths.js';
import { promptVersionFor } from '../lib/evaluation/prompt-version.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

let stateDir;
let claudeDir;
let projectDir;
let env;
let h;

before(async () => {
  stateDir = tmp('mc-state-');
  claudeDir = claudeTmp();
  projectDir = tmp('mc-project-');
  fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'project rules for the unit test');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'index.json'),
    JSON.stringify([{ id: 'unitsess', cwd: projectDir }]));
  env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
});

after(async () => {
  await h?.close?.();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const sub of ['outcomes', 'replay', 'usage']) {
    fs.rmSync(path.join(stateDir, sub), { recursive: true, force: true });
  }
});

async function withServer(fn) {
  const od = path.join(stateDir, 'outcomes');
  fs.mkdirSync(od, { recursive: true });
  fs.writeFileSync(path.join(od, 'rows.ndjson'),
    JSON.stringify({ id: 'session-a', unit: 'session', taskClass: 'feature', turns: 3, firstTry: true, verifier: { exitOk: true }, contextUsageRatio: 0.4 }) + '\n' +
    JSON.stringify({ id: 'session-b', unit: 'session', taskClass: 'feature', turns: 7, firstTry: false, verifier: { exitOk: false }, contextUsageRatio: 0.6 }) + '\n' +
    // turns/firstTry/verifier are populated (not left bare) so unit 'trade'
    // clears the loop-measurement-honesty two-measured-metrics gate; a row
    // with zero populated metrics can no longer support a promotion verdict,
    // by design (see server/lib/evaluation/promotion-view.js).
    JSON.stringify({ id: 'trade-1', unit: 'trade', taskClass: 'other', turns: 5, firstTry: true, verifier: { exitOk: true } }) + '\n');
  const base = `http://127.0.0.1:${h.port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, obj) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); return { status: r.status, body: await r.json() }; };
  await fn({ get, post });
}

test('GET /api/outcomes returns rows and filters', async () => {
  await withServer(async ({ get }) => {
    const all = await get('/api/outcomes');
    assert.equal(all.status, 200);
    assert.equal(all.body.outcomes.length, 3);
    assert.equal((await get('/api/outcomes?unit=trade')).body.outcomes.length, 1);
    assert.equal((await get('/api/outcomes?taskClass=feature')).body.outcomes.length, 2);
  });
});

test('GET /api/outcomes/summary aggregates by taskClass', async () => {
  await withServer(async ({ get }) => {
    const s = await get('/api/outcomes/summary');
    assert.equal(s.status, 200);
    assert.equal(s.body.byClass.feature.n, 2);
    assert.equal(s.body.byClass.feature.medianTurns.value, 5);
    assert.equal(s.body.byClass.feature.medianTurns.evidence, 'measured');
    assert.equal(s.body.byClass.feature.verifierPassRate.value, 0.5);
    assert.equal(s.body.byClass.feature.firstTryRate.value, 0.5);
  });
});

test('GET /api/outcomes/summary reports the judged other share next to its 15% target', async () => {
  const od = path.join(stateDir, 'outcomes');
  fs.mkdirSync(od, { recursive: true });
  const rows = [
    { id: 'pre-judge', taskClass: 'other' },
    { id: 'j1', taskClass: 'other', extra: { judge: { ts: 1, pass: true } } },
    { id: 'j2', taskClass: 'feature', extra: { judge: { ts: 2, pass: true } } },
    { id: 'j3', taskClass: 'review', extra: { judge: { ts: 3, pass: true } } },
    { id: 'j4', taskClass: 'debug', extra: { judge: { ts: 4, pass: true } } },
  ];
  fs.writeFileSync(path.join(od, 'rows.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const body = await (await fetch(`http://127.0.0.1:${h.port}/api/outcomes/summary`)).json();
  assert.equal(body.byClass.other.n, 2);
  assert.deepEqual(body.otherShare, { window: 200, n: 4, other: 1, share: 0.25, target: 0.15, meetsTarget: false });
});

test('GET /api/replay returns empty set when none registered', async () => {
  await withServer(async ({ get }) => {
    const r = await get('/api/replay');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tasks, []);
  });
});

test('GET /api/replay lists the registered eval/replay tasks', async () => {
  fs.mkdirSync(path.join(stateDir, 'replay'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'replay', 'tasks.json'),
    JSON.stringify({ tasks: [{ id: 't1', project: 'p', promptFile: null, baseline: null }] }));
  const r = await fetch(`http://127.0.0.1:${h.port}/api/replay`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].id, 't1');
});

test('GET /api/promotion returns a verdict over per-unit aggregates', async () => {
  await withServer(async ({ get }) => {
    const r = await get('/api/promotion');
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    assert.equal(r.body.champion.unit, 'session'); // n=2, the incumbent
    assert.equal(r.body.challenger.unit, 'trade');  // n=1
    assert.ok(['promote', 'hold', 'reject'].includes(r.body.verdict));
  });
});

test('GET /api/promotion returns insufficient-evidence over HTTP when fewer than two metrics are measured', async () => {
  // Dedicated route-level fixture (separate stateDir, not the shared
  // withServer one) proving the new verdict over the real wire, not just
  // through the pure promotionView() function. Same zero-signal shape as
  // promotion-view.test.js's insufficient-evidence unit test: n=11/n=8
  // straddle evidence.js's MIN_CONSTANT_N=10, so the two sides land
  // DIFFERENT evidence tags, not the same ones. On the n=11 champion
  // ('a'), zero variance + n>=10 tags medianTurns/firstTryRate/
  // medianContextUsage 'constant' (0 measured metrics). On the n=8
  // challenger ('b'), the same zero variance falls under that threshold,
  // so those three land 'measured' instead (3 measured metrics).
  // verifierPassRate is 'absent' on both sides regardless (every row's
  // verifier.exitOk is null, so there are zero valid samples to tag). The
  // gate still trips because it requires >= 2 measured metrics on EACH
  // side (promotion-view.js's champMeasured < 2 || chalMeasured < 2), and
  // the champion side has zero.
  const od = path.join(stateDir, 'outcomes');
  fs.mkdirSync(od, { recursive: true });
  const rows = [];
  for (let i = 0; i < 11; i++) rows.push({ id: `a${i}`, unit: 'a', turns: 0, verifier: { exitOk: null }, firstTry: true, contextUsageRatio: 0.16 });
  for (let i = 0; i < 8; i++) rows.push({ id: `b${i}`, unit: 'b', turns: 0, verifier: { exitOk: null }, firstTry: true, contextUsageRatio: 0.09 });
  fs.writeFileSync(path.join(od, 'rows.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = await fetch(`http://127.0.0.1:${h.port}/api/promotion?champion=a&challenger=b`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.verdict, 'insufficient-evidence');
  assert.ok(body.n, 'n is present on the response');
  assert.equal(body.n.champion, 11);
  assert.equal(body.n.challenger, 8);
});

test('POST /api/outcomes/finalize appends idempotently; 400 without session', async () => {
  await withServer(async ({ get, post }) => {
    const r1 = await post('/api/outcomes/finalize', { session: 'newsess' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.appended, true);
    assert.equal(r1.body.row.id, 'session-newsess');
    const r2 = await post('/api/outcomes/finalize', { session: 'newsess' });
    assert.equal(r2.body.appended, false);
    // unit is now a prompt-version cohort tag (glmps improvements-loop fix), not
    // the literal 'session' - the newly finalized row has an unknown cwd (no
    // index entry) so its unit falls back to a homeDir-only tag, distinct from
    // the two seeded 'session'-unit fixture rows.
    assert.match(r1.body.row.unit, /^prompt-/);
    assert.equal((await get('/api/outcomes?unit=session')).body.outcomes.length, 2);
    assert.equal((await get('/api/outcomes')).body.outcomes.length, 4);
    assert.equal((await post('/api/outcomes/finalize', {})).status, 400);
  });
});

test('POST /api/outcomes/finalize picks up model from the per-session usage row', async () => {
  const usageDir = path.join(stateDir, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  const capturedAt = Date.now();
  fs.writeFileSync(path.join(usageDir, '2026-07-05.ndjson'),
    JSON.stringify({ sid: 'modelsess', ts: capturedAt, capturedAt, model: 'claude-sonnet-5', costUsd: 1, input: 10, output: 5, ctxUsedPct: 20 }) + '\n');
  const r = await fetch(`http://127.0.0.1:${h.port}/api/outcomes/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'modelsess' }),
  });
  const body = await r.json();
  assert.equal(body.row.model, 'claude-sonnet-5');
});

test('POST /api/outcomes/finalize derives model from events when no usage row is present', async () => {
  await withServer(async ({ post }) => {
    // no usage dir/row exists for this session in this stateDir, so the handler
    // should fall back to event-derived model (null here, since fixture events
    // carry no model field either).
    const r = await post('/api/outcomes/finalize', { session: 'noeventmodel' });
    assert.equal(r.status, 200);
    assert.equal(r.body.row.model, null);
  });
});

test('POST /api/outcomes/finalize sets unit to a prompt-version cohort tag for the session cwd', async () => {
  const r = await fetch(`http://127.0.0.1:${h.port}/api/outcomes/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'unitsess' }),
  });
  const body = await r.json();
  // claudeDir (not a bare os.homedir() read) so this assertion never depends
  // on the operator's real ~/.claude/CLAUDE.md: the server computes `unit`
  // from the same getPaths()-redirected claudeDir, which in this test process resolves to a path that does
  // not exist, regardless of what the real home directory contains.
  const expected = promptVersionFor({ cwd: projectDir, claudeDir: getPaths(env).claudeDir });
  assert.equal(body.row.unit, expected);
  assert.match(body.row.unit, /^prompt-/);
});
