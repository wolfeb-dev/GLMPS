// Card glmps-2-0-runtime-98 (F6 second half): the batched full run on the base.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDue, failingFiles, bisect, createMainSuiteLoop, mainSuiteAlerts, fetchOrigin, FETCH_ATTEMPTS, SUITE_BATCH_MERGES, NIGHTLY_MS } from '../lib/orchestration/main-suite.js';

const NOW = Date.parse('2026-10-29T20:00:00.000Z');

test('isDue: first run, a retry, a batch of merges or a nightly gap; never the same tip twice', () => {
  assert.equal(isDue({ rec: {}, tip: 't', nowMs: NOW }).due, true);
  assert.equal(isDue({ rec: { lastTestedSha: 't', retry: true, lastResult: 'timeout' }, tip: 't', nowMs: NOW }).due, true);
  const fresh = { lastTestedSha: 'a', lastRunTs: new Date(NOW - 60_000).toISOString() };
  assert.equal(isDue({ rec: { ...fresh, lastTestedSha: 't' }, tip: 't', nowMs: NOW }).due, false);
  assert.equal(isDue({ rec: fresh, tip: 't', mergesSince: SUITE_BATCH_MERGES - 1, nowMs: NOW }).due, false);
  assert.equal(isDue({ rec: fresh, tip: 't', mergesSince: SUITE_BATCH_MERGES, nowMs: NOW }).due, true);
  const old = { lastTestedSha: 'a', lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() };
  assert.match(isDue({ rec: old, tip: 't', mergesSince: 0, nowMs: NOW }).reason, /nightly/);
  // Card glmps-2-0-173 (B): one merge is enough, so a fix is certified for promotion soon after it lands.
  assert.equal(SUITE_BATCH_MERGES, 1);
  assert.equal(isDue({ rec: fresh, tip: 't', mergesSince: 1, nowMs: NOW }).due, true);
});

test('failingFiles reads the failing files out of node test output', () => {
  const tail = "x failing tests:\n\ntest at server\\test\\a.test.js:12:1\nx boom\ntest at server/test/b.test.js:1:1\ntest at server/test/a.test.js:40:3\n";
  assert.deepEqual(failingFiles(tail), ['server/test/a.test.js', 'server/test/b.test.js']);
  assert.deepEqual(failingFiles('all green'), []);
});

test('bisect names the first red merge in log2 probes', async () => {
  const commits = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
  const probed = [];
  const r = await bisect({ commits, good: 'g', probe: async (s) => { probed.push(s); return commits.indexOf(s) >= 5 ? 'fail' : 'pass'; } });
  assert.equal(r.culprit, 'c6');
  assert.equal(r.good, 'c5');
  assert.ok(probed.length <= 3, probed.join(','));
});

test('bisect: one merge since green is the culprit with no probe; a probe that cannot decide stops it', async () => {
  assert.equal((await bisect({ commits: ['c1'], good: 'g', probe: async () => { throw new Error('no probe expected'); } })).culprit, 'c1');
  const r = await bisect({ commits: ['c1', 'c2', 'c3', 'c4'], good: 'g', probe: async () => 'timeout' });
  assert.equal(r.culprit, null);
  assert.equal(r.bad, 'c4');
});

test('isDue: an open card with a merge in the batch holds the count trigger, never the nightly, red or retry trigger (glmps-2-0-186)', () => {
  const fresh = { lastTestedSha: 'a', lastRunTs: new Date(NOW - 60_000).toISOString() };
  const held = isDue({ rec: fresh, tip: 't', mergesSince: SUITE_BATCH_MERGES, nowMs: NOW, openCards: ['c-1'] });
  assert.equal(held.due, false);
  assert.deepEqual(held.heldBy, ['c-1']);
  assert.match(held.reason, /held until open card\(s\) c-1 close/);
  assert.equal(isDue({ rec: fresh, tip: 't', mergesSince: SUITE_BATCH_MERGES, nowMs: NOW, openCards: [] }).due, true, 'released once the card closes');
  const old = { lastTestedSha: 'a', lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() };
  assert.match(isDue({ rec: old, tip: 't', mergesSince: SUITE_BATCH_MERGES, nowMs: NOW, openCards: ['c-1'] }).reason, /nightly/);
  assert.equal(isDue({ rec: { ...fresh, red: { sha: 'a' } }, tip: 't', mergesSince: SUITE_BATCH_MERGES, nowMs: NOW, openCards: ['c-1'] }).due, true);
  assert.equal(isDue({ rec: { ...fresh, retry: true }, tip: 't', mergesSince: SUITE_BATCH_MERGES, nowMs: NOW, openCards: ['c-1'] }).due, true);
  assert.equal(isDue({ rec: fresh, tip: 't', mergesSince: 0, nowMs: NOW, openCards: ['c-1'] }).heldBy, undefined, 'under the batch is not a hold');
});

