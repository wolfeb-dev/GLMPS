// server/test/qa-trends-store.test.js
//
// Unit tests for qa-trends-store.js: the pure parsers (parseTestSummary,
// runToPoint, parseRunListJson, parseOpenIssuesCount) against realistic
// fixtures - NO network, no gh - plus the plain NDJSON store
// (append/dedup/read/sort). The gh-calling orchestrators (sampleLatestRun,
// backfillHistory, qaTrendsTick) are I/O glue and intentionally not exercised
// here, matching hooks/ci-status-surface.js's own pure-core-vs-CLI-glue split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  qaTrendsFile, readQaTrends, hasRunId, appendPoint,
  parseTestSummary, runToPoint, parseRunListJson, parseOpenIssuesCount,
  unparsedRunIds, repairPoint, qaTrendsView, qaGhArgs, sampleLatestRun, repoFromRemote,
} from '../lib/observability/qa-trends-store.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-qat-')); tmpDirs.push(d); return d; }

// mimicking the repo's real 3-leg matrix (.github/workflows/ci.yml: ubuntu-20,
// ubuntu-24, windows-24) all running the same `npm test` (node --test) suite.

const GREEN_LOG = [
  'test (ubuntu-latest, 20)\tRun npm test\t2026-07-10T12:00:01.0000000Z # tests 2405',
  'test (ubuntu-latest, 20)\tRun npm test\t2026-07-10T12:00:01.0000001Z # suites 45',
  'test (ubuntu-latest, 20)\tRun npm test\t2026-07-10T12:00:01.0000002Z # pass 2405',
  'test (ubuntu-latest, 20)\tRun npm test\t2026-07-10T12:00:01.0000003Z # fail 0',
  'test (ubuntu-latest, 20)\tRun npm test\t2026-07-10T12:00:01.0000004Z # cancelled 0',
  'test (ubuntu-latest, 24)\tRun npm test\t2026-07-10T12:00:05.0000000Z # tests 2405',
  'test (ubuntu-latest, 24)\tRun npm test\t2026-07-10T12:00:05.0000001Z # pass 2405',
  'test (ubuntu-latest, 24)\tRun npm test\t2026-07-10T12:00:05.0000002Z # fail 0',
  'test (windows-latest, 24)\tRun npm test\t2026-07-10T12:00:09.0000000Z # tests 2405',
  'test (windows-latest, 24)\tRun npm test\t2026-07-10T12:00:09.0000001Z # pass 2405',
  'test (windows-latest, 24)\tRun npm test\t2026-07-10T12:00:09.0000002Z # fail 0',
].join('\n') + '\n';

// One leg (windows-latest, 24) actually fails 3 tests; the other two legs are
// clean. fail must come from the failing leg (max across legs), not leg order.
const FAILED_LOG = [
  'test (ubuntu-latest, 20)\tRun npm test\t2026-07-11T09:00:01.0000000Z # tests 2410',
  'test (ubuntu-latest, 20)\tRun npm test\t2026-07-11T09:00:01.0000001Z # pass 2410',
  'test (ubuntu-latest, 20)\tRun npm test\t2026-07-11T09:00:01.0000002Z # fail 0',
  'test (ubuntu-latest, 24)\tRun npm test\t2026-07-11T09:00:05.0000000Z # tests 2410',
  'test (ubuntu-latest, 24)\tRun npm test\t2026-07-11T09:00:05.0000001Z # pass 2410',
  'test (ubuntu-latest, 24)\tRun npm test\t2026-07-11T09:00:05.0000002Z # fail 0',
  'test (windows-latest, 24)\tRun npm test\t2026-07-11T09:00:09.0000000Z # tests 2410',
  'test (windows-latest, 24)\tRun npm test\t2026-07-11T09:00:09.0000001Z # pass 2407',
  'test (windows-latest, 24)\tRun npm test\t2026-07-11T09:00:09.0000002Z # fail 3',
].join('\n') + '\n';

