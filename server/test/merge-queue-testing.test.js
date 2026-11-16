import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn, setGateIn, setPausedIn, load, releaseToIdleIn, updateItemIn } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { createMergeRequest, transition } from '../lib/orchestration/merge-queue.js';
import { readTestedTrees, findTestedTree } from '../lib/orchestration/tested-trees.js';
import { waitFor } from './helpers/wait-for.js';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqtest-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    runnerTickMs: 1000000000,
    mergeQueue: { repos: { 'acme/widgets': { path: checkout, test: 'npm test', timeoutMs: 1234 } } },
  }));
  return {
    tmp, checkout, configFile,
    env: {
      ...process.env,
      GLMPS_CLAUDE_DIR: claudeDir,
      GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
      GLMPS_STATE_DIR: path.join(tmp, 'state'),
      GLMPS_WORKTREES_DIR: path.join(tmp, 'wts'),
      GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
      GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
      GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
      GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
      GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
      GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
      GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
      GLMPS_UNMERGED_SCAN: 'off',
      GLMPS_RUNNER_DRYRUN: '1',
    },
  };
}

const PASS = (extra = {}) => ({
  kind: 'pass', headSha: 'aaa111',
  tests: { status: 'pass', headSha: 'aaa111', mergedBaseSha: 'bbb222', durationMs: 9, tail: 'all green' }, ...extra,
});

async function withQueue(fn, { run, enabled = true, serverOpts = {} } = {}) {
  const e = mkEnv();
  const runs = [];
  const mergeTestsRun = async (args) => {
    runs.push(args);
    return (run ?? (async () => PASS()))(args);
  };
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, mergeTestsRun, ...serverOpts, reviewGit: async () => ({ status: 0, stdout: '', stderr: '' }) });
  const base = `http://127.0.0.1:${srv.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const stateDir = e.env.GLMPS_STATE_DIR;
  if (enabled) saveConfig(stateDir, { enabled: true });
  const fileMr = (id, { filedAt = '2026-10-17T10:00:00.000Z', repo = 'acme/widgets', number = 7 } = {}) => {
    const mr = createMergeRequest({ prUrl: `https://github.com/${repo}/pull/${number}`, repo, number, base: 'main', head: 'feat/x', headSha: 'aaa111', filedBy: 'w' }, { now: filedAt });
    setMergeRequestIn(stateDir, id, mr);
    return mr;
  };
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  try {
    await fn({ srv, j, post, runs, stateDir, fileMr, card, checkout: e.checkout, workRoot: e.env.GLMPS_WORKTREES_DIR });
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
}

test('a requested card goes testing -> merging on a pass, with tests recorded and a devlog line', async () => {
  await withQueue(async ({ srv, post, runs, fileMr, card, checkout, workRoot }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].repoPath, checkout);
    assert.equal(runs[0].override.test, 'npm test');
    assert.equal(runs[0].override.timeoutMs, 1234);
    assert.equal(runs[0].mr.stage, 'testing');
    assert.equal(path.dirname(runs[0].workDir), path.join(workRoot, 'merge-queue'));
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'merging');
    assert.equal(c.mergeRequest.review ?? null, null, 'no reviewer stage in the restored flow');
    assert.equal(c.mergeRequest.tests.status, 'pass');
    assert.equal(c.mergeRequest.tests.headSha, 'aaa111');
    assert.equal(c.mergeRequest.tests.tail, 'all green');
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /tests passed.*on to merging/.test(d.text)));
    assert.deepEqual(c.mergeRequest.history.filter((h) => h.from !== h.to).map((h) => h.to), ['requested', 'testing', 'merging']);
  });
});

