// Routes under test: server/lib/routes/loops-routes.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { matchRoute } from '../lib/observability/route-registry.js';

// Full isolation set (server/test/adapter-health-state.test.js) plus
// GLMPS_UNMERGED_SCAN: 'off' (cross-plan finding F-24): GLMPS_STATE_DIR alone lets
// a startServer() test fall through to the operator's real ~/.claude and
// ~/.glmps state for every dir this does not override.
function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loop-routes-'));
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

let srv;

before(async () => {
  srv = await startServer({ port: 0, env: mkEnv(), pollMs: 100000, restartFn: () => {} });
});

after(async () => {
  await srv?.close();
});

test('the server owns one registry: list, detail, run, report, and loop alerts', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  srv.loopRegistry.registerLoop({ name: 'fixture', trigger: { external: 'test' }, maker: async () => ({ outcome: 'done' }), checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false } });
  let r = await fetch(`${base}/api/loops/fixture/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'failed', reason: 'exit 1' }) });
  assert.equal(r.status, 204);
  const list = await (await fetch(`${base}/api/loops`)).json();
  assert.equal(list.fixture.consecutiveFailures, 1);
  const detail = await (await fetch(`${base}/api/loops/fixture`)).json();
  assert.equal(detail.lastReason, 'exit 1');
  assert.equal((await fetch(`${base}/api/loops/nope`)).status, 404);
  r = await fetch(`${base}/api/loops/fixture/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'deferred' }) });
  assert.equal(r.status, 400);
  const alerts = await (await fetch(`${base}/api/alerts`)).json();
  const rows = Array.isArray(alerts) ? alerts : alerts.alerts;
  assert.ok(rows.some((a) => a.source === 'loop' && a.title === 'Loop failing: fixture'));
  assert.equal((await fetch(`${base}/api/loops/fixture/run`, { method: 'POST' })).status, 409, 'external loops are reported, not run');
  r = await fetch(`${base}/api/loops/fixture/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'done' }) });
  assert.equal(r.status, 204);
  const afterAlerts = await (await fetch(`${base}/api/alerts`)).json();
  assert.ok(!(Array.isArray(afterAlerts) ? afterAlerts : afterAlerts.alerts).some((a) => a.title === 'Loop failing: fixture'), 'a good run clears the alert');
  // an internal loop cannot be reported done over HTTP
  srv.loopRegistry.registerLoop({ name: 'internal-fixture', trigger: { onEvent: 'never' }, maker: async () => ({ outcome: 'nothing-to-do' }), checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: null, obligation: false } });
  r = await fetch(`${base}/api/loops/internal-fixture/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'done' }) });
  assert.equal(r.status, 400);
});

// server.js's registered-routes dispatcher does `return rmatch.route.handle(...)`
// inside a try/catch, but a promise returned from inside a try is not awaited
// there: a later rejection of that promise never re-enters the catch block, so
// an async handle() that throws becomes an unhandled rejection of the whole
// per-request callback, not a response. Every async handler must therefore
// catch its own errors end to end, not just the awaits it happens to wrap.
// Exercised by calling handle() directly (never through a live HTTP round
// trip) so a still-buggy handler fails this assertion instead of hanging the
// test on an unanswered request or crashing the process on an unhandled
// rejection.
test('the async report handler catches its own errors instead of leaving an unhandled rejection', async () => {
  srv.loopRegistry.registerLoop({ name: 'boom', trigger: { external: 'test' }, maker: async () => ({ outcome: 'done' }), checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false } });
  const realGet = srv.loopRegistry.get;
  srv.loopRegistry.get = () => { throw new Error('boom'); };
  try {
    const match = matchRoute('POST', '/api/loops/boom/report');
    assert.ok(match, 'the report route is registered');
    let sent = null;
    const send = (code, obj) => { sent = { code, obj }; };
    await assert.doesNotReject(
      () => match.route.handle({ on() {} }, {}, { params: { name: 'boom' }, send }),
      'the handler must resolve, never reject, so the dispatcher always gets a response to send',
    );
    assert.equal(sent?.code, 500);
  } finally { srv.loopRegistry.get = realGet; }
});

