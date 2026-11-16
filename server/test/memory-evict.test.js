import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evictionPlan, isPinned, rankForEviction } from '../lib/evaluation/memory-evict.js';

// A fact's index line is what costs context; `bytes` is that line's size.
const entry = (target, bytes = 100) => ({ target, line: `- [${target}](${target}) - x`, bytes });
const use = (reads, exposureSessions) => ({ reads, exposureSessions });

test('under budget yields an empty plan (the common case)', () => {
  const entries = [entry('a.md'), entry('b.md')];
  const usage = { 'a.md': use(0, 99), 'b.md': use(0, 99) };
  assert.deepEqual(evictionPlan({ entries, usage, budgetBytes: 1000 }), []);
});

test('exactly at budget does not evict', () => {
  const entries = [entry('a.md', 500), entry('b.md', 500)];
  const usage = { 'a.md': use(0, 99), 'b.md': use(0, 99) };
  assert.deepEqual(evictionPlan({ entries, usage, budgetBytes: 1000 }), []);
});

test('evicts only the minimum needed to clear the budget', () => {
  // 4 x 100 = 400 against a 250 budget: dropping 2 clears it, dropping 1 does not.
  const entries = ['a.md', 'b.md', 'c.md', 'd.md'].map((t) => entry(t, 100));
  const usage = {
    'a.md': use(0, 100), 'b.md': use(0, 90), 'c.md': use(5, 100), 'd.md': use(9, 100),
  };
  const plan = evictionPlan({ entries, usage, budgetBytes: 250 });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((p) => p.target), ['a.md', 'b.md']);
});

// The core protection: a fact written yesterday looks identical to one ignored
// for months if you only count reads.
test('a long-exposed zero-read fact evicts before a fresh zero-read fact', () => {
  const entries = [entry('fresh.md'), entry('stale.md')];
  const usage = { 'fresh.md': use(0, 1), 'stale.md': use(0, 200) };
  const plan = evictionPlan({ entries, usage, budgetBytes: 150 });
  assert.deepEqual(plan.map((p) => p.target), ['stale.md']);
});

test('read count dominates exposure in the ranking', () => {
  const entries = [entry('read-often.md'), entry('never-read.md')];
  const usage = { 'read-often.md': use(9, 200), 'never-read.md': use(0, 5) };
  const plan = evictionPlan({ entries, usage, budgetBytes: 150 });
  assert.deepEqual(plan.map((p) => p.target), ['never-read.md']);
});

test('a fact with no usage record is treated as zero reads, not skipped', () => {
  const entries = [entry('tracked.md'), entry('untracked.md')];
  const usage = { 'tracked.md': use(3, 50) };
  const plan = evictionPlan({ entries, usage, budgetBytes: 150 });
  assert.deepEqual(plan.map((p) => p.target), ['untracked.md']);
});

test('ties break on target name so the plan is deterministic', () => {
  const entries = [entry('b.md'), entry('a.md')];
  const usage = { 'a.md': use(0, 10), 'b.md': use(0, 10) };
  const a = evictionPlan({ entries, usage, budgetBytes: 150 });
  const b = evictionPlan({ entries: [...entries].reverse(), usage, budgetBytes: 150 });
  assert.deepEqual(a.map((p) => p.target), ['a.md']);
  assert.deepEqual(a, b, 'plan must not depend on input order');
});

// Pinning: warning facts are exactly the ones with zero reads, because nobody
// drills into a fact that says "stop".
test('pinned warning facts are never evicted even at zero reads', () => {
  const entries = [entry('warn.md'), entry('plain.md')];
  const usage = { 'warn.md': use(0, 500), 'plain.md': use(4, 500) };
  const plan = evictionPlan({
    entries, usage, budgetBytes: 150, pinned: new Set(['warn.md']),
  });
  assert.deepEqual(plan.map((p) => p.target), ['plain.md']);
});

