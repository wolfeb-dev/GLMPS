// server/test/obligation-routes.test.js
// K4 at the HTTP surface: GET /api/obligations, the gate-PASS
// opener wired into POST /api/backlog/:id/gate, and open_obligations
// climbing at /healthz as a real gate opens one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { reportMiss, adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';
import { listRoutes, matchRoute, registerRoute } from '../lib/observability/route-registry.js';

// Full isolation set (server/test/adapter-health-state.test.js) plus
// GLMPS_UNMERGED_SCAN: 'off' (cross-plan finding F-24): GLMPS_STATE_DIR alone lets
// a startServer() test fall through to the operator's real ~/.claude and
// ~/.glmps state for every dir this does not override.
function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-oblroute-'));
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
    GLMPS_MODEL_RUNNER: 'off',
  };
}

const snapshotRoutes = () => listRoutes().map(({ method, pattern }) => matchRoute(method, pattern).route);
const restoreRoutes = (saved) => { for (const r of saved) registerRoute(r); };

let sharedEnv;
let sharedSrv;
let sharedRoutes;
let realOpen;
let realListOpen;

let brokenSrv;
let brokenRoutes;

before(async () => {
  sharedEnv = mkEnv();
  sharedSrv = await startServer({ port: 0, env: sharedEnv, pollMs: 100000, restartFn: () => {} });
  sharedRoutes = snapshotRoutes();
  realOpen = sharedSrv.obligationStore.open;
  realListOpen = sharedSrv.obligationStore.listOpen;

  const brokenEnv = mkEnv();
  fs.mkdirSync(brokenEnv.GLMPS_STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(brokenEnv.GLMPS_STATE_DIR, 'kernel.db')); // DatabaseSync cannot open a directory
  brokenSrv = await startServer({ port: 0, env: brokenEnv, pollMs: 100000, restartFn: () => {} });
  brokenRoutes = snapshotRoutes();
});

after(async () => {
  await sharedSrv?.close();
  await brokenSrv?.close();
});

async function withServer(fn) {
  restoreRoutes(sharedRoutes);
  const base = `http://127.0.0.1:${sharedSrv.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const get = (p) => j(p);
  try {
    await fn({ post, get, srv: sharedSrv, env: sharedEnv });
  } finally {
    sharedSrv.obligationStore.open = realOpen;
    sharedSrv.obligationStore.listOpen = realListOpen;
  }
}

async function withBrokenServer(fn) {
  restoreRoutes(brokenRoutes);
  await fn(brokenSrv);
}

test('GET /api/obligations lists open rows and ?state=all includes closed ones', async () => {
  await withServer(async ({ post, get }) => {
    const created = await post('/api/backlog', { title: 'obligation route target' });
    const id = created.body.id;
    const gate = await post(`/api/backlog/${id}/gate`, { status: 'PASS', evidence: ['green'], by: 'reviewer' });
    assert.equal(gate.status, 200);

    const open = await get('/api/obligations');
    assert.equal(open.status, 200);
    const row = open.body.find((r) => r.kind === 'gate.independent-verdict' && r.subject === id);
    assert.ok(row, 'the PASS gate opened a gate.independent-verdict obligation');
    assert.equal(row.openedBy, 'agent:reviewer');
    assert.equal(row.closedTs, null);

    const all = await get('/api/obligations?state=all');
    assert.equal(all.status, 200);
    assert.ok(all.body.some((r) => r.id === row.id), 'listAll also carries the same row');
  });
});

test('a CONCERNS/FAIL/WAIVED gate opens no obligation', async () => {
  await withServer(async ({ post, get }) => {
    const created = await post('/api/backlog', { title: 'no obligation here' });
    const id = created.body.id;
    await post(`/api/backlog/${id}/gate`, { status: 'FAIL', by: 'reviewer' });
    const open = await get('/api/obligations');
    assert.equal(open.body.filter((r) => r.subject === id).length, 0);
  });
});

test('GET /api/obligations answers 503 when the store failed to open', async () => {
  await withBrokenServer(async (srv) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/obligations`);
    assert.equal(r.status, 503);
  });
});

test('a PASS gate raises the open_obligations count at /healthz', async () => {
  await withServer(async ({ post, get }) => {
    const before = (await get('/healthz')).body.open_obligations;
    const created = await post('/api/backlog', { title: 'healthz count target' });
    await post(`/api/backlog/${created.body.id}/gate`, { status: 'PASS', by: 'reviewer' });
    const after = (await get('/healthz')).body.open_obligations;
    assert.equal(after, before + 1);
  });
});

