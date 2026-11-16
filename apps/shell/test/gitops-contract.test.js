// Card glmps-2-0-runtime-125 (absorbs -119): the kernel callers that send git
// through this shell must only issue argv the allowlist accepts. A fake git
// records every call while the caller walks its pass and red paths, and each
// recorded call is replayed through validateGitopsOp. The full-suite loop
// failed 16 runs in a row on 'git rev-list is not allowed' because nothing
// checked this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGitopsOp } from '../src/lib/gitops-allow.js';
import { createMainSuiteLoop, NIGHTLY_MS } from '../../../server/lib/orchestration/main-suite.js';
import { runMergeTests } from '../../../server/lib/orchestration/merge-tests.js';

const REPO = 'D:\\glmps';
const WT = 'C:\\Users\\op\\.glmps\\runner\\worktrees';
const roots = { repos: [REPO] };
const NOW = Date.parse('2026-11-01T20:00:00.000Z');
const SHA = (c) => c.repeat(40);

function refusals(calls) {
  return calls
    .map((c) => ({ ...c, v: validateGitopsOp({ kind: 'git', args: c.args, cwd: c.cwd }, { roots, worktreesDir: WT }) }))
    .filter((c) => !c.v.ok)
    .map((c) => `${c.args.join(' ')} (cwd ${c.cwd}): ${c.v.reason}`);
}

