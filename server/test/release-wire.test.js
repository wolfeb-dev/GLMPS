import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn, setRunSessionIn, load } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { waitFor } from './helpers/wait-for.js';
import { createMergeRequest, transition } from '../lib/orchestration/merge-queue.js';

const AUTHOR_SID = '11111111-2222-4333-8444-555555555555';
const H1 = '1'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const BASE = 'b'.repeat(40);

function mkEnv(pkgName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-relwire-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'state', 'state', 'index.json'), JSON.stringify([{ id: AUTHOR_SID, model: 'claude-opus-4-5', skillsUsed: [], agentsUsed: [], eventCount: 0 }]));
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  if (pkgName) fs.writeFileSync(path.join(checkout, 'package.json'), `{\n  "name": "${pkgName}",\n  "version": "2.0.0"\n}\n`);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, mergeQueue: { repos: { 'acme/widgets': { path: checkout, test: 'npm test' } } } }));
  return {
    tmp, configFile, checkout,
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

function fakeGh() {
  const merged = new Set();
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: merged.has(args[2]) ? 'MERGED' : 'OPEN', headRefOid: H1, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: merged.has(args[2]) ? { oid: MERGE_SHA } : null }), stderr: '' };
    if (args[1] === 'merge') { merged.add(args[2]); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { calls, run };
}

// The desktop app's release action, as the gitops broker's run() sees it: one op in, one JSON document out.
function fakeRelease({ reply = (op) => ({ ok: true, version: op.bump === 'minor' ? '2.1.0' : '2.0.1', sha: MERGE_SHA }), gate = null } = {}) {
  const ops = [];
  const run = async (op) => {
    ops.push(op);
    if (gate) await gate;
    const doc = reply(op);
    return doc instanceof Error ? Promise.reject(doc) : { status: 0, stdout: JSON.stringify(doc), stderr: '' };
  };
  return { ops, run };
}

async function withRelease(fn, { release = fakeRelease(), injectRelease = true } = {}) {
  const e = mkEnv('glmps');
  const gh = fakeGh();
  const gitCalls = [];
  const reviewGit = async (args) => {
    gitCalls.push(args);
    if (args[0] === 'rev-parse') return { status: 0, stdout: args[1] === 'HEAD' ? MERGE_SHA : BASE, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const testRuns = [];
  const mergeTestsRun = async () => { testRuns.push(1); return ({ kind: 'pass', tests: { status: 'pass', headSha: H1, mergedBaseSha: BASE, tail: 'green' } }); };
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, ghRun: gh.run, reviewGit, mergeTestsRun, ...(injectRelease ? { releaseRun: release.run } : {}) });
  const base = `http://127.0.0.1:${srv.port}`;
  const stateDir = e.env.GLMPS_STATE_DIR;
  saveConfig(stateDir, { enabled: true, maxConcurrent: 3 });
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  const addCard = async (extra = {}) => {
    const r = await fetch(base + '/api/backlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Add widget', prompt: 'build widget', acceptanceCriteria: ['widgets render'], ...extra }) });
    const id = (await r.json()).id;
    setRunSessionIn(stateDir, id, { sessionId: AUTHOR_SID, launcher: 'native-terminal', worktree: null, recordedTs: Date.now(), purgedTs: null });
    return id;
  };
  const merging = (id) => {
    const t = '2026-11-14T10:00:00.000Z';
    let m = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: H1, filedBy: 'w' }, { now: t });
    m = transition(m, 'testing', { now: t, queue: [], id }).mergeRequest;
    m = transition(m, 'merging', { now: t, queue: [], id }).mergeRequest;
    setMergeRequestIn(stateDir, id, { ...m, tests: { status: 'pass', headSha: H1, mergedBaseSha: BASE, tail: 'green' } });
  };
  const requested = (id, number = 8) => {
    const t = '2026-11-14T10:01:00.000Z';
    setMergeRequestIn(stateDir, id, createMergeRequest({ prUrl: `https://github.com/acme/widgets/pull/${number}`, repo: 'acme/widgets', number, base: 'main', head: 'feat/y', headSha: H1, filedBy: 'w' }, { now: t }));
  };
  const until = async (pred, what) => {
    await waitFor(pred, { message: what });
  };
  try { await fn({ srv, card, addCard, merging, gh, gitCalls, until, checkout: e.checkout, testRuns, requested, release }); }
  finally { await srv.close?.(); fs.rmSync(e.tmp, { recursive: true, force: true }); }
}

