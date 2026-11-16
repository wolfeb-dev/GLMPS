// Card glmps-2-0-runtime-98 (F3): runner sessions run only the tests their change touches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFullSuiteRun, AFFECTED_TESTS_COMMAND } from '../lib/governance/full-suite-guard.js';
import { checkRoleCommand } from '../lib/governance/role-permissions.js';
import { simpleCommands } from '../lib/governance/shell-commands.js';
import { pickBase, testArgv } from '../../scripts/affected-tests.mjs';

const full = (cmd) => simpleCommands(cmd).some(({ tokens }) => isFullSuiteRun(tokens));

test('a bare full-suite run is recognised in its usual spellings', () => {
  for (const cmd of [
    'npm test', 'npm t', 'npm run test', 'npm test -- server/test/a.test.js', 'pnpm test', 'yarn test',
    'node --test', 'node --test --env-file=test.env --test-concurrency=4 "**/*.test.js"',
    'node --test --test-concurrency 4 --env-file test.env', 'cd x && npm test 2>&1 | tail -20',
    'bash -c "npm test"', '"C:/Program Files/nodejs/node.exe" --test',
  ]) assert.equal(full(cmd), true, cmd);
});

test('a run that names its test files, or is not a test run, is allowed', () => {
  for (const cmd of [
    'node --test server/test/a.test.js', 'node --test --env-file=test.env server/test/a.test.js server/test/b.test.js',
    'node --test --test-name-pattern "load hold" server/test/merge-queue.test.js', 'node --test "server/test/merge-*.test.js"',
    'node server/server.js', 'npm run lint', 'npm install', 'node scripts/affected-tests.mjs', 'node --test-reporter=spec x.js',
  ]) assert.equal(full(cmd), false, cmd);
});

test('checkRoleCommand denies a full-suite run to worker and reviewer sessions and names the affected-test command', () => {
  for (const role of ['worker', 'reviewer']) {
    const v = checkRoleCommand({ command: 'npm test 2>&1 | tail -5', role, reviewHead: 'feat/x' });
    assert.equal(v.block, true, role);
    assert.ok(v.reason.includes(AFFECTED_TESTS_COMMAND), v.reason);
  }
  assert.equal(checkRoleCommand({ command: 'node --test server/test/a.test.js', role: 'worker' }).block, false);
});

test('an operator session (no role) is never blocked', () => {
  assert.equal(checkRoleCommand({ command: 'npm test' }).block, false);
  assert.equal(checkRoleCommand({ command: 'node --test', role: '' }).block, false);
});

test('affected-tests script: base fallback and the node argv for the narrowed script', () => {
  assert.equal(pickBase(null, (r) => r === 'origin/main'), 'origin/main');
  assert.equal(pickBase('origin/x', () => false), 'origin/x');
  assert.equal(pickBase(null, () => false), null);
  assert.deepEqual(
    testArgv('node --test --env-file=test.env --test-concurrency=4 "**/*.test.js"', ['a.test.js', 'b.test.js']),
    ['--test', '--env-file=test.env', '--test-concurrency=4', 'a.test.js', 'b.test.js'],
  );
  assert.equal(testArgv('jest', ['a.test.js']), null);
  assert.equal(testArgv('node x.js "**/*.js"', ['a.test.js']), null, 'not a --test script');
});
