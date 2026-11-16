// server/test/wiki-loop.test.js
// D-W5a unit tests with fake deps: no registry, no git, no model.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  wikiLoopDefinition, spawnWikiBuild, evictRejected, readGraphCommit, WIKI_OBLIGATION_KIND, WIKI_OPENED_BY, WIKI_LOOP_NAME, WIKI_LOOP_DEFAULTS,
} from '../lib/observability/wiki-loop.js';
import { wikiPaths, readCurrentWiki } from '../lib/observability/wiki-publish.js';
import { createLoopRegistry } from '../lib/loops/registry.js';
import { graphFingerprint } from '../lib/observability/graph-fingerprint.js';
import { writeFixtureBuild } from './fixtures/wiki-build-fixture.js';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const tmpDirs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function fakeObligations() {
  const rows = new Map(); let n = 0;
  return {
    rows,
    open({ kind, subject, openedBy, dueTs, meta }) {
      for (const r of rows.values()) if (r.kind === kind && r.subject === subject && !r.closedTs) return { id: r.id, created: false };
      const id = `o${++n}`; rows.set(id, { id, kind, subject, openedBy, openedTs: n, dueTs, meta }); return { id, created: true };
    },
    close(id, { closer, closedBy, verifierRef }) {
      const r = rows.get(id);
      if (closer === 'verified.done' && (!verifierRef || closedBy === r.openedBy)) throw new Error('bad verified.done');
      Object.assign(r, { closer, closedBy, verifierRef, closedTs: Date.now() });
    },
    listOpen() { return [...rows.values()].filter(r => !r.closedTs); },
  };
}

function deps(over = {}) {
  const stateDir = tmp('mc-wl-');
  let head = H1;
  let graphFp = 'g1:fixture';
  const d = {
    repoRoot: tmp('mc-wl-root-'), stateDir, webDir: null, cfg: {},
    obligations: fakeObligations(),
    readHead: async () => head,
    readGraph: async () => ({ exists: true, commit: head, fingerprint: graphFp }),
    refreshGraph: async () => {},
    // the build records the graph IT read, as the real builder does
    runBuild: async (o) => writeFixtureBuild(o.buildDir, { headSha: o.headSha, graphFingerprint: graphFp }),
    now: (() => { let t = 10_000; return () => (t += 1000); })(), // every run gets its own build id
    log: () => {},
    setHead: (h) => { head = h; },
    setGraph: (fp) => { graphFp = fp; },
    ...over,
  };
  return d;
}
const ctx = (payload = {}) => ({ name: 'wiki', payload, attempt: 1, signal: new AbortController().signal, countModelCall: () => {} });

test('definition: name, 6h tick, 120 call / 90 min ceiling, sla, checker is not the maker', () => {
  const def = wikiLoopDefinition(deps());
  assert.equal(def.name, WIKI_LOOP_NAME);
  assert.deepEqual(def.trigger, { everyMs: 6 * 3600000 });
  assert.deepEqual(def.ceiling, { maxAttempts: 1, maxModelCalls: 120, timeoutMs: 90 * 60000 });
  assert.deepEqual(def.sla, { maxAgeMs: 36 * 3600000, obligation: false });
  assert.deepEqual(def.backoff, { baseMs: 6 * 3600000, maxMs: 24 * 3600000 });
  assert.notEqual(def.checker, def.maker);
  assert.equal(def.allowOverlap, false);
});

test('defaults: strong model tier, 120 model calls, 90 minute timeout', () => {
  assert.equal(WIKI_LOOP_DEFAULTS.modelTier, 'strong');
  assert.equal(WIKI_LOOP_DEFAULTS.maxModelCalls, 120);
  assert.equal(WIKI_LOOP_DEFAULTS.timeoutMs, 90 * 60000);
});

// A deploy restarts the service, the registry re-registers every loop and
// schedules its first run bootDelayMs later, so each restart runs a wiki build
// (it is a no-op when HEAD equals the published build). That only holds while
// the definition does not override the registry's boot delay.
test('deploy trigger: the definition leaves bootDelayMs to the registry and has an everyMs trigger', () => {
  const def = wikiLoopDefinition(deps());
  assert.equal(def.bootDelayMs, undefined);
  assert.equal(typeof def.trigger.everyMs, 'number');
  assert.ok(def.trigger.everyMs > 0);
});

test('deploy trigger: the registry schedules the wiki loop first run 30 s after registration', () => {
  const pending = [];
  const reg = createLoopRegistry({
    stateDir: tmp('mc-wl-reg-'),
    setTimer: (fn, ms) => { pending.push(ms); return 1; },
    clearTimer: () => {},
  });
  reg.registerLoop(wikiLoopDefinition(deps()));
  assert.deepEqual(pending, [30_000]);
  reg.stop();
});

