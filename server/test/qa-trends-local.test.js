// Tests for the PostToolUse[Bash] hook hooks/qa-trends-local.js's pure core:
// isFullSuiteTestCommand (command -> full-suite yes/no), parseLocalTestSummary
// (Bash tool_response output -> {testCount,pass,fail}), and buildLocalPoint
// (summary -> the qa-trends-store point shape). No stdin, no fs, no git, no
// network -- the CLI's I/O layer (stdin JSON, git rev-parse, appendPoint) is
// intentionally not exercised here, per this hook's pure-core-plus-CLI split
// (same convention as hooks/ci-status-surface.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFullSuiteTestCommand, isAffectedTestCommand, parseLocalTestSummary, buildLocalPoint } from '../../hooks/qa-trends-local.js';


test('isFullSuiteTestCommand: bare "npm test" -> true', () => {
  assert.equal(isFullSuiteTestCommand('npm test'), true);
});

test('isFullSuiteTestCommand: "npm run test" -> true', () => {
  assert.equal(isFullSuiteTestCommand('npm run test'), true);
});

test('isFullSuiteTestCommand: flags forwarded after -- are still a full-suite run', () => {
  assert.equal(isFullSuiteTestCommand('npm test -- --test-concurrency=4'), true);
  assert.equal(isFullSuiteTestCommand('npm run test -- --test-concurrency=4'), true);
});

test('isFullSuiteTestCommand: a flag forwarded without the -- separator is still full-suite', () => {
  assert.equal(isFullSuiteTestCommand('npm test --bail'), true);
});

test('isFullSuiteTestCommand: leading/trailing whitespace is tolerated', () => {
  assert.equal(isFullSuiteTestCommand('   npm   test   '), true);
});

test('isFullSuiteTestCommand: a chained "cd repo && npm test" is still detected', () => {
  assert.equal(isFullSuiteTestCommand('cd D:\\glmps && npm test'), true);
});

test('isFullSuiteTestCommand: npm test as the first of a chained command is still detected', () => {
  assert.equal(isFullSuiteTestCommand('npm test && echo done'), true);
  assert.equal(isFullSuiteTestCommand('npm test || echo failed'), true);
});

test('isFullSuiteTestCommand: rejects a direct node --test single-file run', () => {
  assert.equal(isFullSuiteTestCommand('node --test foo.test.js'), false);
  assert.equal(isFullSuiteTestCommand('node --test server/test/foo.test.js'), false);
});

test('isFullSuiteTestCommand: rejects npm test targeting a specific file (positional arg)', () => {
  assert.equal(isFullSuiteTestCommand('npm test -- foo.test.js'), false);
  assert.equal(isFullSuiteTestCommand('npm test server/test/foo.test.js'), false);
});

test('isFullSuiteTestCommand: rejects an unrelated npm script', () => {
  assert.equal(isFullSuiteTestCommand('npm run lint'), false);
  assert.equal(isFullSuiteTestCommand('npm run build'), false);
});

test('isFullSuiteTestCommand: rejects a differently-named test script (test:watch etc)', () => {
  assert.equal(isFullSuiteTestCommand('npm run test:watch'), false);
  assert.equal(isFullSuiteTestCommand('npm run test:integration'), false);
});

test('isFullSuiteTestCommand: rejects other package managers (out of spec scope)', () => {
  assert.equal(isFullSuiteTestCommand('yarn test'), false);
  assert.equal(isFullSuiteTestCommand('pnpm test'), false);
});

test('isFullSuiteTestCommand: non-string/empty command -> false, never throws', () => {
  assert.equal(isFullSuiteTestCommand(''), false);
  assert.equal(isFullSuiteTestCommand(null), false);
  assert.equal(isFullSuiteTestCommand(undefined), false);
  assert.equal(isFullSuiteTestCommand(42), false);
});


const SPEC_REPORTER_GREEN = [
  '\u2139 tests 2405',
  '\u2139 suites 45',
  '\u2139 pass 2405',
  '\u2139 fail 0',
  '\u2139 cancelled 0',
  '\u2139 skipped 0',
  '\u2139 todo 0',
  '\u2139 duration_ms 12345.678',
].join('\n') + '\n';

const TAP_REPORTER_GREEN = [
  '# tests 2405',
  '# suites 45',
  '# pass 2405',
  '# fail 0',
].join('\n') + '\n';

const SPEC_REPORTER_FAILED = [
  '\u2139 tests 2410',
  '\u2139 pass 2407',
  '\u2139 fail 3',
].join('\n') + '\n';

test('parseLocalTestSummary: spec reporter (i) green output', () => {
  assert.deepEqual(parseLocalTestSummary(SPEC_REPORTER_GREEN), { testCount: 2405, pass: 2405, fail: 0 });
});

test('parseLocalTestSummary: TAP reporter (#) green output', () => {
  assert.deepEqual(parseLocalTestSummary(TAP_REPORTER_GREEN), { testCount: 2405, pass: 2405, fail: 0 });
});

