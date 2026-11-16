import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK, isQuotaError, fallbackModelFor, fallbackChainFor } from '../lib/orchestration/model-fallback.js';
import { isUsageLimitFailure } from '../lib/loops/auto-diagnosis.js';

// The real agy 1.5.2 quota reply (2026-11-07) and the Claude usage-limit text the auto-diagnosis matches.
const AGY_QUOTA = 'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED"}';
const CLAUDE_LIMIT = "Claude AI usage limit: You've hit your 5-hour limit, resets 3pm";

test('one row per vendor', () => {
  assert.deepEqual(Object.keys(FALLBACK).sort(), ['claude', 'gemini', 'gpt', 'grok']);
});

test('isQuotaError: each vendor reads its own error text; unverified vendors read none', () => {
  assert.equal(isQuotaError('gemini', AGY_QUOTA), true);
  assert.equal(isQuotaError('gemini', 'Individual quota reached. Resets in 147h'), true);
  assert.equal(isQuotaError('gemini', 'all good'), false);
  assert.equal(isQuotaError('claude', CLAUDE_LIMIT), true);
  assert.equal(isQuotaError('claude', AGY_QUOTA), false);
  assert.equal(isQuotaError('gpt', 'rate limit reached'), false);
  assert.equal(isQuotaError('grok', 'quota reached'), false);
  assert.equal(isQuotaError('nope', CLAUDE_LIMIT), false);
});

test('fallbackModelFor claude: the next alias in order; no model counts as opus; the last has none', () => {
  assert.equal(fallbackModelFor('claude', null), 'sonnet');
  assert.equal(fallbackModelFor('claude', 'opus'), 'sonnet');
  assert.equal(fallbackModelFor('claude', 'sonnet'), 'haiku');
  assert.equal(fallbackModelFor('claude', 'haiku'), null);
  assert.equal(fallbackModelFor('claude', 'claude-opus-5-5'), 'sonnet');
});

test('fallbackModelFor gemini: the newest from another family in the live list, same tier first', () => {
  const live = ['Gemini 4 Argon (High)', 'Gemini 4 Argon (Medium)', 'Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Medium)', 'Claude Opus 5.5 (High)'];
  assert.equal(fallbackModelFor('gemini', 'Gemini 4 Argon (High)', live), 'Gemini 3.8 Flash (High)');
  assert.equal(fallbackModelFor('gemini', 'Gemini 4 Argon (Low)', live), 'Gemini 3.8 Flash (High)');
  assert.equal(fallbackModelFor('gemini', 'Gemini 3.8 Flash (High)', live), 'Gemini 4 Argon (High)');
  assert.equal(fallbackModelFor('gemini', 'Gemini 4 Argon (High)', ['Gemini 4 Argon (High)']), null);
  assert.equal(fallbackModelFor('gemini', 'Gemini 4 Argon (High)'), null);
});

test('fallbackChainFor: the rest of the Claude order, one Gemini, nothing for the unverified vendors', () => {
  assert.deepEqual(fallbackChainFor('claude', null), ['sonnet', 'haiku']);
  assert.deepEqual(fallbackChainFor('claude', 'sonnet'), ['haiku']);
  assert.deepEqual(fallbackChainFor('claude', 'haiku'), []);
  assert.deepEqual(fallbackChainFor('gemini', 'Gemini 4 Argon (High)', ['Gemini 4 Argon (High)', 'Gemini 3.8 Flash (High)']), ['Gemini 3.8 Flash (High)']);
  assert.deepEqual(fallbackChainFor('gpt', 'gpt-5'), []);
});

test('fallbackModelFor gpt and grok: none until their rows are verified', () => {
  assert.equal(fallbackModelFor('gpt', 'gpt-5'), null);
  assert.equal(fallbackModelFor('grok', 'grok-4'), null);
});

test('the loop auto-diagnosis usage-limit check reads the Claude row', () => {
  assert.equal(isUsageLimitFailure({ lastReason: CLAUDE_LIMIT }), true);
  assert.equal(isUsageLimitFailure({ lastReason: 'ECONNRESET' }), false);
});