test('maker: HEAD equal to the published build is nothing-to-do and opens no obligation', async () => {
  const d = deps();
  const def = wikiLoopDefinition(d);
  const r1 = await def.maker(ctx());
  const v = await def.checker(r1.result, ctx());
  await def.onVerified(r1.result, v, ctx());
  const r2 = await def.maker(ctx());
  assert.equal(r2.outcome, 'nothing-to-do');
  assert.deepEqual(r2.fresh, { builtAtCommit: H1, graphFingerprint: 'g1:fixture' });
  assert.equal(d.obligations.listOpen().length, 0);
});

// the maker did no abort check of its own
// at all -- it opened an obligation and spawned a real build child even
// when ctx.signal was already aborted (e.g. close() tore the run down
// before the maker got anywhere). An obligation opened on a store that may
// already be closing, or a build spawned for a run the server already
// decided to abandon, is wasted and can race shutdown.
test('maker: an already-aborted signal is checked before opening an obligation or spawning a build (M3)', async () => {
  const builds = [];
  const d = deps({ runBuild: async (o) => { builds.push(o); return writeFixtureBuild(o.buildDir, { headSha: o.headSha }); } });
  const opens = [];
  const realOpen = d.obligations.open.bind(d.obligations);
  d.obligations.open = (...args) => { opens.push(args); return realOpen(...args); };
  const def = wikiLoopDefinition(d);
  const ac = new AbortController();
  ac.abort(new Error('server shutting down'));
  const abortedCtx = { name: 'wiki', payload: {}, attempt: 1, signal: ac.signal, countModelCall: () => {} };
  await assert.rejects(def.maker(abortedCtx), /server shutting down/);
  assert.equal(opens.length, 0, 'no obligation opened once the run was already aborted');
  assert.equal(builds.length, 0, 'no build spawned once the run was already aborted');
});

test('maker: an abort during refreshGraph is checked before the build spawns (M3)', async () => {
  const builds = [];
  const ac = new AbortController();
  let readGraphCalls = 0;
  const d = deps({
    readGraph: async () => { readGraphCalls += 1; return { exists: true, commit: readGraphCalls === 1 ? 'f'.repeat(40) : H1 }; },
    refreshGraph: async () => { ac.abort(new Error('server shutting down')); },
    runBuild: async (o) => { builds.push(o); return writeFixtureBuild(o.buildDir, { headSha: o.headSha }); },
  });
  const def = wikiLoopDefinition(d);
  const abortableCtx = { name: 'wiki', payload: {}, attempt: 1, signal: ac.signal, countModelCall: () => {} };
  await assert.rejects(def.maker(abortableCtx), /server shutting down/);
  assert.equal(builds.length, 0, 'the build never spawns once the run was aborted mid-refresh');
});

test('maker: a moved HEAD opens wiki.reflects-head for it, builds, and onVerified publishes and closes it', async () => {
  const d = deps();
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  assert.equal(r.outcome, 'done');
  assert.equal(d.obligations.listOpen()[0].kind, WIKI_OBLIGATION_KIND);
  assert.equal(d.obligations.listOpen()[0].subject, H1);
  const v = await def.checker(r.result, ctx());
  assert.equal(v.ok, true);
  assert.equal(v.verifierRef, `wiki-verify@${r.result.buildId}`);
  await def.onVerified(r.result, v, ctx());
  assert.equal(readCurrentWiki(d.stateDir).builtAtCommit, H1);
  assert.equal(d.obligations.listOpen().length, 0);
  const closed = [...d.obligations.rows.values()][0];
  assert.equal(closed.closer, 'verified.done');
  assert.equal(closed.closedBy, 'wiki-verify');
});

// onVerified publishes current.json, THEN closes
// the obligation. If the close itself throws (SQLITE_BUSY, store closed at
// shutdown), current.json already points at HEAD -- every later run on that
// HEAD is nothing-to-do, so without this fix the obligation would stay open
// until the sweeper's 36h SLA escalates a false overdue alert for a build
// that is, in fact, already published and fresh. The next nothing-to-do run
// must get another chance to close it.
test('a close failure after a successful publish leaves the obligation open; the next nothing-to-do run closes it (R-I1)', async () => {
  const d = deps();
  const def = wikiLoopDefinition(d);
  let failClose = true;
  const realClose = d.obligations.close.bind(d.obligations);
  d.obligations.close = (id, args) => {
    if (failClose) { failClose = false; throw new Error('SQLITE_BUSY: database is locked'); }
    return realClose(id, args);
  };
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  await assert.rejects(def.onVerified(r.result, v, ctx()), /published, but obligation close failed: .*SQLITE_BUSY/);
  assert.equal(readCurrentWiki(d.stateDir).builtAtCommit, H1, 'the publish itself succeeded despite the close failure');
  assert.equal(d.obligations.listOpen().length, 1, 'the obligation is still open after the failed close');

  const r2 = await def.maker(ctx());
  assert.equal(r2.outcome, 'nothing-to-do', 'HEAD already matches the published build');
  assert.equal(d.obligations.listOpen().length, 0, 'the nothing-to-do maker gets another chance and closes the stale obligation');
  const closed = [...d.obligations.rows.values()][0];
  assert.equal(closed.closer, 'verified.done');
  assert.equal(closed.closedBy, 'wiki-verify');
  assert.ok(closed.verifierRef, 'closed with the published build\'s own verifierRef');
});

