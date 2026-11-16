// Card glmps-2-0-107: a PR that covers only some ACs keeps its card open, which
// assumes the author is still there to finish. A headless author exits when it
// files, so runtime-33, -34, -37 and -63 sat idle for hours after their merge
// and deploy with nobody coming back for the live-check criterion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import * as runnerStore from '../lib/orchestration/runner-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import { strandedAfterMerge } from '../lib/orchestration/merge-exec.js';
import { deployFinished } from '../lib/orchestration/auto-deploy.js';

const MERGED = '2026-10-27T00:38:11.000Z';
const mergedMr = (extra = {}) => ({
  repo: 'acme/w', number: 9, base: 'main', stage: 'merged', covers: [1], interim: false, final: false, mergeSha: 'abc1234',
  history: [{ to: 'merged', ts: MERGED }], ...extra,
});
const card = (extra = {}) => ({
  id: 'c-1', state: 'idle', idleSince: '2026-10-27T00:33:33.000Z',
  acceptanceCriteria: [{ text: 'AC-1: code' }, { text: 'AC-2: live check' }],
  coverage: { 1: { prUrl: 'x', at: MERGED } }, mergeRequest: mergedMr(), ...extra,
});

test('an idle card whose session ended before its partial merge is stranded, with its open criteria', () => {
  assert.deepEqual(strandedAfterMerge({ items: [card()] }).map((s) => [s.id, s.open]), [['c-1', [2]]]);
});

test('a card that went idle after the merge already saw it and is left alone', () => {
  assert.deepEqual(strandedAfterMerge({ items: [card({ idleSince: '2026-10-27T00:40:00.000Z' })] }), []);
});

test('interim, final, uncovered-by-covers, fully covered, non-idle, leased and reintent cards are not stranded', () => {
  const none = [
    card({ mergeRequest: mergedMr({ interim: true }) }),
    card({ mergeRequest: mergedMr({ final: true }) }),
    card({ mergeRequest: mergedMr({ covers: null }) }),
    card({ coverage: { 1: { at: MERGED }, 2: { at: MERGED } } }),
    card({ state: 'held' }),
    card({ gate: { status: 'FAIL', reintent: true } }),
    card({ mergeRequest: mergedMr({ stage: 'merging' }) }),
    card({ mergeRequest: mergedMr({ mergedOutsideQueue: true }) }),
  ];
  assert.deepEqual(strandedAfterMerge({ items: none }), []);
  assert.deepEqual(strandedAfterMerge({ items: [card()], ledger: { 'c-1': { pid: null } } }), [], 'a live ledger entry owns it');
});

test('a stranded card waits until its merge has been deployed', () => {
  assert.deepEqual(strandedAfterMerge({ items: [card()], deployed: () => false }), []);
  let asked = null;
  strandedAfterMerge({ items: [card()], deployed: (mr, ts) => { asked = [mr.number, ts]; return true; } });
  assert.deepEqual(asked, [9, Date.parse(MERGED)]);
});

const AUTO = { 'acme/w@main': 'deploy-x' };
const run = (id, startedTs, finishedTs) => [
  { ts: startedTs, type: 'request', id, action: 'deploy-x' },
  { ts: startedTs, type: 'run-started', id, action: 'deploy-x' },
  ...(finishedTs ? [{ ts: finishedTs, type: 'run-finished', id, action: 'deploy-x', result: { ok: true } }] : []),
];

test('deployFinished: no deploy configured for the base means nothing to wait for', () => {
  assert.equal(deployFinished({ mr: mergedMr({ base: 'other' }), mergeTs: Date.parse(MERGED), entries: [], autoDeploy: AUTO }), true);
  assert.equal(deployFinished({ mr: mergedMr(), mergeTs: Date.parse(MERGED), entries: [], autoDeploy: undefined }), true);
});

test('deployFinished: only a run that started at or after the merge and finished counts', () => {
  const t = Date.parse(MERGED);
  const at = (entries) => deployFinished({ mr: mergedMr(), mergeTs: t, entries, autoDeploy: AUTO });
  assert.equal(at([]), false, 'not deployed yet');
  assert.equal(at(run('a', t - 60_000, t - 30_000)), false, 'an earlier deploy does not carry this merge');
  assert.equal(at(run('b', t + 1000, null)), false, 'still running');
  assert.equal(at(run('c', t + 1000, t + 20_000)), true);
});

test('the merge-queue tick requeues a stranded card once, with the open criteria in its reopen note', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stranded-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_SCUT: 'off', GLMPS_UNMERGED_SCAN: 'off' };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()] }));
  const base = { project: 'p', title: 't', prompt: 'x', devLog: [], activity: [] };
  backlogStore.save(stateDir, { items: [{ ...base, ...card() }, { ...base, ...card({ id: 'c-2', idleSince: '2026-10-27T00:40:00.000Z' }) }] });
  runnerStore.saveConfig(stateDir, { enabled: true, maxConcurrent: 0 });
  const h = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {} });
  try {
    await h.mergeQueueTick();
    const byId = (id) => backlogStore.load(stateDir).items.find((i) => i.id === id);
    assert.equal(byId('c-1').state, 'queued');
    assert.match(byId('c-1').pendingReopen.note, /Still open: AC-2/);
    assert.equal(byId('c-2').state, 'idle', 'its session saw the merge');
    await h.mergeQueueTick();
    assert.equal(byId('c-1').activity.filter((a) => /requeued so a session finishes AC-2/.test(a.text)).length, 1, 'once');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
