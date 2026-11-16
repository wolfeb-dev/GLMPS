import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoTree, fileDiff, safeRelPath, resolveResidencyRepo, defaultExec, gitChildEnv } from '../lib/surface/repo-tree.js';
import { FileApi } from '../lib/governance/file-api.js';
import { makeFixture } from './fixtures/git-repo-fixture.js';

test('safeRelPath refuses traversal, absolute and drive paths', () => {
  for (const bad of ['', '../x', 'a/../../x', '/etc/passwd', 'C:/x', 'C:\\x', 'a//b', 'a/', 'a\0b']) assert.equal(safeRelPath(bad), null, bad);
  assert.equal(safeRelPath('dir\\b.txt'), 'dir/b.txt');
});

test('repoTree reports folders and every drifted file with a status word', async () => {
  const { base, work } = makeFixture();
  try {
    const t = await repoTree({ repoPath: work, repo: 'work' });
    assert.equal(t.base, '@{u}');
    const st = Object.fromEntries(t.files.map((f) => [f.path, f.status]));
    assert.equal(st['a.txt'], 'uncommitted');
    assert.equal(st['c.txt'], 'untracked');
    assert.equal(st['dir/b.txt'], 'ahead');
    assert.equal(st['d.txt'], 'behind');
    const dir = t.folders.find((f) => f.dir === 'dir');
    assert.deepEqual(dir, { dir: 'dir', count: 1, drifted: 1 });
    assert.equal(t.truncated, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('repoTree carries size and mtimeMs per file, null for a file gone from the working tree', async () => {
  const { base, work } = makeFixture();
  try {
    fs.rmSync(path.join(work, 'bin.dat'));
    const t = await repoTree({ repoPath: work, repo: 'work' });
    const by = Object.fromEntries(t.files.map((f) => [f.path, f]));
    assert.equal(by['a.txt'].size, 'one changed\n'.length);
    assert.equal(typeof by['a.txt'].mtimeMs, 'number');
    assert.equal(by['bin.dat'].status, 'uncommitted');
    assert.equal(by['bin.dat'].size, null); assert.equal(by['bin.dat'].mtimeMs, null);
    assert.equal(by['d.txt'].size, null, 'a file only upstream is not on disk');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('fileDiff returns the renderDiff change shape; refuses escapes and secrets', async () => {
  const { base, work } = makeFixture();
  const fileApi = new FileApi([work], path.join(base, 'undo'));
  try {
    const d = await fileDiff({ repoPath: work, repo: 'work', relPath: 'dir/b.txt', fileApi });
    assert.deepEqual(d.change, { old: { text: 'bee\n', truncated: false }, new: { text: 'bee two\n', truncated: false } });
    assert.equal(d.absPath, path.join(work, 'dir', 'b.txt'));
    const created = await fileDiff({ repoPath: work, repo: 'work', relPath: 'c.txt', fileApi });
    assert.equal(created.change.old, null);
    const bin = await fileDiff({ repoPath: work, repo: 'work', relPath: 'bin.dat', fileApi });
    assert.equal(bin.change.new.text, '(binary file)');
    const big = await fileDiff({ repoPath: work, repo: 'work', relPath: 'dir/b.txt', fileApi, maxBytes: 3 });
    assert.equal(big.change.new.truncated, true);
    await assert.rejects(fileDiff({ repoPath: work, repo: 'work', relPath: '../x', fileApi }), (e) => e.status === 400);
    await assert.rejects(fileDiff({ repoPath: work, repo: 'work', relPath: '.env', fileApi }), (e) => e.status === 403 && e.message === 'path not allowed');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-out-'));
    fs.writeFileSync(path.join(outside, 's.txt'), 's');
    try { fs.symlinkSync(path.join(outside, 's.txt'), path.join(work, 'link.txt')); } catch { /* symlinks need privilege on Windows: the case is covered on Linux CI */ }
    if (fs.existsSync(path.join(work, 'link.txt'))) await assert.rejects(fileDiff({ repoPath: work, repo: 'work', relPath: 'link.txt', fileApi }), (e) => e.status === 400);
    // A hardlink is a second directory entry for the same inode: there is no
    // "real path" to resolve through the way a symlink has, so the name-based
    // and realpath-based checks above cannot see that alias.txt IS .env's
    // data. Hardlinks need no special privilege on the same volume, unlike
    // symlinks on Windows, so this case always runs.
    fs.linkSync(path.join(work, '.env'), path.join(work, 'hardlink-alias.txt'));
    await assert.rejects(fileDiff({ repoPath: work, repo: 'work', relPath: 'hardlink-alias.txt', fileApi }), (e) => e.status === 403 && e.message === 'path not allowed');
    // A symlink whose own name is innocuous but whose target is a sensitive
    // basename, still inside the repository (so the escape check above does
    // not fire): must be caught by FileApi's realpath-based sensitivity check.
    try { fs.symlinkSync(path.join(work, '.env'), path.join(work, 'envlink.txt')); } catch { /* symlinks need privilege on Windows: the case is covered on Linux CI */ }
    if (fs.existsSync(path.join(work, 'envlink.txt'))) await assert.rejects(fileDiff({ repoPath: work, repo: 'work', relPath: 'envlink.txt', fileApi }), (e) => e.status === 403 && e.message === 'path not allowed');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('repoTree normalizes a git failure to a fixed message, never the raw git stderr or the filesystem path', async () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-notrepo-'));
  try {
    await assert.rejects(repoTree({ repoPath: notARepo, repo: 'work' }), (e) => {
      assert.equal(e.status, 500);
      assert.equal(e.message, 'repository read failed');
      assert.ok(!e.message.includes(notARepo));
      assert.ok(!/fatal/i.test(e.message));
      return true;
    });
  } finally { fs.rmSync(notARepo, { recursive: true, force: true }); }
});

test('resolveResidencyRepo: 503 without the feed, 404 for an unknown repo', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-res-'));
  try {
    assert.equal(resolveResidencyRepo(stateDir, 'x').status, 503);
    fs.mkdirSync(path.join(stateDir, 'residency'));
    fs.writeFileSync(path.join(stateDir, 'residency', 'current.json'), JSON.stringify({ ts: 1, rows: [{ repo: 'work', path: '/w' }] }));
    assert.equal(resolveResidencyRepo(stateDir, 'nope').status, 404);
    assert.equal(resolveResidencyRepo(stateDir, 'work').row.path, '/w');
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('S-F2: fileDiff refuses any path under .git, in any case', async () => {
  const { base, work } = makeFixture();
  const fileApi = new FileApi([work], path.join(base, 'undo'));
  try {
    for (const rel of ['.git/config', '.GIT/config', '.Git/HEAD']) {
      await assert.rejects(fileDiff({ repoPath: work, repo: 'work', relPath: rel, fileApi }), (e) => e.status === 403 && e.message === 'path not allowed', rel);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// Task 16, S-F3 / S-L2: every git call this module makes is read-only in
// effect (no index.lock contention with the operator's own commits) and
// runs no fsmonitor or hook program.
test('S-F3/S-L2: every git call carries --no-optional-locks, core.fsmonitor=false and an empty hooks path', async () => {
  const { base, work } = makeFixture();
  const fileApi = new FileApi([work], path.join(base, 'undo'));
  const calls = [];
  const exec = (file, args, opts) => { calls.push(args); return defaultExec(file, args, opts); };
  try {
    await repoTree({ repoPath: work, repo: 'work', exec });
    await fileDiff({ repoPath: work, repo: 'work', relPath: 'dir/b.txt', fileApi, exec });
    assert.ok(calls.length >= 6, `saw ${calls.length} git calls`);
    for (const args of calls) {
      assert.equal(args[0], '--no-optional-locks', args.join(' '));
      assert.ok(args.includes('core.fsmonitor=false'), args.join(' '));
      assert.ok(args.includes(`core.hooksPath=${os.devnull}`), args.join(' '));
      assert.ok(args.indexOf('-C') > args.indexOf(`core.hooksPath=${os.devnull}`), 'the hardening precedes the subcommand');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('S-L1: gitChildEnv strips repository-redirecting GIT_* variables and keeps the rest', () => {
  const env = gitChildEnv({ PATH: 'p', HOME: 'h', GIT_DIR: 'x', git_work_tree: 'x', GIT_INDEX_FILE: 'x', GIT_CONFIG_GLOBAL: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_EXEC_PATH: 'x', GIT_OBJECT_DIRECTORY: 'x', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'x', GIT_COMMON_DIR: 'x', GIT_NAMESPACE: 'x', GIT_CEILING_DIRECTORIES: 'x', GIT_EXTERNAL_DIFF: 'x' });
  assert.deepEqual(env, { PATH: 'p', HOME: 'h' });
});

test('S-L1: an inherited GIT_DIR does not redirect the tree read away from the named repository', async () => {
  const { base, work } = makeFixture();
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(base, 'remote.git');
  try {
    const t = await repoTree({ repoPath: work, repo: 'work' });
    assert.ok(t.files.some((f) => f.path === 'c.txt' && f.status === 'untracked'), 'read the work tree, not the bare remote');
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// the working file is never read whole before clipping; at
// most maxBytes+1 bytes are read, and an over-bound file reports its size.
test('S-F4: a working file over the bound is read only up to the bound and reported truncated with its size', async () => {
  const { base, work } = makeFixture();
  const fileApi = new FileApi([work], path.join(base, 'undo'));
  const big = path.join(work, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(4096));
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === big) throw new Error('whole-file read of the working file');
    return realRead.call(this, p, ...rest);
  };
  try {
    const d = await fileDiff({ repoPath: work, repo: 'work', relPath: 'big.txt', fileApi, maxBytes: 1000 });
    assert.equal(d.change.new.truncated, true);
    assert.equal(d.change.new.text.length, 1000);
    assert.equal(d.change.new.size, 4096);
    const small = await fileDiff({ repoPath: work, repo: 'work', relPath: 'c.txt', fileApi });
    assert.deepEqual(small.change.new, { text: 'new\n', truncated: false });
  } finally {
    fs.readFileSync = realRead;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
