// glmps-2-0-76: a request whose PR was merged or closed outside the queue is
// settled before it takes the merge slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn, setGateIn, load, save } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { createMergeRequest } from '../lib/orchestration/merge-queue.js';
import { precheckRequest } from '../lib/orchestration/merge-exec.js';
import { waitFor } from './helpers/wait-for.js';

const view = (state, mergeSha = null) => ({ status: 0, stdout: JSON.stringify({ state, headRefOid: 'aaa111', mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: mergeSha ? { oid: mergeSha } : null }), stderr: '' });

test('precheckRequest: MERGED and CLOSED settle, OPEN and any gh failure go ahead', async () => {
  const mr = { repo: 'acme/widgets', number: 7 };
  assert.deepEqual(await precheckRequest({ mr, gh: async () => view('MERGED', 'c'.repeat(40)) }), { kind: 'merged', mergeSha: 'c'.repeat(40), already: true });
  assert.equal((await precheckRequest({ mr, gh: async () => view('CLOSED') })).kind, 'bounce');
  assert.equal((await precheckRequest({ mr, gh: async () => view('OPEN') })).kind, 'open');
  assert.equal((await precheckRequest({ mr, gh: async () => ({ status: 1, stderr: 'refused' }) })).kind, 'open');
  assert.equal((await precheckRequest({ mr, gh: async () => ({ status: 0, stdout: 'nope' }) })).kind, 'open');
  assert.equal((await precheckRequest({ mr, gh: async () => { throw new Error('x'); } })).kind, 'open');
  const calls = [];
  await precheckRequest({ mr, gh: async (f, a) => { calls.push([f, ...a]); return view('OPEN'); } });
  assert.deepEqual(calls[0].slice(0, 6), ['gh', 'pr', 'view', '7', '-R', 'acme/widgets'], 'the pr view shape the desktop shell already allows');
});