test('a worker PASS gate does not move a request forward: it still goes through testing', async () => {
  await withQueue(async ({ srv, post, runs, fileMr, card, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    setGateIn(stateDir, 'glmps-1', { status: 'PASS', evidence: ['self-attested'], by: 'worker' });
    assert.equal(card('glmps-1').gate.status, 'PASS');
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    assert.equal(runs.length, 1, 'the server ran its own tests');
    assert.ok(card('glmps-1').mergeRequest.history.some((h) => h.to === 'testing'));
    assert.equal(card('glmps-1').mergeRequest.stage, 'merging');
  });
  await withQueue(async ({ srv, post, fileMr, card, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    setGateIn(stateDir, 'glmps-1', { status: 'PASS', evidence: ['self-attested'], by: 'worker' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    assert.equal(card('glmps-1').mergeRequest.stage, 'bounced', 'a failing server test beats the PASS gate');
  }, { run: async () => ({ kind: 'fail', tests: { status: 'fail', reason: 'exit code 1', tail: 'x' } }) });
});

test('a test failure bounces the request with the reason on the devlog', async () => {
  await withQueue(async ({ srv, post, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'bounced');
    assert.equal(c.mergeRequest.tests.status, 'fail');
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /tests fail.*exit code 1/.test(d.text)));
  }, { run: async () => ({ kind: 'fail', tests: { status: 'fail', reason: 'exit code 1', tail: 'not ok' } }) });
});

test('a timeout is a load hold: back to requested, no round spent, the author not requeued (glmps-2-0-runtime-98)', async () => {
  await withQueue(async ({ srv, post, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'requested');
    assert.equal(c.mergeRequest.round, 1);
    assert.equal(c.mergeRequest.loadHolds.length, 1);
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /load hold/.test(d.text)));
    assert.ok(!c.devLog.some((d) => /requeued for the author|card held/.test(d.text)));
    assert.notEqual(c.state, 'held');
  }, { run: async () => ({ kind: 'timeout', headSha: 'aaa111', tests: { status: 'fail', timedOut: true, reason: 'timed out after 1234 ms', tail: '' } }) });
});

test('each queue run is recorded with its duration and the node --test count at start; slow runs raise a headroom alert (glmps-2-0-runtime-98)', async () => {
  await withQueue(async ({ srv, j, post, fileMr, card, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    assert.ok(card('glmps-1').devLog.some((d) => /tests passed.*7 node --test running at start/.test(d.text)));
    const file = path.join(stateDir, 'queue', 'merge-queue-runs.json');
    const { runs } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].concurrentTests, 7);
    assert.equal(runs[0].durationMs, 9);
    const before = await j('/api/alerts');
    assert.ok(!JSON.stringify(before.body).includes('merge-queue-headroom'));
    const slow = Array.from({ length: 5 }, (_, i) => ({ ts: new Date().toISOString(), id: `c${i}`, kind: 'pass', durationMs: 20 * 60_000, timeoutMs: 30 * 60_000, concurrentTests: 12 }));
    fs.writeFileSync(file, JSON.stringify({ runs: slow }));
    const after = await j('/api/alerts');
    assert.ok(JSON.stringify(after.body).includes('merge-queue-headroom'));
  }, { serverOpts: { countTestProcs: async () => 7 }, run: async () => PASS({ tests: { status: 'pass', headSha: 'aaa111', mergedBaseSha: 'bbb222', durationMs: 9, timeoutMs: 1234, tail: 'ok' } }) });
});

test('an executor error bounces (fails closed) and is recorded as an error', async () => {
  await withQueue(async ({ srv, post, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'bounced');
    assert.equal(c.mergeRequest.tests.status, 'error');
    assert.match(c.mergeRequest.tests.reason, /kaboom/);
    assert.ok(c.devLog.some((d) => /tests error.*kaboom/.test(d.text)));
  }, { run: async () => { throw new Error('kaboom'); } });
});

test('a merge conflict bounces the request to the author with the conflicting files', async () => {
  await withQueue(async ({ srv, post, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'bounced');
    assert.ok(!c.mergeRequest.reviewKind, 'no conflict-repair reviewer');
    assert.deepEqual(c.mergeRequest.conflict, { files: ['a.txt'] });
    assert.ok(c.mergeRequest.history.some((h) => h.to === 'bounced' && /merge conflict with main in a\.txt/.test(h.reason)));
    assert.ok(c.devLog.some((d) => /merge conflict with main in a\.txt.*bounced to the author/.test(d.text)));
  }, { run: async () => ({ kind: 'conflict', headSha: 'aaa111', conflict: { files: ['a.txt'] } }) });
});

