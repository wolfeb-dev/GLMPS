import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn, setRunSessionIn, load } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { createMergeRequest, transition } from '../lib/orchestration/merge-queue.js';
import { beginMaintenance, clearMaintenance } from '../lib/kernel/maintenance.js';
import { waitFor } from './helpers/wait-for.js';
import { shouldClaim } from '../lib/orchestration/queue-runner.js';

const AUTHOR_SID = '11111111-2222-4333-8444-555555555555';
const H1 = '1'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-maint-'));
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
  const addCard = async (title = 'Add widget') => {
    const r = await post('/api/backlog', { title, prompt: 'build widget', acceptanceCriteria: ['widgets render'] });
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
  const until = (pred, what) => waitFor(pred, { message: what });
  try {
    await fn({ srv, post, card, stateDir, addCard, request, until, gh, testRuns });
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
}


test('under a live maintenance record the queue starts no new test and no merge', async () => {
  await withQueue(async ({ srv, card, addCard, request, stateDir, gh, testRuns }) => {
    // First, because creating a card kicks a runner tick of its own.
    beginMaintenance(stateDir, { runId: 'apr-1' });
    const queued = await addCard();
    request(queued, 'requested');
    const merging = await addCard('Add gadget');
    request(merging, 'merging');
    await srv.mergeQueueTick();
    assert.equal(card(queued).mergeRequest.stage, 'requested');
    assert.equal(card(merging).mergeRequest.stage, 'merging');
    assert.equal(testRuns.length, 0);
    assert.equal(gh.merges().length, 0);
    clearMaintenance(stateDir, 'apr-1');
    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 1, 'work resumes once the record is cleared');
  });
});

test('an expired maintenance record is ignored', async () => {
  await withQueue(async ({ srv, card, addCard, request, stateDir }) => {
    const id = await addCard();
    request(id, 'requested');
    beginMaintenance(stateDir, { runId: 'apr-1', now: Date.now() - 2 * 3_600_000 });
    await srv.mergeQueueTick();
    assert.notEqual(card(id).mergeRequest.stage, 'requested');
  });
});

// Card glmps-2-0-173: a hold left by a previous kernel that this one cannot
// resume (SCUT is off in a test server) is released, and the record goes.
test('a hold taken before this boot with nothing to resume it does not hold the queue', async () => {
  await withQueue(async ({ srv, card, addCard, request, stateDir }) => {
    const id = await addCard();
    request(id, 'requested');
    beginMaintenance(stateDir, { runId: 'apr-old', now: Date.now() - 60_000 });
    await srv.mergeQueueTick();
    assert.notEqual(card(id).mergeRequest.stage, 'requested');
    assert.equal(fs.existsSync(path.join(stateDir, 'maintenance.json')), false);
  });
});

test('a merge already in flight when the record appears finishes', async () => {
  let open;
  const viewGate = new Promise((r) => { open = r; });
  await withQueue(async ({ srv, card, addCard, request, until, gh, stateDir }) => {
    const id = await addCard();
    request(id, 'merging');
    const tick = srv.mergeQueueTick();
    await until(() => gh.calls.length === 1, 'merge step in flight');
    beginMaintenance(stateDir, { runId: 'apr-1' });
    open();
    await tick;
    assert.equal(gh.merges().length, 1);
    assert.equal(card(id).mergeRequest.stage, 'merged');
  }, { viewGate });
});

test('the runner does not claim a card while held, and still does when not', () => {
  assert.equal(shouldClaim({ enabled: true, paused: false, runningCount: 0, maxConcurrent: 2, maintenance: true }), false);
  assert.equal(shouldClaim({ enabled: true, paused: false, runningCount: 0, maxConcurrent: 2, maintenance: false }), true);
  assert.equal(shouldClaim({ enabled: true, paused: false, runningCount: 0, maxConcurrent: 2 }), true);
});
