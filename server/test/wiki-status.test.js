import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWikiStatus, wikiRebuildArgs } from '../lib/observability/wiki-status.js';

test('needsUpdate true when both commits known and differ', () => {
  const r = computeWikiStatus({ builtAtCommit: 'aaa', headCommit: 'bbb', sections: [{ slug: 'x' }] });
  assert.equal(r.needsUpdate, true);
  assert.deepEqual(r.sections, [{ slug: 'x', stale: true }]);
});

test('needsUpdate false when commits match', () => {
  const r = computeWikiStatus({ builtAtCommit: 'aaa', headCommit: 'aaa', sections: [{ slug: 'x' }] });
  assert.equal(r.needsUpdate, false);
  assert.deepEqual(r.sections, [{ slug: 'x', stale: false }]);
});

test('unknown head or built commit => not stale (conservative)', () => {
  assert.equal(computeWikiStatus({ builtAtCommit: 'aaa', headCommit: null }).needsUpdate, false);
  assert.equal(computeWikiStatus({ builtAtCommit: null, headCommit: 'bbb' }).needsUpdate, false);
});

test('missing sections => empty section list', () => {
  const r = computeWikiStatus({ builtAtCommit: 'a', headCommit: 'b' });
  assert.deepEqual(r.sections, []);
});


test('wikiRebuildArgs: default has no --out and no --llm', () => {
  const args = wikiRebuildArgs({ cliPath: '/r/scripts/wiki-build-cli.mjs', target: '/r' });
  assert.deepEqual(args, ['/r/scripts/wiki-build-cli.mjs', '/r']);
});

test('wikiRebuildArgs: llm appends --llm', () => {
  const args = wikiRebuildArgs({ cliPath: 'c', target: 't', llm: true });
  assert.deepEqual(args, ['c', 't', '--llm']);
});

test('wikiRebuildArgs: outDir appends --out <dir>', () => {
  const args = wikiRebuildArgs({ cliPath: 'c', target: 't', llm: true, outDir: '/tmp/wiki' });
  assert.deepEqual(args, ['c', 't', '--llm', '--out', '/tmp/wiki']);
});

test('a missing build marker reads as unknown, not fresh', () => {
  // The same defect f7e0c0f fixed in graph-status.js, on the same
  // built_at_commit field the wiki manifest copies from the graph: absence of
  // evidence must not read as evidence of freshness.
  const noBuilt = computeWikiStatus({ builtAtCommit: null, headCommit: 'abc1234', sections: [{ slug: 's' }] });
  assert.equal(noBuilt.freshness, 'unknown');
  assert.equal(noBuilt.needsUpdate, false, 'needsUpdate stays narrow: we do not KNOW it is behind');

  const noHead = computeWikiStatus({ builtAtCommit: 'abc1234', headCommit: null });
  assert.equal(noHead.freshness, 'unknown');

  assert.equal(computeWikiStatus({}).freshness, 'unknown');
});

test('freshness is fresh when both markers are known and match, stale when they differ', () => {
  assert.equal(computeWikiStatus({ builtAtCommit: 'abc1234', headCommit: 'abc1234', builtFromGraph: 'g1:f', currentGraph: 'g1:f' }).freshness, 'fresh');
  const stale = computeWikiStatus({ builtAtCommit: 'abc1234', headCommit: 'def5678', sections: [{ slug: 's' }] });
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.needsUpdate, true);
  assert.equal(stale.sections[0].stale, true);
});

// The freshness truth table (spec 2026-10-28-wiki-graph-freshness, glmps-2.0
// corpus): a graph rewritten at an unchanged HEAD must not read as fresh.
const row = (o) => { const r = computeWikiStatus({ sections: [{ slug: 's' }], ...o }); return [r.freshness, r.staleReason, r.needsUpdate, r.sections[0].stale]; };

test('truth table: missing recorded commit is unknown / commit-unrecorded', () => {
  assert.deepEqual(row({ builtAtCommit: null, headCommit: 'a', builtFromGraph: 'g1:f', currentGraph: 'g1:f' }), ['unknown', 'commit-unrecorded', false, false]);
});

test('truth table: unreadable HEAD is unknown / head-unreadable', () => {
  assert.deepEqual(row({ builtAtCommit: 'a', headCommit: null, builtFromGraph: 'g1:f', currentGraph: 'g1:f' }), ['unknown', 'head-unreadable', false, false]);
});

test('truth table: different commits are stale / commit whatever the graphs say', () => {
  assert.deepEqual(row({ builtAtCommit: 'a', headCommit: 'b', builtFromGraph: 'g1:f', currentGraph: 'g1:f' }), ['stale', 'commit', true, true]);
  assert.deepEqual(row({ builtAtCommit: 'a', headCommit: 'b' }), ['stale', 'commit', true, true]);
});

test('truth table: same commit, no recorded graph (a legacy build) is unknown / graph-unrecorded', () => {
  assert.deepEqual(row({ builtAtCommit: 'a', headCommit: 'a', builtFromGraph: null, currentGraph: 'g1:f' }), ['unknown', 'graph-unrecorded', false, false]);
  assert.deepEqual(row({ builtAtCommit: 'a', headCommit: 'a' }), ['unknown', 'graph-unrecorded', false, false]);
});

test('truth table: same commit, current graph unavailable is unknown / graph-unreadable', () => {
  assert.deepEqual(row({ builtAtCommit: 'a', headCommit: 'a', builtFromGraph: 'g1:f', currentGraph: null }), ['unknown', 'graph-unreadable', false, false]);
});

test('truth table: same commit, changed graph is stale / graph', () => {
  assert.deepEqual(row({ builtAtCommit: 'a', headCommit: 'a', builtFromGraph: 'g1:f', currentGraph: 'g1:e' }), ['stale', 'graph', true, true]);
});

test('truth table: same commit, same graph is fresh with no reason', () => {
  assert.deepEqual(row({ builtAtCommit: 'a', headCommit: 'a', builtFromGraph: 'g1:f', currentGraph: 'g1:f' }), ['fresh', null, false, false]);
});
