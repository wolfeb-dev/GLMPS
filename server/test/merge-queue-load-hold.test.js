// Card glmps-2-0-runtime-98: a timeout is a load hold, not a bounce (F1), and
// the queue runs only the tests a PR affects (F6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMergeTests, applyOutcome } from '../lib/orchestration/merge-tests.js';
import { createMergeRequest, transition, nextAction, groupQueue, isBounceExit, MAX_ROUNDS } from '../lib/orchestration/merge-queue.js';

const T0 = '2026-10-29T10:00:00.000Z';
const T1 = '2026-10-29T10:30:00.000Z';
const T2 = '2026-10-29T11:00:00.000Z';
const T3 = '2026-10-29T11:30:00.000Z';

const filed = (number, now = T0, headSha = 'aaa111') => createMergeRequest(
  { prUrl: `https://github.com/acme/widgets/pull/${number}`, repo: 'acme/widgets', number, base: 'main', head: `feat/${number}`, headSha, filedBy: 'w' },
  { now },
);
const testing = (m, now = T0) => transition(m, 'testing', { now, queue: [], id: 'c1' }).mergeRequest;
const timeout = (headSha = 'aaa111') => ({ kind: 'timeout', headSha, tests: { status: 'fail', timedOut: true, reason: 'timed out after 1800000 ms', headSha } });
const passedCard = (id, ts) => {
  let m = testing(filed(9, T0, 'ccc333'), T0);
  m = transition(m, 'merging', { now: ts, reason: 'tests passed' }).mergeRequest;
  return { id, mergeRequest: m };
};

test('a timeout requeues the request at the back: no round spent, no bounce, the head recorded', () => {
  const m = testing(filed(7));
  const r = applyOutcome(m, timeout(), { now: T1, queue: [], id: 'c1' });
  assert.equal(r.error, undefined);
  assert.equal(r.mergeRequest.stage, 'requested');
  assert.equal(r.mergeRequest.round, 1);
  assert.equal(r.mergeRequest.queuedAt, T1);
  assert.deepEqual(r.mergeRequest.loadHolds, [{ ts: T1, headSha: 'aaa111' }]);
  assert.equal(isBounceExit(r.mergeRequest), false, 'the author is not relaunched');
  assert.match(r.text, /timed out/);
  assert.match(r.text, /no round spent/);
});

test('a timeout in the last round is still a load hold, never the round-cap hold', () => {
  let m = filed(7);
  for (let i = 1; i < MAX_ROUNDS; i++) m = createMergeRequest({ ...m }, { now: T0, prev: { ...m, stage: 'bounced' } });
  assert.equal(m.round, MAX_ROUNDS);
  const r = applyOutcome(testing(m), timeout(), { now: T1, queue: [], id: 'c1' });
  assert.equal(r.mergeRequest.stage, 'requested');
});

test('the same head timing out twice with no other pass in between is held for load again', () => {
  const m1 = applyOutcome(testing(filed(7)), timeout(), { now: T1, queue: [], id: 'c1' }).mergeRequest;
  const m2 = testing(m1, T2);
  const passedBefore = passedCard('c2', '2026-10-29T10:15:00.000Z');
  const r = applyOutcome(m2, timeout(), { now: T3, queue: [passedBefore], id: 'c1' });
  assert.equal(r.mergeRequest.stage, 'requested');
  assert.equal(r.mergeRequest.loadHolds.length, 2);
});

test('the same head timing out twice while another PR passed in between bounces as today', () => {
  const m1 = applyOutcome(testing(filed(7)), timeout(), { now: T1, queue: [], id: 'c1' }).mergeRequest;
  const m2 = testing(m1, T2);
  const r = applyOutcome(m2, timeout(), { now: T3, queue: [passedCard('c2', '2026-10-29T10:45:00.000Z')], id: 'c1' });
  assert.equal(r.mergeRequest.stage, 'bounced');
  assert.match(r.mergeRequest.history.at(-1).reason, /^tests fail: timed out/);
  assert.match(r.mergeRequest.history.at(-1).reason, /c2 passed/);
  assert.equal(isBounceExit(r.mergeRequest), true);
});

