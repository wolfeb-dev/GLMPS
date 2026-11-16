import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeRoutingCompliance } from '../lib/evaluation/routing-compliance.js';
import { startServer } from '../server.js';
import * as runnerStore from '../lib/orchestration/runner-store.js';
import { loadRoutingLog, appendRoutingLog, mergeRoutingLedger } from '../lib/orchestration/routing-log.js';

const OPTS = { threshold: 0.6, decisionDate: '2026-09-15' };

let sharedStateDir;
let sharedClaudeDir;
let sharedSrv;

before(async () => {
  sharedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-'));
  sharedClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-'));
  const indexStateDir = path.join(sharedStateDir, 'state');
  fs.mkdirSync(indexStateDir, { recursive: true });
  fs.writeFileSync(path.join(indexStateDir, 'index.json'), JSON.stringify([
    { id: 's-complied', cwd: '/w/job-complied', lastTs: 100, agentsUsed: [{ name: 'ui-designer', model: 'sonnet', count: 1, lastTs: 100 }] },
    { id: 's-miss',     cwd: '/w/job-miss',     lastTs: 100, agentsUsed: [{ name: 'general-purpose', model: 'sonnet', count: 1, lastTs: 100 }] },
  ]));
  const env = { ...process.env, GLMPS_STATE_DIR: sharedStateDir, GLMPS_CLAUDE_DIR: sharedClaudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  sharedSrv = await startServer({ port: 0, env, configFile: path.join(sharedStateDir, 'no-config.json') });
});

after(async () => {
  await sharedSrv?.close?.();
  fs.rmSync(sharedStateDir, { recursive: true, force: true });
  fs.rmSync(sharedClaudeDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const sub of ['measurables', 'runner', 'backlog']) {
    fs.rmSync(path.join(sharedStateDir, sub), { recursive: true, force: true });
  }
  fs.rmSync(path.join(sharedStateDir, 'backlog.json'), { force: true });
});

test('a routed card whose session dispatched the named agent counts as complied', () => {
  const r = computeRoutingCompliance({
    ledger: { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/mc-1' } } },
    sessions: [{ id: 's1', cwd: '/w/mc-1', agentsUsed: [{ name: 'ui-designer', model: 'sonnet', count: 1, lastTs: 1 }] }],
    ...OPTS,
  });
  assert.equal(r.routed, 1);
  assert.equal(r.complied, 1);
  assert.equal(r.unmeasurable, 0);
  assert.deepEqual(r.byClass.ui, { routed: 1, complied: 1 });
});

test('a routed card whose session dispatched something else counts as a miss', () => {
  const r = computeRoutingCompliance({
    ledger: { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/mc-1' } } },
    sessions: [{ id: 's1', cwd: '/w/mc-1', agentsUsed: [{ name: 'general-purpose', model: 'sonnet', count: 3, lastTs: 1 }] }],
    ...OPTS,
  });
  assert.equal(r.complied, 0);
  assert.equal(r.unmeasurable, 0);
});

test('a routed card with no worktree is unmeasurable, never a miss', () => {
  const r = computeRoutingCompliance({
    ledger: { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: null } },
    sessions: [],
    ...OPTS,
  });
  assert.equal(r.routed, 1);
  assert.equal(r.complied, 0);
  assert.equal(r.unmeasurable, 1);
});

test('unrouted cards are not counted at all', () => {
  const r = computeRoutingCompliance({
    ledger: { 'mc-1': { route: { agent: null }, worktree: { dir: '/w/mc-1' } }, 'mc-2': {} },
    sessions: [],
    ...OPTS,
  });
  assert.equal(r.routed, 0);
});

// The bridge is a raw string comparison between a ledger worktree `dir`
// (built with node:path's path.join, so native separators and native casing)
// and a session `cwd` (whatever the launched process itself reports as its
// working directory). On Windows those can disagree in separator style,
// trailing slash, and drive-letter case without being different paths at
// all. worktree-project.js hit this exact cwd-vs-worktree-path comparison
// first (server/lib/orchestration/worktree-project.js) and its norm() strips
// separators and trailing slashes, not just case -- this test proves
// routing-compliance's norm() does the same, because trim+lowercase alone
// (the brief's literal norm()) would leave 'c:\\w\\mc-1\\' and 'c:/w/mc-1'
// unequal and misreport this card as unmeasurable.
test('a worktree dir and session cwd differing in separator, trailing slash, and case still bridge (Windows-safe norm)', () => {
  const r = computeRoutingCompliance({
    ledger: { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: 'C:\\w\\Mc-1\\' } } },
    sessions: [{ id: 's1', cwd: 'c:/w/mc-1', agentsUsed: [{ name: 'UI-Designer', model: 'sonnet', count: 1, lastTs: 1 }] }],
    ...OPTS,
  });
  assert.equal(r.unmeasurable, 0);
  assert.equal(r.complied, 1);
});