// The companion to R-I1 above: listOpen() itself (not just the per-row
// close()) must be inside the try, so a store that fails to even LIST open
// rows still gets the "published, but" framing instead of an opaque
// "publish:<raw store error>" that loses the fact the publish itself
// already succeeded.
test('a listOpen failure after a successful publish is also reported as "published, but", not a bare publish error (R-I1)', async () => {
  const d = deps();
  const def = wikiLoopDefinition(d);
  d.obligations.listOpen = () => { throw new Error('ENOTCONN: the store handle is closed'); };
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  await assert.rejects(def.onVerified(r.result, v, ctx()), /published, but obligation close failed: .*ENOTCONN/);
  assert.equal(readCurrentWiki(d.stateDir).builtAtCommit, H1, 'the publish itself still succeeded');
});

test('force rebuilds at an unchanged HEAD; fresh asks the builder not to read the cache', async () => {
  const seen = [];
  const d = deps({ runBuild: async (o) => { seen.push(o.readCache); return writeFixtureBuild(o.buildDir, { headSha: o.headSha }); } });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx()); await def.onVerified(r.result, await def.checker(r.result, ctx()), ctx());
  assert.equal((await def.maker(ctx({ force: true }))).outcome, 'done');
  await def.maker(ctx({ force: true, fresh: true }));
  assert.deepEqual(seen, [true, true, false]);
});

test('checker failure: reason names the rule, last-verify is written, nothing is published', async () => {
  const d = deps({ runBuild: async (o) => writeFixtureBuild(o.buildDir, { headSha: o.headSha, stub: true }) });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  assert.equal(v.ok, false);
  assert.match(v.reason, /^sections: structural stub/);
  assert.equal(readCurrentWiki(d.stateDir), null);
  assert.equal(JSON.parse(fs.readFileSync(wikiPaths(d.stateDir).lastVerify, 'utf8')).ok, false);
});

// per-section modelErrors are computed by the
// builder and piped through the protocol all the way to the maker's
// result.summary, but used to be discarded unlogged at this point -- the
// operator only ever saw "sections: structural stub: <slug>", never WHY
// (rate limit? malformed output? a bug in enrichSection's own post-
// processing?) even though the real reason was sitting right there. Fix:
// carry modelErrors into the checker's own failure reason (bounded) and
// the last-verify record.
test('a model error is carried into the checker\'s failure reason (bounded) and last-verify.json, not discarded (S3)', async () => {
  const logs = [];
  const d = deps({
    log: (m) => logs.push(m),
    runBuild: async (o) => ({
      ...(await writeFixtureBuild(o.buildDir, { headSha: o.headSha, stub: true })),
      modelErrors: [{ slug: 'server', error: 'rate limited (429)' }, { slug: 'hooks', error: 'malformed output' }],
    }),
  });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  assert.equal(v.ok, false);
  assert.match(v.reason, /^sections: structural stub/);
  assert.match(v.reason, /modelErrors: server: rate limited \(429\) \(\+1 more\)/, `expected the model error folded into the reason, got: ${v.reason}`);
  const lastVerify = JSON.parse(fs.readFileSync(wikiPaths(d.stateDir).lastVerify, 'utf8'));
  assert.deepEqual(lastVerify.modelErrors, [{ slug: 'server', error: 'rate limited (429)' }, { slug: 'hooks', error: 'malformed output' }]);
  assert.ok(logs.some((m) => /2 section\(s\) hit a model error/.test(m)), `expected modelErrors to be logged like retentionErrors, got: ${JSON.stringify(logs)}`);
});

test('no model errors: last-verify.json still carries an empty modelErrors array, and nothing is logged for it (S3)', async () => {
  const logs = [];
  const d = deps({ log: (m) => logs.push(m) });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  assert.equal(v.ok, true);
  const lastVerify = JSON.parse(fs.readFileSync(wikiPaths(d.stateDir).lastVerify, 'utf8'));
  assert.deepEqual(lastVerify.modelErrors, []);
  assert.ok(!logs.some((m) => /model error/.test(m)));
});

// S2, the surfacing half: the builder's degraded[]
// array (sourceContext/listFiles/head/gitLog catches) reaches the maker's
// result.summary over the line protocol, but used to go nowhere from there
// -- not logged, not in last-verify.json, not reachable from GET /api/wiki.
// Same posture as modelErrors (S3) and retentionErrors: logged when
// non-empty, and always recorded in last-verify.json so a later clean run
// is provably clean too.
test('a builder degrade is carried into last-verify.json and logged, not discarded (S2 surfacing)', async () => {
  const logs = [];
  const d = deps({
    log: (m) => logs.push(m),
    runBuild: async (o) => ({
      ...(await writeFixtureBuild(o.buildDir, { headSha: o.headSha })),
      degraded: [{ site: 'listFiles', detail: o.root, code: null, error: 'not a git repository', expected: true }],
    }),
  });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  assert.equal(v.ok, true, 'a degrade alone does not fail a build that is otherwise narrative and complete');
  const lastVerify = JSON.parse(fs.readFileSync(wikiPaths(d.stateDir).lastVerify, 'utf8'));
  assert.deepEqual(lastVerify.degraded, [{ site: 'listFiles', detail: d.repoRoot, code: null, error: 'not a git repository', expected: true }]);
  assert.ok(logs.some((m) => /1 degrade\(s\) this run: listFiles/.test(m)), `expected a degrade to be logged, got: ${JSON.stringify(logs)}`);
});

