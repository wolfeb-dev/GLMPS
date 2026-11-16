// Routes under test: server/lib/routes/merge-queue-routes.js
// Card glmps-2-0-runtime-125 (AC-3): while an integration branch's last
// full-suite run is red the queue merges nothing into it except a PR whose
// tests show the red files green, the pause is on the lane and the held
// cards, and a green run resumes the queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn, load, addItemTo } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { createMergeRequest } from '../lib/orchestration/merge-queue.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const RED_SHA = 'r'.repeat(40);
const MERGE = 'c'.repeat(40);
const KEY = 'acme/widgets@main';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqred-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, mergeQueue: { mainSuite: false, repos: { 'acme/widgets': { path: checkout } } } }));
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

// GitHub: every PR is open at HEAD until merged.
function fakeGh() {
  const merged = new Set();
  const run = async (file, args) => {
    const n = args[2];
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: merged.has(n) ? 'MERGED' : 'OPEN', headRefOid: HEAD, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: merged.has(n) ? { oid: MERGE } : null }), stderr: '' };
    if (args[1] === 'merge') { merged.add(n); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, merged };
}

const pass = (redFiles) => ({ kind: 'pass', headSha: HEAD, tests: { status: 'pass', headSha: HEAD, mergedBaseSha: BASE, durationMs: 3, tail: 'ok', selection: { mode: 'affected', files: 1, of: 9, ...(redFiles ? { redFiles } : {}) } } });

test('a red base pauses merging: a non-fix PR is held and shown, the fix merges, and a green run resumes the queue', async () => {
  const e = mkEnv();
  const stateDir = e.env.GLMPS_STATE_DIR;
  const suiteFile = path.join(stateDir, 'merge-queue-main-suite.json');
  fs.writeFileSync(suiteFile, JSON.stringify({ [KEY]: { lastTestedSha: RED_SHA, red: { sha: RED_SHA, ts: '2026-11-01T10:00:00.000Z', files: ['server/test/x.test.js'], cardId: null } } }));
  const gh = fakeGh();
  const runs = [];
  const ids = {};
  const mergeTestsRun = async (a) => { runs.push(a); return a.id === ids['fix-1'] ? pass(a.extraTests) : pass(); };
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, ghRun: gh.run, mergeTestsRun, reviewGit: async (args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? `${BASE}\n` : '', stderr: '' }) });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    saveConfig(stateDir, { enabled: true });
    const file = (name, number, filedAt) => { ids[name] = addItemTo(stateDir, { title: name, prompt: 'p' }).item.id; setMergeRequestIn(stateDir, ids[name], createMergeRequest({ prUrl: `https://github.com/acme/widgets/pull/${number}`, repo: 'acme/widgets', number, base: 'main', head: `feat/${name}`, headSha: HEAD, filedBy: 'w' }, { now: filedAt })); };
    const card = (name) => load(stateDir).items.find((i) => i.id === ids[name]);
    file('other-1', 5, '2026-11-01T11:00:00.000Z');
    file('fix-1', 6, '2026-11-01T11:05:00.000Z');

    await srv.mergeQueueTick();
    assert.deepEqual(runs[0].extraTests, ['server/test/x.test.js'], 'the red run\'s failing files are added to the PR\'s run');
    const held = card('other-1').mergeRequest;
    assert.equal(held.stage, 'requested');
    assert.equal(held.redHold, RED_SHA);
    assert.match(card('other-1').devLog.at(-1).text, /paused: the full suite is red on main at rrrrrrr/);

    for (let i = 0; i < 4 && card('fix-1').mergeRequest.stage !== 'merged'; i += 1) await srv.mergeQueueTick();
    assert.equal(card('fix-1').mergeRequest.stage, 'merged', 'the PR that shows the red files green merges');
    assert.equal(card('other-1').mergeRequest.stage, 'requested', 'the held PR is not retested while the red stands');
    assert.equal(gh.merged.size, 1);

    const lanes = (await (await fetch(`${base}/api/merge-queue`)).json()).branches;
    assert.match(lanes.find((l) => l.branch === KEY).paused.reason, /red on main/);

    fs.writeFileSync(suiteFile, JSON.stringify({ [KEY]: { lastTestedSha: MERGE, lastGreenSha: MERGE, red: null } }));
    await srv.mergeQueueTick();
    assert.equal(card('other-1').mergeRequest.redHold, undefined);
    assert.match(card('other-1').devLog.at(-1).text, /resumed: the full suite on main is green again/);
    for (let i = 0; i < 4 && card('other-1').mergeRequest.stage !== 'merged'; i += 1) await srv.mergeQueueTick();
    assert.equal(card('other-1').mergeRequest.stage, 'merged', 'after a green run the queue merges again');
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
});

test('a request already in merging when the base turns red goes back to be tested against it', async () => {
  const e = mkEnv();
  const stateDir = e.env.GLMPS_STATE_DIR;
  fs.writeFileSync(path.join(stateDir, 'merge-queue-main-suite.json'), JSON.stringify({ [KEY]: { red: { sha: RED_SHA, ts: '2026-11-01T10:00:00.000Z', files: [], cardId: null } } }));
  const gh = fakeGh();
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, ghRun: gh.run, mergeTestsRun: async () => pass(), reviewGit: async () => ({ status: 0, stdout: `${BASE}\n`, stderr: '' }) });
  try {
    saveConfig(stateDir, { enabled: true });
    let m = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/9', repo: 'acme/widgets', number: 9, base: 'main', head: 'feat/y', headSha: HEAD, filedBy: 'w' }, { now: '2026-11-01T09:00:00.000Z' });
    m = { ...m, stage: 'merging', tests: pass().tests };
    const lateId = addItemTo(stateDir, { title: 'late', prompt: 'p' }).item.id;
    setMergeRequestIn(stateDir, lateId, m);
    await srv.mergeQueueTick();
    const now = load(stateDir).items.find((i) => i.id === lateId);
    assert.equal(now.mergeRequest.stage, 'requested');
    assert.match(now.devLog.at(-1).text, /paused before merging/);
    assert.equal(gh.merged.size, 0, 'nothing merges into a red base');
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
});