test('a new head after a load hold starts the guard over', () => {
  const m1 = applyOutcome(testing(filed(7)), timeout('aaa111'), { now: T1, queue: [], id: 'c1' }).mergeRequest;
  const m2 = testing({ ...m1, headSha: 'bbb222' }, T2);
  const r = applyOutcome(m2, timeout('bbb222'), { now: T3, queue: [passedCard('c2', '2026-10-29T10:45:00.000Z')], id: 'c1' });
  assert.equal(r.mergeRequest.stage, 'requested');
});

test('a load-held request waits behind requests filed after it but queued before', () => {
  const held = applyOutcome(testing(filed(7, T0)), timeout(), { now: T2, queue: [], id: 'c1' }).mergeRequest;
  const later = filed(8, T1);
  const queue = [{ id: 'c1', mergeRequest: held }, { id: 'c2', mergeRequest: later }];
  assert.equal(nextAction(held, queue, { id: 'c1' }).action, 'wait');
  assert.equal(nextAction(later, queue, { id: 'c2' }).action, 'start-testing');
  assert.deepEqual(groupQueue(queue)[0].requests.map((r) => r.id), ['c2', 'c1']);
});

test('the operator releasing a hold still clears the restart and repair counts; a load hold keeps them', () => {
  const m = { ...testing(filed(7)), restarts: 2 };
  assert.equal(applyOutcome(m, timeout(), { now: T1, queue: [], id: 'c1' }).mergeRequest.restarts, 2);
  const held = transition({ ...filed(7), stage: 'held', restarts: 2 }, 'requested', { now: T1 }).mergeRequest;
  assert.equal(held.restarts, 0);
});

// F6 in runMergeTests: a scripted git that answers the diff; the test files come from git.listFiles.
function scriptedGit({ diff = '', files = '' } = {}) {
  const calls = [];
  const git = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: 'aaa111\n', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'bbb222\n', stderr: '' };
    if (args[0] === 'diff' && args.includes('bbb222')) return { status: 0, stdout: diff, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  git.calls = calls;
  git.listFiles = () => files.split('\n').filter(Boolean);
  return git;
}
const PKG = { scripts: { test: 'node --test --env-file=test.env --test-concurrency=4 "**/*.test.js"' } };
const SRC = {
  'server/test/a.test.js': "import '../lib/a.js';",
  'server/test/b.test.js': "import '../lib/b.js';",
};
const run = (over) => {
  let seen = null;
  const p = runMergeTests({
    mr: testing(filed(7)), repoPath: '/repo', workDir: '/wt/c1', override: null,
    readPkg: () => PKG, readTest: (_dir, f) => SRC[f], listFiles: () => over?.git?.files ?? [],
    runTest: async (a) => { seen = a; return { exitCode: 0, timedOut: false, tail: 'ok', durationMs: 3 }; },
    listFiles: over.git?.listFiles,
    ...over,
  });
  return p.then((out) => ({ out, seen }));
};

test('runMergeTests runs only the affected test files and records the selection', async () => {
  const git = scriptedGit({ diff: 'server/lib/a.js\ndocs/x.md\n', files: 'server/test/a.test.js\nserver/test/b.test.js\n' });
  const { out, seen } = await run({ git });
  assert.ok(git.calls.includes('diff --name-only bbb222 HEAD'), git.calls.join('\n'));
  assert.equal(seen.command, 'node --test --env-file=test.env --test-concurrency=4 server/test/a.test.js');
  assert.equal(out.kind, 'pass');
  assert.deepEqual(out.tests.selection, { mode: 'affected', files: 1, of: 2 });
});

test('runMergeTests skips the run when the change affects no test file', async () => {
  let ran = false;
  const { out } = await run({ git: scriptedGit({ diff: 'docs/x.md\n', files: 'server/test/a.test.js\n' }), runTest: async () => { ran = true; } });
  assert.equal(ran, false);
  assert.equal(out.kind, 'pass');
  assert.equal(out.tests.status, 'skipped');
  assert.match(out.tests.reason, /no test file/);
});

