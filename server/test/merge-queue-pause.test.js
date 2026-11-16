import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn, setRunSessionIn, load } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { createMergeRequest, transition } from '../lib/orchestration/merge-queue.js';

const AUTHOR_SID = '11111111-2222-4333-8444-555555555555';
const H1 = '1'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqpause-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'state', 'state', 'index.json'), JSON.stringify([{ id: AUTHOR_SID, model: 'claude-opus-4-5', skillsUsed: [], agentsUsed: [], eventCount: 0 }]));
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, mergeQueue: { repos: { 'acme/widgets': { path: checkout, test: 'npm test' } } } }));
  return {
    tmp, configFile,
    env: {
      ...process.env,
      GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
      GLMPS_WORKTREES_DIR: path.join(tmp, 'wts'), GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
      GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
      GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
      GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
      GLMPS_UNMERGED_SCAN: 'off', GLMPS_RUNNER_DRYRUN: '1',
    },
  };
}

// A scripted GitHub; `viewGate` stalls the first call so a test can pause mid-merge.
function fakeGh(viewGate) {
  const st = { state: 'OPEN', head: H1, mergeCommit: null };
  const calls = [];
  let first = true;
  const run = async (file, args) => {
    calls.push({ file, args });
    if (first && viewGate) { first = false; await viewGate; }
    if (args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ state: st.state, headRefOid: st.head, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: st.mergeCommit ? { oid: st.mergeCommit } : null }), stderr: '' };
    }
    if (args[1] === 'merge') { st.state = 'MERGED'; st.mergeCommit = MERGE_SHA; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'unexpected gh' };
  };
  return { st, calls, run, merges: () => calls.filter((c) => c.args[1] === 'merge') };
}

async function withQueue(fn, { viewGate } = {}) {
  const e = mkEnv();
  const gh = fakeGh(viewGate);
  // The testing stage seam: passes against the PR's current head.
  const testRuns = [];
  const mergeTestsRun = async (job) => { testRuns.push(job); return { kind: 'pass', tests: { status: 'pass', headSha: gh.st.head, mergedBaseSha: 'b'.repeat(40), tail: 'green' } }; };
  const reviewGit = async (args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? (String(args[1]).startsWith('origin/') ? 'b'.repeat(40) : H1) : args[0] === 'diff' ? 'diff --git a/f b/f\n+x\n' : '', stderr: '' });
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, ghRun: gh.run, reviewGit, mergeTestsRun });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = async (p, obj) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); return { status: r.status, body: await r.json() }; };
  const stateDir = e.env.GLMPS_STATE_DIR;
  saveConfig(stateDir, { enabled: true, maxConcurrent: 3 });
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  const addCard = async () => {
    const r = await post('/api/backlog', { title: 'Add widget', prompt: 'build widget', acceptanceCriteria: ['widgets render'] });
    setRunSessionIn(stateDir, r.body.id, { sessionId: AUTHOR_SID, launcher: 'native-terminal', worktree: null, recordedTs: Date.now(), purgedTs: null });
    return r.body.id;
  };
  const request = (id, upTo, extra = {}) => {
    const now = '2026-10-17T10:00:00.000Z';
    let m = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: H1, filedBy: 'w' }, { now });
    const path = { requested: [], merging: ['testing', 'merging'], held: ['held'] }[upTo];
    for (const to of path) m = transition(m, to, { now, queue: [], id }).mergeRequest;
    if (upTo === 'merging') m = { ...m, tests: { status: 'pass', headSha: H1, mergedBaseSha: 'b'.repeat(40), tail: 'green' } };
    m = { ...m, ...extra };
    setMergeRequestIn(stateDir, id, m);
  };
  const until = async (pred, what) => {
    for (let i = 0; i < 100 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.ok(pred(), what);
  };
  try {
    await fn({ srv, post, card, stateDir, addCard, request, until, gh, testRuns });
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
}

const pauseBoard = (post) => post('/api/backlog/pause', { paused: true });

test('AC-1: pausing during merging refuses the merge call; the PR is not merged and the request is held', async () => {
  let open;
  const viewGate = new Promise((r) => { open = r; });
  await withQueue(async ({ srv, post, card, addCard, request, until, gh }) => {
    const id = await addCard();
    request(id, 'merging');
    const tick = srv.mergeQueueTick();
    await until(() => gh.calls.length === 1, 'merge step in flight');
    await pauseBoard(post);
    open();
    await tick;
    assert.equal(gh.merges().length, 0, 'gh pr merge never ran after the pause');
    assert.equal(gh.st.state, 'OPEN');
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'held');
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /paused/.test(d.text)));
  }, { viewGate });
});

test('unpausing does not release a held request; the release route does, and only from held', async () => {
  await withQueue(async ({ srv, post, card, addCard, request, gh }) => {
    const id = await addCard();
    request(id, 'held');
    await pauseBoard(post);
    assert.equal(card(id).mergeRequest.stage, 'held');

    await post('/api/backlog/pause', { paused: false });
    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.stage, 'held', 'no auto-release');

    assert.equal((await post('/api/backlog/glmps-nope/merge-request/release', {})).status, 404);
    const r = await post(`/api/backlog/${id}/merge-request/release`, {});
    assert.equal(r.status, 200);
    assert.equal(card(id).mergeRequest.stage, 'requested');
    assert.ok(card(id).devLog.some((d) => d.by === 'merge-queue' && /released/.test(d.text)));
    assert.equal((await post(`/api/backlog/${id}/merge-request/release`, {})).status, 409, 'not held any more');

    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.stage, 'merging', 'requeued request is tested before it can merge');
    assert.equal(gh.merges().length, 0);
    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.stage, 'merged');
    assert.equal(gh.merges().length, 1);
  });
});

test('release is 409 for a card with no merge request', async () => {
  await withQueue(async ({ post, addCard }) => {
    const id = await addCard();
    assert.equal((await post(`/api/backlog/${id}/merge-request/release`, {})).status, 409);
  });
});

test('a PR head that moved since it was tested goes back to testing without merging', async () => {
  await withQueue(async ({ srv, card, addCard, request, gh, testRuns }) => {
    const id = await addCard();
    request(id, 'merging');
    gh.st.head = '2'.repeat(40);
    await srv.mergeQueueTick();
    const c = card(id);
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /head moved/.test(d.text)), c.devLog.map((d) => d.text).join(' | '));
    assert.equal(testRuns.length, 1, 'new commits get new tests');
    assert.equal(c.mergeRequest.tests.headSha, '2'.repeat(40));
    assert.equal(gh.merges().length, 0);
  });
});