function harness({ results = {}, tip = 'tip9', firstParent = ['m1', 'm2', 'm3', 'tip9'], state = {}, busy = false, recordTree, openCardsFor } = {}) {
  let doc = state;
  const runs = []; const cards = []; const trees = [];
  const shaAt = new Map();
  const git = async (args, { cwd }) => {
    if (args[0] === 'rev-parse' && args[1].endsWith('^{tree}')) return { status: 0, stdout: `tree-${args[1].slice(0, -7)}\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${tip}\n`, stderr: '' };
    if (args[0] === 'rev-list') throw Object.assign(new Error('refused by shell: git rev-list is not allowed'), { code: 'REFUSED' });
    if (args[0] === 'log' && args.includes('--format=%H')) return { status: 0, stdout: [...firstParent].reverse().join('\n'), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'add') { shaAt.set(args[3], args[4]); return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'log') return { status: 0, stdout: `Merge pull request #7 from ${args.at(-1)}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '', cwd };
  };
  const runTest = async ({ command, cwd }) => {
    const sha = shaAt.get(cwd);
    runs.push({ sha, command });
    const r = results[sha] ?? 'pass';
    return r === 'timeout' ? { exitCode: null, timedOut: true, tail: '', durationMs: 5 }
      : { exitCode: r === 'pass' ? 0 : 1, timedOut: false, tail: r === 'pass' ? 'ok' : 'test at server/test/x.test.js:3:1', durationMs: 5 };
  };
  const loop = createMainSuiteLoop({
    targets: async () => [{ key: 'acme/w@main', repo: 'acme/w', base: 'main', project: 'p', repoPath: '/repo' }],
    git, runTest, readPkg: () => ({ scripts: { test: 'node --test "**/*.test.js"' } }),
    readState: () => doc, writeState: (d) => { doc = JSON.parse(JSON.stringify(d)); },
    queueBusy: () => busy, fileCard: (c) => cards.push(c), workDirFor: () => '/wt/main-suite', nowMs: () => NOW,
    recordTree: recordTree ?? ((r) => trees.push(r)),
    openCardsFor,
  });
  return { loop, runs, cards, trees, state: () => doc };
}

test('a full batch waits for an open card with a merge in it, records why, and runs once the card closes (glmps-2-0-186)', async () => {
  const fresh = { 'acme/w@main': { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunTs: new Date(NOW - 60_000).toISOString() } };
  let open = ['glmps-2-0-9'];
  const asked = [];
  const h = harness({
    state: fresh, firstParent: ['m1', 'm2', 'm3', 'm4', 'tip9'],
    openCardsFor: ({ target, shas }) => { asked.push({ key: target.key, shas }); return open; },
  });
  assert.equal((await h.loop.maker()).outcome, 'nothing-to-do');
  assert.equal(h.runs.length, 0);
  assert.deepEqual(asked[0], { key: 'acme/w@main', shas: ['m1', 'm2', 'm3', 'm4', 'tip9'] });
  assert.deepEqual(h.state()['acme/w@main'].held.by, ['glmps-2-0-9']);
  assert.match(h.state()['acme/w@main'].held.reason, /5 merge\(s\) since the last full run, held until open card\(s\) glmps-2-0-9 close/);
  open = [];
  assert.equal((await h.loop.maker()).outcome, 'done');
  assert.equal(h.runs.length, 1);
  assert.equal(h.state()['acme/w@main'].lastTestedSha, 'tip9');
  assert.equal(h.state()['acme/w@main'].held, undefined, 'the hold clears when the run starts');
});

test('the loop waits while a merge request is testing', async () => {
  const h = harness({ busy: true });
  assert.equal((await h.loop.maker()).outcome, 'nothing-to-do');
  assert.equal(h.runs.length, 0);
});

test('a green full run records the tip as green, and the checker accepts it', async () => {
  const h = harness();
  const out = await h.loop.maker();
  assert.equal(out.outcome, 'done');
  assert.equal(h.runs[0].command, 'npm test');
  assert.equal(h.state()['acme/w@main'].lastGreenSha, 'tip9');
  assert.equal((await h.loop.checker(out.result)).ok, true);
  assert.equal((await h.loop.maker()).outcome, 'nothing-to-do', 'the same tip is not run twice');
});

test('a red full run bisects with only the failing files and files one card naming the merge', async () => {
  const h = harness({
    state: { 'acme/w@main': { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() } },
    results: { m2: 'fail', m3: 'fail', tip9: 'fail' },
  });
  await h.loop.maker();
  assert.equal(h.runs[0].command, 'npm test');
  assert.ok(h.runs.slice(1).every((r) => r.command === 'node --test server/test/x.test.js'), JSON.stringify(h.runs));
  const rec = h.state()['acme/w@main'];
  assert.equal(rec.red.culprit, 'm2');
  assert.equal(rec.lastGreenSha, 'g0', 'green stays where it was');
  assert.equal(h.cards.length, 1);
  assert.match(h.cards[0].title, /^Full suite red on main: Merge pull request #7 from m2/);
  assert.match(h.cards[0].prompt, /server\/test\/x\.test\.js/);
  const alerts = mainSuiteAlerts(h.state());
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /since m2/);
});

test('a timed-out full run is load, not red: no bisect, no card, retried next time', async () => {
  const h = harness({ results: { tip9: 'timeout' } });
  await h.loop.maker();
  assert.equal(h.runs.length, 1);
  assert.equal(h.cards.length, 0);
  assert.equal(h.state()['acme/w@main'].retry, true);
  assert.equal(mainSuiteAlerts(h.state()).length, 0);
});

test('every completed full run writes one tested-tree record; bisect probes and timeouts write none', async () => {
  const green = harness();
  await green.loop.maker();
  assert.equal(green.trees.length, 1);
  const r = green.trees[0];
  assert.deepEqual(
    { sha: r.sha, treeSha: r.treeSha, verdict: r.verdict, key: r.key, source: r.source, ts: r.ts },
    { sha: 'tip9', treeSha: 'tree-tip9', verdict: 'pass', key: 'acme/w@main', source: 'main-suite', ts: new Date(NOW).toISOString() },
  );
  const red = harness({
    state: { 'acme/w@main': { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() } },
    results: { m2: 'fail', m3: 'fail', tip9: 'fail' },
  });
  await red.loop.maker();
  assert.ok(red.runs.length > 1, 'bisect probed');
  assert.equal(red.trees.length, 1, 'only the full run of the tip is recorded');
  assert.equal(red.trees[0].verdict, 'fail');
  const slow = harness({ results: { tip9: 'timeout' } });
  await slow.loop.maker();
  assert.equal(slow.trees.length, 0);
});

test('a record writer that throws does not fail the run or lose the loop state', async () => {
  const h = harness({ recordTree: () => { throw new Error('disk full'); } });
  assert.equal((await h.loop.maker()).outcome, 'done');
  assert.equal(h.state()['acme/w@main'].lastGreenSha, 'tip9');
});

test('a red branch is due as soon as the tip moves, so a fix lifts the pause on the next tick (glmps-2-0-runtime-125)', () => {
  const rec = { lastTestedSha: 'a', lastRunTs: new Date(NOW - 60_000).toISOString(), red: { sha: 'a' } };
  assert.equal(isDue({ rec, tip: 'b', mergesSince: 1, nowMs: NOW }).due, true);
  assert.equal(isDue({ rec, tip: 'a', mergesSince: 0, nowMs: NOW }).due, false, 'the same red tip is not rerun');
});

test('a repo with no test command is recorded as skipped, not retried every run (glmps-2-0-runtime-119)', async () => {
  let doc = {};
  const loop = createMainSuiteLoop({
    targets: async () => [{ key: 'acme/docs@main', repo: 'acme/docs', base: 'main', project: 'p', repoPath: '/repo' }],
    git: async (args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'tip1\n' : '', stderr: '' }),
    runTest: async () => { throw new Error('must not run'); }, readPkg: () => ({ scripts: {} }),
    readState: () => doc, writeState: (d) => { doc = JSON.parse(JSON.stringify(d)); },
    queueBusy: () => false, fileCard: () => {}, workDirFor: () => '/wt/x', nowMs: () => NOW,
  });
  await loop.maker();
  const rec = doc['acme/docs@main'];
  assert.equal(rec.lastResult, 'skipped');
  assert.equal(rec.retry, false);
  assert.equal(rec.lastTestedSha, 'tip1');
  assert.equal(isDue({ rec, tip: 'tip1', mergesSince: 0, nowMs: NOW }).due, false);
});

test('the red record keeps the id of the card filed for it, so that card can land its fix (glmps-2-0-runtime-125)', async () => {
  let doc = { 'acme/w@main': { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() } };
  const loop = createMainSuiteLoop({
    targets: async () => [{ key: 'acme/w@main', repo: 'acme/w', base: 'main', project: 'p', repoPath: '/repo' }],
    git: async (args) => ({ status: 0, stdout: args[0] === 'rev-parse' || (args[0] === 'log' && args.includes('--format=%H')) ? 'tip9\n' : '', stderr: '' }),
    runTest: async () => ({ exitCode: 1, timedOut: false, tail: 'test at server/test/x.test.js:3:1', durationMs: 5 }),
    readPkg: () => ({ scripts: { test: 'node --test "**/*.test.js"' } }),
    readState: () => doc, writeState: (d) => { doc = JSON.parse(JSON.stringify(d)); },
    queueBusy: () => false, fileCard: () => ({ item: { id: 'p-77' } }), workDirFor: () => '/wt/x', nowMs: () => NOW,
  });
  await loop.maker();
  assert.equal(doc['acme/w@main'].red.cardId, 'p-77');
  assert.deepEqual(doc['acme/w@main'].red.files, ['server/test/x.test.js']);
});

// glmps-2-0-runtime-128, -130: the desktop shell refuses rev-list, so the loop
// counts and bisects with log and never sends rev-list at all.
function oldShellHarness({ results = {}, firstParent = ['m1', 'm2', 'm3', 'tip9'], state }) {
  let doc = state;
  const calls = []; const runs = [];
  const shaAt = new Map();
  const git = async (args) => {
    calls.push(args);
    if (args[0] === 'rev-list') throw Object.assign(new Error('refused by shell: git rev-list is not allowed'), { code: 'REFUSED' });
    if (args[0] === 'rev-parse' && args[1].endsWith('^{tree}')) return { status: 0, stdout: 'tree\n', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'tip9\n', stderr: '' };
    if (args[0] === 'log' && args.includes('--format=%H')) return { status: 0, stdout: [...firstParent].reverse().join('\n'), stderr: '' };
    if (args[0] === 'log') return { status: 0, stdout: `Merge pull request #7 from ${args.at(-1)}\n`, stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'add') shaAt.set(args[3], args[4]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const loop = createMainSuiteLoop({
    targets: async () => [{ key: 'acme/w@main', repo: 'acme/w', base: 'main', project: 'p', repoPath: '/repo' }],
    git,
    runTest: async ({ cwd }) => { const sha = shaAt.get(cwd); runs.push(sha); const r = results[sha] ?? 'pass'; return { exitCode: r === 'pass' ? 0 : 1, timedOut: false, tail: r === 'pass' ? 'ok' : 'test at server/test/x.test.js:3:1', durationMs: 5 }; },
    readPkg: () => ({ scripts: { test: 'node --test "**/*.test.js"' } }),
    readState: () => doc, writeState: (d) => { doc = JSON.parse(JSON.stringify(d)); },
    queueBusy: () => false, fileCard: () => ({ item: { id: 'c-red' } }), workDirFor: () => '/wt/x', nowMs: () => NOW,
  });
  return { loop, calls, runs, doc: () => doc };
}

