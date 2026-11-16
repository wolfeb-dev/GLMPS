// server/test/nightly-main.test.js
//
// glmps-194: every exit path of the nightly script reports to the kernel and
// leaves a line in nightly/run.log. The fake kernel stands in for the
// dashboard's backlog route and the loop report route.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportNightlyOutcome, nightlyMain } from '../../scripts/nightly-run.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nightly-main-')); }

const NOW = Date.parse('2026-10-27T05:00:00.000Z');
const quiet = { log: () => {}, error: () => {} };

function readRunLog(dir) {
  return fs.readFileSync(path.join(dir, 'nightly', 'run.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function fakeKernel({ backlog = 'down', report = 200 } = {}) {
  const reports = [];
  let backlogCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url.includes('/api/backlog')) {
      backlogCalls += 1;
      if (backlog === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:8123');
      return { ok: true, status: 200, json: async () => ({ items: backlog }) };
    }
    reports.push(JSON.parse(init.body));
    return { ok: report >= 200 && report < 300, status: report };
  };
  return { fetchImpl, reports, backlogCalls: () => backlogCalls };
}

// configFile is pinned into the temp dir so no test can fall through to the
// real config.json at the repo root, where nightly may be enabled.
const run = (dir, k, over = {}) => nightlyMain({ stateDir: dir, configFile: path.join(dir, 'config.json'), port: '8123', argv: [], fetchImpl: k.fetchImpl, sleep: async () => {}, console: quiet, now: NOW, ...over });

test('a non-2xx report response is logged with its status and returned', async () => {
  const errors = [];
  const out = await reportNightlyOutcome(0, { port: '8123', fetchImpl: async () => ({ ok: false, status: 404 }), error: (m) => errors.push(m) });
  assert.deepEqual(out, { ok: false, status: 404 });
  assert.ok(errors.some((m) => m.includes('HTTP 404')), errors.join('\n'));
});

test('a 2xx report response returns ok with its status and logs nothing', async () => {
  const errors = [];
  const out = await reportNightlyOutcome(0, { port: '8123', fetchImpl: async () => ({ ok: true, status: 200 }), error: (m) => errors.push(m) });
  assert.deepEqual(out, { ok: true, status: 200 });
  assert.deepEqual(errors, []);
});

test('dashboard unreachable after retries: failed report sent, run.log line written, non-zero exit', async () => {
  const dir = tmp();
  const k = fakeKernel({ backlog: 'down' });
  const code = await run(dir, k);
  assert.notEqual(code, 0);
  assert.equal(k.backlogCalls(), 3);
  assert.equal(k.reports.length, 1);
  assert.equal(k.reports[0].outcome, 'failed');
  assert.match(k.reports[0].reason, /^dashboard unreachable/);
  const lines = readRunLog(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ts, '2026-10-27T05:00:00.000Z');
  assert.equal(lines[0].status, 'failed');
  assert.equal(lines[0].stage, 'backlog');
  assert.equal(lines[0].exitCode, code);
  assert.deepEqual(lines[0].report, { ok: true, status: 200 });
});

test('a normal night logs status, exit code and a rejected report result', async () => {
  const dir = tmp();
  const k = fakeKernel({ backlog: [], report: 500 });
  const code = await run(dir, k);
  assert.equal(code, 0);
  assert.deepEqual(k.reports, [{ outcome: 'done' }]);
  const [line] = readRunLog(dir);
  assert.equal(line.exitCode, 0);
  // No config.json in the temp state dir, so nightly is disabled: a stop.
  assert.equal(line.status, 'stopped');
  assert.deepEqual(line.report, { ok: false, status: 500 });
});

test('a deferred night (lock held) still reports and logs', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'nightly'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nightly', 'run.lock'), '1');
  const k = fakeKernel({ backlog: [] });
  const code = await run(dir, k);
  assert.equal(code, 0);
  assert.deepEqual(k.reports, [{ outcome: 'done' }]);
  assert.equal(readRunLog(dir)[0].status, 'deferred');
});

test('a crash mid-run is reported as failed and logged, never thrown', async () => {
  const dir = tmp();
  const k = fakeKernel({ backlog: [] });
  const code = await run(dir, k, { runNightlyImpl: async () => { throw new Error('boom'); } });
  assert.equal(code, 1);
  assert.deepEqual(k.reports, [{ outcome: 'failed', reason: 'crashed: boom' }]);
  const [line] = readRunLog(dir);
  assert.equal(line.status, 'crashed');
  assert.equal(line.reason, 'boom');
  assert.equal(line.exitCode, 1);
  assert.deepEqual(line.report, { ok: true, status: 200 });
});

test('a budget hard stop exits 1 and its reason reaches both the report and the log', async () => {
  const dir = tmp();
  const k = fakeKernel({ backlog: [] });
  const code = await run(dir, k, { runNightlyImpl: async () => ({ status: 'failed', stage: 'budget', reason: 'over $5', runId: 'nightly-20261027' }) });
  assert.equal(code, 1);
  assert.deepEqual(k.reports, [{ outcome: 'failed', reason: 'over $5' }]);
  const [line] = readRunLog(dir);
  assert.equal(line.stage, 'budget');
  assert.equal(line.runId, 'nightly-20261027');
});

// glmps-2-0-126: the script read <stateDir>/config.json while the server reads
// configFileFor() (GLMPS_CONFIG_FILE or <repoRoot>/config.json), so an operator's
// nightly.enabled:true was never seen and every night stopped as "disabled".
test('nightly reads the same config file the server does, not one under the state dir', async () => {
  const stateDir = tmp();
  const repoRoot = tmp();
  fs.writeFileSync(path.join(repoRoot, 'config.json'), JSON.stringify({ nightly: { enabled: true, repoAllowlist: ['p'] } }));
  const { configFileFor } = await import('../lib/paths.js');
  const k = fakeKernel({ backlog: [] });
  let seen;
  const code = await run(stateDir, k, {
    configFile: configFileFor({ env: {}, repoRoot }),
    runNightlyImpl: async ({ config }) => { seen = config; return { status: 'idle' }; },
  });
  assert.equal(code, 0);
  assert.equal(seen.enabled, true);
  assert.deepEqual(seen.repoAllowlist, ['p']);
  assert.equal(readRunLog(stateDir)[0].config.file, path.join(repoRoot, 'config.json'));
});

test('a missing config file is named in the log and on stderr, not silently read as disabled', async () => {
  const dir = tmp();
  const errors = [];
  const k = fakeKernel({ backlog: [] });
  await run(dir, k, { console: { log: () => {}, error: (m) => errors.push(m) } });
  const [line] = readRunLog(dir);
  assert.equal(line.status, 'stopped');
  assert.equal(line.config.file, path.join(dir, 'config.json'));
  assert.match(line.config.error, /ENOENT/);
  assert.ok(errors.some((m) => m.includes(path.join(dir, 'config.json'))), errors.join('\n'));
});
