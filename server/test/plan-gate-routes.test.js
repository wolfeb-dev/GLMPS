// Routes under test: server/lib/routes/guards-routes.js
// server/test/plan-gate-routes.test.js
// the HTTP side of the chain and the guard-refusal feed. cardChain()
// itself is unit-tested in card-chain.test.js; this covers the routes that
// wire it (and the refusal report) into the running server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { declarePlan } from '../lib/scut/progress-store.js';
import { matchRoute } from '../lib/observability/route-registry.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-state-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: path.join(stateDir, 'claude'), GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); const body = await r.json().catch(() => null); return { status: r.status, body }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const postRaw = (p, raw) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  const get = (p) => j(p);
  try {
    await fn({ post, postRaw, get, stateDir });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('GET /api/backlog/:id/chain returns the intent/plan/taskClass chain', async () => {
  await withServer(async ({ post, get, stateDir }) => {
    const created = await post('/api/backlog', { title: 'Fix the broken wiki build', prompt: 'Fix the broken wiki build' });
    const id = created.body.id;

    const before = await get(`/api/backlog/${id}/chain`);
    assert.equal(before.status, 200);
    assert.equal(before.body.id, id);
    assert.equal(before.body.plan, null);

    declarePlan(stateDir, id, 'docs/superpowers/plans/p.md');
    const after = await get(`/api/backlog/${id}/chain`);
    assert.equal(after.body.plan, 'docs/superpowers/plans/p.md');
  });
});

test('GET /api/backlog/:id/chain 404s for an item that does not exist', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/api/backlog/no-such-card/chain');
    assert.equal(res.status, 404);
  });
});

test('POST /api/guards/refusal records a refusal, visible in GET /api/guards/refusals', async () => {
  await withServer(async ({ post, get }) => {
    const posted = await post('/api/guards/refusal', { hook: 'plan-gate', cardId: 'mc-1', tool: 'Edit', path: 'server/x.js', reason: 'no plan declared' });
    assert.equal(posted.status, 204);

    const listed = await get('/api/guards/refusals');
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.body.recent));
    assert.ok(listed.body.recent.some((r) => r.hook === 'plan-gate' && r.reason === 'no plan declared'));
  });
});

test('POST /api/guards/refusal rejects an unrecognized hook name', async () => {
  await withServer(async ({ post }) => {
    const res = await post('/api/guards/refusal', { hook: 'not-a-real-hook', reason: 'x' });
    assert.equal(res.status, 400);
  });
});

// JSON.parse('null') -> null, and reading
// b.hook off it threw inside the async route handler. matchRoute's dispatcher
// never awaits the handler (server.js:2938-2945's own documented reasoning),
// so that unhandled rejection had no catch anywhere and crashed the process.
// Reproduced by the reviewer. Every one of these must be a clean 4xx, and the
// server must still answer the very next request.
test('C1: a null/array/non-object/oversized body never crashes the server', async () => {
  await withServer(async ({ postRaw, post, get }) => {
    const r1 = await postRaw('/api/guards/refusal', 'null');
    assert.ok(r1.status >= 400 && r1.status < 500, `null body: expected 4xx, got ${r1.status}`);

    const r2 = await post('/api/guards/refusal', ['plan-gate', 'x']);
    assert.ok(r2.status >= 400 && r2.status < 500, `array body: expected 4xx, got ${r2.status}`);

    const r3 = await postRaw('/api/guards/refusal', '"just a string"');
    assert.ok(r3.status >= 400 && r3.status < 500, `non-object body: expected 4xx, got ${r3.status}`);

    const r4 = await post('/api/guards/refusal', { hook: 'plan-gate', reason: 'x'.repeat(2001) });
    assert.ok(r4.status >= 400 && r4.status < 500, `oversized field: expected 4xx, got ${r4.status}`);

    // A real over-cap upload gets its socket torn down mid-stream (readBody's
    // own destroy()) before a response can flush, which a real fetch() sees
    // as a network error rather than a clean 413 - the same reason
    // loop-routes.test.js's own over-cap test drives the handler directly
    // with a fake req instead of a real loopback upload. Mirror that here.
    const match = matchRoute('POST', '/api/guards/refusal');
    assert.ok(match, 'the guards/refusal route is registered');
    const big = Buffer.alloc(16 * 1024 + 1, 'a');
    const fakeReq = { on(event, cb) { if (event === 'data') cb(big); }, destroy() {} };
    let sent = null;
    await match.route.handle(fakeReq, {}, { send: (code, obj) => { sent = { code, obj }; } });
    assert.equal(sent?.code, 413, 'a body over the 16 KB cap must be 413, not a generic 400');

    // The server must still be alive and answering after all five.
    const health = await get('/api/backlog/no-such-card/chain');
    assert.equal(health.status, 404);
  });
});

