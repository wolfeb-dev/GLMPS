// server/test/revert-scan.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { revertedRefs, scanReverts, readWatermark, writeWatermark, LOG_FORMAT } from '../lib/observability/revert-scan.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-revert-')); }

// The wire format scanReverts parses is `git log --format=%H%x00%B%x1e`: each
// record is <sha> NUL <full body>, records separated by 0x1e. Built by code
// point so the fixture cannot silently drift from the real separators, and so
// this source file stays free of raw control characters.
const NUL = String.fromCharCode(0);
const RS = String.fromCharCode(0x1e);

test('the log format the parser expects is the one it asks git for', () => {
  assert.equal(LOG_FORMAT, '%H%x00%B%x1e');
});

test('revertedRefs parses the standard git revert body', () => {
  assert.deepEqual(
    revertedRefs(['Revert "feat: x"\n\nThis reverts commit 1a2b3c4d5e6f7081920304050607080910111213.']),
    ['1a2b3c4d5e6f7081920304050607080910111213'],
  );
});

test('revertedRefs accepts an abbreviated sha and lowercases it', () => {
  assert.deepEqual(revertedRefs(['This reverts commit 1A2B3C4.']), ['1a2b3c4']);
});

test('revertedRefs finds every reverted ref in a multi-revert body', () => {
  const body = 'Revert two things\n\nThis reverts commit aaaaaaa.\nThis reverts commit bbbbbbb.';
  assert.deepEqual(revertedRefs([body]), ['aaaaaaa', 'bbbbbbb']);
});

test('revertedRefs deduplicates repeated refs', () => {
  assert.deepEqual(revertedRefs(['This reverts commit abc1234.', 'This reverts commit abc1234.']), ['abc1234']);
});

test('revertedRefs ignores an ordinary commit', () => {
  assert.deepEqual(revertedRefs(['feat: add a thing\n\nNothing reverted here.']), []);
});

test('revertedRefs ignores prose that merely mentions reverting', () => {
  // "how to revert commit abc1234" is documentation, not a revert. Only the
  // git-generated "This reverts commit <sha>" trailer counts.
  assert.deepEqual(revertedRefs(['docs: explain how to revert commit abc1234 if needed']), []);
});

test('revertedRefs tolerates a too-short or malformed sha', () => {
  assert.deepEqual(revertedRefs(['This reverts commit zzz.']), []);
});

test('scanReverts returns the refs and the new head', async () => {
  const log = [
    `deadbeef00000000000000000000000000000000${NUL}Revert "feat: x"\n\nThis reverts commit 1a2b3c4.${RS}`,
    `cafebabe00000000000000000000000000000000${NUL}feat: unrelated${RS}`,
  ].join('');
  const out = await scanReverts({ repo: '.', since: null, runGit: () => log });
  assert.deepEqual(out.refs, ['1a2b3c4']);
  assert.equal(out.head, 'deadbeef00000000000000000000000000000000');
});

test('scanReverts on an empty log reports no refs and a null head', async () => {
  const out = await scanReverts({ repo: '.', since: 'abc', runGit: () => '' });
  assert.deepEqual(out.refs, []);
  assert.equal(out.head, null);
});

test('scanReverts passes a since watermark as a range and omits it when unset', async () => {
  let seen = null;
  await scanReverts({ repo: '.', since: 'abc123', runGit: (args) => { seen = args; return ''; } });
  assert.ok(seen.includes('abc123..HEAD'), `expected a range arg, got ${JSON.stringify(seen)}`);
  await scanReverts({ repo: '.', since: null, runGit: (args) => { seen = args; return ''; } });
  assert.equal(seen.some((a) => a.includes('..')), false, 'no range arg when there is no watermark');
});

test('scanReverts never throws when git fails, it reports nothing found', async () => {
  const out = await scanReverts({ repo: '.', since: null, runGit: () => { throw new Error('not a git repository'); } });
  assert.deepEqual(out.refs, []);
  assert.equal(out.head, null);
  assert.match(out.error, /not a git repository/);
});

test('the watermark round-trips per repo and defaults to null', () => {
  const dir = tmp();
  assert.equal(readWatermark(dir, 'glmps'), null);
  writeWatermark(dir, 'glmps', 'deadbeef');
  assert.equal(readWatermark(dir, 'glmps'), 'deadbeef');
  assert.equal(readWatermark(dir, 'other-repo'), null, 'watermarks must not leak between repos');
});

test('scanReverts is async and its default runner reads a real repo without blocking', async () => {
  const dir = tmp();
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'feat: x');
    const sha = git('rev-parse', 'HEAD').trim();
    git('revert', '--no-edit', 'HEAD');
    const p = scanReverts({ repo: dir, since: null });
    assert.equal(typeof p.then, 'function');
    const out = await p;
    assert.deepEqual(out.refs, [sha.slice(0, 40)]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scanReverts reports a hung git as an error after the timeout instead of waiting forever', async () => {
  const out = await scanReverts({ repo: '.', since: null, timeoutMs: 20, runGit: () => new Promise(() => {}) });
  assert.deepEqual(out.refs, []);
  assert.match(out.error, /timed out/);
});