// Task 2 review minors, folded into Task 3: the report route's body validation
// was too loose (a non-object body or a non-boolean fresh reached
// loopRegistry.report unchecked, and a genuine "body too large" rejection from
// readBody() was swallowed into the same generic 400 as a JSON syntax error).
test('report: a non-object body is 400; fresh must be a plain object, null or absent', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  srv.loopRegistry.registerLoop({ name: 'validate-body', trigger: { external: 'test' }, maker: async () => ({ outcome: 'done' }), checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false } });
  const post = (body) => fetch(`${base}/api/loops/validate-body/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  let r = await post(JSON.stringify('just a string'));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'body must be an object');

  r = await post(JSON.stringify([1, 2, 3]));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'body must be an object');

  // fresh is the registry's state-record field,
  // an object, never a boolean -- a caller sending a boolean or any other
  // scalar, or an array, is rejected before it ever reaches loopRegistry.report().
  for (const bad of ['yes', true, 42, [1, 2]]) {
    r = await post(JSON.stringify({ outcome: 'done', fresh: bad }));
    assert.equal(r.status, 400, `fresh: ${JSON.stringify(bad)} must be rejected`);
    assert.notEqual((await r.json()).error, 'invalid json', 'an invalid fresh is its own 400, not lumped into a JSON parse failure');
  }

  r = await post(JSON.stringify({ outcome: 'done', fresh: null }));
  assert.equal(r.status, 204, 'a null fresh is accepted');

  r = await post(JSON.stringify({ outcome: 'done', fresh: { builtAtCommit: 'abc' } }));
  assert.equal(r.status, 204, 'a plain-object fresh is accepted');

  r = await post(JSON.stringify({ outcome: 'done' }));
  assert.equal(r.status, 204, 'an absent fresh is accepted');
});

test('report: a body over the size cap is 413 with the literal "body too large"', async () => {
  srv.loopRegistry.registerLoop({ name: 'oversized', trigger: { external: 'test' }, maker: async () => ({ outcome: 'done' }), checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false } });
  const match = matchRoute('POST', '/api/loops/oversized/report');
  assert.ok(match, 'the report route is registered');
  // Drives readBody()'s own size-cap rejection directly (a fake req whose
  // 'data' handler delivers one over-cap chunk) instead of a real 5MB+
  // upload over loopback, mirroring the direct-handle() pattern above.
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
  const fakeReq = { on(event, cb) { if (event === 'data') cb(big); }, destroy() {} };
  let sent = null;
  const send = (code, obj) => { sent = { code, obj }; };
  await match.route.handle(fakeReq, {}, { params: { name: 'oversized' }, send });
  assert.equal(sent?.code, 413);
  assert.equal(sent.obj.error, 'body too large', 'the literal size-cap message, not an echo of readBody()\'s own error');
});

// readBody() can reject for reasons other than the size
// cap (a stream 'error' event -- a dropped connection, a bad transfer
// encoding). Only the size cap is a caller mistake worth a distinct status
// (413); every other read failure is an ordinary 400, and neither echoes the
// raw error text back to the caller.
test('report: a readBody rejection that is not the size cap is 400, not 413', async () => {
  srv.loopRegistry.registerLoop({ name: 'dropped', trigger: { external: 'test' }, maker: async () => ({ outcome: 'done' }), checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false } });
  const match = matchRoute('POST', '/api/loops/dropped/report');
  const fakeReq = { on(event, cb) { if (event === 'error') cb(new Error('ECONNRESET')); }, destroy() {} };
  let sent = null;
  const send = (code, obj) => { sent = { code, obj }; };
  await match.route.handle(fakeReq, {}, { params: { name: 'dropped' }, send });
  assert.equal(sent?.code, 400);
  assert.notEqual(sent.obj.error, 'ECONNRESET', 'the raw stream error is logged server-side, never echoed to the caller');
});

// a 400 from loopRegistry.report() rejecting the body,
// and the handler's own top-level 500, both used to hand e.message straight
// to the HTTP caller. That leaks internal detail to whatever is on the other
// end of the loop's report call (an external script, a Scheduled Task); the
// reason belongs in the server log, not the response body.
test('report: 400 and 500 bodies never echo the internal error message', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  srv.loopRegistry.registerLoop({ name: 'no-echo', trigger: { external: 'test' }, maker: async () => ({ outcome: 'done' }), checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false } });
  let r = await fetch(`${base}/api/loops/no-echo/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'deferred' }) });
  assert.equal(r.status, 400);
  let body = await r.json();
  assert.equal(body.error, 'invalid report', 'the fixed, generic message -- never loopRegistry.report()\'s own TypeError text');

  const match = matchRoute('POST', '/api/loops/no-echo/report');
  const realGet = srv.loopRegistry.get;
  srv.loopRegistry.get = () => { throw new Error('boom'); };
  try {
    let sent = null;
    const send = (code, obj) => { sent = { code, obj }; };
    await match.route.handle({ on() {} }, {}, { params: { name: 'no-echo' }, send });
    assert.equal(sent?.code, 500);
    assert.notEqual(sent.obj.error, 'boom', 'the top-level catch never echoes e.message either');
  } finally { srv.loopRegistry.get = realGet; }
});

test('run: a registered everyMs loop answers 202 and actually runs', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  let ran = 0;
  srv.loopRegistry.registerLoop({
    name: 'ticking', trigger: { everyMs: 3_600_000 }, bootDelayMs: 3_600_000,
    maker: async () => { ran += 1; return { outcome: 'done' }; }, checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false },
  });
  const r = await fetch(`${base}/api/loops/ticking/run`, { method: 'POST' });
  assert.equal(r.status, 202);
  // runNow() is fire-and-forget from the route handler; give it a turn.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ran, 1);
});

test('close() stops the registry: a pending loop timer never fires', async () => {
  const localSrv = await startServer({ port: 0, env: mkEnv(), pollMs: 100000, restartFn: () => {} });
  let ran = 0;
  localSrv.loopRegistry.registerLoop({
    name: 'short-fuse', trigger: { everyMs: 50 }, bootDelayMs: 20,
    maker: async () => { ran += 1; return { outcome: 'done' }; }, checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false },
  });
  await localSrv.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ran, 0, 'close() must clear the registry timer before its boot delay elapses');
  assert.equal(localSrv.loopRegistry.get('short-fuse').lastRunTs, null, 'a loop that never ran before close() keeps a null lastRunTs, not a stale one');
});