test('a shell that refuses rev-list still gets a counted run: merges since the last run are read with log (glmps-2-0-runtime-128)', async () => {
  const h = oldShellHarness({ state: { 'acme/w@main': { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunTs: new Date(NOW - 60_000).toISOString() } }, firstParent: Array.from({ length: SUITE_BATCH_MERGES }, (_, i) => `m${i}`) });
  assert.equal((await h.loop.maker()).outcome, 'done');
  assert.equal(h.doc()['acme/w@main'].lastResult, 'pass', 'a batch of merges since the last run made it due, so it ran');
  assert.ok(h.calls.some((a) => a[0] === 'log' && a.includes('--first-parent') && a.includes('--format=%H') && a.at(-1) === 'g0..tip9'));
  assert.equal(h.calls.filter((a) => a[0] === 'rev-list').length, 0, 'no rev-list call, so no refused broker record');
});

test('a shell that refuses rev-list still bisects a red run oldest first and names the culprit (glmps-2-0-runtime-128)', async () => {
  const h = oldShellHarness({
    results: { m3: 'fail', tip9: 'fail' },
    state: { 'acme/w@main': { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() } },
  });
  await h.loop.maker();
  const red = h.doc()['acme/w@main'].red;
  assert.equal(red.culprit, 'm3');
  assert.equal(red.good, 'm2');
  assert.equal(h.calls.filter((a) => a[0] === 'rev-list').length, 0, 'the bisect path sends no rev-list either');
});

