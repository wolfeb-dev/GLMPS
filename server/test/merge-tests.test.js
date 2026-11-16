import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runMergeTests, applyOutcome, markRestarted } from '../lib/orchestration/merge-tests.js';
import { parseRemote, remoteMatchesRepo, findCheckout, resolveTestCommand, workDirFor, TAIL_CHARS, DEFAULT_TIMEOUT_MS } from '../lib/orchestration/merge-util.js';
import { createMergeRequest, transition } from '../lib/orchestration/merge-queue.js';

const NOW = '2026-10-17T10:00:00.000Z';
const mr0 = () => createMergeRequest(
  { prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: 'aaa111', filedBy: 'w' },
  { now: NOW },
);
const testingMr = () => transition(mr0(), 'testing', { now: NOW, queue: [], id: 'c1' }).mergeRequest;

// A scripted git: `script(args, opts)` may return a partial result; default is success.
function fakeGit(script = () => undefined) {
  const calls = [];
  const git = async (args, opts = {}) => {
    calls.push({ args, cwd: opts.cwd });
    return { status: 0, stdout: '', stderr: '', ...(script(args, opts) ?? {}) };
  };
  git.calls = calls;
  return git;
}
const TREE = 'f'.repeat(40);
const has = (args, ...words) => words.every((w) => args.includes(w));
const happyGit = (over = () => undefined) => fakeGit((args, o) => {
  const r = over(args, o);
  if (r) return r;
  if (has(args, 'rev-parse', 'HEAD')) return { stdout: 'aaa111\n' };
  if (has(args, 'rev-parse', 'origin/main')) return { stdout: 'bbb222\n' };
  if (has(args, 'rev-parse', 'HEAD^{tree}')) return { stdout: `${TREE}\n` };
  return undefined;
});
const passRun = async () => ({ exitCode: 0, timedOut: false, tail: 'ok', durationMs: 12 });
const base = (over = {}) => ({
  mr: testingMr(), repoPath: '/repo', workDir: '/wt/c1', override: { test: 'npm test' },
  git: happyGit(), runTest: passRun, readPkg: () => null, ...over,
});

test('parseRemote reads https and ssh forms, case-insensitively, with or without .git', () => {
  for (const u of [
    'https://github.com/Acme/Widgets.git', 'https://github.com/acme/widgets', 'git@github.com:ACME/widgets.git',
    'ssh://git@github.com/acme/widgets.git', 'https://user:tok@github.com/acme/widgets.git\n',
  ]) assert.equal(parseRemote(u), 'acme/widgets', u);
  assert.equal(parseRemote('not a url'), null);
  assert.equal(parseRemote(null), null);
  assert.equal(remoteMatchesRepo('git@github.com:acme/widgets.git', 'Acme/Widgets'), true);
  assert.equal(remoteMatchesRepo('git@github.com:acme/other.git', 'acme/widgets'), false);
});

test('findCheckout prefers a configured path, else matches origin across the roots', () => {
  const remotes = { '/r/a': 'https://github.com/acme/a.git', '/r/b': 'git@github.com:acme/widgets.git' };
  const remoteOf = (r) => remotes[r] ?? null;
  assert.equal(findCheckout({ repo: 'acme/widgets', roots: ['/r/a', '/r/b'], remoteOf }), '/r/b');
  assert.equal(findCheckout({ repo: 'acme/widgets', roots: ['/r/a', '/r/b'], remoteOf, override: { path: '/custom' } }), '/custom');
  assert.equal(findCheckout({ repo: 'acme/none', roots: ['/r/a', '/r/b'], remoteOf }), null);
});

test('resolveTestCommand: override, then npm test when a real script exists, else none', () => {
  assert.deepEqual(resolveTestCommand({ override: { test: 'make check', timeoutMs: 5000 }, pkg: null }), { command: 'make check', timeoutMs: 5000 });
  assert.deepEqual(resolveTestCommand({ pkg: { scripts: { test: 'node --test' } } }), { command: 'npm test', timeoutMs: DEFAULT_TIMEOUT_MS });
  assert.equal(resolveTestCommand({ pkg: { scripts: {} } }).command, null);
  assert.equal(resolveTestCommand({ pkg: null }).command, null);
  // the npm-init placeholder is not a test command
  assert.equal(resolveTestCommand({ pkg: { scripts: { test: 'echo "Error: no test specified" && exit 1' } } }).command, null);
});

