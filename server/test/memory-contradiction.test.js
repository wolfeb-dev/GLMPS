// server/test/memory-contradiction.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contradictsPinnedVerdict } from '../lib/evaluation/memory-contradiction.js';

const curated = {
  'rushdb-eval.md': '---\nname: rushdb-eval\ndescription: RushDB REJECTED as a dependency, do not re-propose\n---\n\nRushDB was REJECTED. Do not re-propose it.',
  'unrelated.md': '---\nname: unrelated\ndescription: caching note\n---\n\ncache widgets',
};

test('a distilled fact re-proposing a REJECTED subject conflicts', () => {
  const distilled = '---\nname: try-rushdb\ndescription: we should adopt RushDB as our graph store\n---\n\nRushDB looks great, let us adopt it.';
  const r = contradictsPinnedVerdict(distilled, curated);
  assert.equal(r.conflict, true);
  assert.equal(r.against, 'rushdb-eval.md');
});

test('a distilled fact that shares the verdict does not conflict', () => {
  const distilled = '---\nname: rushdb-again\ndescription: RushDB still REJECTED, confirmed\n---\n\nRushDB REJECTED again.';
  assert.equal(contradictsPinnedVerdict(distilled, curated).conflict, false);
});

test('an unrelated distilled fact does not conflict', () => {
  const distilled = '---\nname: pooling\ndescription: postgres pooling\n---\n\npool connections';
  assert.equal(contradictsPinnedVerdict(distilled, curated).conflict, false);
});

// Sentence-initial capitalized words ("This", "Given", "Note", ...) appear in
// almost any multi-sentence prose body regardless of subject; matching on
// full-body capitalized tokens made two totally unrelated facts "conflict"
// purely because both bodies happen to open sentences with the same common
// word. Subject must come from the frontmatter name/description only.

const curatedProse = {
  'rushdb-vs-graphify-eval.md':
    '---\nname: rushdb-vs-graphify-eval\ndescription: RushDB rejected as a graphify replacement, do not re-propose\n---\n\n' +
    'This document walks through the RushDB evaluation end to end. Given the migration cost and the schema mismatch, RushDB was REJECTED as a dependency. Note that graphify remains the tool of record.',
};

test('an unrelated prose-style fact sharing only sentence-initial capitals does not conflict (regression)', () => {
  const distilled =
    '---\nname: response-cache-ttl\ndescription: tune the HTTP response cache TTL\n---\n\n' +
    'This proposal adds a configurable TTL to the response cache layer. Given current traffic patterns, sixty seconds balances freshness against hit rate. Note this change has no bearing on the memory subsystem.';
  const r = contradictsPinnedVerdict(distilled, curatedProse);
  assert.equal(r.conflict, false);
});

test("reviewer's exact repro: unrelated caching proposal vs a pinned-REJECTED verdict, both bodies opening sentences with This/Given/Note", () => {
  const pinned = {
    'rushdb-eval.md':
      '---\nname: rushdb-eval\ndescription: RushDB REJECTED as our graph store\n---\n\n' +
      'This evaluation compared RushDB against graphify on ingestion speed and query ergonomics. Given the results, RushDB was REJECTED. Note the decision is final; do not re-propose it.',
  };
  const distilled =
    '---\nname: edge-cache-warming\ndescription: pre-warm the CDN edge cache after deploy\n---\n\n' +
    'This change adds a post-deploy warming step for the edge cache. Given the deploy cadence, warming the top 200 routes is sufficient. Note this is unrelated to the graph store decision.';
  const r = contradictsPinnedVerdict(distilled, pinned);
  assert.equal(r.conflict, false);
});

test('a genuine reopen still conflicts even when wrapped in multi-sentence prose', () => {
  const pinned = {
    'rushdb-eval.md':
      '---\nname: rushdb-eval\ndescription: RushDB REJECTED as our graph store\n---\n\n' +
      'This evaluation compared RushDB against graphify. Given the results, RushDB was REJECTED. Note the decision is final.',
  };
  const distilled =
    '---\nname: try-rushdb\ndescription: adopt RushDB as our graph store\n---\n\n' +
    'This note revisits the graph store question. Given new benchmark numbers, RushDB looks worth adopting again.';
  const r = contradictsPinnedVerdict(distilled, pinned);
  assert.equal(r.conflict, true);
  assert.equal(r.against, 'rushdb-eval.md');
});

test('a distilled fact using a verdict word as a common word does not conflict (null is not a subject)', () => {
  // Every pinned NULL verdict's description contains "NULL"; a distilled fact
  // about an unrelated topic that merely uses lowercase "null" (a common
  // technical word) must not conflict on that shared word.
  const pinned = {
    'orb-null.md':
      '---\nname: orb-risk-exec-null\ndescription: the standalone ORB risk/exec architecture was a TRUSTWORTHY NULL\n---\n\nORB was a trustworthy NULL result.',
  };
  const distilled =
    '---\nname: defensive-null-checks\ndescription: add null checks to the parser input path\n---\n\nGuard against a null pointer in the parser.';
  assert.equal(contradictsPinnedVerdict(distilled, pinned).conflict, false);
});

test('the corpus "-eval" naming convention does not cause systematic false conflicts', () => {
  // Six-plus real pinned facts are named "<subject>-...-eval". The word-split
  // tokenizer would make "eval" a shared token across all of them; an unrelated
  // eval-harness fact must not conflict with a RushDB verdict just because both
  // are, at a meta level, evaluations.
  const pinned = {
    'rushdb-vs-graphify-eval.md':
      '---\nname: rushdb-vs-graphify-eval\ndescription: RushDB rejected as a graphify replacement, do not re-propose\n---\n\nRushDB was REJECTED.',
  };
  const distilled =
    '---\nname: nemotron-eval-harness\ndescription: five-step cost-tiered eval harness tuning loop\n---\n\nA harness for tuning at lower cost.';
  assert.equal(contradictsPinnedVerdict(distilled, pinned).conflict, false);
});

test('a fact with no frontmatter name/description falls back to no conflict', () => {
  const pinned = {
    'rushdb-eval.md':
      '---\nname: rushdb-eval\ndescription: RushDB REJECTED as our graph store\n---\n\nRushDB was REJECTED.',
  };
  const distilled = 'RushDB looks great, we should adopt it for our graph store.';
  assert.equal(contradictsPinnedVerdict(distilled, pinned).conflict, false);
});