// Card glmps-2-0-175: a failed fetch used to be a quiet skip, so the run read
// nothing-to-do and the registry never ran the checker or raised an alert.
test('a failed fetch fails the run and names the branch, rather than reading nothing-to-do', async () => {
  const runs = [];
  let doc = {};
  const loop = createMainSuiteLoop({
    targets: async () => [{ key: 'acme/w@main', repo: 'acme/w', base: 'main', project: 'p', repoPath: '/repo' }],
    git: async (args) => (args[0] === 'fetch' ? { status: 128, stdout: '', stderr: 'fatal: unable to access origin' } : { status: 0, stdout: 'tip9', stderr: '' }),
    runTest: async () => { runs.push(1); return { exitCode: 0, timedOut: false, tail: 'ok', durationMs: 5 }; },
    readPkg: () => ({ scripts: { test: 'node --test' } }),
    readState: () => doc, writeState: (d) => { doc = JSON.parse(JSON.stringify(d)); },
    queueBusy: () => false, fileCard: () => null, workDirFor: () => '/wt/x', nowMs: () => NOW,
  });
  await assert.rejects(() => loop.maker(), /acme.w@main: git fetch failed: fatal: unable to access origin/);
  assert.equal(runs.length, 0);
});

// Card glmps-2-0-215: a merge kicks this loop and the batch reviewer together,
// both fetch the same checkout, and the loser's ref update fails its lock check.
const LOCK_ERR = "error: cannot lock ref 'refs/remotes/origin/main': is at f84e234 but expected 10f37a2";