test('no degrades: last-verify.json still carries an empty degraded array, and nothing is logged for it', async () => {
  const logs = [];
  const d = deps({ log: (m) => logs.push(m) });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  assert.equal(v.ok, true);
  const lastVerify = JSON.parse(fs.readFileSync(wikiPaths(d.stateDir).lastVerify, 'utf8'));
  assert.deepEqual(lastVerify.degraded, []);
  assert.ok(!logs.some((m) => /degrade/.test(m)));
});

// S4, the production-path half: spawnWikiBuild only
// surfaces the child's stderr tail when the build exits NON-ZERO, so even
// with the CLI's own unconditional stderr warning, a SUCCESSFUL but
// silently-downgraded build (wikiLoop.backend: 'agy' configured, agy not
// ready, falls back to 'gemini' or 'none') would still reach the checker
// with no trace of the downgrade anywhere the loop itself logs. The checker
// compares the build's actual backend against what was configured.
test('checker logs when the build used a different backend than configured (a silent downgrade, S4)', async () => {
  const logs = [];
  const d = deps({
    cfg: { backend: 'agy' },
    log: (m) => logs.push(m),
    runBuild: async (o) => ({ ...(await writeFixtureBuild(o.buildDir, { headSha: o.headSha })), backend: 'none' }),
  });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  assert.equal(v.ok, true, 'a backend downgrade alone does not fail the checker: the build may still be a valid structural-only one');
  assert.ok(logs.some((m) => /requested backend 'agy'.*used 'none'/.test(m)), `expected a downgrade warning, got: ${JSON.stringify(logs)}`);
});

test('checker logs nothing when the build used the configured backend', async () => {
  const logs = [];
  const d = deps({
    cfg: { backend: 'claude' },
    log: (m) => logs.push(m),
    runBuild: async (o) => ({ ...(await writeFixtureBuild(o.buildDir, { headSha: o.headSha })), backend: 'claude' }),
  });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  await def.checker(r.result, ctx());
  assert.ok(!logs.some((m) => /requested backend/.test(m)));
});

test('K4 absent: obligations null is skipped cleanly and logged once', async () => {
  const logs = [];
  const d = deps({ obligations: null, log: (m) => logs.push(m) });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  await def.onVerified(r.result, await def.checker(r.result, ctx()), ctx());
  d.setHead(H2);
  const r2 = await def.maker(ctx());
  await def.onVerified(r2.result, await def.checker(r2.result, ctx()), ctx());
  assert.equal(readCurrentWiki(d.stateDir).builtAtCommit, H2);
  assert.equal(logs.filter(m => /obligations store unavailable/.test(m)).length, 1);
});

test('graph behind HEAD: refreshGraph runs; still behind is failed graph-stale; missing graph is no-graph', async () => {
  let refreshed = 0;
  const d = deps({ readGraph: async () => ({ exists: true, commit: 'f'.repeat(40) }), refreshGraph: async () => { refreshed += 1; } });
  await assert.rejects(wikiLoopDefinition(d).maker(ctx()), /^Error: graph-stale: graph at ffffffff, HEAD 11111111/);
  assert.equal(refreshed, 1);
  const d2 = deps({ readGraph: async () => ({ exists: false, commit: null }) });
  await assert.rejects(wikiLoopDefinition(d2).maker(ctx()), /no-graph/);
});

test('a builder that reports skipped is a failure, not a silent success', async () => {
  const d = deps({ runBuild: async () => ({ skipped: 'no-graph' }) });
  await assert.rejects(wikiLoopDefinition(d).maker(ctx()), /build-skipped: no-graph/);
});

test('graph exists but carries no built_at_commit fails visibly as graph-unversioned, not a silent pass', async () => {
  const d = deps({ readGraph: async () => ({ exists: true, commit: null }) });
  await assert.rejects(wikiLoopDefinition(d).maker(ctx()), /graph-unversioned/);
});

test('HEAD moving during the build is not published: maker rejects head-moved', async () => {
  const d = deps({ runBuild: async (o) => { d.setHead(H2); return writeFixtureBuild(o.buildDir, { headSha: o.headSha }); } });
  const def = wikiLoopDefinition(d);
  await assert.rejects(def.maker(ctx()), /head-moved:/);
  assert.equal(readCurrentWiki(d.stateDir), null);
});

