// Tests for running an approved action (server/lib/scut/approval-run.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runApprovalAction, queryTask, checkHealth } from '../lib/scut/approval-run.js';
import { approvalsConfig, outcomeText } from '../lib/scut/approvals.js';
import { REPO_ROOT } from '../lib/paths.js';

const DEPLOY = approvalsConfig({}).registry['deploy-glmps2'];
const RESTART = approvalsConfig({}).registry['restart-glmps2'];
const noSleep = async () => {};
const HEAD = 'abc1234def5678abc1234def5678abc1234def56';

function fakeExec({ launchCode = 0, states = [] } = {}) {
  const calls = [];
  const queue = [...states];
  const impl = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    if (file === 'powershell.exe') {
      const s = queue.length > 1 ? queue.shift() : queue[0];
      return cb(null, JSON.stringify(s), '');
    }
    if (file === 'git') return cb(null, `${HEAD}\n`, '');
    if (launchCode === 0) return cb(null, 'SUCCESS', '');
    const err = new Error('failed'); err.code = launchCode;
    return cb(err, '', 'ERROR: The system cannot find the file specified.');
  };
  return { impl, calls };
}

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'up', version: '0.1.0+abc1234', uptime_s: 3 }) });

test('deploy-glmps2 starts the task with its fixed args, waits for it, then checks health', async () => {
  const startedTs = Date.parse('2026-10-17T20:00:00Z');
  const { impl, calls } = fakeExec({ states: [
    { state: 'Running', lastResult: 267009, lastRunTime: '2026-10-17T20:00:01Z' },
    { state: 'Ready', lastResult: 0, lastRunTime: '2026-10-17T20:00:01Z' },
  ] });
  const r = await runApprovalAction(DEPLOY, { startedTs, execFileImpl: impl, fetchImpl: okFetch, sleep: noSleep, pollMs: 0 });
  assert.deepEqual(r, { ok: true, exitCode: 0, health: { status: 200, summary: 'up, 0.1.0+abc1234' } });
  const launch = calls.find((c) => c.file === 'C:\\Windows\\System32\\schtasks.exe');
  assert.deepEqual(launch.args, ['/Run', '/TN', '\\GLMPS\\deploy-glmps2']);
  assert.equal(launch.opts.shell, undefined);
  const q = calls.find((c) => c.file === 'powershell.exe');
  assert.equal(q.opts.env.GLMPS_APPROVAL_TASK, '\\GLMPS\\deploy-glmps2');
  assert.equal(q.args.join(' ').includes('deploy-glmps2'), false); // the name is never spliced into the script
});