const devlog = (c, re) => c.devLog.find((d) => re.test(d.text));

test('AC-1: a merged feature card asks the desktop app for a minor release, with values only, and logs it', async () => {
  await withRelease(async ({ srv, card, addCard, merging, gitCalls, until, checkout, release }) => {
    const id = await addCard({ title: ', can we add widgets? raw chat text' });
    merging(id);
    await srv.mergeQueueTick();
    await until(() => devlog(card(id), /released v2\.1\.0/), 'released devlog line');
    assert.equal(card(id).state, 'done');
    assert.equal(release.ops.length, 1);
    assert.deepEqual(release.ops[0], { kind: 'release', cwd: checkout, repo: 'acme/widgets', base: 'main', number: 7, cardId: id, bump: 'minor', summary: '' });
    assert.ok(!JSON.stringify(release.ops).includes('raw chat'), 'AC-3: the card title is never sent');
    assert.ok(!gitCalls.some((a) => a[0] === 'push' || a[0] === 'tag' || a[0] === 'commit'), 'the kernel itself never pushes');
  });
});

test('AC-1: a non-feature card asks for a patch release', async () => {
  await withRelease(async ({ srv, card, addCard, merging, until, release }) => {
    const id = await addCard({ title: 'Fix crash', prompt: 'fix the crash in the parser' });
    merging(id);
    await srv.mergeQueueTick();
    await until(() => devlog(card(id), /released v2\.0\.1/), 'released devlog line');
    assert.equal(release.ops[0].bump, 'patch');
  });
});

test('AC-4: a refused or failed release leaves the card merged and done, with one devlog line naming it', async () => {
  for (const reply of [() => ({ ok: false, reason: 'gh release create failed: HTTP 502' }), () => Object.assign(new Error('refused by shell: release base must be a safe git ref'), { code: 'REFUSED' })]) {
    await withRelease(async ({ srv, card, addCard, merging, until }) => {
      const id = await addCard();
      merging(id);
      await srv.mergeQueueTick();
      await until(() => devlog(card(id), /release failed/), 'failure devlog line');
      assert.equal(card(id).mergeRequest.stage, 'merged');
      assert.equal(card(id).state, 'done');
      assert.equal(card(id).devLog.filter((d) => /release failed/.test(d.text)).length, 1);
      assert.match(devlog(card(id), /release failed/).text, /HTTP 502|refused by shell/);
    }, { release: fakeRelease({ reply }) });
  }
});

test('a skipped release (another repo) logs nothing', async () => {
  await withRelease(async ({ srv, card, addCard, merging, until, release }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();
    await until(() => card(id).state === 'done' && release.ops.length === 1, 'closed and asked');
    await srv.mergeQueueTick();
    assert.ok(!devlog(card(id), /released v|release failed/));
  }, { release: fakeRelease({ reply: () => ({ ok: true, skipped: true, reason: 'package name x is not glmps' }) }) });
});

test('outside service mode with no desktop app to ask, no release is attempted', async () => {
  await withRelease(async ({ srv, card, addCard, merging, until, release }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();
    await until(() => card(id).state === 'done', 'closed');
    await srv.mergeQueueTick();
    assert.equal(release.ops.length, 0);
    assert.ok(!devlog(card(id), /released v|release failed/));
  }, { injectRelease: false });
});

test('AC-4: the queue does not start the next PR tests while a release is pending, then does', async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  await withRelease(async ({ srv, card, addCard, merging, requested, testRuns, until, release }) => {
    const a = await addCard();
    const b = await addCard({ title: 'Second' });
    merging(a);
    requested(b);
    const first = srv.mergeQueueTick(); // resolves only after the release it started settles
    await until(() => release.ops.length === 1, 'the release reached the desktop app');
    await srv.mergeQueueTick();
    await srv.mergeQueueTick();
    assert.equal(testRuns.length, 0, 'no test job starts on the pre-release base');
    assert.equal(card(b).mergeRequest.stage, 'requested');
    open();
    await first;
    await until(() => devlog(card(a), /released v2\.1\.0/), 'release finished');
    await srv.mergeQueueTick();
    await until(() => testRuns.length === 1, 'the next PR is tested once the release is done');
  }, { release: fakeRelease({ gate }) });
});