// the route only ever meant 'open' or
// 'all' - a typo'd or unsupported value used to silently fall back to
// 'open' rather than telling the caller their query was wrong.
test('GET /api/obligations rejects an unsupported state value with 400', async () => {
  await withServer(async ({ get }) => {
    const bad = await get('/api/obligations?state=bogus');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /state/);
    const ok = await get('/api/obligations?state=open');
    assert.equal(ok.status, 200);
    const noParam = await get('/api/obligations');
    assert.equal(noParam.status, 200, 'the state param stays optional, defaulting to open');
  });
});

// K4 fix round 1, item 2 records that a failed gate-obligation open
// used to reach only the console, and a later fix round routed it through
// the shared consecutive-failure tracker so it also showed as a dashboard
// alert. K Task 6 deletes that tracker with no general-purpose replacement
// (only the four named plugin loops get one, via loopAlerts) - a
// gate-obligation-open failure has no registered loop of its own to
// attribute to, so it is logged fail-open again; the gate call itself must
// still succeed regardless.
test('a gate-obligation-open failure is logged fail-open, and the gate PASS itself still succeeds', async () => {
  await withServer(async ({ post, srv }) => {
    srv.obligationStore.open = () => { throw new Error('simulated disk error'); };
    const realError = console.error;
    const logs = [];
    console.error = (...args) => { logs.push(args.join(' ')); };
    let gate;
    let created;
    try {
      created = await post('/api/backlog', { title: 'obligation open will fail' });
      gate = await post(`/api/backlog/${created.body.id}/gate`, { status: 'PASS', by: 'reviewer' });
    } finally { console.error = realError; }
    assert.equal(gate.status, 200, 'the gate call itself must not fail just because the obligation open did');
    assert.ok(logs.some((m) => /gate obligation open failed/.test(m) && m.includes(created.body.id) && /simulated disk error/.test(m)),
      `expected a logged reason naming the ticket and the error, got: ${JSON.stringify(logs)}`);
  });
});

// I8/I5: a successful gate-obligation-open clears any
// earlier failure episode - the success path wiring itself, not just
// clearMiss() in isolation.
test('a successful gate-obligation-open clears an earlier gate-obligation-open miss', async () => {
  resetAdapterHealth();
  try {
    reportMiss('gate-obligation-open', 'an earlier failure, before this boot');
    await withServer(async ({ post }) => {
      const created = await post('/api/backlog', { title: 'obligation open will succeed' });
      const gate = await post(`/api/backlog/${created.body.id}/gate`, { status: 'PASS', by: 'reviewer' });
      assert.equal(gate.status, 200);
    });
    assert.equal(adapterHealth()['gate-obligation-open'], undefined, 'the successful open must clear the earlier miss');
  } finally {
    resetAdapterHealth();
  }
});

// A store method throwing for one unrelated reason (this is what a genuine
// disk/db error looks like, as opposed to the whole store being null) must
// not take the entire alert center down with it - every other health
// signal in collectCurrentAlerts() already fails open the same way (see
// the memoryFindings try/catch a few lines above the obligations wiring).
test('a throwing obligationStore.listOpen() degrades /api/alerts, never 500s it', async () => {
  await withServer(async ({ post, get, srv }) => {
    const created = await post('/api/backlog', { title: 'still shows other alerts' });
    await post(`/api/backlog/${created.body.id}/gate`, { status: 'PASS', by: 'reviewer' });
    srv.obligationStore.listOpen = () => { throw new Error('simulated read error'); };
    const r = await get('/api/alerts?all=1');
    assert.equal(r.status, 200, 'a broken obligations read must not 500 the whole alert center');
    assert.ok(Array.isArray(r.body.alerts));
  });
});

