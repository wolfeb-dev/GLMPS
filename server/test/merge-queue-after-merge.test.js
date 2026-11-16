// Card glmps-2-0-176 (review findings 1 and 2), server wiring after a queue
// merge: the merge kicks main's full test run at once when the queue is idle
// (card glmps-2-0-173 AC-4), the run waits while a request is testing, and the
// live check is its own registered loop that runs git only when it must.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { setMergeRequestIn, load, addItemTo } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { createMergeRequest } from '../lib/orchestration/merge-queue.js';
import { waitFor } from './helpers/wait-for.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);

function mkEnv(mergeQueue) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mq-after-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, mergeQueue: mergeQueue(tmp) }));
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

// A bare origin with one commit on main carrying a test script, and a clone of it.
function gitCheckout(tmp) {
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const origin = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(seed);
  g(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  g(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'w', scripts: { test: 'node --test' } }));
  g(seed, 'add', '.');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'seed');
  g(seed, 'push', '-q', origin, 'main');
  g(tmp, 'clone', '-q', origin, checkout);
  return checkout;
}

function fakeGh() {
  const merged = new Set();
  return async (file, args) => {
    const n = args[2];
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: merged.has(n) ? 'MERGED' : 'OPEN', headRefOid: HEAD, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: merged.has(n) ? { oid: MERGE } : null }), stderr: '' };
    if (args[1] === 'merge') { merged.add(n); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
}

const pass = () => ({ kind: 'pass', headSha: HEAD, tests: { status: 'pass', headSha: HEAD, mergedBaseSha: BASE, durationMs: 3, tail: 'ok', selection: { mode: 'affected', files: 1, of: 9 } } });
const reviewGit = async (args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? `${BASE}\n` : '', stderr: '' });


test('a queue merge starts the full main run at once, and the run waits while a request is testing', async () => {
  let checkout;
  const e = mkEnv((tmp) => { checkout = gitCheckout(tmp); return { repos: { 'acme/widgets': { path: checkout } } }; });
  const stateDir = e.env.GLMPS_STATE_DIR;
  const suiteRuns = [];
  const mainSuiteRunTest = async ({ cwd }) => { suiteRuns.push(cwd); return { exitCode: 0, tail: 'ok', durationMs: 1 }; };
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, ghRun: fakeGh(), mergeTestsRun: async () => pass(), reviewGit, mainSuiteRunTest });
  try {
    saveConfig(stateDir, { enabled: true });
    const id = addItemTo(stateDir, { title: 'one', prompt: 'p' }).item.id;
    setMergeRequestIn(stateDir, id, createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/5', repo: 'acme/widgets', number: 5, base: 'main', head: 'feat/one', headSha: HEAD, filedBy: 'w' }, { now: '2026-11-11T01:00:00.000Z' }));
    for (let i = 0; i < 4 && load(stateDir).items.find((x) => x.id === id).mergeRequest.stage !== 'merged'; i += 1) await srv.mergeQueueTick();
    assert.equal(load(stateDir).items.find((x) => x.id === id).mergeRequest.stage, 'merged');
    await waitFor(() => suiteRuns.length === 1, { message: 'the merge to kick one full run without waiting for the 30-minute timer' });
    await srv.loopRegistry.drain();
    assert.equal(srv.loopRegistry.snapshot()['merge-queue-main-suite'].lastOutcome, 'done');

    // A second request testing: the run is skipped, not queued behind it.
    const busy = addItemTo(stateDir, { title: 'busy', prompt: 'p' }).item.id;
    setMergeRequestIn(stateDir, busy, { ...createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/6', repo: 'acme/widgets', number: 6, base: 'main', head: 'feat/busy', headSha: HEAD, filedBy: 'w' }, { now: '2026-11-11T01:05:00.000Z' }), stage: 'testing' });
    const r = await srv.loopRegistry.runNow('merge-queue-main-suite');
    assert.equal(r.outcome, 'nothing-to-do');
    assert.equal(suiteRuns.length, 1, 'no full run while a request is testing');
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
});

function kernelSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: path.resolve(import.meta.dirname, '..', '..'), stdio: 'pipe' }).toString().trim();
    const m = /[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : 'wolfeb-dev/glmps-2.0';
  } catch { return 'wolfeb-dev/glmps-2.0'; }
}

test('the live check is its own loop: no git on queue ticks, one check per merge per running build, a quiet first run', async () => {
  const repo = kernelSlug();
  const e = mkEnv(() => ({ mainSuite: false, autoDeploy: { [`${repo}@main`]: 'deploy-glmps2' } }));
  const stateDir = e.env.GLMPS_STATE_DIR;
  const calls = [];
  const inBuild = new Set(['sha-a', 'sha-b']);
  const liveNoticeGit = async (args) => { calls.push(args.join(' ')); return { status: inBuild.has(args[2]) ? 0 : 1, stdout: '', stderr: '' }; };
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, ghRun: fakeGh(), mergeTestsRun: async () => pass(), reviewGit, liveNoticeGit });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    saveConfig(stateDir, { enabled: true });
    await waitFor(async () => !/\+unknown$/.test((await (await fetch(`${base}/healthz`)).json()).version), { message: 'the running commit to be known' });
    const mergedCard = (title, sha) => {
      const id = addItemTo(stateDir, { title, prompt: 'p' }).item.id;
      const mr = createMergeRequest({ prUrl: `https://github.com/${repo}/pull/9`, repo, number: 9, base: 'main', head: `feat/${title}`, headSha: HEAD, filedBy: 'w' }, { now: new Date(Date.now() - 60_000).toISOString() });
      setMergeRequestIn(stateDir, id, { ...mr, stage: 'merged', mergeSha: sha, history: [...mr.history, { ts: new Date().toISOString(), to: 'merged' }] });
      return id;
    };
    const card = (id) => load(stateDir).items.find((x) => x.id === id);
    const a = mergedCard('a', 'sha-a');
    const c = mergedCard('c', 'sha-c');

    for (let i = 0; i < 3; i += 1) await srv.mergeQueueTick();
    assert.equal(calls.length, 0, 'the 5 s queue tick runs no live-check git');
    assert.deepEqual(srv.loopRegistry.snapshot()['merge-queue-live-notice'].trigger, { everyMs: 60_000 });

    await srv.loopRegistry.runNow('merge-queue-live-notice');
    assert.ok(card(a).mergeRequest.live, 'a merge in the build is marked live');
    assert.equal(card(a).devLog?.some((d) => /^Live: /.test(d.text)) ?? false, false, 'the first run is quiet');
    assert.ok(fs.existsSync(path.join(stateDir, 'live-notices.json')), 'the first-run marker is written');
    assert.equal(card(c).mergeRequest.live, undefined);

    const b = mergedCard('b', 'sha-b');
    for (let i = 0; i < 3; i += 1) await srv.loopRegistry.runNow('merge-queue-live-notice');
    assert.match(card(b).devLog.at(-1).text, /^Live: .+ is in the running build/);
    assert.equal(calls.filter((x) => x.includes('sha-c')).length, 1, 'a merge not in the build is checked once per running build');
    assert.equal(calls.filter((x) => x.includes('sha-a')).length, 1, 'a live merge is not checked again');
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
});