// A job that failed before npm test ever printed a summary (e.g. checkout or
// setup-node failure) - no `# tests`/`# pass`/`# fail` lines anywhere.
const MISSING_SUMMARY_LOG = [
  'test (ubuntu-latest, 20)\tSet up job\t2026-07-12T08:00:00.0000000Z Current runner version: 2.999.0',
  'test (ubuntu-latest, 20)\tRun actions/checkout@v4\t2026-07-12T08:00:01.0000000Z Syncing repository',
  'test (ubuntu-latest, 20)\tRun actions/checkout@v4\t2026-07-12T08:00:02.0000000Z ##[error] fatal: unable to access repository',
].join('\n') + '\n';


test('parseTestSummary: green log -> testCount/pass from first leg, fail 0', () => {
  const s = parseTestSummary(GREEN_LOG);
  assert.deepEqual(s, { testCount: 2405, pass: 2405, fail: 0 });
});

test('parseTestSummary: failed log -> fail is the MAX across legs, not the first leg (0)', () => {
  const s = parseTestSummary(FAILED_LOG);
  assert.deepEqual(s, { testCount: 2410, pass: 2410, fail: 3 });
});

test('parseTestSummary: missing summary -> null', () => {
  assert.equal(parseTestSummary(MISSING_SUMMARY_LOG), null);
});

test('parseTestSummary: empty/non-string input -> null, never throws', () => {
  assert.equal(parseTestSummary(''), null);
  assert.equal(parseTestSummary(null), null);
  assert.equal(parseTestSummary(undefined), null);
  assert.equal(parseTestSummary(12345), null);
});

test('parseTestSummary: tolerates a single leg with no prefix at all', () => {
  const s = parseTestSummary('# tests 10\n# pass 9\n# fail 1\n');
  assert.deepEqual(s, { testCount: 10, pass: 9, fail: 1 });
});


function ghRun(overrides = {}) {
  return {
    databaseId: 29369243984,
    conclusion: 'success',
    status: 'completed',
    headSha: '4d8b2ddabcdef1234567890abcdef1234567890',
    createdAt: '2026-07-10T12:00:00Z',
    ...overrides,
  };
}

test('runToPoint: builds the exact point shape from a completed run + summary + openIssues', () => {
  const p = runToPoint(ghRun(), { testCount: 2405, pass: 2364, fail: 0 }, 0);
  assert.deepEqual(p, {
    ts: Date.parse('2026-07-10T12:00:00Z'),
    runId: 29369243984,
    sha: '4d8b2dd', // short (7-char) sha
    testCount: 2405,
    pass: 2364,
    fail: 0,
    conclusion: 'success',
    openIssues: 0,
    source: 'ci', // every CI-sampler point is tagged source:'ci' (glmps qa-trends-local)
  });
});

test('runToPoint: null summary -> testCount/pass/fail all null, point still recorded', () => {
  const p = runToPoint(ghRun({ conclusion: 'failure' }), null, 2);
  assert.equal(p.testCount, null);
  assert.equal(p.pass, null);
  assert.equal(p.fail, null);
  assert.equal(p.conclusion, 'failure');
  assert.equal(p.openIssues, 2);
});

test('runToPoint: non-completed status -> null', () => {
  assert.equal(runToPoint(ghRun({ status: 'in_progress' }), { testCount: 1, pass: 1, fail: 0 }, 0), null);
  assert.equal(runToPoint(ghRun({ status: 'queued' }), { testCount: 1, pass: 1, fail: 0 }, 0), null);
});

test('runToPoint: missing/non-numeric databaseId -> null', () => {
  assert.equal(runToPoint(ghRun({ databaseId: undefined }), null, 0), null);
  assert.equal(runToPoint(ghRun({ databaseId: 'abc' }), null, 0), null);
});

test('runToPoint: unparseable createdAt -> null', () => {
  assert.equal(runToPoint(ghRun({ createdAt: 'not-a-date' }), null, 0), null);
  assert.equal(runToPoint(ghRun({ createdAt: undefined }), null, 0), null);
});

test('runToPoint: null/non-object run -> null, never throws', () => {
  assert.equal(runToPoint(null, null, 0), null);
  assert.equal(runToPoint('nope', null, 0), null);
});

test('runToPoint: missing headSha -> sha null', () => {
  const p = runToPoint(ghRun({ headSha: undefined }), { testCount: 1, pass: 1, fail: 0 }, 0);
  assert.equal(p.sha, null);
});