test('wikiLoopDefinition requires runBuild and refreshGraph: missing either is a named error, not a runtime crash inside maker', () => {
  assert.throws(() => wikiLoopDefinition(deps({ runBuild: undefined })), /runBuild is required/);
  assert.throws(() => wikiLoopDefinition(deps({ refreshGraph: undefined })), /refreshGraph is required/);
});

test('maker wires the builder\'s onModelCall through to ctx.countModelCall', async () => {
  let calls = 0;
  const d = deps({ runBuild: async (o) => { o.onModelCall('x'); o.onModelCall('y'); return writeFixtureBuild(o.buildDir, { headSha: o.headSha }); } });
  const def = wikiLoopDefinition(d);
  await def.maker({ name: 'wiki', payload: {}, attempt: 1, signal: new AbortController().signal, countModelCall: () => { calls += 1; } });
  assert.equal(calls, 2);
});

test('checker forwards deps.webDir into verifyWikiBuild: a broken absolute asset link fails only when webDir is set', async () => {
  const webDir = tmp('mc-wl-web-');
  const d = deps({ webDir });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  fs.writeFileSync(path.join(r.result.buildDir, 'server.html'),
    '<article><h1>server</h1><p>ok</p></article><a href="/missing-asset.png">x</a>');
  const v = await def.checker(r.result, ctx());
  assert.equal(v.ok, false);
  assert.match(v.reason, /^links:.*missing-asset\.png/);
});

test('onVerified never closes an obligation opened after this run started (a HEAD that appeared mid-run, not yet built)', async () => {
  const d = deps();
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  d.obligations.rows.set('mid', {
    id: 'mid', kind: WIKI_OBLIGATION_KIND, subject: H2, openedBy: WIKI_OPENED_BY,
    openedTs: r.result.runStartTs + 999999, dueTs: 0, meta: {},
  });
  const v = await def.checker(r.result, ctx());
  await def.onVerified(r.result, v, ctx());
  const stillOpen = d.obligations.listOpen();
  assert.equal(stillOpen.length, 1);
  assert.equal(stillOpen[0].id, 'mid');
});

test('a retention error after a successful publish is logged, reported in the result, and reaches onRetention', async () => {
  const logs = [];
  const retentionCalls = [];
  const d = deps({ log: (m) => logs.push(m), rm: () => { throw new Error('EBUSY: file open'); },
    onRetention: (errors) => retentionCalls.push(errors) });
  const p = wikiPaths(d.stateDir);
  fs.mkdirSync(p.builds, { recursive: true });
  for (let i = 1; i <= 3; i++) {
    const dir = path.join(p.builds, `${'a'.repeat(12)}-${i * 1000}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  }
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  await def.onVerified(r.result, v, ctx()); // must not throw
  assert.equal(readCurrentWiki(d.stateDir).builtAtCommit, H1);
  assert.ok(r.result.publishRetentionErrors?.length >= 1);
  assert.ok(logs.some((m) => /old build\(s\) not removed/.test(m)));
  // A caller (server.js) needs a structured signal, not a log-message parse,
  // to know when a retention problem is resolved: the LAST call is the
  // publish-time (onVerified) prune, and it must carry the same errors.
  assert.ok(retentionCalls.length >= 2, `expected a call from the pre-build prune and the publish prune, got ${retentionCalls.length}`);
  assert.deepEqual(retentionCalls.at(-1), r.result.publishRetentionErrors);
});

test('a clean run (nothing to prune) calls onRetention with an empty array, both before the build and after publish', async () => {
  const retentionCalls = [];
  const d = deps({ onRetention: (errors) => retentionCalls.push(errors) });
  const def = wikiLoopDefinition(d);
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  await def.onVerified(r.result, v, ctx());
  assert.ok(retentionCalls.length >= 2);
  for (const errors of retentionCalls) assert.deepEqual(errors, []);
});

test('onRetention defaults to a no-op: a retention error still logs and reports, but does not throw for lacking the dep', async () => {
  const d = deps({ rm: () => { throw new Error('EBUSY'); } });
  const p = wikiPaths(d.stateDir);
  fs.mkdirSync(p.builds, { recursive: true });
  for (let i = 1; i <= 3; i++) {
    const dir = path.join(p.builds, `${'a'.repeat(12)}-${i * 1000}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  }
  const def = wikiLoopDefinition(d); // no onRetention override
  const r = await def.maker(ctx());
  const v = await def.checker(r.result, ctx());
  await def.onVerified(r.result, v, ctx()); // must not throw
  assert.ok(r.result.publishRetentionErrors?.length >= 1);
});

// Review Focus 2 ("a section the checker rejects
// comes back from the cache forever") was only half-pinned -- the standalone
// evictRejected() unit above proves the FUNCTION works, but nothing proved
// the MAKER actually calls it before the build runs. This is a maker-level
// test: a rejected cache entry must be gone by the time runBuild reads the
// cache file, not just eventually removable by the function in isolation.
test('maker calls evictRejected before the build runs: a rejected cache entry is gone by the time runBuild reads it (R-M3)', async () => {
  let seenCache = null;
  const d = deps({
    runBuild: async (o) => { seenCache = JSON.parse(fs.readFileSync(o.cacheFile, 'utf8')); return writeFixtureBuild(o.buildDir, { headSha: o.headSha }); },
  });
  const p = wikiPaths(d.stateDir);
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.cache, JSON.stringify({ 'h-rejected': { llm: true, proseMd: 'stale' }, 'h-kept': { llm: true, proseMd: 'fine' } }));
  fs.writeFileSync(p.lastVerify, JSON.stringify({ ok: false, offending: [{ slug: 'rejected-slug', contentHash: 'h-rejected' }] }));
  const def = wikiLoopDefinition(d);
  await def.maker(ctx());
  assert.ok(seenCache, 'runBuild actually ran and read the cache file');
  assert.deepEqual(Object.keys(seenCache), ['h-kept'], 'the rejected entry is gone before the build sees the cache; the kept entry survives');
});