function mainSuiteHarness({ results, state }) {
  const calls = [];
  const shaAt = new Map();
  const commits = [SHA('1'), SHA('2'), SHA('3'), SHA('9')];
  const git = async (args, { cwd }) => {
    calls.push({ args, cwd });
    if (args[0] === 'rev-parse' && args[1].endsWith('^{tree}')) return { status: 0, stdout: `${SHA('e')}\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${SHA('9')}\n`, stderr: '' };
    if (args[0] === 'log' && args.includes('--format=%H')) return { status: 0, stdout: [...commits].reverse().join('\n'), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'add') shaAt.set(args[3], args[4]);
    if (args[0] === 'log') return { status: 0, stdout: 'Merge pull request #7\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const runTest = async ({ cwd }) => {
    const r = results[shaAt.get(cwd)] ?? 'pass';
    return { exitCode: r === 'pass' ? 0 : 1, timedOut: false, tail: r === 'pass' ? 'ok' : 'test at server/test/x.test.js:3:1', durationMs: 5 };
  };
  let doc = state;
  const loop = createMainSuiteLoop({
    targets: async () => [{ key: 'wolfeb-dev/glmps@glmps2/main', repo: 'wolfeb-dev/glmps', base: 'glmps2/main', project: 'p', repoPath: REPO }],
    git, runTest, readPkg: () => ({ scripts: { test: 'node --test "**/*.test.js"' } }),
    readState: () => doc, writeState: (d) => { doc = d; },
    queueBusy: () => false, fileCard: () => ({ item: { id: 'c-red' } }),
    workDirFor: () => `${WT}\\merge-queue\\main-suite-wolfeb-dev_glmps_glmps2_main`,
    nowMs: () => NOW, recordTree: () => {},
  });
  return { loop, calls };
}

test('the full-suite loop issues only git argv the shell allows, on the green path', async () => {
  const h = mainSuiteHarness({ results: {}, state: { 'wolfeb-dev/glmps@glmps2/main': { lastTestedSha: SHA('0'), lastGreenSha: SHA('0'), lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() } } });
  assert.equal((await h.loop.maker()).outcome, 'done');
  assert.ok(h.calls.some((c) => c.args[0] === 'log' && c.args.includes('--format=%H')), 'the green path counts merges since the last run');
  assert.deepEqual(refusals(h.calls), []);
});

test('the full-suite loop issues only git argv the shell allows, on the red path with a bisect and a named culprit', async () => {
  const h = mainSuiteHarness({
    results: { [SHA('2')]: 'fail', [SHA('3')]: 'fail', [SHA('9')]: 'fail' },
    state: { 'wolfeb-dev/glmps@glmps2/main': { lastTestedSha: SHA('0'), lastGreenSha: SHA('0'), lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() } },
  });
  await h.loop.maker();
  assert.ok(h.calls.some((c) => c.args[0] === 'log'), 'the red path reads the culprit subject');
  assert.equal(h.calls.filter((c) => c.args[0] === 'log' && c.args.includes('--format=%H')).length, 2, 'the red path counts, then lists the merges to bisect');
  assert.deepEqual(refusals(h.calls), []);
});

function mergeTestsHarness({ mergeFails = false } = {}) {
  const calls = [];
  const git = async (args, { cwd }) => {
    calls.push({ args, cwd });
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${args[1] === 'HEAD^{tree}' ? SHA('e') : args[1] === 'HEAD' ? SHA('a') : SHA('b')}\n`, stderr: '' };
    if (args.includes('merge') && !args.includes('--abort') && mergeFails) return { status: 1, stdout: '', stderr: 'CONFLICT' };
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) return { status: 0, stdout: 'server/server.js\n', stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: 'server/lib/x.js\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const mr = { repo: 'wolfeb-dev/glmps', number: 5, base: 'glmps2/main', head: 'card/x', headSha: SHA('a'), history: [] };
  const run = () => runMergeTests({
    mr, repoPath: REPO, workDir: `${WT}\\merge-queue\\card-x`, git,
    runTest: async () => ({ exitCode: 0, timedOut: false, tail: 'ok', durationMs: 5 }),
    readPkg: () => ({ scripts: { test: 'node --test "**/*.test.js"' } }),
    readTest: () => "import '../lib/x.js';", listFiles: () => ['server/test/x.test.js'],
  });
  return { run, calls };
}

test('the testing stage issues only git argv the shell allows, on the pass path', async () => {
  const h = mergeTestsHarness();
  assert.equal((await h.run()).kind, 'pass');
  assert.deepEqual(refusals(h.calls), []);
});

test('the testing stage issues only git argv the shell allows, on the conflict path', async () => {
  const h = mergeTestsHarness({ mergeFails: true });
  assert.equal((await h.run()).kind, 'conflict');
  assert.deepEqual(refusals(h.calls), []);
});

// glmps-2-0-runtime-128, -130: rev-list is off the allowlist, so the loop must
// never send it. This fake shell refuses whatever the allowlist refuses, as the
// installed shell does, and the bisect must still name the culprit.
test('the full-suite loop names a culprit through a shell that enforces the allowlist on every call', async () => {
  const calls = [];
  const shaAt = new Map();
  const commits = [SHA('1'), SHA('2'), SHA('3'), SHA('9')];
  const git = async (args, { cwd }) => {
    calls.push({ args, cwd });
    const v = validateGitopsOp({ kind: 'git', args, cwd }, { roots, worktreesDir: WT });
    if (!v.ok) throw Object.assign(new Error(`refused by shell: ${v.reason}`), { code: 'REFUSED' });
    if (args[0] === 'rev-parse' && args[1].endsWith('^{tree}')) return { status: 0, stdout: `${SHA('e')}\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${SHA('9')}\n`, stderr: '' };
    if (args[0] === 'log' && args.includes('--format=%H')) return { status: 0, stdout: [...commits].reverse().join('\n'), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'add') shaAt.set(args[3], args[4]);
    if (args[0] === 'log') return { status: 0, stdout: 'Merge pull request #7\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let doc = { 'wolfeb-dev/glmps@glmps2/main': { lastTestedSha: SHA('0'), lastGreenSha: SHA('0'), lastRunTs: new Date(NOW - NIGHTLY_MS).toISOString() } };
  const red = new Set([SHA('2'), SHA('3'), SHA('9')]);
  const sep = String.fromCharCode(92);
  const loop = createMainSuiteLoop({
    targets: async () => [{ key: 'wolfeb-dev/glmps@glmps2/main', repo: 'wolfeb-dev/glmps', base: 'glmps2/main', project: 'p', repoPath: REPO }],
    git,
    runTest: async ({ cwd }) => (red.has(shaAt.get(cwd)) ? { exitCode: 1, timedOut: false, tail: 'test at server/test/x.test.js:3:1', durationMs: 5 } : { exitCode: 0, timedOut: false, tail: 'ok', durationMs: 5 }),
    readPkg: () => ({ scripts: { test: 'node --test "**/*.test.js"' } }),
    readState: () => doc, writeState: (d) => { doc = d; },
    queueBusy: () => false, fileCard: () => ({ item: { id: 'c-red' } }),
    workDirFor: () => [WT, 'merge-queue', 'main-suite-wolfeb-dev_glmps_glmps2_main'].join(sep),
    nowMs: () => NOW, recordTree: () => {},
  });
  assert.equal((await loop.maker()).outcome, 'done');
  assert.equal(doc['wolfeb-dev/glmps@glmps2/main'].red.culprit, SHA('2'));
  assert.equal(calls.filter((c) => c.args[0] === 'rev-list').length, 0);
  assert.deepEqual(refusals(calls), []);
});

// glmps-2-0-155: the QA-trends CI sampler sends gh through this shell, so a
// gh the allowlist refuses is answered as the shell would answer it.
test('the QA-trends sampler records a run through a shell that enforces the allowlist on every gh call', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { sampleLatestRun, readQaTrends } = await import('../../../server/lib/observability/qa-trends-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-qat-contract-'));
  try {
    const refused = [];
    const gh = async (file, args) => {
      const v = validateGitopsOp({ kind: 'gh', args }, { roots, worktreesDir: WT });
      if (!v.ok) { refused.push(`${args.join(' ')}: ${v.reason}`); return { status: 1, stdout: '', stderr: v.reason }; }
      if (args[1] === 'list' && args[0] === 'run') return { status: 0, stdout: JSON.stringify([{ databaseId: 7, conclusion: 'success', status: 'completed', headSha: 'abc1234', createdAt: '2026-11-06T17:31:44Z' }]) };
      if (args[0] === 'run' && args[3] === '-R' && args[5] === '--json') return { status: 0, stdout: JSON.stringify({ jobs: [{ databaseId: 70, name: 'test' }] }) };
      if (args[2] === '--job') return { status: 0, stdout: '# tests 5\n# pass 5\n# fail 0\n' };
      return { status: 0, stdout: '[]' };
    };
    const p = await sampleLatestRun(dir, { gh, repo: 'wolfeb-dev/glmps-2.0' });
    assert.deepEqual(refused, []);
    assert.deepEqual([p?.testCount, p?.fail], [5, 0]);
    assert.equal(readQaTrends(dir).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