test('a repo with no local checkout bounces with a clear reason and never runs', async () => {
  await withQueue(async ({ srv, post, runs, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1', { repo: 'nobody/nothing' });
    await srv.mergeQueueTick();
    assert.equal(runs.length, 0);
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'bounced');
    assert.match(c.mergeRequest.tests.reason, /no local checkout for nobody\/nothing/);
  });
});

test('the tick does nothing while the runner is disabled or paused', async () => {
  await withQueue(async ({ srv, post, runs, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    assert.equal(runs.length, 0);
    assert.equal(card('glmps-1').mergeRequest.stage, 'requested');
  }, { enabled: false });
  await withQueue(async ({ srv, post, runs, fileMr, card, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    setPausedIn(stateDir, true);
    await srv.mergeQueueTick();
    assert.equal(runs.length, 0);
    assert.equal(card('glmps-1').mergeRequest.stage, 'requested');
  });
});

test('never two jobs for one card: a second tick while the job is in flight starts nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withQueue(async ({ srv, post, runs, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    const first = srv.mergeQueueTick();
    await waitFor(() => runs.length === 1, { message: 'the test job started' });
    assert.equal(card('glmps-1').mergeRequest.stage, 'testing');
    await srv.mergeQueueTick();
    assert.equal(runs.length, 1);
    release();
    await first;
    assert.equal(card('glmps-1').mergeRequest.stage, 'merging');
    assert.equal(runs.length, 1, 'a passed request is not tested again');
  }, { run: async () => { await gate; return PASS(); } });
});

test('one active request per branch: the second waits until the first leaves testing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withQueue(async ({ srv, post, runs, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    await post('/api/backlog', { title: 'two' });
    fileMr('glmps-1', { filedAt: '2026-10-17T10:00:00.000Z', number: 7 });
    fileMr('glmps-2', { filedAt: '2026-10-17T10:01:00.000Z', number: 8 });
    const first = srv.mergeQueueTick();
    await waitFor(() => runs.length === 1, { message: 'the test job started' });
    assert.equal(card('glmps-1').mergeRequest.stage, 'testing');
    assert.equal(card('glmps-2').mergeRequest.stage, 'requested');
    release();
    await first;
    assert.equal(runs.length, 1);
  }, { run: async () => { await gate; return PASS(); } });
});

test('after a server restart a request found in testing with no job is restarted and says so', async () => {
  await withQueue(async ({ srv, post, runs, stateDir, fileMr, card }) => {
    await post('/api/backlog', { title: 'one' });
    const mr = fileMr('glmps-1');
    const t = transition(mr, 'testing', { now: '2026-10-17T10:00:01.000Z', queue: [], id: 'glmps-1' }).mergeRequest;
    setMergeRequestIn(stateDir, 'glmps-1', t);
    await srv.mergeQueueTick();
    assert.equal(runs.length, 1);
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'merging');
    assert.ok(c.devLog.some((d) => /was testing when the server restarted; restarting the tests/.test(d.text)));
    assert.ok(c.mergeRequest.history.some((h) => /restarted after server restart/.test(h.reason)));
  });
});