test('the task exit status is its last result; a non-zero one fails the run', async () => {
  const startedTs = Date.parse('2026-10-17T20:00:00Z');
  const { impl } = fakeExec({ states: [{ state: 'Ready', lastResult: 1, lastRunTime: '2026-10-17T20:00:02Z' }] });
  const r = await runApprovalAction(DEPLOY, { startedTs, execFileImpl: impl, fetchImpl: okFetch, sleep: noSleep, pollMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
});

test('a stale last run (before this approval) is not taken as the outcome', async () => {
  const startedTs = Date.parse('2026-10-17T20:00:00Z');
  const { impl } = fakeExec({ states: [
    { state: 'Ready', lastResult: 0, lastRunTime: '2026-10-17T18:00:00Z' },
    { state: 'Ready', lastResult: 5, lastRunTime: '2026-10-17T20:00:03Z' },
  ] });
  const r = await runApprovalAction(DEPLOY, { startedTs, execFileImpl: impl, fetchImpl: okFetch, sleep: noSleep, pollMs: 0 });
  assert.equal(r.exitCode, 5);
});

test('a launch failure reports its exit status and does not wait', async () => {
  const { impl, calls } = fakeExec({ launchCode: 1 });
  const r = await runApprovalAction(DEPLOY, { startedTs: Date.now(), execFileImpl: impl, fetchImpl: okFetch, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.error, /could not start/);
  assert.deepEqual(calls.map((c) => c.file).filter((f) => f !== 'git'), ['C:\\Windows\\System32\\schtasks.exe']);
});

test('resume does not relaunch; it only waits on the task', async () => {
  const startedTs = Date.parse('2026-10-17T20:00:00Z');
  const { impl, calls } = fakeExec({ states: [{ state: 'Ready', lastResult: 0, lastRunTime: '2026-10-17T20:00:01Z' }] });
  const r = await runApprovalAction(DEPLOY, { startedTs, resume: true, execFileImpl: impl, fetchImpl: okFetch, sleep: noSleep, pollMs: 0 });
  assert.equal(r.ok, true);
  assert.ok(calls.every((c) => c.file === 'powershell.exe' || c.file === 'git'));
});

test('a task still running past the timeout is reported, not hung on', async () => {
  let t = 0;
  const { impl } = fakeExec({ states: [{ state: 'Running', lastResult: 267009, lastRunTime: new Date(0).toISOString() }] });
  const r = await runApprovalAction({ ...DEPLOY, timeoutMs: 1000 }, {
    startedTs: 0, execFileImpl: impl, fetchImpl: okFetch, now: () => t, sleep: async () => { t += 400; }, pollMs: 400,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /still running/);
});

test('an unhealthy server fails an otherwise clean run', async () => {
  const startedTs = Date.parse('2026-10-17T20:00:00Z');
  const { impl } = fakeExec({ states: [{ state: 'Ready', lastResult: 0, lastRunTime: '2026-10-17T20:00:01Z' }] });
  const down = async () => { throw new Error('ECONNREFUSED'); };
  const r = await runApprovalAction(DEPLOY, { startedTs, execFileImpl: impl, fetchImpl: down, sleep: noSleep, pollMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 0);
  assert.match(r.health.error, /ECONNREFUSED/);
});

// glmps-2-0-58: the 2026-10-18 run reported ok while an orphan of the old
// build answered /healthz 200.
test('a 200 from the old build fails the run and says so in the thread', async () => {
  const startedTs = Date.parse('2026-10-18T07:37:00Z');
  const { impl, calls } = fakeExec({ states: [{ state: 'Ready', lastResult: 0, lastRunTime: '2026-10-18T07:37:01Z' }] });
  const orphan = async () => ({ ok: true, status: 200, json: async () => ({ status: 'up', version: '0.1.0+7c5ed64', uptime_s: 30252 }) });
  const r = await runApprovalAction(DEPLOY, { startedTs, execFileImpl: impl, fetchImpl: orphan, sleep: noSleep, pollMs: 0, now: () => startedTs + 60_000 });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 0);
  assert.match(r.error, /0\.1\.0\+7c5ed64, expected \+abc1234/);
  const git = calls.find((c) => c.file === 'git');
  assert.deepEqual([git.args, git.opts.cwd], [['rev-parse', 'HEAD'], REPO_ROOT]);
  assert.match(outcomeText(DEPLOY, r), /^:x: `deploy-glmps2` FAILED: \/healthz reports 0\.1\.0\+7c5ed64, expected \+abc1234: the old build is still serving\. exit 0, \/healthz 200/);
});

const oldProcess = async () => ({ ok: true, status: 200, json: async () => ({ status: 'up', version: '0.1.0+abc1234', uptime_s: 3600 }) });
const readyState = { states: [{ state: 'Ready', lastResult: 0, lastRunTime: '2026-10-18T07:37:01Z' }] };
const T0 = Date.parse('2026-10-18T07:37:00Z');
// Reads HEAD once before the launch and again after, as the run wrapper does.
const heads = (...shas) => { const q = [...shas]; return async () => ({ sha: q.length > 1 ? q.shift() : q[0] }); };

test('plain restart keeps the strict check: the right commit from an older process fails on uptime', async () => {
  const { impl } = fakeExec(readyState);
  const r = await runApprovalAction(RESTART, { startedTs: T0, execFileImpl: impl, fetchImpl: oldProcess, sleep: noSleep, pollMs: 0, now: () => T0 + 60_000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /predates the restart/);
});

test('an update that moved the commit still fails when an older process serves it', async () => {
  const { impl } = fakeExec(readyState);
  const r = await runApprovalAction(DEPLOY, { startedTs: T0, execFileImpl: impl, fetchImpl: oldProcess, sleep: noSleep, pollMs: 0, now: () => T0 + 60_000, readHead: heads('1111111aaaa', HEAD) });
  assert.equal(r.ok, false);
  assert.match(r.error, /predates the restart/);
});

test('an update that exits 0, leaves the commit unchanged and serves it is a success', async () => {
  const { impl } = fakeExec(readyState);
  const r = await runApprovalAction(DEPLOY, { startedTs: T0, execFileImpl: impl, fetchImpl: oldProcess, sleep: noSleep, pollMs: 0, now: () => T0 + 60_000, readHead: heads(HEAD) });
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined);
});

test('an unchanged commit still fails if the wrong build is serving', async () => {
  const { impl } = fakeExec(readyState);
  const wrong = async () => ({ ok: true, status: 200, json: async () => ({ status: 'up', version: '0.1.0+7c5ed64', uptime_s: 3600 }) });
  const r = await runApprovalAction(DEPLOY, { startedTs: T0, execFileImpl: impl, fetchImpl: wrong, sleep: noSleep, pollMs: 0, now: () => T0 + 60_000, readHead: heads(HEAD) });
  assert.equal(r.ok, false);
  assert.match(r.error, /expected \+abc1234/);
});

test('a resumed update keeps the strict check', async () => {
  const { impl } = fakeExec(readyState);
  const r = await runApprovalAction(DEPLOY, { startedTs: T0, resume: true, execFileImpl: impl, fetchImpl: oldProcess, sleep: noSleep, pollMs: 0, now: () => T0 + 60_000, readHead: heads(HEAD) });
  assert.equal(r.ok, false);
  assert.match(r.error, /predates the restart/);
});

test('the health check retries a mismatch, so a server still coming up can pass', async () => {
  const startedTs = Date.parse('2026-10-18T07:37:00Z');
  const { impl } = fakeExec({ states: [{ state: 'Ready', lastResult: 0, lastRunTime: '2026-10-18T07:37:01Z' }] });
  let n = 0;
  const f = async () => ({ ok: true, status: 200, json: async () => (++n < 3 ? { version: '0.1.0+unknown', uptime_s: 1 } : { status: 'up', version: '0.1.0+abc1234', uptime_s: 2 }) });
  const r = await runApprovalAction(DEPLOY, { startedTs, execFileImpl: impl, fetchImpl: f, sleep: noSleep, pollMs: 0, now: () => startedTs + 30_000 });
  assert.equal(r.ok, true);
  assert.equal(n, 3);
});

test('an unreadable deployed commit fails the run rather than skipping the check', async () => {
  const startedTs = Date.parse('2026-10-18T07:37:00Z');
  const { impl } = fakeExec({ states: [{ state: 'Ready', lastResult: 0, lastRunTime: '2026-10-18T07:37:01Z' }] });
  const r = await runApprovalAction(DEPLOY, { startedTs, execFileImpl: impl, fetchImpl: okFetch, sleep: noSleep, pollMs: 0, readHead: async () => ({ sha: null, error: 'dubious ownership' }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, `could not read the deployed commit in ${REPO_ROOT}: dubious ownership`);
});

test('checkHealth retries until the server answers', async () => {
  let n = 0;
  const f = async () => { if (++n < 3) throw new Error('down'); return { ok: true, status: 200, json: async () => ({ status: 'up' }) }; };
  assert.deepEqual(await checkHealth('http://x/healthz', { fetchImpl: f, sleep: noSleep }), { status: 200, summary: 'up' });
});

test('queryTask parses the PowerShell JSON', async () => {
  const { impl } = fakeExec({ states: [{ state: 'Ready', lastResult: 0, lastRunTime: '2026-10-17T20:00:01.0000000Z' }] });
  const s = await queryTask('\\GLMPS\\deploy-glmps2', { execFileImpl: impl });
  assert.deepEqual(s, { state: 'Ready', lastResult: 0, lastRunTs: Date.parse('2026-10-17T20:00:01Z') });
});
