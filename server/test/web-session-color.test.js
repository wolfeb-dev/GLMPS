// server/test/web-session-color.test.js
// glmps-49: stable per-session color assignment (web/shared/session-color.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionColor } from '../../web/shared/session-color.js';

const HEX = /^#[0-9a-f]{6}$/i;

test('sessionColor is deterministic: same id -> same color', () => {
  const a = sessionColor('sess-abc-123');
  assert.equal(sessionColor('sess-abc-123'), a);
  assert.match(a, HEX);
});

test('sessionColor handles empty/missing ids with a stable fallback', () => {
  assert.match(sessionColor(''), HEX);
  assert.equal(sessionColor(''), sessionColor(null));
  assert.equal(sessionColor(undefined), sessionColor(''));
});

test('sessionColor spreads across the palette (different ids hit multiple colors)', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(sessionColor(`session-${i}`));
  assert.ok(seen.size >= 4, `expected >=4 distinct colors across 50 ids, got ${seen.size}`);
  for (const c of seen) assert.match(c, HEX);
});