// the round 1 tests all drove a test
// double that re-implemented nextDiagnosisBudget's own decision inline -
// none of them would have failed if server.js's real diagnose wiring
// dropped that call entirely. This test drives the REAL wiring instead:
// a real obligation-sweeper run, through the real registry, calling the
// real server.js `diagnose` closure, with a real (but disabled)
// chatCompletion built the same way server.js builds it. GLMPS_MODEL_RUNNER
// is explicitly 'off' (runClaude's own guard, claude-model.js), so if the
// wiring's budget/ceiling gate is ever reverted (or simply not called),
// diagnoseLoop's real chatCompletion attempt would reject with "model
// runner disabled (GLMPS_MODEL_RUNNER=off)" instead of the ceiling stub's own
// message - the two are distinguishable in the filed card's own text,
// which is exactly what this test tells apart.
test('the real server wiring routes obligation diagnoses through the persisted daily budget: over the ceiling, no real model call is attempted', async () => {
  await withServer(async ({ srv, env }) => {
    const budgetFile = path.join(env.GLMPS_STATE_DIR, 'loops', 'diagnosis-budget.json');
    try {
      // A fresh loop with a near-zero freshness SLA: registering it opens a
      // 'loop.freshness' obligation (the real registry's own obligations
      // adapter, wired at boot) due almost immediately.
      const registerTarget = (name) => srv.loopRegistry.registerLoop({
        name, trigger: { external: 'test' },
        maker: async () => { throw new Error('never actually run'); }, checker: async () => ({ ok: false }),
        ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1 }, sla: { maxAgeMs: 1 },
      });

      // the old version of this test computed
      // "today" from `new Date()` in the TEST process, separately from the
      // server's own internal Date.now() - correct almost always, but a
      // real (if vanishingly rare) midnight-UTC race between the two. Warm
      // the budget with one real, cheap diagnosis first instead: the
      // "today" it persists is read straight back from the file the SERVER
      // itself just wrote, so the rest of this test derives from the exact
      // same clock the wiring under test uses, never a separate guess.
      registerTarget('diag-budget-warm');
      await new Promise((r) => setTimeout(r, 30)); // let the 1ms SLA become overdue
      await srv.loopRegistry.runNow('obligation-sweeper');
      const { day } = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
      // cfg.kernel.diagnosis.maxPerDay defaults to 10 (server.js) - top up
      // to that ceiling for the SAME day the server just recorded.
      fs.writeFileSync(budgetFile, JSON.stringify({ day, n: 10 }));

      registerTarget('diag-budget-target');
      await new Promise((r) => setTimeout(r, 30));
      await srv.loopRegistry.runNow('obligation-sweeper');

      const listResp = await fetch(`http://127.0.0.1:${srv.port}/api/backlog`);
      const items = (await listResp.json()).items;
      const card = items.find((i) => i.title.startsWith('Loop diag-budget-target failing:'));
      assert.ok(card, `expected a diagnosis card for diag-budget-target, got titles: ${JSON.stringify(items.map((i) => i.title))}`);
      assert.match(card.prompt, /diagnosis skipped: daily ceiling reached/);
      // Outside-2.0 inventory Q3: no project in config.json lands the card on
      // the glmps-2.0-runtime board.
      assert.equal(card.project, 'glmps-2.0-runtime');
      assert.doesNotMatch(card.prompt, /model runner disabled/, 'a match here would mean the real model was attempted - the budget wiring was bypassed');
    } finally {
      fs.rmSync(budgetFile, { force: true });
      fs.rmSync(path.join(env.GLMPS_STATE_DIR, 'backlog'), { recursive: true, force: true });
    }
  });
});

