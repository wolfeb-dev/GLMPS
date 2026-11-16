// The fact gatherer works over an async git too (the desktop shell's git seam in
// service mode), and says why when it could not read anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherWorktreeFacts, integrationRefsFor, whenSettled } from '../lib/orchestration/worktree-outcome.js';

function asyncGit(script) {
  return async (args) => {
    const j = args.join(' ');
    for (const [prefix, res] of script) if (j.startsWith(prefix)) return res;
    return { status: 128, stdout: '', stderr: 'fatal: nope' };
  };
}

test('gatherWorktreeFacts over an async git returns a promise with the same facts', async () => {
  const git = asyncGit([
    ['rev-parse HEAD', { status: 0, stdout: 'abc123\n' }],
    ['status --porcelain', { status: 0, stdout: ' M a.js\n' }],
    ['for-each-ref', { status: 0, stdout: 'refs/remotes/origin/b\n' }],
    ['merge-base --is-ancestor abc123 origin/main', { status: 1, stdout: '' }],
    ['merge-base --is-ancestor abc123 main', { status: 0, stdout: '' }],
  ]);
  const p = gatherWorktreeFacts({ dir: '/w', branch: 'b', git, integrationRefs: ['origin/main', 'main'] });
  assert.equal(typeof p.then, 'function');
  assert.deepEqual(await p, { branch: 'b', head: 'abc123', pushed: true, merged: true, dirty: 1 });
});

test('integrationRefsFor works over an async git', async () => {
  const git = asyncGit([['rev-parse --abbrev-ref', { status: 0, stdout: 'origin/glmps2/main\n' }]]);
  const refs = await integrationRefsFor({ git, repo: '/r' });
  assert.deepEqual(refs.slice(0, 2), ['origin/glmps2/main', 'origin/main']);
});

test('unreadable facts carry the git error as the reason', async () => {
  const git = asyncGit([]);
  const f = await gatherWorktreeFacts({ dir: '/w', branch: 'b', git, integrationRefs: [] });
  assert.equal(f.head, null);
  assert.match(f.why, /fatal: nope/);
});

test('whenSettled runs synchronously on a plain value and chains on a promise', async () => {
  let seen = null;
  assert.equal(whenSettled(2, (v) => { seen = v; return v + 1; }), 3);
  assert.equal(seen, 2);
  assert.equal(await whenSettled(Promise.resolve(2), (v) => v + 1), 3);
});

test('integrationRefsFor lists remote refs only, so an unpushed local merge never counts as merged', async () => {
  const git = asyncGit([['rev-parse --abbrev-ref', { status: 0, stdout: 'main\n' }]]);
  const refs = await integrationRefsFor({ git, repo: '/r' });
  assert.deepEqual(refs, ['origin/main', 'origin/master']);
});

test('worktree-outcome no longer exports a synchronous git runner', async () => {
  const mod = await import('../lib/orchestration/worktree-outcome.js');
  assert.equal('execGit' in mod, false);
});
