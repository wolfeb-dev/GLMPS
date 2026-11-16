import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitCommonDir, dedupeByCommonDir } from '../lib/orchestration/git-common-dir.js';

function git(args, cwd) { execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] }); }
const key = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

test('real git: a primary checkout and its linked worktrees share one common dir; an unrelated repo does not', () => {
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-commondir-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main', repo], repo);
    git(['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
    const wt = path.join(root, 'wt');
    git(['worktree', 'add', '-q', '-b', 'wtb', wt], repo);
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    git(['init', '-q', other], other);

    assert.equal(key(gitCommonDir(repo)), key(path.join(repo, '.git')));
    assert.equal(key(gitCommonDir(wt)), key(path.join(repo, '.git')), 'a linked worktree resolves to its main repo .git');
    assert.equal(key(gitCommonDir(other)), key(path.join(other, '.git')));
    assert.equal(gitCommonDir(path.join(root, 'not-a-repo')), null);

    // Worktree listed first: the primary checkout still wins.
    const kept = dedupeByCommonDir([wt, other, repo]);
    assert.deepEqual(kept, [other, repo]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('dedupeByCommonDir: a primary checkout wins, else the first seen; unreadable roots are kept', () => {
  const dirs = {
    '/main': { common: '/main/.git', primary: true },
    '/main/.claude/worktrees/a': { common: '/main/.git', primary: false },
    '/main/.claude/worktrees/b': { common: '/main/.git', primary: false },
    '/x/wt1': { common: '/x/.git', primary: false },
    '/x/wt2': { common: '/x/.git', primary: false },
    '/broken': { common: null, primary: false },
  };
  const opts = { commonDirOf: (r) => dirs[r].common, isPrimary: (r) => dirs[r].primary };

  assert.deepEqual(
    dedupeByCommonDir(['/main/.claude/worktrees/a', '/main', '/main/.claude/worktrees/b', '/x/wt1', '/x/wt2', '/broken'], opts),
    ['/main', '/x/wt1', '/broken'],
  );
  // Live shape (2026-10-26): D:/glmps-2.0-runtime and D:/scut-build are
  // linked worktrees of D:/glmps. Collection order (this server's
  // own root first) must not decide the survivor.
  assert.deepEqual(dedupeByCommonDir(['/main/.claude/worktrees/a', '/main'], opts), ['/main']);
});