test('plan stops short rather than evicting a pinned fact to reach budget', () => {
  const entries = [entry('warn1.md'), entry('warn2.md')];
  const usage = { 'warn1.md': use(0, 500), 'warn2.md': use(0, 500) };
  const plan = evictionPlan({
    entries, usage, budgetBytes: 50, pinned: new Set(['warn1.md', 'warn2.md']),
  });
  assert.deepEqual(plan, [], 'never evict a pinned fact, even if the budget cannot be met');
});

test('each eviction carries its evidence', () => {
  const entries = [entry('gone.md'), entry('kept.md')];
  const usage = { 'gone.md': use(0, 42), 'kept.md': use(7, 42) };
  const [p] = evictionPlan({ entries, usage, budgetBytes: 150 });
  assert.equal(p.target, 'gone.md');
  assert.equal(p.reads, 0);
  assert.equal(p.exposureSessions, 42);
  assert.equal(p.line, '- [gone.md](gone.md) - x', 'verbatim line, so restoring is mechanical');
  assert.match(p.reason, /0 reads/);
});

test('isPinned matches the hard-warning vocabulary', () => {
  assert.ok(isPinned('operator stopped the search; do not resume'));
  assert.ok(isPinned("keep graphify, don't re-propose"));
  assert.ok(isPinned('bulk-skipped, dont re-propose'));
  assert.ok(isPinned('use var(--fs-*), NEVER raw sub-16px font-size'));
  assert.ok(isPinned('repo is PUBLIC (push-gate)'));
  assert.ok(isPinned('do not size off funded-EV'));
  assert.ok(isPinned('do not record as nulls'));
});

test('isPinned does not fire on ordinary prose', () => {
  assert.ok(!isPinned('built+merged 2026-07-14: CI panel + local-run capture'));
  assert.ok(!isPinned('right-label when resampling or every bar shifts 1 min'));
  assert.ok(!isPinned(''));
  assert.ok(!isPinned(undefined));
});

// Verdicts: losing one buys the same investigation twice.
test('isPinned pins settled eval verdicts', () => {
  assert.ok(isPinned('DECLINED 2026-07-12 (GLMPS owns skill provenance)'));
  assert.ok(isPinned('RushDB REJECTED, Potpie closest sidegrade'));
  assert.ok(isPinned('ABANDONED 2026-06-15; vol-Z sign-flips OOS'));
  assert.ok(isPinned('SUPERSEDED 2026-07-22: line closed'));
  assert.ok(isPinned('RETIRED 2026-06-24 (superseded by queue-runner)'));
  assert.ok(isPinned('glmps-121 = DISCARD (PF<1.3 + selection artifact)'));
  assert.ok(isPinned('skeptic-confirmed TRUSTWORTHY NULL'));
  assert.ok(isPinned('10 tickets CANCELLED'));
});

// Over-pinning is the real failure mode here: evictionPlan stops short rather
// than evicting a pinned fact, so a loose matcher makes the budget unmeetable.
test('isPinned ignores lowercase prose that merely contains a verdict word', () => {
  assert.ok(!isPinned('we closed the branch and rejected the first draft'));
  assert.ok(!isPinned('the null hypothesis was not discarded'));
  assert.ok(!isPinned('this supersedes the earlier note'));
});

// "never" is a common English word; require it to be emphatic (standalone,
// capitalized, or adjacent to an imperative) rather than incidental prose.
test('isPinned ignores incidental "never"', () => {
  assert.ok(!isPinned('cross-agent memory was built-but-never-fed (now fed)'));
  assert.ok(!isPinned('so the user is never blocked'));
});

test('rankForEviction is exported for inspection and is stable', () => {
  const entries = [entry('a.md'), entry('b.md')];
  const usage = { 'a.md': use(1, 10), 'b.md': use(0, 10) };
  assert.deepEqual(rankForEviction(entries, usage).map((e) => e.target), ['b.md', 'a.md']);
});