test('a ref-lock collision on fetch is retried and the run goes ahead (glmps-2-0-215)', async () => {
  const runs = [];
  const slept = [];
  let fetches = 0;
  let doc = {};
  const loop = createMainSuiteLoop({
    targets: async () => [{ key: 'acme/w@main', repo: 'acme/w', base: 'main', project: 'p', repoPath: '/repo' }],
    git: async (args) => {
      if (args[0] === 'fetch') return ++fetches === 1 ? { status: 1, stdout: '', stderr: LOCK_ERR } : { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: 'tip9', stderr: '' };
    },
    runTest: async () => { runs.push(1); return { exitCode: 0, timedOut: false, tail: 'ok', durationMs: 5 }; },
    readPkg: () => ({ scripts: { test: 'node --test' } }),
    readState: () => doc, writeState: (d) => { doc = JSON.parse(JSON.stringify(d)); },
    queueBusy: () => false, fileCard: () => null, workDirFor: () => '/wt/x', nowMs: () => NOW,
    sleep: async (ms) => { slept.push(ms); },
  });
  await loop.maker();
  assert.equal(fetches, 2);
  assert.equal(slept.length, 1);
  assert.equal(runs.length, 1);
  assert.equal(doc['acme/w@main'].lastResult, 'pass');
});

test('fetchOrigin retries only a ref-lock collision, and gives up after its attempts (glmps-2-0-215)', async () => {
  const sleep = async () => {};
  let n = 0;
  const locked = await fetchOrigin(async () => { n++; return { status: 1, stdout: '', stderr: LOCK_ERR }; }, '/repo', { sleep });
  assert.equal(locked.status, 1);
  assert.equal(n, FETCH_ATTEMPTS);
  n = 0;
  const offline = await fetchOrigin(async () => { n++; return { status: 128, stdout: '', stderr: 'fatal: unable to access origin' }; }, '/repo', { sleep });
  assert.equal(offline.status, 128);
  assert.equal(n, 1, 'a network failure is not retried here');
  for (const stderr of ["error: Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists.", 'error: some local refs could not be updated; try running']) {
    n = 0;
    await fetchOrigin(async () => (++n === 1 ? { status: 1, stdout: '', stderr } : { status: 0, stdout: '', stderr: '' }), '/repo', { sleep });
    assert.equal(n, 2, stderr);
  }
});

