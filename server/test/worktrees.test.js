// Tests for the shared worktree module (glmps-71): session plans, list recipe,
// porcelain parser. Runner-job plan/recipes keep their coverage in
// queue-runner.test.js via the re-export (import-path stability).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import {
  worktreePlan, addWorktree, sessionWorktreePlan, listWorktreesRecipe, parseWorktreeList, safeSeg, isUnderDir, pathsEqual,
} from '../lib/orchestration/worktrees.js';

test('sessionWorktreePlan: deterministic dir + session/<project>/<shortid> branch', () => {
  const p = sessionWorktreePlan({ baseDir: '/wt', project: 'glmps', sessionId: 'abcd1234-ef56-7890' });
  assert.equal(p.dir, path.join('/wt', 'glmps', 'session-abcd1234-ef5'));
  assert.equal(p.branch, 'session/glmps/abcd1234-ef5');
});

test('sessionWorktreePlan scrubs git-hostile characters', () => {
  const p = sessionWorktreePlan({ baseDir: '/wt', project: 'a~b:c', sessionId: 'x?*y' });
  assert.ok(!/[~:?*]/.test(p.branch), p.branch);
  assert.ok(!/[~:?*]/.test(p.dir), p.dir);
});

test('listWorktreesRecipe is a pure git argv (no shell)', () => {
  assert.deepEqual(listWorktreesRecipe({ repo: '/r' }),
    { file: 'git', args: ['-C', '/r', 'worktree', 'list', '--porcelain'] });
});

test('parseWorktreeList parses porcelain stanzas incl. detached', () => {
  const text = [
    'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /wt/p/session-x', 'HEAD bbb', 'branch refs/heads/session/p/x', '',
    'worktree /wt/detached', 'HEAD ccc', 'detached', '',
  ].join('\n');
  const list = parseWorktreeList(text);
  assert.equal(list.length, 3);
  assert.deepEqual(list[1], { dir: '/wt/p/session-x', head: 'bbb', branch: 'session/p/x' });
  assert.equal(list[2].branch, null);
});

test('parseWorktreeList tolerates empty/garbage input', () => {
  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList(null), []);
});

test('safeSeg strips everything not path/branch safe', () => {
  assert.equal(safeSeg('a b~c:d'), 'a-b-c-d');
});

test('isUnderDir: a dir is under itself, and under its parent', () => {
  assert.equal(isUnderDir('/a/b', '/a/b'), true);
  assert.equal(isUnderDir('/a/b/c', '/a/b'), true);
  assert.equal(isUnderDir('/a', '/a/b'), false);
});

test('isUnderDir: separator, case and trailing slash do not matter', () => {
  assert.equal(isUnderDir('C:\\Users\\w\\wt\\job', 'c:/users/w/wt'), true);
  assert.equal(isUnderDir('/a/b/', '/a/b'), true);
});

test('isUnderDir: a sibling with a shared prefix is NOT under it', () => {
  assert.equal(isUnderDir('/a/bc', '/a/b'), false);
});

test('isUnderDir: an empty or missing base never matches', () => {
  assert.equal(isUnderDir('/a/b', ''), false);
  assert.equal(isUnderDir('/a/b', null), false);
  assert.equal(isUnderDir('', '/a/b'), false);
});

// the purge route's registration match used a
// strict `===` on two fs.realpathSync results, which is case-SENSITIVE - on
// win32 a drive letter can come back a different case than the caller's own
// path, producing a false 404 for a perfectly real, registered worktree.
// pathsEqual shares isUnderDir's own normalization (separator, case,
// trailing slash) so the two checks can never quietly diverge.
test('pathsEqual: same path, different separator/case/trailing slash, is equal', () => {
  assert.equal(pathsEqual('C:\\Users\\w\\wt\\job', 'c:/users/w/wt/job'), true);
  assert.equal(pathsEqual('/a/b/', '/a/b'), true);
});

test('pathsEqual: a parent or a sibling is NOT equal', () => {
  assert.equal(pathsEqual('/a/b', '/a/b/c'), false);
  assert.equal(pathsEqual('/a/bc', '/a/b'), false);
});

test('pathsEqual: an empty or missing side never matches', () => {
  assert.equal(pathsEqual('', '/a/b'), false);
  assert.equal(pathsEqual('/a/b', ''), false);
  assert.equal(pathsEqual(null, null), false);
});

test('safeSeg replaces dot-only segments so the plan dir stays inside baseDir', () => {
  assert.equal(safeSeg('..'), '-');
  assert.equal(safeSeg('.'), '-');
  assert.equal(safeSeg('a..b'), 'a..b');
  const base = path.resolve('/wt');
  for (const bad of ['..', '.', '...']) {
    const p = worktreePlan({ baseDir: base, project: bad, jobId: bad });
    assert.ok(isUnderDir(p.dir, base) && path.resolve(p.dir) !== base, `${bad} -> ${p.dir}`);
    const s = sessionWorktreePlan({ baseDir: base, project: bad, sessionId: bad });
    assert.ok(isUnderDir(s.dir, base) && path.resolve(s.dir) !== base, `${bad} -> ${s.dir}`);
  }
});

function gitSync(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wtadd-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  gitSync(repo, 'init', '-q', '-b', 'main');
  gitSync(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  return { root, repo };
}
const runGit = (recipe) => new Promise((resolve) => {
  execFile(recipe.file, recipe.args, { encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
  });
});

test('addWorktree resets a leftover branch that is behind its start point (-B, no commits lost)', async () => {
  const { root, repo } = makeRepo();
  try {
    gitSync(repo, 'branch', 'job/x');
    gitSync(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'ahead on main');
    const dir = path.join(root, 'wt');
    const r = await addWorktree({ repo, dir, branch: 'job/x', startPoint: 'main', run: runGit });
    assert.equal(r.ok, true);
    assert.equal(r.reusedBranch, false);
    assert.equal(gitSync(dir, 'rev-parse', 'HEAD'), gitSync(repo, 'rev-parse', 'main'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('addWorktree reuses a branch holding commits the start point lacks, instead of resetting it', async () => {
  const { root, repo } = makeRepo();
  try {
    gitSync(repo, 'checkout', '-q', '-b', 'job/x');
    gitSync(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'agent work');
    const work = gitSync(repo, 'rev-parse', 'job/x');
    gitSync(repo, 'checkout', '-q', 'main');
    const dir = path.join(root, 'wt');
    const r = await addWorktree({ repo, dir, branch: 'job/x', startPoint: 'main', run: runGit });
    assert.equal(r.ok, true);
    assert.equal(r.reusedBranch, true);
    assert.equal(gitSync(dir, 'rev-parse', 'HEAD'), work, 'the agent commit survives');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('addWorktree creates the branch when it does not exist', async () => {
  const { root, repo } = makeRepo();
  try {
    const dir = path.join(root, 'wt');
    const r = await addWorktree({ repo, dir, branch: 'job/new', startPoint: null, run: runGit });
    assert.equal(r.ok, true);
    assert.equal(r.reusedBranch, false);
    assert.equal(gitSync(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'job/new');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
