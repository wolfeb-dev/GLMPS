// server/test/graph-status.test.js
// Unit tests for the pure computeGraphStatus function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGraphStatus, selectRebuildTargets } from '../lib/observability/graph-status.js';

const BASE = { project: 'my-repo', root: '/d/my-repo', nodes: 42, mtimeMs: 1700000000000 };

test('needsUpdate true when commits differ', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: 'def5678' });
  assert.equal(r.needsUpdate, true);
});

test('a graph verified at HEAD by a no-op is fresh though built_at_commit lags (7b step 3)', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: 'def5678', verifiedAtCommit: 'def5678' });
  assert.equal(r.freshness, 'fresh');
  assert.equal(r.needsUpdate, false);
  assert.equal(r.verifiedAtCommit, 'def5678');
  const older = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: 'fff0000', verifiedAtCommit: 'def5678' });
  assert.equal(older.freshness, 'stale', 'a verification of an older commit does not vouch for HEAD');
  const noBuilt = computeGraphStatus({ ...BASE, builtAtCommit: null, headCommit: 'def5678', verifiedAtCommit: 'def5678' });
  assert.equal(noBuilt.freshness, 'fresh');
});

test('needsUpdate false when commits are equal', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: 'abc1234' });
  assert.equal(r.needsUpdate, false);
});

test('needsUpdate false when builtAtCommit is missing', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: null, headCommit: 'abc1234' });
  assert.equal(r.needsUpdate, false);
});

test('needsUpdate false when headCommit is missing', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: null });
  assert.equal(r.needsUpdate, false);
});

test('needsUpdate false when both commits missing', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: null, headCommit: null });
  assert.equal(r.needsUpdate, false);
});

test('passes nodes through as integer', () => {
  const r = computeGraphStatus({ ...BASE, nodes: 17.9, builtAtCommit: null, headCommit: null });
  assert.equal(r.nodes, 17);
});

test('nodes defaults to 0 for undefined/falsy', () => {
  const r = computeGraphStatus({ ...BASE, nodes: undefined, builtAtCommit: null, headCommit: null });
  assert.equal(r.nodes, 0);
});

test('passes rebuiltMs (mtimeMs) through', () => {
  const r = computeGraphStatus({ ...BASE, mtimeMs: 9999, builtAtCommit: null, headCommit: null });
  assert.equal(r.rebuiltMs, 9999);
});

test('rebuiltMs is null when mtimeMs is null/undefined', () => {
  const r = computeGraphStatus({ ...BASE, mtimeMs: null, builtAtCommit: null, headCommit: null });
  assert.equal(r.rebuiltMs, null);
  const r2 = computeGraphStatus({ ...BASE, mtimeMs: undefined, builtAtCommit: null, headCommit: null });
  assert.equal(r2.rebuiltMs, null);
});

test('passes project, root, builtAtCommit, headCommit through', () => {
  const r = computeGraphStatus({
    project: 'foo', root: '/x/foo', nodes: 3, mtimeMs: 1,
    builtAtCommit: 'aaa', headCommit: 'bbb',
  });
  assert.equal(r.project, 'foo');
  assert.equal(r.root, '/x/foo');
  assert.equal(r.builtAtCommit, 'aaa');
  assert.equal(r.headCommit, 'bbb');
});

test('needsUpdate false when builtAtCommit is empty string', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: '', headCommit: 'abc1234' });
  assert.equal(r.needsUpdate, false);
});

// needsUpdate answers "do we KNOW this is stale". It cannot distinguish
// "known fresh" from "we have no idea", and on 2026-08-16 that gap went live:
// graphify's incremental write path stopped emitting built_at_commit, so the
// two most actively rebuilt graphs reported needsUpdate:false, which reads as
// healthy. freshness is the third state that makes blindness visible.

test('freshness is stale when both commits are known and differ', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: 'def5678' });
  assert.equal(r.freshness, 'stale');
  assert.equal(r.needsUpdate, true);
});

test('freshness is fresh when both commits are known and equal', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: 'abc1234' });
  assert.equal(r.freshness, 'fresh');
  assert.equal(r.needsUpdate, false);
});

test('freshness is unknown when builtAtCommit is missing (the 2026-08-16 case)', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: null, headCommit: 'abc1234' });
  assert.equal(r.freshness, 'unknown');
  assert.equal(r.needsUpdate, false, 'needsUpdate keeps its known-stale-only meaning');
});

test('freshness is unknown when headCommit is missing', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: null });
  assert.equal(r.freshness, 'unknown');
});

test('freshness is unknown when both commits are missing', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: null, headCommit: null });
  assert.equal(r.freshness, 'unknown');
});

test('freshness is unknown when builtAtCommit is an empty string', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: '', headCommit: 'abc1234' });
  assert.equal(r.freshness, 'unknown');
});

// Commit comparison tolerates short vs full SHAs, matching code-graph.js's
// loadGraph. Exact !== would report a short-SHA graph as permanently stale.

test('a short builtAtCommit that prefixes headCommit is fresh, not stale', () => {
  const r = computeGraphStatus({
    ...BASE, builtAtCommit: 'c56756dc', headCommit: 'c56756dc92e388259dff6e9dec6344bc6c4413ef',
  });
  assert.equal(r.freshness, 'fresh');
  assert.equal(r.needsUpdate, false);
});

test('a short headCommit that prefixes builtAtCommit is fresh, not stale', () => {
  const r = computeGraphStatus({
    ...BASE, builtAtCommit: 'c56756dc92e388259dff6e9dec6344bc6c4413ef', headCommit: 'c56756dc',
  });
  assert.equal(r.freshness, 'fresh');
  assert.equal(r.needsUpdate, false);
});

test('commits sharing no prefix are still stale', () => {
  const r = computeGraphStatus({
    ...BASE, builtAtCommit: 'c56756dc92e388259dff6e9dec6344bc6c4413ef', headCommit: '70e03945f139a3673f85b2dd6aaf7626699e14b4',
  });
  assert.equal(r.freshness, 'stale');
  assert.equal(r.needsUpdate, true);
});

// Extracted from server.js's /api/graph/rebuild so the targeting rule is
// testable without spawning graphify. A graph whose freshness is unknown is a
// rebuild target: rebuilding it is how its marker gets restored.

const st = (root, freshness, needsUpdate) => ({ root, freshness, needsUpdate });

test('selectRebuildTargets picks known-stale graphs', () => {
  const targets = selectRebuildTargets([
    st('/a', 'stale', true), st('/b', 'fresh', false),
  ]);
  assert.deepEqual(targets, ['/a']);
});

test('selectRebuildTargets picks unknown-freshness graphs', () => {
  const targets = selectRebuildTargets([
    st('/a', 'fresh', false), st('/b', 'unknown', false),
  ]);
  assert.deepEqual(targets, ['/b']);
});

test('selectRebuildTargets picks both stale and unknown', () => {
  const targets = selectRebuildTargets([
    st('/a', 'stale', true), st('/b', 'fresh', false), st('/c', 'unknown', false),
  ]);
  assert.deepEqual(targets, ['/a', '/c']);
});

test('selectRebuildTargets falls back to every root when nothing needs it', () => {
  // Preserves the pre-existing "rebuild all" fallback: an explicit no-body
  // rebuild request with nothing detectably stale still rebuilds everything.
  const targets = selectRebuildTargets([
    st('/a', 'fresh', false), st('/b', 'fresh', false),
  ]);
  assert.deepEqual(targets, ['/a', '/b']);
});

test('selectRebuildTargets returns an empty list for no graphs', () => {
  assert.deepEqual(selectRebuildTargets([]), []);
});