test('resolveTestCommand: with no test command it falls back to the build script, then the lint script', () => {
  assert.deepEqual(resolveTestCommand({ pkg: { scripts: { build: 'tsc', lint: 'eslint .' } } }), { command: 'npm run build', timeoutMs: DEFAULT_TIMEOUT_MS, fallback: 'build' });
  assert.deepEqual(resolveTestCommand({ pkg: { scripts: { lint: 'eslint .' } } }), { command: 'npm run lint', timeoutMs: DEFAULT_TIMEOUT_MS, fallback: 'lint' });
  assert.equal(resolveTestCommand({ pkg: { scripts: { build: 'tsc' }, test: 'x' } }).fallback, 'build');
  assert.equal(resolveTestCommand({ pkg: { scripts: { test: 'node --test', build: 'tsc' } } }).command, 'npm test', 'a real test script wins');
  assert.equal(resolveTestCommand({ override: { test: 'make check' }, pkg: { scripts: { build: 'tsc' } } }).command, 'make check', 'config wins');
  assert.equal(resolveTestCommand({ pkg: { scripts: { build: '  ' } } }).command, null, 'a blank script is no script');
  assert.equal(resolveTestCommand({ pkg: { scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' } } }).command, 'npm run lint');
});

test('workDirFor lives under <worktrees>/merge-queue', () => {
  assert.equal(workDirFor('/w', 'glmps-1').replace(/\\/g, '/'), '/w/merge-queue/glmps-1');
});

test('runMergeTests pass: merges base into head locally, runs the command in the throwaway worktree, never pushes, cleans up', async () => {
  const o = base();
  const out = await runMergeTests(o);
  assert.equal(out.kind, 'pass');
  assert.deepEqual(
    { ...out.tests, durationMs: typeof out.tests.durationMs },
    {
      status: 'pass', treeSha: TREE, headSha: 'aaa111', mergedBaseSha: 'bbb222', durationMs: 'number', timeoutMs: DEFAULT_TIMEOUT_MS, tail: 'ok',
      selection: { mode: 'full', reason: 'the test command is not the repo test script' },
    },
  );
  assert.equal(out.command, 'npm test', 'the outcome names the command it ran');
  const cmds = o.git.calls.map((c) => c.args.join(' '));
  assert.ok(cmds.some((c) => c === 'fetch -q origin'));
  assert.ok(cmds.some((c) => c === 'worktree add --detach /wt/c1 origin/feat/x'));
  assert.ok(cmds.some((c) => /merge --no-ff .*origin\/main$/.test(c)));
  assert.ok(!cmds.some((c) => /\bpush\b/.test(c)));
  assert.equal(cmds.at(-1), 'worktree remove --force /wt/c1');
});

test('runMergeTests: the tree sha is read after the base merge, and an unreadable tree leaves it null without failing the stage', async () => {
  const o = base();
  await runMergeTests(o);
  const cmds = o.git.calls.map((c) => c.args.join(' '));
  assert.ok(cmds.indexOf('rev-parse HEAD^{tree}') > cmds.findIndex((c) => /merge --no-ff/.test(c)), 'tree read after the merge');
  const out = await runMergeTests(base({ git: happyGit((a) => (has(a, 'rev-parse', 'HEAD^{tree}') ? { status: 128, stderr: 'bad' } : undefined)) }));
  assert.equal(out.kind, 'pass');
  assert.equal(out.tests.treeSha, null);
});

test('runMergeTests runs the configured command in the worktree with the timeout', async () => {
  let seen;
  const o = base({ override: { test: 'make check', timeoutMs: 777 }, runTest: async (a) => { seen = a; return { exitCode: 0, tail: '', durationMs: 1 }; } });
  await runMergeTests(o);
  assert.deepEqual(seen, { command: 'make check', cwd: '/wt/c1', timeoutMs: 777 });
});

test('runMergeTests fail: non-zero exit is a fail with the reason and the tail, worktree still removed', async () => {
  const o = base({ runTest: async () => ({ exitCode: 1, timedOut: false, tail: 'not ok 3', durationMs: 5 }) });
  const out = await runMergeTests(o);
  assert.equal(out.kind, 'fail');
  assert.equal(out.tests.status, 'fail');
  assert.equal(out.tests.reason, 'exit code 1 (failed again on a rerun)');
  assert.equal(out.tests.tail, 'not ok 3');
  assert.equal(o.git.calls.at(-1).args.join(' '), 'worktree remove --force /wt/c1');
});

test('runMergeTests reruns a failed run once: a pass on the rerun passes the stage and records the flake', async () => {
  let n = 0;
  const o = base({ runTest: async () => (++n === 1
    ? { exitCode: 1, timedOut: false, tail: 'not ok 1 flaky timing test', durationMs: 5 }
    : { exitCode: 0, timedOut: false, tail: 'ok', durationMs: 6 }) });
  const out = await runMergeTests(o);
  assert.equal(n, 2);
  assert.equal(out.kind, 'pass');
  assert.equal(out.tests.status, 'pass');
  assert.equal(out.tests.flaky.firstTail, 'not ok 1 flaky timing test');
  assert.equal(out.tests.flaky.firstExitCode, 1);
  const { text } = applyOutcome(o.mr, out, { now: NOW, queue: [], id: 'c1' });
  assert.match(text, /on a rerun: the first run exited 1/);
});

test('runMergeTests: a run that fails twice fails, and says it was rerun', async () => {
  let n = 0;
  const o = base({ runTest: async () => { n++; return { exitCode: 1, timedOut: false, tail: 'not ok 3', durationMs: 5 }; } });
  const out = await runMergeTests(o);
  assert.equal(n, 2);
  assert.equal(out.kind, 'fail');
  assert.equal(out.tests.reason, 'exit code 1 (failed again on a rerun)');
});

test('runMergeTests: a timeout is not rerun', async () => {
  let n = 0;
  const o = base({ runTest: async () => { n++; return { exitCode: null, timedOut: true, tail: '', durationMs: 5 }; } });
  await runMergeTests(o);
  assert.equal(n, 1);
});

test('runMergeTests: a timeout is its own outcome, never a pass, and says so', async () => {
  const o = base({ override: { test: 'x', timeoutMs: 50 }, runTest: async () => ({ exitCode: null, timedOut: true, tail: 'hang', durationMs: 50 }) });
  const out = await runMergeTests(o);
  assert.equal(out.kind, 'timeout');
  assert.equal(out.tests.status, 'fail');
  assert.match(out.tests.reason, /timed out after 50 ms/);
});

test('runMergeTests error: an executor throw is an error outcome, worktree still removed', async () => {
  const o = base({ runTest: async () => { throw new Error('spawn exploded'); } });
  const out = await runMergeTests(o);
  assert.equal(out.kind, 'error');
  assert.equal(out.tests.status, 'error');
  assert.match(out.tests.reason, /spawn exploded/);
  assert.equal(o.git.calls.at(-1).args.join(' '), 'worktree remove --force /wt/c1');
});

test('runMergeTests error: a git failure (fetch) is an error outcome and no test runs', async () => {
  let ran = false;
  const o = base({ git: happyGit((a) => (has(a, 'fetch') ? { status: 128, stderr: 'no network' } : undefined)), runTest: async () => { ran = true; return passRun(); } });
  const out = await runMergeTests(o);
  assert.equal(out.kind, 'error');
  assert.match(out.tests.reason, /fetch.*no network/);
  assert.equal(ran, false);
});

// The service has no GitHub sign-in, so its git and test runs go through the desktop
// shell. When that is not available the request is held, never bounced to the author.
const noShell = () => Object.assign(new Error('gitops broker: the desktop app did not pick this up within 10000 ms (is the GLMPS 2.0 desktop app running?)'), { code: 'NO_SHELL' });

test('runMergeTests hold: no desktop shell during fetch is a held outcome naming the desktop app, no tests run, cleanup does not throw', async () => {
  let ran = false;
  const git = fakeGit(() => { throw noShell(); });
  const out = await runMergeTests(base({ git, runTest: async () => { ran = true; return passRun(); } }));
  assert.equal(out.kind, 'held');
  assert.match(out.reason, /desktop app/);
  assert.equal(ran, false);
});

test('runMergeTests hold: a shell refusal or a shell that dies mid-run holds too, and the test executor path holds as well', async () => {
  const refused = Object.assign(new Error('refused by shell: git push is not allowed'), { code: 'REFUSED' });
  const out1 = await runMergeTests(base({ git: happyGit((a) => { if (has(a, 'merge', '--no-ff')) throw refused; return undefined; }) }));
  assert.equal(out1.kind, 'held');
  assert.match(out1.reason, /refused by shell/);
  const out2 = await runMergeTests(base({ runTest: async () => { throw noShell(); } }));
  assert.equal(out2.kind, 'held');
  assert.match(out2.reason, /desktop app/);
});

test('runMergeTests hold: after a held test run the worktree removal is still attempted', async () => {
  const o = base({ runTest: async () => { throw noShell(); } });
  await runMergeTests(o);
  assert.equal(o.git.calls.at(-1).args.join(' '), 'worktree remove --force /wt/c1');
});

test('applyOutcome held: testing -> held with the reason on the card, never bounced', () => {
  const r = applyOutcome(testingMr(), { kind: 'held', reason: 'the desktop app is not running' }, { now: NOW });
  assert.equal(r.mergeRequest.stage, 'held');
  assert.match(r.mergeRequest.history.at(-1).reason, /desktop app is not running/);
  assert.match(r.text, /held.*desktop app is not running/);
});

test('runMergeTests conflict: aborts the merge, lists files, runs no tests', async () => {
  let ran = false;
  const g = happyGit((a) => {
    if (has(a, '--no-ff')) return { status: 1, stdout: 'CONFLICT' };
    if (has(a, 'diff', '--diff-filter=U')) return { stdout: 'a.txt\nsub/b.txt\n' };
    return undefined;
  });
  const out = await runMergeTests(base({ git: g, runTest: async () => { ran = true; return passRun(); } }));
  assert.equal(out.kind, 'conflict');
  assert.deepEqual(out.conflict, { files: ['a.txt', 'sub/b.txt'] });
  assert.equal(ran, false);
  const cmds = g.calls.map((c) => c.args.join(' '));
  assert.ok(cmds.includes('merge --abort'));
  assert.equal(cmds.at(-1), 'worktree remove --force /wt/c1');
});

test('runMergeTests: a merge that fails without conflicts is an error, not a conflict', async () => {
  const g = happyGit((a) => (has(a, '--no-ff') ? { status: 128, stderr: 'unrelated histories' } : undefined));
  const out = await runMergeTests(base({ git: g }));
  assert.equal(out.kind, 'error');
  assert.match(out.tests.reason, /unrelated histories/);
});

test('runMergeTests: a head that moved since filing is tested at its new sha and reported', async () => {
  const g = happyGit((a) => (has(a, 'rev-parse', 'HEAD') ? { stdout: 'ccc333\n' } : undefined));
  const out = await runMergeTests(base({ git: g }));
  assert.equal(out.kind, 'pass');
  assert.equal(out.headSha, 'ccc333');
  assert.equal(out.tests.headSha, 'ccc333');
  assert.deepEqual(out.headMoved, { from: 'aaa111', to: 'ccc333' });
});

test('runMergeTests: no test command records a skip and still passes the stage', async () => {
  let ran = false;
  const out = await runMergeTests(base({ override: null, readPkg: () => ({ scripts: {} }), runTest: async () => { ran = true; return passRun(); } }));
  assert.equal(out.kind, 'pass');
  assert.deepEqual(
    { status: out.tests.status, reason: out.tests.reason, headSha: out.tests.headSha, mergedBaseSha: out.tests.mergedBaseSha },
    { status: 'skipped', reason: 'no test command configured', headSha: 'aaa111', mergedBaseSha: 'bbb222' },
  );
  assert.equal(ran, false);
});

test('runMergeTests: with no test script it runs the build script and says so on the record', async () => {
  let cmd;
  const out = await runMergeTests(base({ override: null, readPkg: () => ({ scripts: { build: 'tsc' } }), runTest: async (a) => { cmd = a.command; return passRun(); } }));
  assert.equal(cmd, 'npm run build');
  assert.equal(out.kind, 'pass');
  assert.equal(out.tests.status, 'pass');
  assert.equal(out.tests.command, 'npm run build');
  assert.match(out.tests.reason, /no test command; ran the build script/);
  const bad = await runMergeTests(base({ override: null, readPkg: () => ({ scripts: { lint: 'eslint .' } }), runTest: async () => ({ exitCode: 1, timedOut: false, tail: 'lint errors', durationMs: 1 }) }));
  assert.equal(bad.kind, 'fail');
  assert.equal(bad.tests.command, 'npm run lint');
});

test('runMergeTests reads package.json from the merged worktree for the default command', async () => {
  let dirSeen; let cmd;
  await runMergeTests(base({
    override: null,
    // package.json in the diff keeps the full suite (glmps-2-0-runtime-98).
    git: happyGit((args) => (args[0] === 'diff' ? { stdout: 'package.json' } : undefined)),
    readPkg: (d) => { dirSeen = d; return { scripts: { test: 'node --test' } }; },
    runTest: async (a) => { cmd = a.command; return passRun(); },
  }));
  assert.equal(dirSeen, '/wt/c1');
  assert.equal(cmd, 'npm test');
});

test('applyOutcome pass: testing -> merging with the tests recorded; no per-PR reviewer (glmps-2-0-runtime-125)', () => {
  const tests = { status: 'pass', headSha: 'aaa111', mergedBaseSha: 'bbb222', durationMs: 3, tail: 'ok' };
  const r = applyOutcome(testingMr(), { kind: 'pass', headSha: 'aaa111', tests }, { now: NOW });
  assert.equal(r.mergeRequest.stage, 'merging');
  assert.deepEqual(r.mergeRequest.tests, tests);
  assert.match(r.text, /tests passed/);
});

test('applyOutcome skipped pass says the tests were skipped and why', () => {
  const tests = { status: 'skipped', reason: 'no test command configured', headSha: 'a', mergedBaseSha: 'b' };
  const r = applyOutcome(testingMr(), { kind: 'pass', headSha: 'a', tests }, { now: NOW });
  assert.equal(r.mergeRequest.stage, 'merging');
  assert.match(r.text, /skipped.*no test command configured/);
});

test('applyOutcome fail and error bounce with the reason', () => {
  for (const kind of ['fail', 'error']) {
    const tests = { status: kind, reason: 'exit code 1', tail: 't' };
    const r = applyOutcome(testingMr(), { kind, tests }, { now: NOW });
    assert.equal(r.mergeRequest.stage, 'bounced', kind);
    assert.equal(r.mergeRequest.tests.status, kind);
    assert.match(r.text, new RegExp(`tests ${kind}.*exit code 1`));
    assert.match(r.mergeRequest.history.at(-1).reason, /exit code 1/);
  }
});

test('applyOutcome conflict bounces to the author with the files; there is no conflict-repair reviewer (glmps-2-0-runtime-125)', () => {
  const r = applyOutcome(testingMr(), { kind: 'conflict', conflict: { files: ['a.txt'] } }, { now: NOW });
  assert.equal(r.mergeRequest.stage, 'bounced');
  assert.deepEqual(r.mergeRequest.conflict, { files: ['a.txt'] });
  assert.match(r.mergeRequest.history.at(-1).reason, /merge conflict.*a\.txt/);
  assert.match(r.text, /conflict.*a\.txt.*bounced/);
});

test('applyOutcome records a moved head in the record and the history', () => {
  const tests = { status: 'pass', headSha: 'ccc333', mergedBaseSha: 'b' };
  const r = applyOutcome(testingMr(), { kind: 'pass', headSha: 'ccc333', headMoved: { from: 'aaa111', to: 'ccc333' }, tests }, { now: NOW });
  assert.equal(r.mergeRequest.headSha, 'ccc333');
  assert.ok(r.mergeRequest.history.some((h) => /head moved aaa111.*ccc333/.test(h.reason)));
});

test('a final-round failure holds instead of bouncing (queue rule is kept)', () => {
  const mr = { ...testingMr(), round: 3 };
  const r = applyOutcome(mr, { kind: 'fail', tests: { status: 'fail', reason: 'exit code 1' } }, { now: NOW });
  assert.equal(r.mergeRequest.stage, 'held');
});

test('a test bounce records the failing test files and names them in the devlog line', () => {
  const tail = 'not ok 1 - x\n  test at server\\test\\b.test.js:9:1\n  test at server/test/a.test.js:3:1\n  test at server/test/a.test.js:7:1';
  const r = applyOutcome(testingMr(), { kind: 'fail', tests: { status: 'fail', reason: 'exit code 1', tail } }, { now: NOW });
  assert.equal(r.mergeRequest.stage, 'bounced');
  assert.deepEqual(r.mergeRequest.tests.failedFiles, ['server/test/a.test.js', 'server/test/b.test.js']);
  assert.match(r.text, /exit code 1 in server\/test\/a\.test\.js, server\/test\/b\.test\.js; bounced/);
  assert.match(r.mergeRequest.history.at(-1).reason, /in server\/test\/a\.test\.js/);
  const none = applyOutcome(testingMr(), { kind: 'fail', tests: { status: 'fail', reason: 'exit code 1', tail: 'boom' } }, { now: NOW });
  assert.deepEqual(none.mergeRequest.tests.failedFiles, []);
  assert.match(none.text, /^tests fail: exit code 1; bounced/);
});

test('markRestarted adds a history line and keeps the stage', () => {
  const m = markRestarted(testingMr(), { now: NOW });
  assert.equal(m.stage, 'testing');
  assert.match(m.history.at(-1).reason, /restarted after server restart/);
});

test('tail is capped at TAIL_CHARS', () => {
  assert.equal(TAIL_CHARS, 4000);
});


function sh(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim(); }

function fixture(t, { conflict = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqtests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  fs.mkdirSync(origin);
  sh(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) sh(seed, 'config', k, v);
  fs.writeFileSync(path.join(seed, 'shared.txt'), 'line\n');
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'fx', scripts: {} }));
  sh(seed, 'add', '.'); sh(seed, 'commit', '-q', '-m', 'seed');
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '-q', 'origin', 'main');
  sh(seed, 'checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(seed, conflict ? 'shared.txt' : 'feature.txt'), 'from head\n');
  sh(seed, 'add', '.'); sh(seed, 'commit', '-q', '-m', 'head change');
  const headSha = sh(seed, 'rev-parse', 'HEAD');
  sh(seed, 'push', '-q', 'origin', 'feat/x');
  sh(seed, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(seed, conflict ? 'shared.txt' : 'base-only.txt'), 'from base\n');
  sh(seed, 'add', '.'); sh(seed, 'commit', '-q', '-m', 'base advances');
  const baseSha = sh(seed, 'rev-parse', 'HEAD');
  sh(seed, 'push', '-q', 'origin', 'main');
  // the "local checkout" the server would find: a clone that has not fetched yet
  sh(root, 'clone', '-q', origin, clone);
  return { root, origin, clone, headSha, baseSha, workDir: path.join(root, 'wts', 'merge-queue', 'c1') };
}

function realMr(headSha) {
  return { ...testingMr(), head: 'feat/x', base: 'main', headSha };
}

test('real git: fetch, throwaway worktree at the head, base merged in, test passes, worktree removed, nothing pushed, tree recorded', async (t) => {
  const f = fixture(t);
  const originMainBefore = sh(f.origin, 'rev-parse', 'main');
  const out = await runMergeTests({
    mr: realMr(f.headSha), repoPath: f.clone, workDir: f.workDir,
    override: { test: 'node -e "process.exit(require(\'fs\').existsSync(\'base-only.txt\') && require(\'fs\').existsSync(\'feature.txt\') ? 0 : 3)"', timeoutMs: 60000 },
  });
  assert.equal(out.kind, 'pass', JSON.stringify(out));
  assert.equal(out.tests.status, 'pass');
  assert.equal(out.tests.headSha, f.headSha);
  assert.equal(out.tests.mergedBaseSha, f.baseSha);
  assert.equal(fs.existsSync(f.workDir), false);
  assert.equal(sh(f.clone, 'worktree', 'list', '--porcelain').includes('merge-queue'), false);
  assert.equal(sh(f.origin, 'rev-parse', 'main'), originMainBefore);
  // The recorded tree is the tree of the merge commit the PR lands as: GitHub's
  // merge has the base as first parent, the queue's test merge has the head first.
  assert.match(out.tests.treeSha, /^[0-9a-f]{40}$/);
  const land = path.join(f.root, 'land');
  sh(f.root, 'clone', '-q', f.origin, land);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) sh(land, 'config', k, v);
  sh(land, 'merge', '--no-ff', '-q', '-m', 'Merge pull request #7', 'origin/feat/x');
  assert.equal(sh(land, 'rev-parse', 'HEAD^{tree}'), out.tests.treeSha);
});

test('real git: a failing test command fails with exit code and output tail', async (t) => {
  const f = fixture(t);
  const out = await runMergeTests({
    mr: realMr(f.headSha), repoPath: f.clone, workDir: f.workDir,
    override: { test: 'node -e "console.log(\'boom-marker\'); process.exit(1)"', timeoutMs: 60000 },
  });
  assert.equal(out.kind, 'fail');
  assert.equal(out.tests.reason, 'exit code 1 (failed again on a rerun)');
  assert.match(out.tests.tail, /boom-marker/);
  assert.equal(fs.existsSync(f.workDir), false);
});

test('real git: a timeout kills the command and fails closed', async (t) => {
  const f = fixture(t);
  const out = await runMergeTests({
    mr: realMr(f.headSha), repoPath: f.clone, workDir: f.workDir,
    override: { test: 'node -e "setTimeout(()=>{},60000)"', timeoutMs: 700 },
  });
  assert.equal(out.kind, 'timeout');
  assert.match(out.tests.reason, /timed out/);
  assert.equal(fs.existsSync(f.workDir), false);
});

test('real git: a textual conflict is aborted, listed, and routed without running tests', async (t) => {
  const f = fixture(t, { conflict: true });
  const out = await runMergeTests({
    mr: realMr(f.headSha), repoPath: f.clone, workDir: f.workDir,
    override: { test: 'node -e "process.exit(0)"', timeoutMs: 60000 },
  });
  assert.equal(out.kind, 'conflict');
  assert.deepEqual(out.conflict.files, ['shared.txt']);
  assert.equal(fs.existsSync(f.workDir), false);
});

test('real git: no test script in package.json records a skip', async (t) => {
  const f = fixture(t);
  const out = await runMergeTests({ mr: realMr(f.headSha), repoPath: f.clone, workDir: f.workDir, override: null });
  assert.equal(out.kind, 'pass');
  assert.equal(out.tests.status, 'skipped');
  assert.equal(out.tests.reason, 'no test command configured');
});

// glmps-2-0-runtime-112: the shell allowlist has no ls-files, so affected-test
// selection lists the worktree's test files from the filesystem.
const lsRefused = () => Object.assign(new Error('refused by shell: git ls-files is not allowed'), { code: 'REFUSED' });
const npmPkg = { scripts: { test: 'node --test "**/*.test.js"' } };

test('runMergeTests selects affected tests without git ls-files, which the shell refuses', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-ls-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const workDir = path.join(tmp, 'wt');
  const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(workDir, rel)), { recursive: true }); fs.writeFileSync(path.join(workDir, rel), body); };
  const git = happyGit((a) => {
    if (a[0] === 'ls-files') throw lsRefused();
    if (has(a, 'worktree', 'add')) {
      write('server/test/a.test.js', "import '../lib/a.js';");
      write('server/test/b.test.js', "import '../lib/b.js';");
      write('node_modules/dep/x.test.js', '');
      write('.git', 'gitdir: elsewhere');
    }
    if (has(a, 'diff', '--name-only', 'bbb222')) return { stdout: 'server/lib/a.js\n' };
    return undefined;
  });
  let seen = null;
  const out = await runMergeTests({ ...base({ git }), workDir, override: null, readPkg: () => npmPkg, runTest: async (r) => { seen = r; return passRun(); } });
  assert.equal(out.kind, 'pass', JSON.stringify(out));
  assert.ok(!git.calls.some((c) => c.args[0] === 'ls-files'), 'no ls-files call');
  assert.deepEqual(out.tests.selection, { mode: 'affected', files: 1, of: 2 });
  assert.equal(seen.command, 'node --test server/test/a.test.js');
});