test('evictRejected removes exactly the rejected sections\' cache entries', () => {
  const dir = tmp('mc-wl-ev-');
  const cacheFile = path.join(dir, 'cache.json');
  const lastVerifyFile = path.join(dir, 'last-verify.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ 'h-a': { llm: true }, 'h-b': { llm: true } }));
  fs.writeFileSync(lastVerifyFile, JSON.stringify({ ok: false, offending: [{ slug: 'a', contentHash: 'h-a' }] }));
  assert.equal(evictRejected({ cacheFile, lastVerifyFile }), 1);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))), ['h-b']);
  fs.writeFileSync(lastVerifyFile, JSON.stringify({ ok: true, offending: [] }));
  assert.equal(evictRejected({ cacheFile, lastVerifyFile }), 0);
  assert.equal(evictRejected({ cacheFile: path.join(dir, 'none.json'), lastVerifyFile: path.join(dir, 'none2.json') }), 0);
});

function fakeCli() {
  const file = path.join(tmp('mc-wl-cli-'), 'fake-cli.mjs');
  fs.writeFileSync(file, [
    "const mode = process.env.FAKE_MODE;",
    "for (let i = 1; i <= 3; i++) process.stdout.write(`WIKI_MODEL_CALL ${i} s${i}\\n`);",
    "if (mode === 'fail') { process.stderr.write('wiki: build failed: boom\\n'); process.exit(1); }",
    "if (mode === 'hang') setTimeout(() => {}, 60000);",
    "else process.stdout.write('WIKI_RESULT ' + JSON.stringify({ sections: 3, llmSections: 3, modelCalls: 3, builtAtCommit: 'abc' }) + '\\n');",
  ].join('\n'));
  return file;
}
const withMode = (mode) => (cmd, args, opts) => spawn(cmd, args, { ...opts, env: { ...process.env, FAKE_MODE: mode } });
const base = (over) => ({ cliPath: fakeCli(), root: os.tmpdir(), buildDir: tmp('mc-wl-b-'), cacheFile: 'c.json', headSha: 'abc', backend: 'claude', model: 'haiku', ...over });

test('spawnWikiBuild: reports each model call and resolves the WIKI_RESULT summary', async () => {
  const calls = [];
  const s = await spawnWikiBuild(base({ spawnImpl: withMode('ok'), onModelCall: (l) => calls.push(l) }));
  assert.deepEqual(calls, ['1 s1', '2 s2', '3 s3']);
  assert.equal(s.sections, 3);
});

test('spawnWikiBuild: a ceiling error from onModelCall kills the child and rejects with that error', async () => {
  let killed = 0;
  class CeilingError extends Error {}
  await assert.rejects(spawnWikiBuild(base({ spawnImpl: withMode('hang'),
    onModelCall: (l) => { if (l.startsWith('3 ')) throw new CeilingError('ceiling:model-calls'); },
    killTree: (c) => { killed += 1; c.kill(); } })), (e) => e instanceof CeilingError);
  assert.equal(killed, 1);
});

test('spawnWikiBuild: a non-zero exit rejects with the stderr reason', async () => {
  await assert.rejects(spawnWikiBuild(base({ spawnImpl: withMode('fail') })), /wiki build exited 1: wiki: build failed: boom/);
});

test('spawnWikiBuild: abort (the registry timeout) kills the child and rejects', async () => {
  const ac = new AbortController();
  let killed = 0;
  const p = spawnWikiBuild(base({ spawnImpl: withMode('hang'), signal: ac.signal, killTree: (c) => { killed += 1; c.kill(); },
    onModelCall: (l) => { if (l.startsWith('1 ')) ac.abort(new Error('timeout')); } }));
  await assert.rejects(p, /timeout/);
  assert.equal(killed, 1);
});

