// The shared "is this a test run?" predicate (server/lib/test-process.js).
// Every branch is driven through the injectable env/processEnv/argv, so the
// result never depends on this test's own real process state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestProcess } from '../lib/test-process.js';

const NONE = { env: {}, processEnv: {}, argv: ['node', 'server/server.js'] };

test('no signal anywhere is not a test process', () => {
  assert.equal(isTestProcess(NONE), false);
});

test('NODE_TEST_CONTEXT counts from the injected env or the ambient processEnv', () => {
  assert.equal(isTestProcess({ ...NONE, env: { NODE_TEST_CONTEXT: 'child' } }), true);
  assert.equal(isTestProcess({ ...NONE, processEnv: { NODE_TEST_CONTEXT: 'child' } }), true);
});

test('GLMPS_TEST counts only when it is exactly "1", from either env', () => {
  assert.equal(isTestProcess({ ...NONE, env: { GLMPS_TEST: '1' } }), true);
  assert.equal(isTestProcess({ ...NONE, processEnv: { GLMPS_TEST: '1' } }), true);
  assert.equal(isTestProcess({ ...NONE, env: { GLMPS_TEST: '0' } }), false);
  assert.equal(isTestProcess({ ...NONE, env: { GLMPS_TEST: 'true' } }), false);
});

test('a *.test.js or *.test.mjs entry script counts, a lookalike name does not', () => {
  assert.equal(isTestProcess({ ...NONE, argv: ['node', 'server/test/x.test.js'] }), true);
  assert.equal(isTestProcess({ ...NONE, argv: ['node', 'server/test/x.test.mjs'] }), true);
  assert.equal(isTestProcess({ ...NONE, argv: ['node', 'server/test/x.test.json'] }), false);
  assert.equal(isTestProcess({ ...NONE, argv: ['node', 'server/latest.js'] }), false);
});

test('null or missing inputs never throw and read as not-a-test', () => {
  assert.equal(isTestProcess({ env: null, processEnv: null, argv: null }), false);
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: [] }), false);
});