// Card glmps-2-0-190: an open card's interim merge from before the last run
// must not hold every later batch until the nightly backstop.
import { openCardsInBatch } from '../lib/orchestration/main-suite.js';

test('openCardsInBatch: an open card holds only for a merge in this batch, never for one before the last run started (glmps-2-0-190)', () => {
  const since = '2026-10-29T12:00:00.000Z';
  const mr = (extra) => ({ repo: 'acme/w', base: 'main', stage: 'requested', history: [], ...extra });
  const items = [
    { id: 'old-interim', state: 'in_progress', mergeRequest: mr({ history: [{ ts: '2026-10-26T01:00:00.000Z', to: 'merged' }, { ts: '2026-10-29T13:00:00.000Z', from: 'merged', to: 'requested' }] }) },
    { id: 'new-interim', state: 'in_progress', mergeRequest: mr({ stage: 'bounced', history: [{ ts: '2026-10-29T14:00:00.000Z', to: 'merged' }] }) },
    { id: 'by-sha', state: 'in_progress', mergeRequest: mr({ stage: 'merged', mergeSha: 'm2', mergedAt: '2026-10-29T14:05:00.000Z' }) },
    { id: 'by-cover', state: 'in_progress', coverage: { 1: { mergeSha: 'm1', at: '2026-10-29T14:10:00.000Z' } }, mergeRequest: mr({}) },
    { id: 'closed', state: 'done', mergeRequest: mr({ stage: 'merged', mergeSha: 'm2' }) },
    { id: 'other-branch', state: 'in_progress', mergeRequest: mr({ base: 'dev', stage: 'merged', mergeSha: 'm2' }) },
  ];
  const nowMs = Date.parse('2026-10-29T14:15:00.000Z');
  const ask = (shas, sinceTs) => openCardsInBatch({ items, key: 'acme/w@main', shas, sinceTs, nowMs, keyOf: (m) => `${m.repo}@${m.base}`, closedStates: new Set(['done']) }).holding;
  assert.deepEqual(ask(['m1', 'm2'], since), ['new-interim', 'by-sha', 'by-cover']);
  assert.deepEqual(ask(['m1'], null), ['by-cover'], 'with no run start on record a history entry alone never holds');
});

test('the loop passes the last run start to openCardsFor and records the next one (glmps-2-0-190)', async () => {
  const started = new Date(NOW - 3_600_000).toISOString();
  const rec = { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunStartTs: started, lastRunTs: new Date(NOW - 60_000).toISOString() };
  const asked = [];
  const h = harness({ state: { 'acme/w@main': rec }, firstParent: ['m1', 'tip9'], openCardsFor: (q, opts) => { asked.push(opts); return []; } });
  assert.equal((await h.loop.maker()).outcome, 'done');
  assert.equal(asked[0].sinceTs, started);
  assert.equal(h.state()['acme/w@main'].lastRunStartTs, new Date(NOW).toISOString());
});

// Card glmps-2-0-198: merged cards that stayed open for other reasons held the
// run, and with it the deploy, for about 2 hours on 2026-11-13.
import { HOLD_WINDOW_MS, isDeployCheck, openCardsForBacklog } from '../lib/orchestration/main-suite.js';

const T0 = Date.parse('2026-11-13T20:00:00.000Z');
const key198 = 'acme/w@main';
const ask198 = (items, nowMs, shas = ['m1', 'm2']) => openCardsInBatch({
  items, key: key198, shas, sinceTs: '2026-11-13T10:00:00.000Z', nowMs,
  keyOf: (m) => `${m.repo}@${m.base}`, closedStates: new Set(['done']),
});
const merged198 = (id, mergedTs, extra = {}) => ({
  id, state: 'in_progress', acceptanceCriteria: [{ text: 'AC-1: code' }, { text: 'AC-2: more code' }],
  mergeRequest: { repo: 'acme/w', base: 'main', stage: 'merged', mergeSha: 'm1', history: [{ ts: new Date(mergedTs).toISOString(), to: 'merged' }] },
  ...extra,
});

test('a merged card that stays open holds the run for at most one 30-minute cycle after its merge (glmps-2-0-198 AC-1)', () => {
  assert.equal(HOLD_WINDOW_MS, 30 * 60_000);
  const card = merged198('c-open', T0);
  assert.deepEqual(ask198([card], T0 + HOLD_WINDOW_MS - 1).holding, ['c-open'], 'inside the window it holds');
  const after = ask198([card], T0 + HOLD_WINDOW_MS);
  assert.deepEqual(after.holding, [], 'at the window it no longer holds');
  assert.deepEqual(after.released, [{ id: 'c-open', why: 'cap' }]);
});