// defaultKillTree's failure path used to be
// console-only -- a genuine taskkill/SIGKILL failure left the child process
// (and the registry's own run) with no trace that the kill may not have
// actually worked, only a line in a log file nobody watches. Fold it into
// the rejection's own message so it reaches lastReason, not just the console.
test('spawnWikiBuild: a kill failure is folded into the rejection message, not just console-logged (S6)', async () => {
  const p = spawnWikiBuild(base({
    spawnImpl: withMode('hang'),
    killTree: (c) => { c.kill(); return 'taskkill /T exited 1 for pid 999'; },
    onModelCall: (l) => { if (l.startsWith('1 ')) throw new Error('ceiling:model-calls'); },
  }));
  await assert.rejects(p, /ceiling:model-calls \(and the build process may still be running: taskkill \/T exited 1 for pid 999\)/);
});

// the registry's own timeout path calls
// ac.abort() with NO reason (registry.js); signal.reason then defaults to a
// DOMException (instanceof Error, so onAbort's ternary passes it straight
// to fail() unchanged). If killTree also fails, the S6 fix's `err.message
// += ...` tries to SET a getter-only property (DOMException.message has no
// setter) -- in this ESM (always-strict) module that throws a TypeError
// INSIDE the abort listener: uncaught, would crash the server, and the
// promise never settles. The existing S6 test never hit this because it
// aborts via a plain `new Error('timeout')`, not a reasonless abort().
test('spawnWikiBuild: a reasonless abort() (DOMException reason) plus a failing killTree rejects cleanly, never an uncaught exception (C1)', async () => {
  const ac = new AbortController();
  const p = spawnWikiBuild(base({
    spawnImpl: withMode('hang'), signal: ac.signal,
    killTree: (c) => { c.kill(); return 'taskkill /T exited 1 for pid 999'; },
    onModelCall: (l) => { if (l.startsWith('1 ')) ac.abort(); }, // no reason: signal.reason becomes a DOMException
  }));
  await assert.rejects(p, (e) => e instanceof Error && /taskkill \/T exited 1 for pid 999/.test(e.message));
});

// spawnImpl ran BEFORE the signal.aborted
// check -- a run already aborted when spawnWikiBuild is called (e.g.
// close() tore the whole wiki loop run down between the maker's own
// checkNotAborted(ctx) call and the runBuild call that reaches here) still
// spawned a real child, only to kill it immediately afterward.
test('spawnWikiBuild: a pre-aborted signal never spawns a child at all (N5)', async () => {
  const ac = new AbortController();
  ac.abort(new Error('server shutting down'));
  let spawnCalled = false;
  const p = spawnWikiBuild(base({
    signal: ac.signal,
    spawnImpl: (...args) => { spawnCalled = true; return withMode('hang')(...args); },
  }));
  await assert.rejects(p, /server shutting down/);
  assert.equal(spawnCalled, false, 'a pre-aborted signal must never spawn a child at all');
});

test('spawnWikiBuild: passes --no-cache-read when readCache is false, --prior when given', async () => {
  let seenArgs;
  await spawnWikiBuild(base({ readCache: false, priorDir: '/p', spawnImpl: (cmd, args, opts) => { seenArgs = args; return withMode('ok')(cmd, args, opts); } }));
  assert.ok(seenArgs.includes('--no-cache-read'));
  assert.equal(seenArgs[seenArgs.indexOf('--prior') + 1], '/p');
  assert.equal(seenArgs[seenArgs.indexOf('--max-model-calls') + 1], 'auto');
  assert.equal(seenArgs[seenArgs.indexOf('--expect-head') + 1], 'abc');
});

test('spawnWikiBuild: passes --state-dir only when given, and always --max-model-calls auto', async () => {
  const seen = [];
  const spy = (cmd, args, opts) => { seen.push(args); return withMode('ok')(cmd, args, opts); };
  await spawnWikiBuild(base({ spawnImpl: spy, stateDir: 'D:/state' }));
  await spawnWikiBuild(base({ spawnImpl: spy }));
  const [withState, without] = seen;
  assert.equal(withState[withState.indexOf('--state-dir') + 1], 'D:/state');
  assert.ok(!without.includes('--state-dir'));
  for (const a of seen) assert.equal(a[a.indexOf('--max-model-calls') + 1], 'auto');
});

// Spec 2026-10-28-wiki-graph-freshness (glmps-2.0 corpus): freshness is the
// same commit AND the same graph; drift adds no trigger of its own.
async function publishOnce(def) {
  const r = await def.maker(ctx());
  await def.onVerified(r.result, await def.checker(r.result, ctx()), ctx());
  return r;
}

test('graph drift: same HEAD, changed graph rebuilds and opens wiki.reflects-head with reason graph-drift', async () => {
  const builds = [];
  const d = deps();
  const inner = d.runBuild;
  d.runBuild = async (o) => { builds.push(o.headSha); return inner(o); };
  const def = wikiLoopDefinition(d);
  await publishOnce(def);
  assert.equal(readCurrentWiki(d.stateDir).graphFingerprint, 'g1:fixture');
  d.setGraph('g1:rebuilt');
  const r = await def.maker(ctx());
  assert.equal(r.outcome, 'done');
  assert.equal(builds.length, 2);
  const [row] = d.obligations.listOpen();
  assert.equal(row.subject, H1, 'same kind and subject as a commit rebuild (D4)');
  assert.deepEqual(row.meta, { previous: H1, reason: 'graph-drift', builtFromGraph: 'g1:fixture', currentGraph: 'g1:rebuilt' });
  await def.onVerified(r.result, await def.checker(r.result, ctx()), ctx());
  assert.equal(readCurrentWiki(d.stateDir).graphFingerprint, 'g1:rebuilt');
  assert.equal(d.obligations.listOpen().length, 0);
  assert.equal((await def.maker(ctx())).outcome, 'nothing-to-do');
  assert.equal(builds.length, 2);
});

