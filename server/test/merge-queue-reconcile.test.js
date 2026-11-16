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
const T0 = '2026-10-17T10:00:00.000Z';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqrec-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'state', 'state', 'index.json'), JSON.stringify([{ id: AUTHOR_SID, model: 'claude-opus-4-5', skillsUsed: [], agentsUsed: [], eventCount: 0 }]));
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, mergeQueue: { reconcileEveryMs: 0, repos: { 'acme/widgets': { path: checkout, test: 'npm test' } } } }));
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

function fakeGh(pr = {}) {
  const st = { state: 'OPEN', head: H1, mergeable: 'MERGEABLE', base: 'main', mergeCommit: null, viewFails: null, ...pr };
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    if (args[1] === 'view') {
      if (st.viewFails) return { status: 1, stdout: '', stderr: st.viewFails };
      return { status: 0, stdout: JSON.stringify({ state: st.state, headRefOid: st.head, mergeable: st.mergeable, baseRefName: st.base, mergeCommit: st.mergeCommit ? { oid: st.mergeCommit } : null }), stderr: '' };
    }
    if (args[1] === 'merge') { st.state = 'MERGED'; st.mergeCommit = MERGE_SHA; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { st, calls, run };
}

async function withQueue(fn, { pr } = {}) {
  const e = mkEnv();
  const gh = fakeGh(pr);
  const reviewGit = async (args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? (String(args[1]).startsWith('origin/') ? 'b'.repeat(40) : H1) : '', stderr: '' });
  const mergeTestsRun = async () => ({ kind: 'pass', headSha: H1, tests: { status: 'pass', headSha: H1, mergedBaseSha: 'b'.repeat(40), tail: 'green' } });
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, ghRun: gh.run, mergeTestsRun, reviewGit });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = async (p, obj) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); return { status: r.status, body: await r.json() }; };
  const patch = async (p, obj) => { const r = await fetch(base + p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); return { status: r.status, body: await r.json() }; };
  const stateDir = e.env.GLMPS_STATE_DIR;
  saveConfig(stateDir, { enabled: true, maxConcurrent: 3 });
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  const addCard = async () => {
    const r = await post('/api/backlog', { title: 'Add widget', prompt: 'build widget', acceptanceCriteria: ['widgets render', 'no regressions'] });
    setRunSessionIn(stateDir, r.body.id, { sessionId: AUTHOR_SID, launcher: 'native-terminal', worktree: null, recordedTs: Date.now(), purgedTs: null });
    return r.body.id;
  };
  // A request parked at `stage`; merging also carries approved tests and review.
  const park = (id, stage, extra = {}) => {
    let m = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: H1, filedBy: 'w', ...extra }, { now: T0 });
    for (const to of stage === 'merging' ? ['testing', 'merging'] : []) m = transition(m, to, { now: T0, queue: [], id }).mergeRequest;
    if (stage === 'merging') m = { ...m, tests: { status: 'pass', headSha: H1, mergedBaseSha: 'b'.repeat(40), tail: 'green' } };
    if (stage === 'held' || stage === 'bounced') m = { ...m, stage, history: [...m.history, { ts: T0, from: 'requested', to: stage, reason: 'test setup' }] };
    setMergeRequestIn(stateDir, id, m);
    return m;
  };
  try {
    await fn({ srv, post, patch, card, stateDir, addCard, park, gh });
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
}

for (const stage of ['held', 'bounced']) {
  test(`reconcile: a ${stage} request whose PR merged on GitHub becomes merged and closes the card like a queue merge`, async () => {
    await withQueue(async ({ srv, card, addCard, park }) => {
      const id = await addCard();
      park(id, stage);
      await srv.mergeQueueTick();
      const c = card(id);
      assert.equal(c.mergeRequest.stage, 'merged');
      assert.equal(c.mergeRequest.mergeSha, MERGE_SHA);
      assert.equal(c.mergeRequest.mergedOutsideQueue, true, 'a hand merge is never auto-deployed');
      assert.equal(c.state, 'done');
      assert.equal(c.gate.status, 'WAIVED', 'the queue did not test a hand merge, so it records no PASS');
      assert.equal(c.gate.by, 'merge-queue');
      assert.deepEqual(c.gate.evidence, ['merged outside the queue; not tested by the queue']);
      assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /reconciled/.test(d.text) && /merged/.test(d.text)), 'devlog says what GitHub reported');
      assert.ok(c.devLog.some((d) => /merge record/.test(d.text)));
    }, { pr: { state: 'MERGED', mergeCommit: MERGE_SHA } });
  });
}