test('parseLocalTestSummary: failed output', () => {
  assert.deepEqual(parseLocalTestSummary(SPEC_REPORTER_FAILED), { testCount: 2410, pass: 2407, fail: 3 });
});

test('parseLocalTestSummary: no summary present -> null', () => {
  assert.equal(parseLocalTestSummary('npm ERR! some unrelated failure before tests ran\n'), null);
});

test('parseLocalTestSummary: empty/non-string input -> null, never throws', () => {
  assert.equal(parseLocalTestSummary(''), null);
  assert.equal(parseLocalTestSummary(null), null);
  assert.equal(parseLocalTestSummary(undefined), null);
  assert.equal(parseLocalTestSummary(12345), null);
});


test('buildLocalPoint: builds the exact local point shape', () => {
  const p = buildLocalPoint({ summary: { testCount: 2405, pass: 2405, fail: 0 }, sha: '4d8b2dd', ts: 1752530000000 });
  assert.deepEqual(p, {
    ts: 1752530000000,
    runId: null,
    sha: '4d8b2dd',
    testCount: 2405,
    pass: 2405,
    fail: 0,
    conclusion: 'success',
    openIssues: null,
    source: 'local',
  });
});

test('buildLocalPoint: fail > 0 -> conclusion "failure"', () => {
  const p = buildLocalPoint({ summary: { testCount: 2410, pass: 2407, fail: 3 }, sha: 'abc1234', ts: 1 });
  assert.equal(p.conclusion, 'failure');
});

test('buildLocalPoint: missing/non-string sha -> sha null', () => {
  const p = buildLocalPoint({ summary: { testCount: 1, pass: 1, fail: 0 }, sha: undefined, ts: 1 });
  assert.equal(p.sha, null);
});

test('buildLocalPoint: null/invalid summary -> null', () => {
  assert.equal(buildLocalPoint({ summary: null, sha: 'abc', ts: 1 }), null);
  assert.equal(buildLocalPoint({ summary: { testCount: 'nope' }, sha: 'abc', ts: 1 }), null);
});

test('buildLocalPoint: non-finite ts -> null', () => {
  assert.equal(buildLocalPoint({ summary: { testCount: 1, pass: 1, fail: 0 }, sha: 'abc', ts: NaN }), null);
  assert.equal(buildLocalPoint({ summary: { testCount: 1, pass: 1, fail: 0 }, sha: 'abc' }), null);
});

test('buildLocalPoint: missing opts entirely -> null, never throws', () => {
  assert.equal(buildLocalPoint(), null);
  assert.equal(buildLocalPoint(undefined), null);
});

test('isAffectedTestCommand: a node --test run of named test files, or the affected-tests script, is a narrowed run', () => {
  assert.equal(isAffectedTestCommand('node --test --env-file=test.env --test-concurrency=4 server/test/a.test.js server/test/b.test.js'), true);
  assert.equal(isAffectedTestCommand('cd repo && node --test server/test/a.test.js 2>&1 | tail -8'), true);
  assert.equal(isAffectedTestCommand('node scripts/affected-tests.mjs'), true);
  assert.equal(isAffectedTestCommand('node scripts/affected-tests.mjs 2>&1 | tail -5'), true);
});

test('isAffectedTestCommand: a quoted test file path is still a narrowed run', () => {
  assert.equal(isAffectedTestCommand('node --test "server/test/a.test.js"'), true);
  assert.equal(isAffectedTestCommand("node --test 'server/test/a.test.js' 'server/test/b.test.js'"), true);
  assert.equal(isAffectedTestCommand('"node" --test "server/test/a.test.js"'), true);
});

test('isAffectedTestCommand: a print-only pick, a full suite, a bare node --test or another command is not', () => {
  assert.equal(isAffectedTestCommand('node scripts/affected-tests.mjs --print'), false);
  assert.equal(isAffectedTestCommand('npm test'), false);
  assert.equal(isAffectedTestCommand('node --test'), false);
  assert.equal(isAffectedTestCommand('node --test "**/*.test.js"'), false);
  assert.equal(isAffectedTestCommand('node server/server.js'), false);
  assert.equal(isAffectedTestCommand(''), false);
  assert.equal(isAffectedTestCommand(null), false);
});

test('buildLocalPoint: a narrowed run is tagged scope affected; a full run carries no scope', () => {
  const summary = { testCount: 40, pass: 39, fail: 1 };
  assert.equal(buildLocalPoint({ summary, sha: 'abc1234', ts: 1, scope: 'affected' }).scope, 'affected');
  assert.equal('scope' in buildLocalPoint({ summary, sha: 'abc1234', ts: 1 }), false);
  assert.equal('scope' in buildLocalPoint({ summary, sha: 'abc1234', ts: 1, scope: 'bogus' }), false);
});