test('a merge again starts a fresh window, so the newest merge bounds the hold (glmps-2-0-198 AC-1)', () => {
  const card = merged198('c-again', T0);
  card.mergeRequest.history.push({ ts: new Date(T0 + 20 * 60_000).toISOString(), from: 'merged', to: 'requested' }, { ts: new Date(T0 + 40 * 60_000).toISOString(), to: 'merged' });
  assert.deepEqual(ask198([card], T0 + 50 * 60_000).holding, ['c-again']);
  assert.deepEqual(ask198([card], T0 + 70 * 60_000).holding, []);
});

test('a card still mid-feature inside the window holds, whether its next PR is filed or not (glmps-2-0-198 AC-2)', () => {
  const building = merged198('c-building', T0, { coverage: { 1: { mergeSha: 'm1', at: new Date(T0).toISOString() } }, mergeRequest: { repo: 'acme/w', base: 'main', stage: 'merged', mergeSha: 'm1', covers: [1], history: [{ ts: new Date(T0).toISOString(), to: 'merged' }] } });
  const next = merged198('c-next', T0, { mergeRequest: { repo: 'acme/w', base: 'main', stage: 'testing', history: [{ ts: new Date(T0).toISOString(), to: 'merged' }, { ts: new Date(T0 + 60_000).toISOString(), to: 'requested' }] } });
  const r = ask198([building, next], T0 + 10 * 60_000);
  assert.deepEqual(r.holding, ['c-building', 'c-next']);
  assert.deepEqual(r.released, []);
});

test('a card whose only open criteria are its own deploy or live check never holds (glmps-2-0-198 AC-3)', () => {
  const acs = [{ text: 'AC-1: code' }, { text: 'AC-2: tests' }, { text: 'AC-3: after the first real deploy, live shows the change' }];
  const waiting = merged198('c-deploy', T0, {
    acceptanceCriteria: acs, coverage: { 1: { mergeSha: 'm1' }, 2: { mergeSha: 'm1' } },
    mergeRequest: { repo: 'acme/w', base: 'main', stage: 'merged', mergeSha: 'm1', covers: [1, 2], history: [{ ts: new Date(T0).toISOString(), to: 'merged' }] },
  });
  const r = ask198([waiting], T0 + 60_000);
  assert.deepEqual(r.holding, [], 'one minute after its merge, inside the window, it still does not hold');
  assert.deepEqual(r.released, [{ id: 'c-deploy', why: 'deploy' }]);
  const done = merged198('c-done-ac', T0, { acceptanceCriteria: [{ text: 'AC-1: code', done: true }, { text: 'AC-2: verified live after deploy' }] });
  assert.deepEqual(ask198([done], T0 + 60_000).holding, [], 'a criterion marked done counts as finished too');
  const live = merged198('c-live', T0, { acceptanceCriteria: acs, coverage: { 1: {}, 2: {} } });
  live.mergeRequest.live = { sha: 'm1', ts: T0 + 60_000 };
  assert.deepEqual(ask198([live], T0 + 120_000).holding, ['c-live'], 'once its merge is live it is no longer waiting for a deploy');
  const code = merged198('c-code', T0, { acceptanceCriteria: acs, coverage: { 1: {} } });
  assert.deepEqual(ask198([code], T0 + 60_000).holding, ['c-code'], 'a code criterion still open keeps it mid-feature');
});

test('a criterion is a deploy check only when phrased as one, never for the bare word (glmps-2-0-199)', () => {
  for (const t of [
    'AC-3: after the first real deploy, live shows the change',
    'AC-2: verified live after deploy',
    'AC-3: after deploy, PR #53 goes requested to merged on the live server',
    'AC-10: The runtime change is deployed and the plugin is uninstalled.',
    'AC-3: the web test suite passes and the change is merged and live on 8123',
    'AC-3: after the operator runs it, a smoke check on the live server shows the endpoint answering.',
    'post-deploy, /healthz reports the merge commit',
  ]) assert.equal(isDeployCheck(t), true, t);
  for (const t of [
    'AC-2: the hold reason names any card waiting for its own deploy',
    'AC-2: auto-deploy collapses a burst of merges into one run',
    'AC-1: the live dashboard shows the hold reason',
    'AC-2: A paused board starts no deploy, and a burst of merges collapses into one run.',
    'AC-3: The deploy restart step rolls back to ORIG_HEAD when the new build does not come up',
    'AC-1: pausing the runner stops a live reviewer session; a test covers it.',
    'AC-4: a test covers what happens after a deploy fails',
    'Rebuilds are automatic on deploy and incremental',
  ]) assert.equal(isDeployCheck(t), false, t);
});

