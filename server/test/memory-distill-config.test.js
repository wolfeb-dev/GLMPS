import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryDistillConfig, DEFAULTS } from '../lib/evaluation/memory-distill-config.js';

test('defaults when no config', () => {
  const c = getMemoryDistillConfig();
  assert.equal(c.enabled, true);
  assert.equal(c.engine, 'claude');
  assert.equal(c.sweepBackfill, false);
});
test('overrides merge over defaults', () => {
  const c = getMemoryDistillConfig({ memoryDistill: { sweepBackfill: true, minTranscriptBytes: 500 } });
  assert.equal(c.sweepBackfill, true);
  assert.equal(c.minTranscriptBytes, 500);
  assert.equal(c.enabled, true); // untouched default
});
test('malformed input returns defaults', () => {
  assert.equal(getMemoryDistillConfig(null).enabled, DEFAULTS.enabled);
  assert.equal(getMemoryDistillConfig('nope').engine, 'claude');
});