test('runToPoint: negative/NaN openIssues falls back to 0', () => {
  const p = runToPoint(ghRun(), { testCount: 1, pass: 1, fail: 0 }, NaN);
  assert.equal(p.openIssues, 0);
  const p2 = runToPoint(ghRun(), { testCount: 1, pass: 1, fail: 0 }, undefined);
  assert.equal(p2.openIssues, 0);
});


test('parseRunListJson: array of runs passes through', () => {
  const arr = [ghRun({ databaseId: 1 }), ghRun({ databaseId: 2 })];
  assert.deepEqual(parseRunListJson(JSON.stringify(arr)), arr);
});

test('parseRunListJson: empty array -> []', () => {
  assert.deepEqual(parseRunListJson('[]'), []);
});

test('parseRunListJson: invalid JSON / non-array -> [], never throws', () => {
  assert.deepEqual(parseRunListJson('not json'), []);
  assert.deepEqual(parseRunListJson(''), []);
  assert.deepEqual(parseRunListJson(undefined), []);
  assert.deepEqual(parseRunListJson(JSON.stringify({ not: 'an array' })), []);
});


test('parseOpenIssuesCount: array length', () => {
  assert.equal(parseOpenIssuesCount(JSON.stringify([{ number: 1 }, { number: 2 }])), 2);
});

test('parseOpenIssuesCount: empty array -> 0', () => {
  assert.equal(parseOpenIssuesCount('[]'), 0);
});

test('parseOpenIssuesCount: invalid JSON / non-array -> 0, never throws', () => {
  assert.equal(parseOpenIssuesCount('not json'), 0);
  assert.equal(parseOpenIssuesCount(undefined), 0);
  assert.equal(parseOpenIssuesCount(JSON.stringify({ not: 'an array' })), 0);
});


function point(overrides = {}) {
  return {
    ts: Date.parse('2026-07-10T12:00:00Z'), runId: 1, sha: 'abc1234',
    testCount: 100, pass: 100, fail: 0, conclusion: 'success', openIssues: 0,
    source: 'ci',
    ...overrides,
  };
}

test('readQaTrends: missing store -> []', () => {
  const stateDir = mkTmp();
  assert.deepEqual(readQaTrends(stateDir), []);
});

test('appendPoint + readQaTrends: round-trips a point', () => {
  const stateDir = mkTmp();
  const ok = appendPoint(stateDir, point());
  assert.equal(ok, true);
  const rows = readQaTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], point());
  assert.ok(fs.existsSync(qaTrendsFile(stateDir)));
});

test('appendPoint: dedupes by runId - second append of the same runId is a no-op', () => {
  const stateDir = mkTmp();
  assert.equal(appendPoint(stateDir, point({ runId: 5, testCount: 100 })), true);
  assert.equal(appendPoint(stateDir, point({ runId: 5, testCount: 999 })), false); // dup runId, dropped
  const rows = readQaTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].testCount, 100); // original kept, not overwritten
});

test('hasRunId: true only for a recorded runId', () => {
  const stateDir = mkTmp();
  appendPoint(stateDir, point({ runId: 42 }));
  assert.equal(hasRunId(stateDir, 42), true);
  assert.equal(hasRunId(stateDir, 43), false);
});

test('readQaTrends: sorted ascending by ts regardless of append order', () => {
  const stateDir = mkTmp();
  appendPoint(stateDir, point({ runId: 3, ts: Date.parse('2026-07-12T00:00:00Z') }));
  appendPoint(stateDir, point({ runId: 1, ts: Date.parse('2026-07-10T00:00:00Z') }));
  appendPoint(stateDir, point({ runId: 2, ts: Date.parse('2026-07-11T00:00:00Z') }));
  const rows = readQaTrends(stateDir);
  assert.deepEqual(rows.map(r => r.runId), [1, 2, 3]);
});

test('readQaTrends: tolerates blank lines and malformed/incomplete records', () => {
  const stateDir = mkTmp();
  const dir = path.join(stateDir, 'qa-trends');
  fs.mkdirSync(dir, { recursive: true });
  const good = JSON.stringify(point({ runId: 9 }));
  fs.writeFileSync(qaTrendsFile(stateDir),
    '\n' + good + '\n' + 'not json\n' + JSON.stringify({ runId: 10 }) /* no ts */ + '\n' + JSON.stringify({ ts: 1 }) /* no runId */ + '\n   \n');
  const rows = readQaTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, 9);
});