test('POST /api/guards/refusal accepts a well-formed body with a failOpen flag, visible in recent', async () => {
  await withServer(async ({ post, get }) => {
    const posted = await post('/api/guards/refusal', { hook: 'plan-gate', cardId: 'mc-1', tool: 'Edit', path: 'a.js', reason: 'board unreachable', failOpen: true });
    assert.equal(posted.status, 204);
    const listed = await get('/api/guards/refusals');
    const entry = listed.body.recent.find((r) => r.reason === 'board unreachable');
    assert.ok(entry, 'expected the fail-open report to be recorded');
    assert.equal(entry.failOpen, true, 'M3: a fail-open report must be marked, not indistinguishable from a real refusal');
  });
});

test('GET /api/guards/refusals reports the byHook rate from the hook-written counters file', async () => {
  await withServer(async ({ get, stateDir }) => {
    fs.mkdirSync(path.join(stateDir, 'guards'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'guards', 'counters.json'), JSON.stringify({ 'plan-gate': { checks: 4, refusals: 1 } }));
    const res = await get('/api/guards/refusals');
    assert.equal(res.status, 200);
    assert.equal(res.body.byHook['plan-gate'].checks, 4);
    assert.equal(res.body.byHook['plan-gate'].refusals, 1);
    assert.equal(res.body.byHook['plan-gate'].rate, 0.25);
  });
});

// Phase K final review (silent-failure): the counters.json read swallowed
// every error, and a valid-JSON but wrong-shape file (`null`) reached
// Object.entries(null) and 500'd the whole route. A missing file is still
// empty counts; anything else is named in the body and logged.
test('silent-failure: a wrong-shape counters.json never 500s the refusals route, and the problem is named', async () => {
  await withServer(async ({ get, stateDir }) => {
    fs.mkdirSync(path.join(stateDir, 'guards'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'guards', 'counters.json'), 'null');
    const res = await get('/api/guards/refusals');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.byHook, {});
    assert.match(res.body.countersError, /not an object/);
    fs.writeFileSync(path.join(stateDir, 'guards', 'counters.json'), JSON.stringify({ 'plan-gate': null, 'test-file-guard': { checks: 2, refusals: 1 } }));
    const res2 = await get('/api/guards/refusals');
    assert.equal(res2.status, 200);
    assert.deepEqual(Object.keys(res2.body.byHook), ['test-file-guard'], 'a malformed entry is skipped, the rest still shown');
    fs.writeFileSync(path.join(stateDir, 'guards', 'counters.json'), '{ torn');
    const res3 = await get('/api/guards/refusals');
    assert.equal(res3.status, 200);
    assert.match(res3.body.countersError, /unreadable or corrupt/);
  });
});

test('silent-failure: an unreadable refusals log is named in the route body, not shown as an empty list', async () => {
  await withServer(async ({ get, stateDir }) => {
    fs.mkdirSync(path.join(stateDir, 'guards', 'refusals.ndjson'), { recursive: true }); // a directory: EISDIR on read
    const res = await get('/api/guards/refusals');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.recent, []);
    assert.match(res.body.recentError, /EISDIR|unreadable/);
  });
});