// glmps-2-0-runtime-50 (dev/prod T3): each verdict lands in the tested-tree record.
test('a finished test job appends the tested tree to the state dir; a conflict records nothing', async () => {
  const tree = 'c'.repeat(40);
  await withQueue(async ({ srv, post, fileMr, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    const recs = readTestedTrees(stateDir);
    assert.equal(recs.length, 1);
    assert.deepEqual(
      { ...recs[0], ts: typeof recs[0].ts },
      { ts: 'string', treeSha: tree, status: 'pass', headSha: 'aaa111', mergedBaseSha: 'bbb222', command: 'npm test', durationMs: 9, repo: 'acme/widgets', number: 7, base: 'main', cardId: 'glmps-1', flaky: false },
    );
    assert.equal(findTestedTree(stateDir, tree).status, 'pass');
  }, { run: async () => PASS({ command: 'npm test', tests: { ...PASS().tests, treeSha: tree } }) });
  await withQueue(async ({ srv, post, fileMr, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    assert.equal(readTestedTrees(stateDir)[0].status, 'fail');
  }, { run: async () => ({ kind: 'fail', tests: { status: 'fail', reason: 'exit code 1', treeSha: tree, tail: 'x' } }) });
  await withQueue(async ({ srv, post, fileMr, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    assert.deepEqual(readTestedTrees(stateDir), []);
  }, { run: async () => ({ kind: 'conflict', headSha: 'aaa111', conflict: { files: ['a.txt'] } }) });
});

// glmps-2-0-runtime-63: the overnight chain stalled when a bounce left an idle card idle.
const FAIL = async () => ({ kind: 'fail', tests: { status: 'fail', reason: 'exit code 1', tail: 'not ok 3 - widgets render' } });

test('AC-1: a test bounce returns an idle card to queued with the reason and the tail', async () => {
  await withQueue(async ({ srv, post, fileMr, card, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    releaseToIdleIn(stateDir, 'glmps-1', { kind: 'headless-exit', why: 'run ended' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'bounced');
    assert.equal(c.state, 'queued');
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /requeued/.test(d.text) && /exit code 1/.test(d.text) && /not ok 3 - widgets render/.test(d.text)));
    assert.match(c.pendingReopen.note, /not ok 3 - widgets render/);
    assert.equal(c.pendingReopen.source, 'merge-queue');
  }, { run: FAIL });
});

test('AC-2: an operator-held card stays held after a bounce', async () => {
  await withQueue(async ({ srv, post, fileMr, card, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    updateItemIn(stateDir, 'glmps-1', { state: 'held' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    const c = card('glmps-1');
    assert.equal(c.state, 'held');
    assert.ok(!c.pendingReopen);
    assert.ok(c.devLog.some((d) => /not requeued: the operator holds the card/.test(d.text)));
  }, { run: FAIL });
});

test('AC-2: a reintent card is not requeued', async () => {
  await withQueue(async ({ srv, post, fileMr, card, stateDir }) => {
    await post('/api/backlog', { title: 'one' });
    setGateIn(stateDir, 'glmps-1', { status: 'FAIL', evidence: ['a'] });
    setGateIn(stateDir, 'glmps-1', { status: 'FAIL', evidence: ['b'] });
    releaseToIdleIn(stateDir, 'glmps-1', { kind: 'headless-exit', why: 'run ended' });
    fileMr('glmps-1');
    await srv.mergeQueueTick();
    const c = card('glmps-1');
    assert.equal(c.state, 'idle');
    assert.ok(c.devLog.some((d) => /not requeued: the card waits for a restated intent/.test(d.text)));
  }, { run: FAIL });
});

test('AC-2: past maxRetries bounces in a row the card is held for the operator', async () => {
  await withQueue(async ({ srv, post, card, stateDir }) => {
    saveConfig(stateDir, { enabled: true, maxRetries: 1 });
    await post('/api/backlog', { title: 'one' });
    releaseToIdleIn(stateDir, 'glmps-1', { kind: 'headless-exit', why: 'run ended' });
    const first = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: 'aaa111', filedBy: 'w' }, { now: '2026-10-17T09:00:00.000Z' });
    const prev = transition({ ...first, stage: 'testing' }, 'bounced', { now: '2026-10-17T09:30:00.000Z', reason: 'tests fail: exit code 1' }).mergeRequest;
    setMergeRequestIn(stateDir, 'glmps-1', createMergeRequest({ ...first }, { now: '2026-10-17T10:00:00.000Z', prev }));
    await srv.mergeQueueTick();
    const c = card('glmps-1');
    assert.equal(c.mergeRequest.stage, 'bounced');
    assert.equal(c.state, 'held');
    assert.ok(c.devLog.some((d) => /held for the operator: 2 bounces in a row \(retry cap 1\)/.test(d.text)));
  }, { run: FAIL });
});