// the round 2 test above proves the
// BUDGET reaches the real wiring; nothing proved ctx itself does. If
// server.js's diagnose closure ever drops its second parameter (`(row,
// ctx) => ...` losing the `ctx`), diagnosisStubReason would be called with
// `ctx: undefined`, its own `if (ctx) {...}` guard would skip
// ctx.countModelCall() entirely, and the loop's own run ceiling would
// never be spent no matter how many real diagnoses happen - the run would
// wrongly always succeed. Seven fresh, near-zero-SLA loops (well under
// the daily budget's default ceiling of 10, well OVER the obligation-
// sweeper's own registered maxModelCalls of 5) drives that past the real
// ceiling; GLMPS_MODEL_RUNNER stays 'off' only to keep this fast and
// offline - the model call itself never needs to succeed, only be
// attempted (ctx.countModelCall() runs before diagnoseLoop is even
// called).
// Phase K final review minor (sweeper ceiling vs sequential diagnoses),
// cap real diagnoses at one per sweep. This replaces the round-3 test
// that drove seven expiries past a ceiling of 5 and expected the sweep to
// FAIL on ceiling:model-calls: with up to 120 s per claude -p call, five
// sequential diagnoses could never fit the sweeper's own timeout, and a
// failed sweep is itself a false alarm. Now seven expiries make exactly one
// real model attempt (ctx reaching the wiring is what makes the cap work: a
// dropped ctx would attempt all seven), six stub cards, and the sweep is done.
test('the real server wiring makes one real diagnosis per sweep: seven near-zero-SLA loops give one model attempt, six stub cards, and a done sweep', async () => {
  await withServer(async ({ srv, env }) => {
    const budgetFile = path.join(env.GLMPS_STATE_DIR, 'loops', 'diagnosis-budget.json');
    try {
      for (let i = 0; i < 7; i++) {
        srv.loopRegistry.registerLoop({
          name: `diag-ceiling-target-${i}`, trigger: { external: 'test' },
          maker: async () => { throw new Error('never actually run'); }, checker: async () => ({ ok: false }),
          ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1 }, sla: { maxAgeMs: 1 },
        });
      }
      await new Promise((r) => setTimeout(r, 30));
      const res = await srv.loopRegistry.runNow('obligation-sweeper');
      assert.equal(res.outcome, 'done', `the sweep itself must succeed, got ${JSON.stringify(res)}`);
      const items = (await (await fetch(`http://127.0.0.1:${srv.port}/api/backlog`)).json()).items;
      const cards = items.filter((i) => i.source === 'loop-diagnosis' && /diag-ceiling-target-/.test(i.title));
      assert.equal(cards.length, 7, 'every expiry still files a card');
      assert.equal(cards.filter((c) => /model runner disabled/.test(c.prompt)).length, 1, 'exactly one real model attempt');
      assert.equal(cards.filter((c) => /one model diagnosis per sweep/.test(c.prompt)).length, 6);
      for (const c of cards) assert.doesNotMatch(c.prompt, /failed 0 consecutive/, 'a freshness card names the expiry');
    } finally {
      fs.rmSync(budgetFile, { force: true });
      fs.rmSync(path.join(env.GLMPS_STATE_DIR, 'backlog'), { recursive: true, force: true });
    }
  });
});

// drive cfg.kernel.diagnosis.enabled
// through the real wiring too, not just diagnosisStubReason's own unit
// test - a config.json actually read by startServer(), a real sweep, and
// the filed card's own text as the observable proof no real model call
// was attempted.
test('the real server wiring honors cfg.kernel.diagnosis.enabled: false, filing a disabled stub card with no real model call', async () => {
  const env = mkEnv();
  env.GLMPS_MODEL_RUNNER = 'off';
  const configFile = path.join(env.GLMPS_STATE_DIR, '..', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ kernel: { diagnosis: { enabled: false } } }));
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {} });
  try {
    srv.loopRegistry.registerLoop({
      name: 'diag-disabled-target', trigger: { external: 'test' },
      maker: async () => { throw new Error('never actually run'); }, checker: async () => ({ ok: false }),
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1 }, sla: { maxAgeMs: 1 },
    });
    await new Promise((r) => setTimeout(r, 30));
    await srv.loopRegistry.runNow('obligation-sweeper');

    const items = (await (await fetch(`http://127.0.0.1:${srv.port}/api/backlog`)).json()).items;
    const card = items.find((i) => i.title.startsWith('Loop diag-disabled-target failing:'));
    assert.ok(card, `expected a diagnosis card for diag-disabled-target, got titles: ${JSON.stringify(items.map((i) => i.title))}`);
    assert.match(card.prompt, /diagnosis disabled/);
    assert.doesNotMatch(card.prompt, /model runner disabled/, 'a match here would mean the real model was attempted despite cfg.kernel.diagnosis.enabled being false');
  } finally { await srv.close(); }
});

