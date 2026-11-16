// server/test/head-ref.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { headRef, clearHeadRefCache } from '../lib/observability/head-ref.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-headref-')); }

function repoWithCommit() {
  const dir = tmp();
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

test('headRef reads the current sha of a real repo', () => {
  clearHeadRefCache();
  const dir = repoWithCommit();
  const expected = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(headRef(dir), expected);
});

test('headRef follows a packed ref when no loose ref file exists', () => {
  clearHeadRefCache();
  const dir = repoWithCommit();
  const expected = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  execSync('git pack-refs --all', { cwd: dir });
  clearHeadRefCache();
  assert.equal(headRef(dir), expected, 'a packed-refs repo must still resolve');
});

test('headRef resolves inside a linked worktree, where .git is a file', () => {
  clearHeadRefCache();
  const dir = repoWithCommit();
  const wt = path.join(tmp(), 'wt');
  execSync(`git worktree add -q "${wt}" -b side`, { cwd: dir });
  try {
    const expected = execSync('git rev-parse HEAD', { cwd: wt, encoding: 'utf8' }).trim();
    assert.equal(headRef(wt), expected);
  } finally {
    try { execSync(`git worktree remove --force "${wt}"`, { cwd: dir }); } catch { /* best effort */ }
  }
});

test('headRef returns null for a path that is not a repo', () => {
  clearHeadRefCache();
  assert.equal(headRef(tmp()), null);
});

test('headRef returns null rather than throwing for a missing path', () => {
  clearHeadRefCache();
  assert.equal(headRef(path.join(os.tmpdir(), 'definitely-not-here-9f3a')), null);
});

test('headRef returns null for a null or empty repo path', () => {
  clearHeadRefCache();
  assert.equal(headRef(null), null);
  assert.equal(headRef(''), null);
});

test('headRef caches within the TTL and refreshes after it', () => {
  clearHeadRefCache();
  const dir = repoWithCommit();
  const first = headRef(dir, { now: 1000, ttlMs: 60000 });

  fs.writeFileSync(path.join(dir, 'f.txt'), 'b');
  execSync('git commit -qam second', { cwd: dir });
  const moved = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  assert.notEqual(moved, first, 'the repo really did move');

  assert.equal(headRef(dir, { now: 5000, ttlMs: 60000 }), first, 'inside the TTL the cached value is served');
  assert.equal(headRef(dir, { now: 90000, ttlMs: 60000 }), moved, 'after the TTL it re-reads');
});

test('a detached HEAD resolves to the sha it points at', () => {
  clearHeadRefCache();
  const dir = repoWithCommit();
  const sha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  execSync(`git checkout -q --detach ${sha}`, { cwd: dir });
  clearHeadRefCache();
  assert.equal(headRef(dir), sha);
});