async function withQueue(fn, prState) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqpre-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  const checkout = path.join(tmp, 'checkout'); fs.mkdirSync(checkout);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, mergeQueue: { repos: { 'acme/widgets': { path: checkout, test: 'npm test' } } } }));
  const env = { ...process.env, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_STATE_DIR: path.join(tmp, 'state'), GLMPS_WORKTREES_DIR: path.join(tmp, 'wts'), GLMPS_UNMERGED_SCAN: 'off', GLMPS_RUNNER_DRYRUN: '1' };
  const runs = [];
  const ghCalls = [];
  let merged = false;
  const ghRun = async (file, args) => {
    ghCalls.push(args);
    if (typeof prState === 'function') return prState(args);
    if (args[1] === 'merge') { merged = true; return { status: 0, stdout: '', stderr: '' }; }
    return view(merged ? 'MERGED' : prState, 'd'.repeat(40));
  };
  // The testing stage seam: counts test runs and passes the filed head.
  const mergeTestsRun = async (job) => { runs.push(job); return { kind: 'pass', tests: { status: 'pass', headSha: 'aaa111', tail: 'green' } }; };
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {}, ghRun, reviewGit: async () => ({ status: 0, stdout: '', stderr: '' }), mergeTestsRun });
  const stateDir = env.GLMPS_STATE_DIR;
  saveConfig(stateDir, { enabled: true });
  const post = (p, o) => fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }).then((r) => r.json());
  await post('/api/backlog', { title: 'one' });
  const id = load(stateDir).items[0].id;
  setGateIn(stateDir, id, { status: 'PASS', evidence: ['author evidence'], by: 'agent' });
  setMergeRequestIn(stateDir, id, createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: 'aaa111', filedBy: 'w' }, { now: '2026-10-17T10:00:00.000Z' }));
  const card = () => load(stateDir).items.find((i) => i.id === id);
  try { await fn({ srv, card, runs, ghCalls, stateDir }); } finally { await srv.close?.(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('a PR merged outside the queue is recorded merged and the card closed, with no test run and the author gate kept', async () => {
  await withQueue(async ({ srv, card, runs }) => {
    await srv.mergeQueueTick();
    const c = card();
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.mergeRequest.mergedOutsideQueue, true);
    assert.equal(c.mergeRequest.mergeSha, 'd'.repeat(40));
    assert.equal(runs.length, 0, 'no test run was spent');
    assert.equal(c.state, 'done');
    assert.deepEqual(c.gate.evidence, ['author evidence'], 'the queue records no PASS of its own');
    assert.ok(c.devLog.some((l) => /already merged acme\/widgets#7.*not tested or reviewed by the queue/.test(l.text)));
  }, 'MERGED');
});

test('a PR closed outside the queue bounces with no test run', async () => {
  await withQueue(async ({ srv, card, runs }) => {
    await srv.mergeQueueTick();
    assert.equal(card().mergeRequest.stage, 'bounced');
    assert.equal(runs.length, 0);
    assert.notEqual(card().state, 'done');
  }, 'CLOSED');
});

test('an open PR, or one gh cannot read in precheck, advances to testing, then merging, then merges', async () => {
  await withQueue(async ({ srv, card, ghCalls, runs }) => {
    await srv.mergeQueueTick();
    assert.equal(ghCalls[0][1], 'view');
    assert.equal(runs.length, 1, 'an open PR is tested before it can merge');
    assert.equal(card().mergeRequest.stage, 'merging');
    assert.ok(!ghCalls.some((a) => a[1] === 'merge'), 'nothing merges in the testing tick');
    await srv.mergeQueueTick();
    assert.ok(ghCalls.some((a) => a[1] === 'merge'), 'the tested head goes to gh pr merge');
    assert.equal(card().mergeRequest.stage, 'merged');
  }, 'OPEN');
  await withQueue(async ({ srv, card, runs }) => {
    await srv.mergeQueueTick();
    assert.equal(runs.length, 1, 'an unreadable PR in precheck still goes to testing');
    assert.equal(card().mergeRequest.stage, 'merging');
    await srv.mergeQueueTick();
    assert.equal(card().mergeRequest.stage, 'held', 'when gh keeps failing, the merge step holds');
  }, () => ({ status: 1, stderr: 'refused by shell' }));
});

// glmps-2-0-171 D2 (replaces the 163 merge-queue promotion): a merge does not
// close a card that still hosts open cards; the card stays open and names them.
const withKid = (card, stateDir) => {
  const host = card();
  const st = load(stateDir);
  const kid = { ...st.items[0], id: `${host.id}-kid`, title: 'kid', state: 'in_progress', parentId: host.id, mergeRequest: null, gate: null, devLog: [], mode: null, order: 99 };
  save(stateDir, { ...st, items: [...st.items, kid] });
  return { host, kid, k: () => load(stateDir).items.find((i) => i.id === kid.id) };
};

test('a queue merge of a host with an open spawned card keeps the host open and does not promote the child', async () => {
  await withQueue(async ({ srv, card, stateDir }) => {
    const { kid, k } = withKid(card, stateDir);
    await srv.mergeQueueTick();
    await srv.mergeQueueTick();
    assert.equal(card().mergeRequest.stage, 'merged');
    assert.notEqual(card().state, 'done');
    assert.ok(card().devLog.some((d) => d.text.includes(`merged; the card stays open while it hosts ${kid.id}`)));
    assert.equal(k().promoted, undefined);
    assert.equal(k().state, 'in_progress');
  }, 'OPEN');
});

test('a PR merged outside the queue also keeps an open host open', async () => {
  await withQueue(async ({ srv, card, stateDir }) => {
    const { kid } = withKid(card, stateDir);
    await srv.mergeQueueTick();
    assert.equal(card().mergeRequest.stage, 'merged');
    assert.notEqual(card().state, 'done');
    assert.ok(card().devLog.some((d) => d.text.includes(`merged; the card stays open while it hosts ${kid.id}`)));
  }, 'MERGED');
});