test('appendPoint: rejects a point with no numeric runId', () => {
  const stateDir = mkTmp();
  assert.equal(appendPoint(stateDir, { ts: 1 }), false);
  assert.equal(appendPoint(stateDir, null), false);
  assert.equal(appendPoint(stateDir, { ts: 1, runId: 'not-a-number' }), false);
  assert.deepEqual(readQaTrends(stateDir), []);
});

// docs/superpowers/specs/2026-07-14-qa-trends-design.md's "option C": the
// local hook writes points with runId:null (there is no CI run id for a local
// `npm test`), so appendPoint/readQaTrends must treat runId:null as a valid,
// non-deduped point shape -- distinct from "missing/malformed runId", which
// must keep being rejected/dropped exactly as before.

test('readQaTrends: legacy point with no source field defaults to source:"ci" (no migration)', () => {
  const stateDir = mkTmp();
  const dir = path.join(stateDir, 'qa-trends');
  fs.mkdirSync(dir, { recursive: true });
  // A pre-existing NDJSON line written before the source field existed --
  // simulate it by deleting the key rather than relying on point()'s default.
  const legacy = point();
  delete legacy.source;
  fs.writeFileSync(qaTrendsFile(stateDir), JSON.stringify(legacy) + '\n');
  const rows = readQaTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'ci');
});

test('readQaTrends: preserves an explicit source:"local" value', () => {
  const stateDir = mkTmp();
  const dir = path.join(stateDir, 'qa-trends');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(qaTrendsFile(stateDir), JSON.stringify(point({ runId: null, source: 'local' })) + '\n');
  const rows = readQaTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'local');
});

test('readQaTrends: an unrecognized/garbage source value also defaults to "ci"', () => {
  const stateDir = mkTmp();
  const dir = path.join(stateDir, 'qa-trends');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(qaTrendsFile(stateDir), JSON.stringify(point({ source: 'bogus' })) + '\n');
  const rows = readQaTrends(stateDir);
  assert.equal(rows[0].source, 'ci');
});

test('appendPoint: accepts runId:null (a local point) and writes it', () => {
  const stateDir = mkTmp();
  const ok = appendPoint(stateDir, point({ runId: null, source: 'local' }));
  assert.equal(ok, true);
  const rows = readQaTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, null);
  assert.equal(rows[0].source, 'local');
});

test('appendPoint: runId:null points are never deduped against each other -- every local run is kept', () => {
  const stateDir = mkTmp();
  assert.equal(appendPoint(stateDir, point({ runId: null, source: 'local', ts: 1 })), true);
  assert.equal(appendPoint(stateDir, point({ runId: null, source: 'local', ts: 2 })), true);
  assert.equal(appendPoint(stateDir, point({ runId: null, source: 'local', ts: 3 })), true);
  const rows = readQaTrends(stateDir);
  assert.equal(rows.length, 3);
});

test('readQaTrends: a point with runId explicitly null is retained, not silently dropped', () => {
  const stateDir = mkTmp();
  const dir = path.join(stateDir, 'qa-trends');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(qaTrendsFile(stateDir), JSON.stringify(point({ runId: null })) + '\n');
  const rows = readQaTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, null);
});

test('appendPoint: still rejects a point whose runId is undefined (missing key), same as before', () => {
  const stateDir = mkTmp();
  assert.equal(appendPoint(stateDir, { ts: 1, source: 'local' }), false);
  assert.deepEqual(readQaTrends(stateDir), []);
});

// Observed: the point for runId 29954154238 (sha b924e46) carried
// testCount/pass/fail null while conclusion was 'success'. Two distinct causes,
// both fixed here.

// Cause 1: the CI matrix emits TWO summary styles. Measured on that run's real
// log: 2 legs printed the spec reporter's "i tests N" and 1 leg printed TAP's
// "# tests N". The parser only understood "#", so a run whose legs all used the
// spec reporter parsed to null.
test('parseTestSummary reads the spec reporter marker, not just TAP', () => {
  const log = [
    'test (ubuntu, 20)\tRun npm test\t2026-07-22T01:00:00Z \u2139 tests 2960',
    'test (ubuntu, 20)\tRun npm test\t2026-07-22T01:00:00Z \u2139 pass 2960',
    'test (ubuntu, 20)\tRun npm test\t2026-07-22T01:00:00Z \u2139 fail 0',
  ].join('\n');
  assert.deepEqual(parseTestSummary(log), { testCount: 2960, pass: 2960, fail: 0 });
});

