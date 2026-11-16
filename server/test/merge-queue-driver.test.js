// The merge queue's engine as a module (card glmps-2-0-220): one driver, with
// gh, git, the test runner and the card store's helpers passed in, walks a
// request from filed to merged and closed without a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMergeQueueDriver } from '../lib/orchestration/merge-queue-driver.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { createMergeRequest } from '../lib/orchestration/merge-queue.js';

const HEAD = '1'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);

function fakeGh() {
  const st = { state: 'OPEN', mergeCommit: null };
  const calls = [];
  const run = async (file, args) => {
    calls.push(args);
    if (args[1] === 'view') {
      const fields = args[args.indexOf('--json') + 1];
      if (fields.startsWith('baseRefName')) return { status: 0, stdout: JSON.stringify({ baseRefName: 'main', headRefName: 'feat/x', headRefOid: HEAD, state: st.state, isCrossRepository: false }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ state: st.state, headRefOid: HEAD, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: st.mergeCommit ? { oid: st.mergeCommit } : null }), stderr: '' };
    }
    if (args[1] === 'merge') { st.state = 'MERGED'; st.mergeCommit = MERGE_SHA; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { run, merges: () => calls.filter((a) => a[1] === 'merge') };
}

function harness({ testOutcome = null, mayRun = () => true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mq-driver-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  const gh = fakeGh();
  const testRuns = [];
  let halts = 0;
  const saveMergeRequest = (id, mr, text) => {
    backlogStore.setMergeRequestIn(stateDir, id, mr);
    if (text) backlogStore.appendDevLogIn(stateDir, id, { by: 'merge-queue', text });
  };
  const driver = createMergeQueueDriver({
    P: { stateDir, worktreesDir: path.join(tmp, 'wts') }, env: { GLMPS_TEST: '1' }, cfg: {},
    mergeJobs: new Map(), runGh: gh.run,
    runReviewGit: async (args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? BASE : '', stderr: '' }),
    runMergeJobImpl: async (job) => { testRuns.push(job.id); return testOutcome ?? { kind: 'pass', tests: { status: 'pass', headSha: HEAD, mergedBaseSha: BASE, tail: 'green' } }; },
    countQueueTestProcs: async () => null, releaseRun: null, gitopsViaShell: false, gitopsBroker: null, shellSeams: null,
    mergeTestsRun: null, mainSuiteLoop: null, batchReviewLoop: null,
    checkoutFor: async () => ({ repoPath: checkout, override: null }), saveMergeRequest,
    mergeQueueMayRun: mayRun, maintenanceHold: () => false, redFor: () => null, haltMergeQueue: () => { halts++; },
    broadcastBacklog: () => {}, autoDeployTick: () => {}, resumeStrandedTick: () => {}, getScut: () => null,
  });
  const file = () => {
    const { item } = backlogStore.addItemTo(stateDir, { title: 'Add widget', project: 'harbor-app', acceptanceCriteria: ['widgets render'] });
    const mr = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: HEAD, filedBy: 'agent' }, { now: new Date().toISOString() });
    backlogStore.setMergeRequestIn(stateDir, item.id, mr);
    return item.id;
  };
  const card = (id) => backlogStore.load(stateDir).items.find((i) => i.id === id);
  return { driver, gh, file, card, testRuns, halts: () => halts, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('a filed request is tested on one tick and merged on the next, and the card closes done', async () => {
  const h = harness();
  try {
    const id = h.file();
    await h.driver.tick();
    assert.deepEqual(h.testRuns, [id]);
    assert.equal(h.card(id).mergeRequest.stage, 'merging');
    await h.driver.tick();
    assert.equal(h.gh.merges().length, 1);
    const c = h.card(id);
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.mergeRequest.mergeSha, MERGE_SHA);
    assert.equal(c.state, 'done');
  } finally { h.done(); }
});

test('a failing test run bounces the request and never merges', async () => {
  const h = harness({ testOutcome: { kind: 'fail', tests: { status: 'fail', headSha: HEAD, mergedBaseSha: BASE, tail: '1 failing' } } });
  try {
    const id = h.file();
    await h.driver.tick();
    assert.equal(h.card(id).mergeRequest.stage, 'bounced');
    await h.driver.tick();
    assert.equal(h.gh.merges().length, 0);
  } finally { h.done(); }
});

test('a paused queue starts nothing and halts', async () => {
  const h = harness({ mayRun: () => false });
  try {
    const id = h.file();
    await h.driver.tick();
    assert.deepEqual(h.testRuns, []);
    assert.equal(h.card(id).mergeRequest.stage, 'requested');
    assert.equal(h.halts(), 1);
  } finally { h.done(); }
});