test('a mid-feature card whose open criterion is code about deploys keeps holding inside the window (glmps-2-0-199)', () => {
  const acs = [{ text: 'AC-1: code' }, { text: 'AC-2: the hold reason names any card waiting for its own deploy' }, { text: 'AC-3: the live dashboard shows X' }];
  const card = merged198('c-deploy-code', T0, {
    acceptanceCriteria: acs, coverage: { 1: { mergeSha: 'm1' } },
    mergeRequest: { repo: 'acme/w', base: 'main', stage: 'merged', mergeSha: 'm1', covers: [1], history: [{ ts: new Date(T0).toISOString(), to: 'merged' }] },
  });
  const r = ask198([card], T0 + 60_000);
  assert.deepEqual(r.holding, ['c-deploy-code']);
  assert.deepEqual(r.released, []);
});

test('the backlog seam forwards the loop clock, so the hold window is pinned through it (glmps-2-0-199)', () => {
  const card = merged198('c-seam', T0);
  const seam = openCardsForBacklog({ loadItems: () => [card], keyOf: (m) => `${m.repo}@${m.base}`, closedStates: new Set(['done']) });
  const target = { key: 'acme/w@main' };
  assert.deepEqual(seam({ target, shas: ['m1'] }, { nowMs: T0 + 10 * 60_000 }).holding, ['c-seam']);
  assert.deepEqual(seam({ target, shas: ['m1'] }, { nowMs: T0 + HOLD_WINDOW_MS }).released, [{ id: 'c-seam', why: 'cap' }]);
});

test('the server wires the backlog seam rather than its own copy', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /openCardsFor: mainSuite\.openCardsForBacklog\(/);
});

test('a merge with no time on record cannot be bounded, so it does not hold (glmps-2-0-198)', () => {
  const card = merged198('c-nots', T0);
  card.mergeRequest.history = [];
  assert.deepEqual(ask198([card], T0).released, [{ id: 'c-nots', why: 'cap' }]);
});

test('the hold reason names cards released by the cap, and a run that goes ahead records why (glmps-2-0-198 AC-3)', async () => {
  const fresh = { lastTestedSha: 'a', lastRunTs: new Date(NOW - 60_000).toISOString() };
  const released = [{ id: 'c-old', why: 'cap' }, { id: 'c-dep', why: 'deploy' }];
  const held = isDue({ rec: fresh, tip: 't', mergesSince: 1, nowMs: NOW, openCards: ['c-new'], released });
  assert.equal(held.due, false);
  assert.match(held.reason, /held until open card\(s\) c-new close/);
  assert.match(held.reason, /c-old released by the 30-minute cap/);
  assert.match(held.reason, /c-dep waiting only for its own deploy/);
  const go = isDue({ rec: fresh, tip: 't', mergesSince: 1, nowMs: NOW, openCards: [], released });
  assert.equal(go.due, true);
  assert.match(go.reason, /c-old released by the 30-minute cap/);

  const h = harness({
    state: { 'acme/w@main': { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunTs: new Date(NOW - 60_000).toISOString() } },
    firstParent: ['m1', 'tip9'],
    openCardsFor: () => ({ holding: [], released: [{ id: 'c-old', why: 'cap' }] }),
  });
  assert.equal((await h.loop.maker()).outcome, 'done');
  assert.match(h.state()['acme/w@main'].lastDueReason, /c-old released by the 30-minute cap/);
});

test('with no run start on record the last run end bounds the history check (glmps-2-0-190)', async () => {
  const ended = new Date(NOW - 60_000).toISOString();
  const asked = [];
  const h = harness({ state: { 'acme/w@main': { lastTestedSha: 'g0', lastGreenSha: 'g0', lastRunTs: ended } }, firstParent: ['m1', 'tip9'], openCardsFor: (q, opts) => { asked.push(opts); return []; } });
  await h.loop.maker();
  assert.equal(asked[0].sinceTs, ended);
});