test('reconcile: a held request whose PR was closed unmerged becomes closed and the card is untouched', async () => {
  await withQueue(async ({ srv, card, addCard, park }) => {
    const id = await addCard();
    park(id, 'held');
    const before = card(id);
    await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'closed');
    assert.equal(c.state, before.state);
    assert.equal(c.gate ?? null, null);
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /closed without merging/.test(d.text)));
    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.history.length, c.mergeRequest.history.length, 'closed is final and is not re-read');
  }, { pr: { state: 'CLOSED' } });
});

test('reconcile: an open PR and an unreadable PR leave the request exactly as it was', async () => {
  await withQueue(async ({ srv, card, addCard, park, gh }) => {
    const id = await addCard();
    const m = park(id, 'held');
    await srv.mergeQueueTick();
    assert.deepEqual(card(id).mergeRequest, m, 'open PR: unchanged');
    gh.st.viewFails = 'HTTP 502 from GitHub';
    gh.st.state = 'MERGED';
    await srv.mergeQueueTick();
    assert.deepEqual(card(id).mergeRequest, m, 'unreadable PR: unchanged');
    gh.st.viewFails = null;
    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.stage, 'merged', 'the next successful read settles it');
  });
});

test('reconcile: an interim request reconciled as merged leaves the card open', async () => {
  await withQueue(async ({ srv, card, addCard, park }) => {
    const id = await addCard();
    park(id, 'held', { interim: true });
    const before = card(id);
    await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.state, before.state);
    assert.equal(c.gate ?? null, null);
  }, { pr: { state: 'MERGED', mergeCommit: MERGE_SHA } });
});

test('reconcile: it does not run while the queue is paused', async () => {
  await withQueue(async ({ srv, card, addCard, park, stateDir }) => {
    const id = await addCard();
    const m = park(id, 'held');
    saveConfig(stateDir, { enabled: false, maxConcurrent: 3 });
    await srv.mergeQueueTick();
    assert.deepEqual(card(id).mergeRequest, m);
  }, { pr: { state: 'MERGED', mergeCommit: MERGE_SHA } });
});

test('coverage: a merge covering one of two criteria records it and keeps the card open, listing what is left', async () => {
  await withQueue(async ({ srv, card, addCard, park }) => {
    const id = await addCard();
    park(id, 'merging', { covers: [1] });
    const before = card(id);
    await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.state, before.state, 'the card stays open');
    assert.equal(c.gate ?? null, null);
    assert.equal(c.coverage['1'].mergeSha, MERGE_SHA);
    assert.equal(c.coverage['1'].prUrl, 'https://github.com/acme/widgets/pull/7');
    assert.equal(c.coverage['2'], undefined);
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /still open: AC-2/.test(d.text)));
  });
});

test('coverage: the merge that covers the last open criterion closes the card', async () => {
  await withQueue(async ({ srv, card, addCard, park, gh }) => {
    const id = await addCard();
    park(id, 'merging', { covers: [1] });
    await srv.mergeQueueTick();
    assert.notEqual(card(id).state, 'done');
    gh.st.state = 'OPEN'; gh.st.mergeCommit = null;
    park(id, 'merging', { covers: [2] });
    await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.state, 'done');
    assert.equal(c.gate.status, 'PASS');
    assert.deepEqual(Object.keys(c.coverage).sort(), ['1', '2']);
  });
});

test('coverage: final closes the card even with criteria uncovered, and covers of every criterion closes it too', async () => {
  await withQueue(async ({ srv, card, addCard, park }) => {
    const a = await addCard();
    park(a, 'merging', { covers: [1], final: true });
    await srv.mergeQueueTick();
    assert.equal(card(a).state, 'done');
  });
  await withQueue(async ({ srv, card, addCard, park }) => {
    const a = await addCard();
    park(a, 'merging', { covers: [1, 2] });
    await srv.mergeQueueTick();
    assert.equal(card(a).state, 'done');
  });
});

test('coverage: a request with no covers and no final still closes the card on merge', async () => {
  await withQueue(async ({ srv, card, addCard, park }) => {
    const id = await addCard();
    park(id, 'merging');
    await srv.mergeQueueTick();
    assert.equal(card(id).state, 'done');
    assert.equal(card(id).coverage ?? null, null);
  });
});

test('coverage: the per-criterion coverage record cannot be set through a generic PATCH', async () => {
  await withQueue(async ({ card, addCard, patch }) => {
    const id = await addCard();
    const r = await patch(`/api/backlog/${id}`, { coverage: { 1: { prUrl: 'x' } }, title: 'renamed' });
    assert.equal(r.status, 200);
    assert.equal(card(id).title, 'renamed');
    assert.equal(card(id).coverage ?? null, null);
  });
});
