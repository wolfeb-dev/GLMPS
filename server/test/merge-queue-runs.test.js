// Card glmps-2-0-runtime-98 (F5): the queue's headroom record and alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRuns, recordRun, runRecord, headroomAlerts, countTestProcs, KEEP_RUNS } from '../lib/orchestration/merge-queue-runs.js';

const CEIL = 30 * 60 * 1000;
const run = (min, i = 0) => ({ ts: `2026-10-29T1${i}:00:00.000Z`, id: `c${i}`, kind: 'pass', durationMs: min * 60_000, timeoutMs: CEIL, concurrentTests: 3 + i, selection: 'affected' });

test('runRecord keeps duration, ceiling, concurrency and selection; a skip records nothing', () => {
  const r = runRecord({ id: 'c1', ts: 'T', concurrentTests: 4, outcome: { kind: 'timeout', tests: { status: 'fail', headSha: 'a', durationMs: CEIL, timeoutMs: CEIL, selection: { mode: 'full' } } } });
  assert.deepEqual(r, { ts: 'T', id: 'c1', kind: 'timeout', headSha: 'a', durationMs: CEIL, timeoutMs: CEIL, concurrentTests: 4, selection: 'full' });
  assert.equal(runRecord({ id: 'c1', ts: 'T', outcome: { kind: 'pass', tests: { status: 'skipped' } } }), null);
  assert.equal(runRecord({ id: 'c1', ts: 'T', outcome: { kind: 'error', tests: { status: 'error', reason: 'x' } } }), null);
});

test('recordRun appends and keeps the last 50', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqruns-'));
  try {
    assert.deepEqual(loadRuns(dir), []);
    for (let i = 0; i < KEEP_RUNS + 3; i++) recordRun(dir, { ...run(1), id: `c${i}` });
    const runs = loadRuns(dir);
    assert.equal(runs.length, KEEP_RUNS);
    assert.equal(runs.at(-1).id, `c${KEEP_RUNS + 2}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('headroomAlerts warns when the median of the last 5 passes half the ceiling', () => {
  assert.deepEqual(headroomAlerts([run(5), run(6), run(20), run(4), run(5)]), []);
  assert.deepEqual(headroomAlerts([run(20), run(20), run(20), run(20)]), [], 'fewer than 5 runs');
  const a = headroomAlerts([run(1), run(5), run(16, 1), run(20, 2), run(17, 3), run(30, 4)]);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warn');
  assert.equal(a[0].source, 'merge-queue-headroom');
  assert.match(a[0].title, /median 17 min of the 30 min ceiling/);
  assert.match(a[0].detail, /3, 4, 5, 6, 7/);
});

test('countTestProcs counts node --test command lines only', () => {
  const lines = [
    '"C:\\Program Files\\nodejs\\node.exe" --test --env-file=test.env --test-concurrency=4 **/*.test.js',
    'node --test server/test/a.test.js',
    'node server/server.js',
    'node --test-reporter=spec x.js',
    'node C:\\npm\\npm-cli.js test',
  ].join('\r\n');
  assert.equal(countTestProcs(lines), 2);
  assert.equal(countTestProcs(''), 0);
});
