// In service mode the merge queue has no GitHub sign-in (session 0, D33), so its
// gh calls and git reads are 'gitops' launch records the desktop shell runs.
// These tests stand in for the shell with a fake that claims each record and
// answers it. With no shell the request is held with a clear reason, never
// bounced and never merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn, setRunSessionIn, load } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { createMergeRequest, transition } from '../lib/orchestration/merge-queue.js';
import { fakeShell } from './helpers/fake-gitops-shell.js';

const AUTHOR_SID = '11111111-2222-4333-8444-555555555555';
const H1 = 'a'.repeat(40);
const MERGE_SHA = 'd'.repeat(40);

function mkEnv(mq = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqshell-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'state', 'state', 'index.json'), JSON.stringify([{ id: AUTHOR_SID, model: 'claude-opus-4-5', skillsUsed: [], agentsUsed: [], eventCount: 0 }]));
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    runnerTickMs: 1000000000,
    mergeQueue: { repos: { 'acme/widgets': { path: checkout, test: 'npm test' } }, shellClaimWaitMs: 80, ...mq },
  }));
  return {
    tmp, checkout, configFile,
    env: {
      ...process.env,
      GLMPS_SERVICE: '1',
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

async function withShellMode(fn, mq = {}) {
  const e = mkEnv(mq);
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {} });
  const base = `http://127.0.0.1:${srv.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': srv.localSession }, body: JSON.stringify(obj) });
  const stateDir = e.env.GLMPS_STATE_DIR;
  saveConfig(stateDir, { enabled: true, maxConcurrent: 3 });
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  const addCard = async () => {
    const r = await post('/api/backlog', { title: 'Add widget', prompt: 'build widget', acceptanceCriteria: ['widgets render'] });
    setRunSessionIn(stateDir, r.body.id, { sessionId: AUTHOR_SID, launcher: 'native-terminal', worktree: null, recordedTs: Date.now(), purgedTs: null });
    return r.body.id;
  };
  const filed = (id, stages, extra = {}) => {
    let m = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: H1, filedBy: 'w' }, { now: '2026-10-17T10:00:00.000Z' });
    for (const to of stages) m = transition(m, to, { now: '2026-10-17T10:00:00.000Z', queue: [], id }).mergeRequest;
    m = { ...m, ...extra };
    setMergeRequestIn(stateDir, id, m);
    return m;
  };
  try { await fn({ srv, post, card, addCard, filed, launchBroker: srv.launchBroker, checkout: e.checkout, wts: e.env.GLMPS_WORKTREES_DIR }); }
  finally { await srv.close?.(); fs.rmSync(e.tmp, { recursive: true, force: true }); }
}

const gitAnswers = (op) => {
  const a = op.args ?? [];
  if (op.kind === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD') return { stdout: `${H1}\n` };
  if (op.kind === 'git' && a[0] === 'rev-parse' && a[1] === 'origin/main') return { stdout: `${'b'.repeat(40)}\n` };
  if (op.kind === 'test') return { stdout: 'all green' };
  return undefined;
};

test('AC-1 requested -> testing -> merging -> merged in service mode: the test stage git and test ops and the merge gh calls all go to the shell', async () => {
  await withShellMode(async ({ srv, addCard, filed, card, launchBroker }) => {
    let merged = false;
    const shell = fakeShell(launchBroker, (op) => {
      if (op.kind === 'git') return gitAnswers(op) ?? { stdout: '' };
      if (op.kind === 'test') return gitAnswers(op);
      if (op.kind !== 'gh') return undefined;
      if (op.args[1] === 'merge') { merged = true; return { stdout: '' }; }
      return { stdout: JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', headRefOid: H1, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: merged ? { oid: MERGE_SHA } : null }) };
    });
    const id = await addCard();
    filed(id, []);
    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.stage, 'merging');
    assert.ok(!shell.seen.some((o) => o.kind === 'gh' && o.args[1] === 'merge'), 'nothing merges in the testing tick');
    assert.ok(shell.seen.some((o) => o.kind === 'git'), 'the test stage git work went through the shell');
    assert.ok(shell.seen.some((o) => o.kind === 'test'), 'the test command went through the shell');

    await srv.mergeQueueTick();
    shell.stop();
    const merge = shell.seen.find((o) => o.kind === 'gh' && o.args[1] === 'merge');
    assert.deepEqual(merge.args, ['pr', 'merge', '7', '-R', 'acme/widgets', '--merge', '--match-head-commit', H1]);
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.mergeRequest.mergeSha, MERGE_SHA);
    assert.deepEqual(c.mergeRequest.history.filter((h) => h.from !== h.to).map((h) => h.to), ['requested', 'testing', 'merging', 'merged']);
  });
});

test('AC-2 requested stage: with no shell the request enters testing and is held with the desktop-app reason, not bounced and nothing merges', async () => {
  await withShellMode(async ({ srv, addCard, filed, card, launchBroker }) => {
    const id = await addCard();
    filed(id, []);
    const t0 = Date.now();
    await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'held');
    assert.ok(c.mergeRequest.history.some((h) => h.to === 'testing'), 'the unreadable PR failed open into testing');
    assert.match(c.mergeRequest.history.at(-1).reason, /desktop app/i);
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /held.*desktop app/i.test(d.text)));
    assert.ok(Date.now() - t0 < 5000, `held in about a claim wait, took ${Date.now() - t0} ms`);
    assert.equal(launchBroker.pending().length, 0, 'no stale record is left for a late shell to run');
  });
});

test('AC-1 merging stage: gh pr view and gh pr merge go to the shell pinned to the tested head, and the request merges', async () => {
  await withShellMode(async ({ srv, addCard, filed, card, launchBroker }) => {
    let merged = false;
    const shell = fakeShell(launchBroker, (op) => {
      if (op.kind === 'git') return gitAnswers(op) ?? { stdout: '' };
      if (op.kind !== 'gh') return undefined;
      if (op.args[1] === 'merge') { merged = true; return { stdout: '' }; }
      return { stdout: JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', headRefOid: H1, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: merged ? { oid: MERGE_SHA } : null }) };
    });
    const id = await addCard();
    filed(id, ['testing', 'merging'], { tests: { status: 'pass', headSha: H1, mergedBaseSha: 'b'.repeat(40), tail: 'green' } });
    await srv.mergeQueueTick();
    shell.stop();
    const merge = shell.seen.find((o) => o.kind === 'gh' && o.args[1] === 'merge');
    assert.deepEqual(merge.args, ['pr', 'merge', '7', '-R', 'acme/widgets', '--merge', '--match-head-commit', H1]);
    assert.equal(card(id).mergeRequest.stage, 'merged');
    assert.equal(card(id).mergeRequest.mergeSha, MERGE_SHA);
  });
});

test('AC-2 merging stage: with no shell the request is held with the reason and nothing merges', async () => {
  await withShellMode(async ({ srv, addCard, filed, card }) => {
    const id = await addCard();
    filed(id, ['testing', 'merging'], { tests: { status: 'pass', headSha: H1, mergedBaseSha: 'b'.repeat(40), tail: 'green' } });
    await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'held');
    assert.match(c.mergeRequest.history.at(-1).reason, /desktop app/i);
    assert.notEqual(c.state, 'done');
  });
});

test('AC-2 intake: filing a merge request with no shell answers 503 naming the desktop app; with a shell the PR is read through it', async () => {
  await withShellMode(async ({ post, addCard, launchBroker, card }) => {
    const id = await addCard();
    const down = await post(`/api/backlog/${id}/merge-request`, { prUrl: 'https://github.com/acme/widgets/pull/7' });
    assert.equal(down.status, 503);
    assert.match(down.body.error, /desktop app/i);
    assert.equal(card(id).mergeRequest ?? null, null);

    const shell = fakeShell(launchBroker, (op) => (op.kind === 'gh'
      ? { stdout: JSON.stringify({ baseRefName: 'main', headRefName: 'feat/glmps-1-x', headRefOid: H1, state: 'OPEN', isCrossRepository: false }) }
      : undefined));
    const up = await post(`/api/backlog/${id}/merge-request`, { prUrl: 'https://github.com/acme/widgets/pull/7' });
    shell.stop();
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(card(id).mergeRequest.stage, 'requested');
  });
});
