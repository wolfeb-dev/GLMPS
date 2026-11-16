// server/test/wiki-preserve.test.js
// Pure decision function behind the no-downgrade invariant: a structural
// (no --llm) rebuild must never blank an existing narrative page just because
// its contentHash changed (cache miss). See scripts/wiki-build-cli.mjs, which
// consults this before falling through to the Tier-1 structural stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPreserveNarrative } from '../lib/observability/wiki-preserve.js';

test('shouldPreserveNarrative: true on a cache miss with no real LLM attempt when the prior page was narrative', () => {
  assert.equal(
    shouldPreserveNarrative({ slug: 'foo' }, false, { slug: 'foo', llm: true }),
    true,
  );
});

test('shouldPreserveNarrative: false when this run is actually attempting LLM enrichment (may re-author)', () => {
  assert.equal(
    shouldPreserveNarrative({ slug: 'foo' }, true, { slug: 'foo', llm: true }),
    false,
  );
});

test('shouldPreserveNarrative: false when there is no prior manifest entry (first build, nothing to preserve)', () => {
  assert.equal(shouldPreserveNarrative({ slug: 'foo' }, false, undefined), false);
  assert.equal(shouldPreserveNarrative({ slug: 'foo' }, false, null), false);
});

test('shouldPreserveNarrative: false when the prior entry was already structural (nothing narrative to lose)', () => {
  assert.equal(
    shouldPreserveNarrative({ slug: 'foo' }, false, { slug: 'foo', llm: false }),
    false,
  );
});


test('shouldPreserveNarrative: false when the fresh section is missing entirely', () => {
  assert.equal(shouldPreserveNarrative(null, false, { slug: 'foo', llm: true }), false);
});