// the eligibility guard itself
// (row.kind !== 'loop.freshness' || !loopRegistry.get(row.subject)) is
// what the earlier round-2 test only exercised via a hand-copied test
// double. Drive it through the real wiring: a gate.independent-verdict
// row (never eligible for diagnosis, whatever loop name its subject
// happens to be) that expires must never get a diagnosis card - if the
// guard is removed, diagnosisStubReason (and then diagnoseLoop) would run
// for it too, filing one.
test('the real server wiring never diagnoses a gate.independent-verdict expiry', async () => {
  await withServer(async ({ srv }) => {
    srv.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'faketkt-1', openedBy: 'kernel', dueTs: 1 });
    await srv.loopRegistry.runNow('obligation-sweeper');
    const items = (await (await fetch(`http://127.0.0.1:${srv.port}/api/backlog`)).json()).items;
    // A diagnosis card's title is 'Loop <name> failing: ...', never the
    // obligation's own subject id ('faketkt-1' is a backlog ticket id, not
    // a loop name, so it would never appear in the title text even if the
    // eligibility guard were removed and diagnoseLoop ran anyway - the
    // right test is "no diagnosis card was filed at all", by source.
    const diagnosisCards = items.filter((i) => i.source === 'loop-diagnosis');
    assert.equal(diagnosisCards.length, 0,
      `a gate.independent-verdict expiry must never file a diagnosis card, got: ${JSON.stringify(diagnosisCards.map((i) => i.title))}`);
    const row = srv.obligationStore.listOpen().find((r) => r.subject === 'faketkt-1');
    assert.ok(row, 'the row is still open and tracked normally');
    assert.ok(row.escalationLevel >= 0, 'the row was expired by the sweep - only diagnosis is skipped, not expiry/escalation tracking');
  });
});

// Phase K final review I2: a loop that cannot run must not open a freshness
// promise. nightly-run is an external loop driven by a Scheduled Task that
// only exists when cfg.nightly.enabled is true (false by default, and forced
// false in the 2.0 shadow); registered with a real freshness obligation it
// expired into a false alert 36h after every boot.
test('I2: nightly-run opens no freshness obligation while cfg.nightly.enabled is false (the default), and opens one when enabled', async () => {
  await withServer(async ({ get }) => {
    const open = await get('/api/obligations');
    assert.equal(open.status, 200);
    assert.equal(open.body.filter((r) => r.kind === 'loop.freshness' && r.subject === 'nightly-run').length, 0,
      'a disabled nightly actor must not open a freshness promise');
    assert.ok(open.body.some((r) => r.kind === 'loop.freshness' && r.subject === 'git-remote-feed'), 'a loop that does run still opens one');
  });
  const env = mkEnv();
  const configFile = path.join(env.GLMPS_STATE_DIR, '..', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ nightly: { enabled: true } }));
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {} });
  try {
    const rows = await (await fetch(`http://127.0.0.1:${srv.port}/api/obligations`)).json();
    assert.ok(rows.some((r) => r.kind === 'loop.freshness' && r.subject === 'nightly-run'), 'an enabled nightly actor keeps its 36h freshness promise');
  } finally { await srv.close(); }
});