test('runMergeTests runs the full suite, never holds, when the test files cannot be listed', async () => {
  const git = happyGit((a) => (has(a, 'diff', '--name-only', 'bbb222') ? { stdout: 'server/lib/a.js\n' } : undefined));
  let seen = null;
  const out = await runMergeTests({
    ...base({ git }), override: null, readPkg: () => npmPkg,
    listFiles: () => { throw new Error('EACCES: permission denied'); },
    runTest: async (r) => { seen = r; return passRun(); },
  });
  assert.equal(out.kind, 'pass');
  assert.equal(seen.command, 'npm test');
  assert.equal(out.tests.selection.mode, 'full');
  assert.match(out.tests.selection.reason, /could not list the test files: EACCES/);
});

// glmps-2-0-runtime-125: on a red base the queue merges only a PR that proves it leaves those files green.
const RED = { sha: 'r'.repeat(40), ts: NOW, files: ['server/test/x.test.js'], cardId: 'red-card' };
const passWith = (selection) => ({ kind: 'pass', headSha: 'aaa111', tests: { status: 'pass', headSha: 'aaa111', mergedBaseSha: 'b', selection } });

test('red base: a pass that ran every failing file is a fix and goes to merging, marked for this red', () => {
  const r = applyOutcome(testingMr(), passWith({ mode: 'affected', files: 2, of: 9, redFiles: ['server/test/x.test.js'] }), { now: NOW, red: RED, id: 'c1' });
  assert.equal(r.mergeRequest.stage, 'merging');
  assert.equal(r.mergeRequest.redFix, RED.sha);
  assert.match(r.text, /fixes the red full suite/);
});