test('runMergeTests runs the full suite when the change touches package.json, or the diff cannot be read', async () => {
  const a = await run({ git: scriptedGit({ diff: 'package.json\nserver/lib/a.js\n', files: 'server/test/a.test.js\n' }) });
  assert.equal(a.seen.command, 'npm test');
  assert.equal(a.out.tests.selection.mode, 'full');
  assert.match(a.out.tests.selection.reason, /package\.json/);
  const failing = scriptedGit();
  const broken = async (args, o) => (args[0] === 'diff' ? { status: 128, stdout: '', stderr: 'bad object' } : failing(args, o));
  const b = await run({ git: broken });
  assert.equal(b.seen.command, 'npm test');
  assert.match(b.out.tests.selection.reason, /diff/);
});

test('runMergeTests keeps an operator-configured command as the full run', async () => {
  const { seen, out } = await run({ override: { test: 'make check' }, git: scriptedGit({ diff: 'server/lib/a.js\n', files: 'server/test/a.test.js\n' }) });
  assert.equal(seen.command, 'make check');
  assert.equal(out.tests.selection.mode, 'full');
});

test('runMergeTests reports a timeout as its own outcome kind', async () => {
  const { out } = await run({
    git: scriptedGit({ diff: 'server/lib/a.js\n', files: 'server/test/a.test.js\n' }),
    runTest: async () => ({ exitCode: null, timedOut: true, tail: 'hang', durationMs: 9 }),
  });
  assert.equal(out.kind, 'timeout');
  assert.equal(out.tests.timedOut, true);
  assert.match(out.tests.reason, /timed out after/);
});

test('runMergeTests runs a long affected list as several commands in order, under one ceiling', async () => {
  const names = Array.from({ length: 300 }, (_, i) => `server/test/a-fairly-long-test-file-name-${i}.test.js`);
  const src = Object.fromEntries(names.map((n) => [n, "import '../server.js';"]));
  const git = scriptedGit({ diff: 'server/server.js\n', files: `${names.join('\n')}\n` });
  const seen = [];
  const out = await runMergeTests({
    mr: testing(filed(7)), repoPath: '/repo', workDir: '/wt/c1', override: null, git, listFiles: git.listFiles,
    readPkg: () => PKG, readTest: (_dir, f) => src[f],
    runTest: async (a) => { seen.push(a); return { exitCode: 0, timedOut: false, tail: 'ok', durationMs: 1 }; },
  });
  assert.equal(out.kind, 'pass');
  assert.ok(seen.length > 1, `${seen.length} commands`);
  assert.equal(seen.flatMap((a) => a.command.split(' ').filter((t) => t.endsWith('.test.js'))).length, 300);
  assert.equal(seen[0].timeoutMs, 30 * 60 * 1000);
  assert.ok(seen.slice(1).every((a) => a.timeoutMs <= seen[0].timeoutMs));
  assert.equal(out.tests.selection.mode, 'affected');
  assert.equal(out.tests.selection.commands, seen.length);
});

test('a failing chunk stops the run and is reported as a failure', async () => {
  const names = Array.from({ length: 300 }, (_, i) => `server/test/a-fairly-long-test-file-name-${i}.test.js`);
  const src = Object.fromEntries(names.map((n) => [n, "import '../server.js';"]));
  const git = scriptedGit({ diff: 'server/server.js\n', files: `${names.join('\n')}\n` });
  let calls = 0;
  const out = await runMergeTests({
    mr: testing(filed(7)), repoPath: '/repo', workDir: '/wt/c1', override: null,
    git, listFiles: git.listFiles,
    readPkg: () => PKG, readTest: (_dir, f) => src[f],
    runTest: async () => { calls += 1; return { exitCode: 1, timedOut: false, tail: 'not ok', durationMs: 1 }; },
  });
  assert.equal(out.kind, 'fail');
  assert.equal(calls, 2, 'the first chunk, then its rerun');
});
