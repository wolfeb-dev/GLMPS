// apps/shell/test/model-fallback.test.js
// The desktop app's copy of the model fallback table answers exactly as the
// server's does (card glmps-2-0-164).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK, isQuotaError, fallbackModelFor, fallbackChainFor } from '../src/lib/model-fallback.js';
import * as server from '../../../server/lib/orchestration/model-fallback.js';

const TEXTS = [
  'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}',
  'Individual quota reached. Resets in 147h',
  "Claude AI usage limit: You've hit your 5-hour limit",
  'rate limit reached', 'all good', '',
];
const MODELS = [null, 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'Gemini 4 Argon (High)', 'Gemini 4 Argon (Low)', 'Gemini 3.8 Flash (High)', 'gpt-5', 'grok-4'];
const LIVE = ['Gemini 4 Argon (High)', 'Gemini 4 Argon (Medium)', 'Gemini 3.8 Flash (High)', 'Claude Opus 5.5 (High)'];

test('the shell table has the same rows, patterns and orders as the server table', () => {
  assert.deepEqual(Object.keys(FALLBACK), Object.keys(server.FALLBACK));
  for (const v of Object.keys(FALLBACK)) {
    assert.equal(String(FALLBACK[v].quota), String(server.FALLBACK[v].quota), v);
    assert.deepEqual(FALLBACK[v].order, server.FALLBACK[v].order, v);
    assert.equal(FALLBACK[v].byFamily, server.FALLBACK[v].byFamily, v);
  }
});

test('isQuotaError and fallbackModelFor agree with the server for every vendor', () => {
  for (const v of [...Object.keys(FALLBACK), 'nope']) {
    for (const t of TEXTS) assert.equal(isQuotaError(v, t), server.isQuotaError(v, t), `${v} ${t}`);
    for (const m of MODELS) {
      assert.equal(fallbackModelFor(v, m, LIVE), server.fallbackModelFor(v, m, LIVE), `${v} ${m}`);
      assert.deepEqual(fallbackChainFor(v, m, LIVE), server.fallbackChainFor(v, m, LIVE), `${v} ${m} chain`);
    }
  }
});
