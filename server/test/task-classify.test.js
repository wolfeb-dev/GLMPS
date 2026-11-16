import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from '../lib/evaluation/task-classify.js';

test('debug from fix/bug + test file', () => {
  assert.equal(classifyTask({ firstPrompt: 'fix the failing auth bug', filesTouched: ['src/auth.test.js'] }).taskClass, 'debug');
});
test('feature from implement + new file', () => {
  assert.equal(classifyTask({ firstPrompt: 'implement a new export button', filesTouched: ['src/export.js'] }).taskClass, 'feature');
});
test('refactor', () => {
  assert.equal(classifyTask({ firstPrompt: 'refactor and simplify the parser' }).taskClass, 'refactor');
});
test('docs when all md', () => {
  assert.equal(classifyTask({ firstPrompt: 'update the readme', filesTouched: ['README.md','docs/x.md'] }).taskClass, 'docs');
});
test('research with no edits', () => {
  assert.equal(classifyTask({ firstPrompt: 'investigate and compare options for caching', filesTouched: [] }).taskClass, 'research');
});
test('empty -> other low confidence', () => {
  const r = classifyTask({ firstPrompt: '', filesTouched: [] });
  assert.equal(r.taskClass, 'other');
  assert.ok(r.confidence <= 0.34);
});

test('keywords match whole words, not substrings', () => {
  // 'ci' (ops) must not match inside "specific" or "decision"
  assert.equal(classifyTask({ firstPrompt: 'a specific decision' }).taskClass, 'other');
  // 'add' (feature) must not match inside "padding"
  assert.equal(classifyTask({ firstPrompt: 'adjust the padding' }).taskClass, 'other');
});

test('word-boundary matching still matches real hits', () => {
  // 'add' (feature) and 'CI' (ops) are each real whole-word hits, 1 vs 1 = tie -> other.
  // (Note: 'add support for CI' would NOT tie: 'support' is also a feature keyword,
  // so that phrasing scores feature=2 vs ops=1 and 'feature' wins outright.)
  assert.equal(classifyTask({ firstPrompt: 'add a CI step' }).taskClass, 'other');
  assert.equal(classifyTask({ firstPrompt: 'add a new endpoint', filesTouched: ['src/api.js'] }).taskClass, 'feature');
});

test('ui class from keywords', () => {
  assert.equal(classifyTask({ firstPrompt: 'fix the dashboard layout and styling' }).taskClass, 'ui');
});

test('ui amplified by web/ and .css file signal', () => {
  const r = classifyTask({ firstPrompt: 'adjust the component layout', filesTouched: ['web/grid.js', 'web/styles.css'] });
  assert.equal(r.taskClass, 'ui');
  assert.ok(r.score >= 3, `expected boosted score, got ${r.score}`);
});

// The isWebFile boost normalises backslashes so the Linux and Windows CI legs
// agree, but every existing case above supplies a forward-slash path, so
// deleting that .replace() passed the whole suite. A NATIVE Windows path is the
// only input that exercises the branch: with the normalisation removed,
// 'web\\grid.js' matches neither 'web/' nor '/web/' nor '.css', the ui score
// stays at its unboosted 1 (from 'layout' alone) and this assertion fails.
test('ui is amplified by a native Windows web path (backslash normalisation)', () => {
  const r = classifyTask({ firstPrompt: 'adjust the layout', filesTouched: ['web\\grid.js'] });
  assert.equal(r.taskClass, 'ui');
  assert.equal(r.score, 1.5, 'the 1.5x web-file boost must apply to a backslash path too');
});

test('ui does not steal the review class', () => {
  assert.equal(classifyTask({ firstPrompt: 'review the auth changes' }).taskClass, 'review');
});

test('score is returned alongside taskClass and confidence', () => {
  const r = classifyTask({ firstPrompt: 'refactor and simplify the parser' });
  assert.equal(typeof r.score, 'number');
  assert.ok(r.score > 0);
});

test('a single weak keyword scores confidence 1.0 but score 1', () => {
  const r = classifyTask({ firstPrompt: 'please check it' });
  assert.equal(r.confidence, 1);
  assert.equal(r.score, 1);
});

// 2026-08-12 roster re-cut: the shipped keyword lists were written against
// generic software vocabulary, so 37 of 79 real glmps cards scored
// zero and fell to `other`. These are the words that actually recur in this
// backlog.
test('expanded keywords: GLMPS vocabulary classifies instead of falling to other', () => {
  assert.equal(classifyTask({ firstPrompt: 'the nightly job is flaky' }).taskClass, 'debug');
  assert.equal(classifyTask({ firstPrompt: 'ship the companion extension' }).taskClass, 'feature');
  assert.equal(classifyTask({ firstPrompt: 'consolidate the duplicate guards' }).taskClass, 'refactor');
  assert.equal(classifyTask({ firstPrompt: 'summarize what the result was' }).taskClass, 'research');
  assert.equal(classifyTask({ firstPrompt: 'refresh the wiki narrative' }).taskClass, 'docs');
  assert.equal(classifyTask({ firstPrompt: 'register the PreToolUse hook' }).taskClass, 'ops');
  assert.equal(classifyTask({ firstPrompt: 'harden the write path' }).taskClass, 'review');
  assert.equal(classifyTask({ firstPrompt: 'the dashboard column is misaligned' }).taskClass, 'ui');
});

// The expansion makes ties MORE likely, not less: a card can now hit one
// keyword in each of two classes. That still resolves to `other`, which emits
// no directive and falls to today's behavior. Pinned deliberately, because the
// tempting "fix" is to break the tie arbitrarily and start misrouting.
test('expanded keywords: a cross-class tie still resolves to other', () => {
  // 'flaky' (debug) vs 'ci' (ops), one hit each.
  const r = classifyTask({ firstPrompt: 'the windows CI leg is flaky' });
  assert.equal(r.taskClass, 'other');
  assert.equal(r.confidence, 0.5);
});

// Guard for a keyword set that was tried and rejected. Adding generic UI nouns
// (panel, tab, chip, row, badge) tied `ui` against `feature` on the commonest
// phrasing in this backlog and sent those cards to `other`, which routes
// nowhere. If someone re-adds them, this fails.
test('a "new <thing> panel" card on a web file is a feature, not an ambiguous tie', () => {
  const r = classifyTask({ firstPrompt: 'implement a new outcomes panel', filesTouched: ['web/evaluation/outcomes.js'] });
  assert.equal(r.taskClass, 'feature');
});