// Phase K final review I2: the server tells the operator a human closes an
// obligation the kernel cannot verify (decision.deferred/decision.cancelled),
// but no route existed to do it. POST /api/obligations/:id/close.
// The caller presents the dashboard's local-session proof unless the test
// passes its own headers (scan F11).
async function closeReq(srv, id, body, raw = null, proof = { 'x-glmps-local-session': srv.localSession }) {
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/obligations/${encodeURIComponent(id)}/close`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...proof }, body: raw ?? JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

// Scan F11 (card glmps-2-0-runtime-111): every agent session reaches this
// route on loopback, so loopback alone must not let one close its own
// gate.independent-verdict as the operator.
test('F11: the close route refuses a loopback caller without the local session or the master token (403)', async () => {
  const env = { ...mkEnv(), GLMPS_ACCESS_TOKEN: 'f11-master-token' };
  const srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    const { id } = srv.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'tkt-f11', openedBy: 'agent:x' });
    const body = { closer: 'decision.cancelled', note: 'closing my own gate' };
    for (const [label, proof] of [
      ['bare', {}],
      ['wrong session', { 'x-glmps-local-session': 'b'.repeat(64) }],
      ['wrong token', { authorization: 'Bearer nope' }],
    ]) {
      const r = await closeReq(srv, id, body, null, proof);
      assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'operator-only');
    }
    assert.ok(srv.obligationStore.findOpen({ kind: 'gate.independent-verdict', subject: 'tkt-f11' }), 'every refusal left the row open');
    const tok = await closeReq(srv, id, body, null, { authorization: 'Bearer f11-master-token' });
    assert.equal(tok.status, 200, `the master token is operator proof: ${JSON.stringify(tok.body)}`);
    assert.equal(tok.body.closedBy, 'operator');
  } finally { await srv.close(); }
});

test('I2: POST /api/obligations/:id/close closes a row with an operator decision and a note', async () => {
  await withServer(async ({ srv }) => {
    const { id } = srv.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'tkt-close-1', openedBy: 'agent:x' });
    const r = await closeReq(srv, id, { closer: 'decision.deferred', note: 'judge offline this week' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.closer, 'decision.deferred');
    assert.equal(r.body.closedBy, 'operator');
    assert.equal(r.body.verifierRef, 'judge offline this week');
    assert.equal(srv.obligationStore.findOpen({ kind: 'gate.independent-verdict', subject: 'tkt-close-1' }), null);
    const again = await closeReq(srv, id, { closer: 'decision.cancelled' });
    assert.equal(again.status, 409, 'an already-closed row is not silently re-closed');
  });
});

test('I2: the close route refuses verified.done, an unknown closer, a closer the kind does not allow, bad bodies, and unknown ids', async () => {
  await withServer(async ({ srv }) => {
    const { id } = srv.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'tkt-close-2', openedBy: 'agent:x' });
    assert.equal((await closeReq(srv, id, { closer: 'verified.done', note: 'trust me' })).status, 400, 'verified.done needs a real verifier, never an HTTP caller');
    assert.equal((await closeReq(srv, id, { closer: 'whatever' })).status, 400);
    assert.equal((await closeReq(srv, id, null, 'null')).status, 400);
    assert.equal((await closeReq(srv, id, null, '{bad')).status, 400);
    assert.equal((await closeReq(srv, id, { closer: 'decision.deferred', note: 5 })).status, 400);
    assert.equal((await closeReq(srv, id, { closer: 'decision.deferred', note: 'x'.repeat(2001) })).status, 400);
    // Over the 16 KB cap: readBody() destroys the request socket as it
    // rejects, so the client sees either the 413 or a reset; either way the
    // row must stay open (asserted at the end).
    const big = await closeReq(srv, id, null, JSON.stringify({ closer: 'decision.deferred', note: 'y'.repeat(20 * 1024) })).catch((e) => ({ status: 'reset', e }));
    assert.ok(big.status === 413 || big.status === 'reset', `expected 413 or a reset, got ${big.status}`);
    assert.equal((await closeReq(srv, 'obl_nope', { closer: 'decision.cancelled' })).status, 404);
    const wiki = srv.obligationStore.open({ kind: 'wiki.reflects-head', subject: 'repo-a', openedBy: 'kernel' });
    assert.equal((await closeReq(srv, wiki.id, { closer: 'decision.deferred' })).status, 400, 'wiki.reflects-head cannot be deferred');
    assert.ok(srv.obligationStore.findOpen({ kind: 'gate.independent-verdict', subject: 'tkt-close-2' }), 'every refusal left the row open');
  });
});

test('I2: the close route answers 503 when the store failed to open', async () => {
  await withBrokenServer(async (srv) => {
    assert.equal((await closeReq(srv, 'obl_x', { closer: 'decision.cancelled' })).status, 503);
  });
});

test('I2: a row opened before a restart can be closed after it, and the close survives the next restart', async () => {
  const env = mkEnv();
  let id;
  let srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try { id = srv.obligationStore.open({ kind: 'gate.independent-verdict', subject: 'tkt-restart', openedBy: 'agent:x' }).id; }
  finally { await srv.close(); }
  srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try { assert.equal((await closeReq(srv, id, { closer: 'decision.cancelled', note: 'ticket dropped' })).status, 200); }
  finally { await srv.close(); }
  srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    const rows = await (await fetch(`http://127.0.0.1:${srv.port}/api/obligations?state=all`)).json();
    const row = rows.find((r) => r.id === id);
    assert.equal(row.closer, 'decision.cancelled');
    assert.equal(row.verifierRef, 'ticket dropped');
    const open = await (await fetch(`http://127.0.0.1:${srv.port}/api/obligations`)).json();
    assert.equal(open.some((r) => r.id === id), false);
  } finally { await srv.close(); }
});

// Phase K final review (silent-failure): the embed-model catch at boot
// replaced every failure with one fixed hint, discarding the real cause (a
// corrupt download reads identically to a missing one). The hint stays; the
// real reason is appended.
test('silent-failure: a missing embed model reports the fixed hint AND the real reason on memory-admission', async () => {
  await withServer(async ({ srv }) => {
    const reason = srv.loopRegistry.get('memory-admission')?.lastReason || '';
    assert.match(reason, /^model not installed: run node scripts\/fetch-embed-model\.mjs \(.+\)$/, `got: ${reason}`);
  });
});
