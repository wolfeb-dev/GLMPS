// Tests for the per-repo git working-tree status reader: pure recipe builder,
// pure porcelain=v2 parser, and the injected-exec scanner. Mirrors the house
// style of unmerged-branches.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusRecipe, parseStatus, gitStatus } from '../lib/observability/git-status.js';


test('statusRecipe builds the porcelain=v2 --branch command for a dir', () => {
  const r = statusRecipe('/x/y');
  assert.deepEqual(r, { file: 'git', args: ['-C', '/x/y', 'status', '--porcelain=v2', '--branch'] });
});


test('parseStatus: clean repo with upstream', () => {
  const out = '# branch.head main\n# branch.ab +0 -0\n';
  assert.deepEqual(parseStatus(out), { dirty: 0, ahead: 0, behind: 0, branch: 'main', head: null, detached: false });
});

test('parseStatus: dirty repo counts changed + untracked + unmerged but not ignored', () => {
  const out = [
    '# branch.oid abcdef1234567890',
    '# branch.head feature/x',
    '# branch.ab +0 -0',
    '1 .M N... 100644 100644 100644 aaaa bbbb src/foo.js',
    '2 R. N... 100644 100644 100644 aaaa bbbb R100 src/bar.js\tsrc/old-bar.js',
    'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.js',
    '? untracked.js',
    '! ignored.log',
    '',
  ].join('\n');
  const result = parseStatus(out);
  assert.equal(result.dirty, 4); // 1 ordinary + 1 renamed + 1 unmerged + 1 untracked, NOT ignored
  assert.equal(result.branch, 'feature/x');
  assert.equal(result.ahead, 0);
  assert.equal(result.behind, 0);
});

test('parseStatus: ahead/behind parsed from branch.ab', () => {
  const out = '# branch.head main\n# branch.ab +3 -2\n';
  const result = parseStatus(out);
  assert.equal(result.ahead, 3);
  assert.equal(result.behind, 2);
});

test('parseStatus: no upstream (no branch.ab line) defaults ahead/behind to 0', () => {
  const out = '# branch.head main\n1 .M N... 100644 100644 100644 aaaa bbbb foo.js\n';
  const result = parseStatus(out);
  assert.equal(result.ahead, 0);
  assert.equal(result.behind, 0);
  assert.equal(result.branch, 'main');
  assert.equal(result.dirty, 1);
});

test('parseStatus: detached HEAD', () => {
  const out = '# branch.head (detached)\n# branch.ab +0 -0\n';
  const result = parseStatus(out);
  assert.equal(result.branch, '(detached)');
  assert.equal(result.detached, true);
});

test('parseStatus: head comes from branch.oid, null for an initial commit', () => {
  const oid = 'a'.repeat(40);
  const out = (o, h) => ['# branch.oid ' + o, '# branch.head ' + h, ''].join('\n');
  assert.equal(parseStatus(out(oid, 'main')).head, oid);
  assert.equal(parseStatus(out('(initial)', 'main')).head, null);
  assert.equal(parseStatus(out(oid, '(detached)')).head, oid);
  assert.equal(parseStatus(out(oid, 'main')).detached, false);
});

test('parseStatus: empty/blank input is clean with no branch', () => {
  assert.deepEqual(parseStatus(''), { dirty: 0, ahead: 0, behind: 0, branch: null, head: null, detached: false });
  assert.deepEqual(parseStatus(null), { dirty: 0, ahead: 0, behind: 0, branch: null, head: null, detached: false });
});


test('gitStatus resolves the parsed status via a fake async exec', async () => {
  const fixture = '# branch.head main\n# branch.ab +1 -0\n1 .M N... 100644 100644 100644 aaaa bbbb foo.js\n';
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    return fixture;
  };
  const result = await gitStatus('/repo', exec);
  assert.deepEqual(result, parseStatus(fixture));
  assert.deepEqual(calls, [['git', '-C', '/repo', 'status', '--porcelain=v2', '--branch']]);
});

test('gitStatus resolves the parsed status via a fake sync exec', async () => {
  const fixture = '# branch.head main\n# branch.ab +0 -0\n';
  const exec = (file, args) => fixture;
  const result = await gitStatus('/repo', exec);
  assert.deepEqual(result, { dirty: 0, ahead: 0, behind: 0, branch: 'main', head: null, detached: false });
});

test('gitStatus resolves null (never throws) when exec rejects', async () => {
  const exec = async () => { throw new Error('not a repo'); };
  const result = await gitStatus('/missing', exec);
  assert.equal(result, null);
});

test('gitStatus resolves null when exec throws synchronously', async () => {
  const exec = () => { throw new Error('git not found'); };
  const result = await gitStatus('/missing', exec);
  assert.equal(result, null);
});