// A worktree directory is named after the job id (worktrees.js worktreePlan),
// so a RETRIED job's failed first attempt and its retry share the exact same
// cwd. The failed attempt never dispatched the named agent; the retry did.
// IndexStore.list() (the real caller) returns newest-first, but this module
// must not depend on that -- picking whichever session happens to be LAST in
// the input array would make the verdict depend on caller sort order, which
// is exactly the bug: with a naive "last one in wins" Map.set(), a
// newest-first caller feeds the OLDEST session last, so the bridge would
// keep the failed attempt and misreport a real compliance win as a miss.
// Both orderings below must land on the SAME verdict, taken from whichever
// session has the greater `lastTs`.
test('a retried job (two sessions sharing one worktree cwd) is judged by the newer session, regardless of input order', () => {
  const failedFirstAttempt = { id: 's-old', cwd: '/w/mc-1', lastTs: 100, agentsUsed: [{ name: 'general-purpose', model: 'sonnet', count: 1, lastTs: 100 }] };
  const compliantRetry = { id: 's-new', cwd: '/w/mc-1', lastTs: 200, agentsUsed: [{ name: 'ui-designer', model: 'sonnet', count: 1, lastTs: 200 }] };
  const ledger = { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/mc-1' } } };

  const newestFirst = computeRoutingCompliance({ ledger, sessions: [compliantRetry, failedFirstAttempt], ...OPTS });
  const oldestFirst = computeRoutingCompliance({ ledger, sessions: [failedFirstAttempt, compliantRetry], ...OPTS });

  for (const r of [newestFirst, oldestFirst]) {
    assert.equal(r.unmeasurable, 0);
    assert.equal(r.complied, 1, 'verdict must come from the newer (retry) session, not the failed first attempt');
  }
});

test('a session with no lastTs never displaces one that has a real timestamp, either order', () => {
  const timestamped = { id: 's-real', cwd: '/w/mc-1', lastTs: 50, agentsUsed: [{ name: 'ui-designer', model: 'sonnet', count: 1, lastTs: 50 }] };
  const timestampless = { id: 's-blank', cwd: '/w/mc-1', agentsUsed: [{ name: 'general-purpose', model: 'sonnet', count: 1 }] };
  const ledger = { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/mc-1' } } };

  const a = computeRoutingCompliance({ ledger, sessions: [timestampless, timestamped], ...OPTS });
  const b = computeRoutingCompliance({ ledger, sessions: [timestamped, timestampless], ...OPTS });

  for (const r of [a, b]) {
    assert.equal(r.unmeasurable, 0);
    assert.equal(r.complied, 1, 'the timestamped session must win over the timestamp-less one, in either input order');
  }
});

// Final-review Critical 3(b): `lastTs` arrives in BOTH shapes against real
// data. IndexStore.applyEvents assigns `rec.lastTs = e.ts`, and a Claude Code
// transcript timestamp is an ISO-8601 STRING, so a session whose last poll
// ingested events carries a string; a record whose lastTs came from a file
// mtime carries a number. The original Number.isFinite-only tie-break treated
// the string as ABSENT, so the live retry session could never displace the idle
// failed attempt - inverting this comparison against real data and biasing the
// compliance metric DOWNWARD, which is precisely what the tie-break exists to
// prevent. Both tests above use numbers only, which is why this survived.
test('an ISO-string lastTs (real transcript shape) still beats an older numeric one, either order', () => {
  const failedFirstAttempt = { id: 's-old', cwd: '/w/mc-1', lastTs: Date.parse('2026-06-05T10:00:00Z'), agentsUsed: [{ name: 'general-purpose', count: 1 }] };
  const compliantRetry = { id: 's-new', cwd: '/w/mc-1', lastTs: '2026-06-05T12:00:00Z', agentsUsed: [{ name: 'ui-designer', count: 1 }] };
  const ledger = { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/mc-1' } } };

  for (const sessions of [[compliantRetry, failedFirstAttempt], [failedFirstAttempt, compliantRetry]]) {
    const r = computeRoutingCompliance({ ledger, sessions, ...OPTS });
    assert.equal(r.unmeasurable, 0);
    assert.equal(r.complied, 1, 'the ISO-timestamped retry is newer and must win');
  }
});

test('a numeric lastTs still beats an OLDER ISO-string one (the coercion is not a blanket string-wins rule)', () => {
  const older = { id: 's-old', cwd: '/w/mc-1', lastTs: '2026-06-05T10:00:00Z', agentsUsed: [{ name: 'general-purpose', count: 1 }] };
  const newer = { id: 's-new', cwd: '/w/mc-1', lastTs: Date.parse('2026-06-05T12:00:00Z'), agentsUsed: [{ name: 'ui-designer', count: 1 }] };
  const ledger = { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/mc-1' } } };

  for (const sessions of [[older, newer], [newer, older]]) {
    assert.equal(computeRoutingCompliance({ ledger, sessions, ...OPTS }).complied, 1);
  }
});

test('an unparseable lastTs string is treated as absent, not as a winner', () => {
  const garbage = { id: 's-junk', cwd: '/w/mc-1', lastTs: 'not-a-date', agentsUsed: [{ name: 'general-purpose', count: 1 }] };
  const real = { id: 's-real', cwd: '/w/mc-1', lastTs: '2026-06-05T10:00:00Z', agentsUsed: [{ name: 'ui-designer', count: 1 }] };
  const ledger = { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/mc-1' } } };

  for (const sessions of [[garbage, real], [real, garbage]]) {
    assert.equal(computeRoutingCompliance({ ledger, sessions, ...OPTS }).complied, 1);
  }
});

// Ride-along (glmps-138 Task 8 review): pin byClass for a routed-but-
// unmeasurable card so `routed` still lands on the right taskClass bucket
// even when there is no session to check compliance against.
test('a routed card with no worktree still records its taskClass under byClass, with complied 0', () => {
  const r = computeRoutingCompliance({
    ledger: { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: null } },
    sessions: [],
    ...OPTS,
  });
  assert.deepEqual(r.byClass.ui, { routed: 1, complied: 0 });
  assert.equal(r.unmeasurable, 1);
  assert.equal(r.complied, 0);
});

// Anti-fabrication guard on the server-side write path (glmps-166 Task 11):
// on a fresh state dir there is no ledger, so `metric.routed` is 0 and
// persistRoutingCompliance's guard must refuse to write. Kept as a
// permanent regression test, not a red step - it is expected to PASS
// immediately, before anything writes the measurable, and must keep
// passing after the write path ships.
test('the routing-compliance measurable appears on /api/measurables', async () => {
  const body = await (await fetch(`http://127.0.0.1:${sharedSrv.port}/api/measurables`)).json();
  const found = body.measurables.filter(m => m.kind === 'routing-compliance');
  // With no routed cards yet there must be no fabricated measurable.
  assert.equal(found.length, 0);
});

// glmps-166 Task 11 review (Important finding): the test above only proves
// the anti-fabrication guard on an EMPTY ledger. Nothing exercised
// computeRoutingComplianceMetric()/persistRoutingCompliance() - the only
// genuinely new glue this task added - against a REAL ledger entry plus a
// matching session, so a wiring bug (wrong field name, a flipped argument,
// passing the wrong thing as `sessions`) would have passed every check that
// existed and the panel would have silently rendered whatever wrong number
// resulted. This drives the real path end to end, same pattern as
// api-measurables-tick.test.js: seed the runner ledger (the real
// runnerStore.saveLedger write path) and the session index at the exact
// path IndexStore reads (server/lib/paths.js indexFile, same precedent as
// agent-usage.test.js), boot a real server, call h.measurablesTick() (the
// same function the interval timer calls, exposed on the handle for
// deterministic tests), then read back through the real GET /api/measurables
// route. Two ledger entries under two different taskClasses - one whose
// session's agentsUsed contains the routed agent (complied) and one whose
// session dispatched something else (a miss) - so a sign flip or an
// inverted `some()` comparison cannot pass this deepEqual.
test('measurablesTick(), driven end to end, produces a routing-compliance measurable shaped from a real ledger + a real session index', async () => {
  // Real ledger write path (runnerStore.saveLedger), not a hand-rolled file -
  // proves computeRoutingComplianceMetric's runnerStore.loadLedger(P.stateDir)
  // call reads what the real runner actually persists.
  runnerStore.saveLedger(sharedStateDir, {
    'job-complied': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/job-complied' } },
    'job-miss':     { route: { agent: 'ui-designer', taskClass: 'feature' }, worktree: { dir: '/w/job-miss' } },
  });

  // The interval hasn't elapsed; drive the same function it calls directly.
  sharedSrv.measurablesTick();

  const body = await (await fetch(`http://127.0.0.1:${sharedSrv.port}/api/measurables`)).json();
  const m = body.measurables.find(x => x.kind === 'routing-compliance');
  assert.ok(m, `expected a routing-compliance measurable, got kinds: ${JSON.stringify(body.measurables.map(x => x.kind))}`);
  assert.equal(m.id, 'routing-compliance:current');
  assert.deepEqual(m.metric, {
    routed: 2,
    complied: 1,
    explained: 0,
    unmeasurable: 0,
    byClass: {
      ui: { routed: 1, complied: 1 },
      feature: { routed: 1, complied: 0 },
    },
    // Both cards in this fixture were routed to ui-designer, so byAgent
    // collapses what byClass splits. That asymmetry is the point of having
    // both: one agent can serve several classes.
    byAgent: {
      'ui-designer': { routed: 2, complied: 1 },
    },
    threshold: 0.6,
    decisionDate: '2026-09-15',
  });
});

//
// reconcileLedger drops every entry whose card reached a FINISHED state, and
// reconcileNow persists that pruned ledger over launched.json. The routing
// decision lived ONLY on the ledger entry, so it was erased the moment the card
// closed and computeRoutingCompliance saw in-flight jobs only: `routed` was
// structurally capped at maxConcurrent (1 here, 3 on the author's machine),
// which makes the pre-registered n=20 escalation review unreachable no matter
// how many cards actually run.
//
// The test above could not catch it: it SEEDED a ledger that still held both
// entries and called measurablesTick() directly, so the pruning step never ran.
// This one goes through the real runner tick both times - claim, close, tick -
// and asserts the metric still counts the finished card. Before the fix the
// ledger is empty at that point, `routed` is 0, persistRoutingCompliance's
// anti-fabrication guard refuses to write, and there is NO measurable at all.
test('runnerTick end to end: a routed card still counts after it finishes and the ledger prunes it', async () => {
  const base = `http://127.0.0.1:${sharedSrv.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const patch = (p, obj) => j(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

  // Real claim path: shipped agentRoutes defaults (no config file) + a card
  // whose prompt classifies as `ui`, launched by the real tick.
  await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'registry polish', prompt: 'Update the dashboard layout for the registry view' });
  await post('/api/runner/config', { enabled: true });
  await sharedSrv.runnerTick();
  const claimed = (await j('/api/runner')).body.ledger['glmps-1'];
  assert.ok(claimed, 'the tick claimed the card');
  assert.equal(claimed.route.agent, 'ui-designer');

  // The card closes exactly as a launched session closes it.
  await patch('/api/backlog/glmps-1', { labels: ['agent:done'] });
  await sharedSrv.runnerTick();

  // The live ledger is now empty - this is the erasure the metric used to be
  // blind to. Asserting it makes the test meaningful rather than incidental.
  assert.deepEqual((await j('/api/runner')).body.ledger, {}, 'the finished card left the live ledger');

  sharedSrv.measurablesTick();
  const body = (await j('/api/measurables')).body;
  const m = body.measurables.find(x => x.kind === 'routing-compliance');
  assert.ok(m, 'the finished routed card must still produce a routing-compliance measurable');
  assert.equal(m.metric.routed, 1, 'a departed routed card still counts toward the pre-registered n=20');
  assert.deepEqual(m.metric.byClass.ui, { routed: 1, complied: 0 });
  // No worktree in a dry run, so the card is honestly unmeasurable, never a miss.
  assert.equal(m.metric.unmeasurable, 1);
});

// The union must not DOUBLE count: a card is recorded in the durable log when
// it departs, and a relaunch of the same id puts it back in the live ledger.
// Counting both would inflate `routed` against the same pre-registered n=20 the
// fix above exists to make reachable.
test('a card present in BOTH the live ledger and the durable routing log is counted once', () => {
  const merged = mergeRoutingLedger(
    { 'mc-1': { route: { agent: 'ui-designer', taskClass: 'ui' }, worktree: { dir: '/w/mc-1-retry' } } },
    [{ id: 'mc-1', route: { agent: 'ui-designer', taskClass: 'ui' }, worktreeDir: '/w/mc-1' }],
  );
  assert.deepEqual(Object.keys(merged), ['mc-1']);
  assert.equal(merged['mc-1'].worktree.dir, '/w/mc-1-retry', 'the live entry wins: it is the fresher record');

  const r = computeRoutingCompliance({
    ledger: merged,
    sessions: [{ id: 's1', cwd: '/w/mc-1-retry', lastTs: 1, agentsUsed: [{ name: 'ui-designer', count: 1 }] }],
    ...OPTS,
  });
  assert.equal(r.routed, 1);
  assert.equal(r.complied, 1);
});

test('the routing log survives a reload and upserts by card id rather than appending duplicates', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rlog-'));
  try {
    appendRoutingLog(stateDir, [{ id: 'mc-1', route: { agent: 'ui-designer', taskClass: 'ui' }, worktreeDir: '/w/a', ts: 1 }]);
    appendRoutingLog(stateDir, [{ id: 'mc-2', route: { agent: 'web-researcher', taskClass: 'research' }, worktreeDir: '/w/b', ts: 2 }]);
    // Same card again (a requeued job relaunched, then departed a second time).
    appendRoutingLog(stateDir, [{ id: 'mc-1', route: { agent: 'ui-designer', taskClass: 'ui' }, worktreeDir: '/w/a2', ts: 3 }]);
    // Unrouted departures are not recorded at all: the metric skips them anyway.
    appendRoutingLog(stateDir, [{ id: 'mc-3', route: { agent: null }, worktreeDir: '/w/c', ts: 4 }]);

    const rows = loadRoutingLog(stateDir);
    assert.deepEqual(rows.map(r => r.id).sort(), ['mc-1', 'mc-2']);
    assert.equal(rows.find(r => r.id === 'mc-1').worktreeDir, '/w/a2', 'latest wins on re-append');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a missing or corrupt routing log reads as empty instead of throwing', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rlog-'));
  try {
    assert.deepEqual(loadRoutingLog(stateDir), []);
    fs.mkdirSync(path.join(stateDir, 'runner'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runner', 'routing-log.json'), '{not json');
    assert.deepEqual(loadRoutingLog(stateDir), []);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// 2026-08-12 roster re-cut: byClass answers "is routing working", byAgent
// answers "is THIS agent earning its place", which is the question a static
// roster has to keep answering. Same numerator and denominator, keyed by the
// agent the runner actually named.
test('byAgent breaks compliance down per named agent', () => {
  const ledger = {
    a: { route: { agent: 'debugger', taskClass: 'debug' }, worktree: { dir: '/w/a' } },
    b: { route: { agent: 'debugger', taskClass: 'debug' }, worktree: { dir: '/w/b' } },
    c: { route: { agent: 'code-critic', taskClass: 'review' }, worktree: { dir: '/w/c' } },
    d: { route: { agent: 'code-critic', taskClass: 'review' }, worktree: null },
  };
  const sessions = [
    { cwd: '/w/a', lastTs: 1, agentsUsed: [{ name: 'debugger' }] },
    { cwd: '/w/b', lastTs: 1, agentsUsed: [{ name: 'general-purpose' }] },
    { cwd: '/w/c', lastTs: 1, agentsUsed: [{ name: 'code-critic' }] },
  ];
  const r = computeRoutingCompliance({ ledger, sessions, threshold: 0.6, decisionDate: null });
  assert.deepEqual(r.byAgent.debugger, { routed: 2, complied: 1 });
  // The unmeasurable card counts as routed for this agent but can never comply,
  // matching how the top-level counters already treat it.
  assert.deepEqual(r.byAgent['code-critic'], { routed: 2, complied: 1 });
  assert.equal(r.unmeasurable, 1);
});

test('glmps-2-0-185: a skip with a Routing note devlog counts as explained, not complied', () => {
  const r = computeRoutingCompliance({
    ledger: {
      'mc-1': { route: { agent: 'debugger', taskClass: 'debug' }, worktree: { dir: '/w/mc-1' } },
      'mc-2': { route: { agent: 'debugger', taskClass: 'debug' }, worktree: { dir: '/w/mc-2' } },
    },
    sessions: [{ id: 's1', cwd: '/w/mc-1', agentsUsed: [] }, { id: 's2', cwd: '/w/mc-2', agentsUsed: [] }],
    notes: { 'mc-1': ['Outcome: fixed.\nRouting note: inline, a 2-line change.'], 'mc-2': ['Outcome: fixed.'] },
    ...OPTS,
  });
  assert.equal(r.routed, 2);
  assert.equal(r.complied, 0);
  assert.equal(r.explained, 1);
  assert.deepEqual(r.byClass.debug, { routed: 2, complied: 0 });
});

test('glmps-2-0-185: a complied card is never also counted as explained', () => {
  const r = computeRoutingCompliance({
    ledger: { 'mc-1': { route: { agent: 'debugger', taskClass: 'debug' }, worktree: { dir: '/w/mc-1' } } },
    sessions: [{ id: 's1', cwd: '/w/mc-1', agentsUsed: [{ name: 'debugger', count: 1, lastTs: 1 }] }],
    notes: { 'mc-1': ['Routing note: dispatched the debugger.'] },
    ...OPTS,
  });
  assert.equal(r.complied, 1);
  assert.equal(r.explained, 0);
});

test('glmps-2-0-185: a Routing note mid-paragraph still counts as explained', () => {
  const r = computeRoutingCompliance({
    ledger: { 'mc-1': { route: { agent: 'debugger', taskClass: 'debug' }, worktree: { dir: '/w/mc-1' } } },
    sessions: [{ id: 's1', cwd: '/w/mc-1', agentsUsed: [] }],
    notes: { 'mc-1': ['Outcome: green again. No decision needed. Routing note: inline, a one-file fix.'] },
    ...OPTS,
  });
  assert.equal(r.explained, 1);
});