test('parseTestSummary still reads the TAP marker', () => {
  const log = '# tests 2774\n# pass 2733\n# fail 0\n';
  assert.deepEqual(parseTestSummary(log), { testCount: 2774, pass: 2733, fail: 0 });
});

test('parseTestSummary takes the max fail across mixed-style legs', () => {
  const log = '\u2139 tests 10\n\u2139 pass 10\n\u2139 fail 0\n# tests 10\n# pass 8\n# fail 2\n';
  assert.equal(parseTestSummary(log).fail, 2, 'a failing leg must not be masked by a clean one');
});

test('parseTestSummary still returns null when no summary is present at all', () => {
  assert.equal(parseTestSummary('no summary here'), null);
  assert.equal(parseTestSummary(''), null);
});

// Cause 2: `gh run view --log` can transiently fail on a just-completed run
// (GitHub has not assembled the archive yet). The point was still recorded, and
// hasRunId then made every later tick skip it, so a momentary failure became
// permanent. Points needing repair must stay findable.
test('unparsedRunIds finds CI points recorded without counts', () => {
  const dir = mkTmp();
  appendPoint(dir, { ts: 1, runId: 101, sha: 'a', testCount: null, pass: null, fail: null, conclusion: 'success', source: 'ci' });
  appendPoint(dir, { ts: 2, runId: 102, sha: 'b', testCount: 10, pass: 10, fail: 0, conclusion: 'success', source: 'ci' });
  assert.deepEqual(unparsedRunIds(dir), [101]);
});

test('unparsedRunIds ignores local points, which never have a run to re-fetch', () => {
  const dir = mkTmp();
  appendPoint(dir, { ts: 1, runId: null, sha: null, testCount: null, pass: null, fail: null, conclusion: null, source: 'local' });
  assert.deepEqual(unparsedRunIds(dir), []);
});

test('unparsedRunIds returns newest first and respects a limit', () => {
  const dir = mkTmp();
  for (const [ts, runId] of [[1, 201], [2, 202], [3, 203]]) {
    appendPoint(dir, { ts, runId, sha: 'x', testCount: null, pass: null, fail: null, conclusion: 'success', source: 'ci' });
  }
  assert.deepEqual(unparsedRunIds(dir), [203, 202, 201]);
  assert.deepEqual(unparsedRunIds(dir, 2), [203, 202]);
});

test('repairPoint fills in counts for an already-recorded run', () => {
  const dir = mkTmp();
  appendPoint(dir, { ts: 1, runId: 301, sha: 'a', testCount: null, pass: null, fail: null, conclusion: 'success', source: 'ci' });
  assert.equal(repairPoint(dir, 301, { testCount: 42, pass: 41, fail: 1 }), true);
  const pts = readQaTrends(dir);
  assert.equal(pts.length, 1, 'repair must supersede, not duplicate the run');
  assert.equal(pts[0].testCount, 42);
  assert.equal(pts[0].fail, 1);
  assert.equal(pts[0].conclusion, 'success', 'the original fields must survive the repair');
});

test('repairPoint refuses to overwrite counts that already parsed', () => {
  const dir = mkTmp();
  appendPoint(dir, { ts: 1, runId: 302, sha: 'a', testCount: 10, pass: 10, fail: 0, conclusion: 'success', source: 'ci' });
  assert.equal(repairPoint(dir, 302, { testCount: 999, pass: 0, fail: 0 }), false);
  assert.equal(readQaTrends(dir)[0].testCount, 10);
});

test('repairPoint is a no-op for an unknown run', () => {
  const dir = mkTmp();
  assert.equal(repairPoint(dir, 404, { testCount: 1, pass: 1, fail: 0 }), false);
});