test('red base: a full-suite pass, or a pass on the card filed for the red, is a fix too', () => {
  assert.equal(applyOutcome(testingMr(), passWith({ mode: 'full', reason: 'x' }), { now: NOW, red: RED, id: 'c1' }).mergeRequest.stage, 'merging');
  const none = { ...RED, files: [] };
  assert.equal(applyOutcome(testingMr(), passWith({ mode: 'affected', files: 1, of: 9 }), { now: NOW, red: none, id: 'red-card' }).mergeRequest.stage, 'merging');
});

test('red base: any other pass is a red hold: back to requested, no round, author not relaunched', () => {
  const r = applyOutcome(testingMr(), passWith({ mode: 'affected', files: 1, of: 9 }), { now: NOW, red: { ...RED, files: [] }, id: 'c1' });
  assert.equal(r.mergeRequest.stage, 'requested');
  assert.equal(r.mergeRequest.redHold, RED.sha);
  assert.equal(r.mergeRequest.round, 1);
  assert.equal(r.mergeRequest.queuedAt, NOW);
  assert.match(r.text, /paused: the full suite is red on main/);
});

test('red base: a failure only in the red run\'s failing files is the base, not the PR: red hold, not a bounce', () => {
  const fail = { kind: 'fail', tests: { status: 'fail', reason: 'exit code 1', tail: 'test at server/test/x.test.js:3:1' } };
  const r = applyOutcome(testingMr(), fail, { now: NOW, red: RED, id: 'c1' });
  assert.equal(r.mergeRequest.stage, 'requested');
  assert.equal(r.mergeRequest.redHold, RED.sha);
  const other = { kind: 'fail', tests: { status: 'fail', reason: 'exit code 1', tail: 'test at server/test/y.test.js:3:1\ntest at server/test/x.test.js:3:1' } };
  assert.equal(applyOutcome(testingMr(), other, { now: NOW, red: RED, id: 'c1' }).mergeRequest.stage, 'bounced', 'a failure outside the red files is the PR\'s');
});

