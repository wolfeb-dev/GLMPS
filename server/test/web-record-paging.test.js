import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RECORD_PAGE, recordPage } from '../../web/observability/history.js';

test('the Record pages ended sessions 50 at a time (glmps-2-0-63)', () => {
  assert.equal(RECORD_PAGE, 50);
  assert.deepEqual(recordPage(1908, 0), { from: 0, to: 50, rest: 1858 });
  assert.deepEqual(recordPage(1908, 1900), { from: 1900, to: 1908, rest: 0 });
  assert.deepEqual(recordPage(12, 0), { from: 0, to: 12, rest: 0 });
  assert.deepEqual(recordPage(0, 0), { from: 0, to: 0, rest: 0 });
});

test('the Record table renders ended rows through the pager, not all at once', () => {
  const src = fs.readFileSync(new URL('../../web/observability/history.js', import.meta.url), 'utf8');
  assert.match(src, /recordPage\(ended\.length, shown\)/);
  assert.doesNotMatch(src, /for \(const entry of ended\) \{/);
});