test('a repaired run is no longer reported as unparsed', () => {
  const dir = mkTmp();
  appendPoint(dir, { ts: 1, runId: 303, sha: 'a', testCount: null, pass: null, fail: null, conclusion: 'success', source: 'ci' });
  repairPoint(dir, 303, { testCount: 7, pass: 7, fail: 0 });
  assert.deepEqual(unparsedRunIds(dir), []);
  assert.equal(hasRunId(dir, 303), true, 'dedup must still see the run');
});

test('qaTrendsView: narrowed runs leave the chart series and are summarised over the trailing 7 days', () => {
  const DAY = 86400000;
  const now = 100 * DAY;
  const pts = [
    { ts: now - 10 * DAY, source: 'local', scope: 'affected', fail: 1, conclusion: 'failure' },
    { ts: now - 3 * DAY, source: 'ci', fail: 0, conclusion: 'success', testCount: 9000 },
    { ts: now - 2 * DAY, source: 'local', scope: 'affected', fail: 2, conclusion: 'failure' },
    { ts: now - DAY, source: 'local', scope: 'affected', fail: 0, conclusion: 'success' },
    { ts: now - 1000, source: 'local', fail: 0, conclusion: 'success', testCount: 9100 },
  ];
  const v = qaTrendsView(pts, { now });
  assert.deepEqual(v.points.map((p) => p.testCount), [9000, 9100]);
  assert.deepEqual(v.affected, { runs: 2, failedRuns: 1, lastTs: now - DAY, windowDays: 7 });
  assert.deepEqual(qaTrendsView([], { now }).affected, { runs: 0, failedRuns: 0, lastTs: null, windowDays: 7 });
});

test('sampleLatestRun through a gh seam: names the repo on every call, reads each job log, keeps the max fail', async () => {
  const dir = mkTmp();
  const repo = 'wolfeb-dev/glmps-2.0';
  const calls = [];
  const leg = (n, fail) => `test (ubuntu-latest, ${n})\tRun npm test\tZ \u2139 tests 9959\nZ \u2139 pass ${9959 - fail}\nZ \u2139 fail ${fail}\n`;
  const answers = new Map([
    [qaGhArgs.runs(repo, 1).join(' '), JSON.stringify([{ databaseId: 42262455402, conclusion: 'failure', status: 'completed', headSha: 'abcdef1234', createdAt: '2026-11-06T17:31:44Z' }])],
    [qaGhArgs.jobs(repo, 42262455402).join(' '), JSON.stringify({ jobs: [{ databaseId: 1, name: 'test (ubuntu-latest, 24)' }, { databaseId: 2, name: 'test (ubuntu-latest, 22)' }] })],
    [qaGhArgs.jobLog(repo, 1).join(' '), leg(24, 0)],
    [qaGhArgs.jobLog(repo, 2).join(' '), leg(22, 1)],
    [qaGhArgs.issues(repo).join(' '), JSON.stringify([{ number: 1 }, { number: 2 }])],
  ]);
  const gh = async (file, args) => {
    calls.push(args);
    const out = answers.get(args.join(' '));
    return out == null ? { status: 1, stdout: '', stderr: 'unexpected' } : { status: 0, stdout: out, stderr: '' };
  };
  const p = await sampleLatestRun(dir, { gh, repo });
  assert.equal(p.runId, 42262455402);
  assert.deepEqual([p.testCount, p.pass, p.fail, p.openIssues, p.conclusion], [9959, 9959, 1, 2, 'failure']);
  assert.ok(calls.every((a) => a.includes('-R') && a[a.indexOf('-R') + 1] === repo), 'every call names the repo');
  assert.equal(readQaTrends(dir).length, 1);
  assert.equal(await sampleLatestRun(dir, { gh, repo }), null, 'a recorded run is skipped');
});

test('repoFromRemote reads owner/repo from an https or ssh GitHub remote, else null', () => {
  assert.equal(repoFromRemote('https://github.com/wolfeb-dev/glmps-2.0.git'), 'wolfeb-dev/glmps-2.0');
  assert.equal(repoFromRemote('git@github.com:wolfeb-dev/glmps-2.0.git\n'), 'wolfeb-dev/glmps-2.0');
  assert.equal(repoFromRemote('https://github.com/wolfeb-dev/glmps'), 'wolfeb-dev/glmps');
  assert.equal(repoFromRemote('https://gitlab.com/a/b.git'), null);
  assert.equal(repoFromRemote(''), null);
});