test('red base: the testing stage adds the red run\'s failing files to the affected run', async () => {
  let cmd = null;
  const out = await runMergeTests({
    mr: mr0(), repoPath: '/repo', workDir: '/wt/c1', extraTests: ['server/test/x.test.js', 'server/test/gone.test.js'],
    git: async (args) => ({ status: 0, stdout: args[0] === 'diff' ? 'server/lib/y.js\n' : args[0] === 'rev-parse' ? `${args[1] === 'HEAD' ? 'aaa111' : 'b'.repeat(40)}\n` : '', stderr: '' }),
    readPkg: () => ({ scripts: { test: 'node --test "**/*.test.js"' } }),
    listFiles: () => ['server/test/x.test.js', 'server/test/y.test.js'],
    readTest: (dir, f) => (f.endsWith('y.test.js') ? "import '../lib/y.js';" : ''),
    runTest: async (a) => { cmd = a.command; return { exitCode: 0, timedOut: false, tail: 'ok', durationMs: 1 }; },
  });
  assert.equal(out.kind, 'pass');
  assert.equal(cmd, 'node --test server/test/x.test.js server/test/y.test.js');
  assert.deepEqual(out.tests.selection.redFiles, ['server/test/x.test.js'], 'a failing file the PR deleted is not run');
});
