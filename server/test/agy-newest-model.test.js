import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGY_MODELS, newestGeminiModel } from '../lib/huddle/agy-models.js';
import { DEFAULT_AGY_MODEL } from '../lib/observability/wiki-agy.js';
import { vendorById } from '../lib/orchestration/vendor-agents.js';

test('newestGeminiModel: highest version wins numerically, at the asked tier', () => {
  const names = ['Gemini 3.8 Flash (High)', 'Gemini 4 Argon (Medium)', 'Gemini 4 Argon (High)', 'Gemini 10 Zed (Low)', 'Gemini 9.9 Yak (High)'];
  assert.equal(newestGeminiModel(names), 'Gemini 9.9 Yak (High)');
  assert.equal(newestGeminiModel(names, 'Low'), 'Gemini 10 Zed (Low)');
  assert.equal(newestGeminiModel(names, 'Medium'), 'Gemini 4 Argon (Medium)');
  assert.equal(newestGeminiModel(['Gemini 3.10 A (High)', 'Gemini 3.9 B (High)']), 'Gemini 3.10 A (High)');
});

test('newestGeminiModel: non-Gemini names and junk are ignored; nothing usable is null', () => {
  assert.equal(newestGeminiModel(['Claude Opus 5.5 (High)', 'GPT-OSS 120B (Medium)', 'Gemini (High)', null, 7]), null);
  assert.equal(newestGeminiModel([]), null);
  assert.equal(newestGeminiModel(undefined), null);
});

test('the shipped defaults are the newest allowlisted Gemini: Gemini 4 Argon (High) today', () => {
  assert.equal(newestGeminiModel(AGY_MODELS), 'Gemini 4 Argon (High)');
  assert.equal(DEFAULT_AGY_MODEL, newestGeminiModel(AGY_MODELS));
});

test('a Gemini card that names no model sends none, so the desktop app picks the newest agy lists at run time', () => {
  assert.equal(vendorById('gemini').defaultModel, null);
});

// Card glmps-2-0-173: outside the exempt huddle seats, no script pins a Gemini name.
test('the scripts that generate with agy take the shipped default, not a pinned name', () => {
  const src = fs.readFileSync(new URL('../../scripts/memory-probe-gen.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /['"]Gemini [^'"]+['"]/);
  assert.match(src, /DEFAULT_AGY_MODEL/);
});