test('graph unchanged: same HEAD, same graph is nothing-to-do with zero builds', async () => {
  let builds = 0;
  const d = deps();
  const inner = d.runBuild;
  d.runBuild = async (o) => { builds += 1; return inner(o); };
  const def = wikiLoopDefinition(d);
  await publishOnce(def);
  const r = await def.maker(ctx());
  assert.equal(r.outcome, 'nothing-to-do');
  assert.deepEqual(r.fresh, { builtAtCommit: H1, graphFingerprint: 'g1:fixture' });
  assert.equal(builds, 1);
});

test('a legacy published build with no recorded fingerprint rebuilds once (graph-unrecorded), then is nothing-to-do', async () => {
  const d = deps();
  const def = wikiLoopDefinition(d);
  await publishOnce(def);
  const p = wikiPaths(d.stateDir);
  const cur = JSON.parse(fs.readFileSync(p.current, 'utf8'));
  delete cur.graphFingerprint;
  fs.writeFileSync(p.current, JSON.stringify(cur));
  const r = await def.maker(ctx());
  assert.equal(r.outcome, 'done');
  assert.equal(d.obligations.listOpen()[0].meta.reason, 'graph-unrecorded');
  await def.onVerified(r.result, await def.checker(r.result, ctx()), ctx());
  assert.equal((await def.maker(ctx())).outcome, 'nothing-to-do');
});

test('a graph with no built_at_commit still fails graph-unversioned at an unchanged HEAD, and never builds blind', async () => {
  let builds = 0;
  const d = deps();
  const inner = d.runBuild;
  d.runBuild = async (o) => { builds += 1; return inner(o); };
  const def = wikiLoopDefinition(d);
  await publishOnce(def);
  d.readGraph = async () => ({ exists: true, commit: null, fingerprint: 'g1:other' });
  await assert.rejects(wikiLoopDefinition(d).maker(ctx()), /graph-unversioned/);
  assert.equal(builds, 1);
});

test('a missing graph at an unchanged HEAD fails no-graph instead of a silent nothing-to-do (D5)', async () => {
  const d = deps();
  const def = wikiLoopDefinition(d);
  await publishOnce(def);
  d.readGraph = async () => ({ exists: false, commit: null, fingerprint: null });
  await assert.rejects(wikiLoopDefinition(d).maker(ctx()), /no-graph/);
});

test('published current.json carries the fingerprint the build read, not the one the loop saw before spawning', async () => {
  const d = deps();
  d.runBuild = async (o) => writeFixtureBuild(o.buildDir, { headSha: o.headSha, graphFingerprint: 'g1:moved-mid-build' });
  const def = wikiLoopDefinition(d);
  await publishOnce(def);
  assert.equal(readCurrentWiki(d.stateDir).graphFingerprint, 'g1:moved-mid-build');
  const r = await def.maker(ctx());
  assert.equal(r.outcome, 'done', 'the next tick sees the drift between what was built and the graph now');
  assert.equal(d.obligations.listOpen()[0].meta.reason, 'graph-drift');
});

test('readGraphCommit returns the commit and the fingerprint from one read', async () => {
  const root = tmp('mc-wl-g-');
  assert.deepEqual(await readGraphCommit(root), { exists: false, commit: null, fingerprint: null });
  fs.mkdirSync(path.join(root, 'graphify-out'));
  const g = { built_at_commit: H1, nodes: [{ id: 'a', label: 'A', source_file: 'a.js' }], links: [] };
  fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(g));
  assert.deepEqual(await readGraphCommit(root), { exists: true, commit: H1, fingerprint: graphFingerprint(g) });
});

test('a moved HEAD still opens its obligation when the graph is missing, unversioned or corrupt, then fails by name', async () => {
  for (const [readGraph, re] of [
    [async () => ({ exists: false, commit: null, fingerprint: null }), /no-graph/],
    [async () => ({ exists: true, commit: null, fingerprint: 'g1:x' }), /graph-unversioned/],
    [async () => { throw new SyntaxError('Unexpected end of JSON input'); }, /Unexpected end of JSON/],
  ]) {
    const d = deps({ readGraph });
    await assert.rejects(wikiLoopDefinition(d).maker(ctx()), re);
    const [row] = d.obligations.listOpen();
    assert.equal(row?.subject, H1);
    assert.deepEqual(row.meta, { previous: null });
  }
});
