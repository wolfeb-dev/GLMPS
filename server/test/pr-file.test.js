// server/test/pr-file.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { filePr, prBody } from '../lib/orchestration/pr-file.js';

test('dryRun files nothing and reports why, without ever calling run', () => {
  const r = filePr({
    repo: '.', branch: 'b', title: 't', body: 'b', dryRun: true,
    run: () => { throw new Error('must not run'); },
  });
  assert.deepEqual(r, { filed: false, url: null, reason: 'dry-run' });
});

test('a missing gh binary degrades instead of throwing', () => {
  const r = filePr({
    repo: '.', branch: 'b', title: 't', body: 'b',
    run: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }),
  });
  assert.equal(r.filed, false);
  assert.equal(r.url, null);
  assert.equal(r.reason, 'gh-missing');
});

test('a non-zero exit degrades instead of throwing', () => {
  const r = filePr({
    repo: '.', branch: 'b', title: 't', body: 'b',
    run: () => ({ status: 1, stdout: '', stderr: 'not authenticated' }),
  });
  assert.equal(r.filed, false);
  assert.equal(r.url, null);
  assert.equal(r.reason, 'gh-failed');
  assert.match(r.stderr ?? '', /not authenticated/);
});

test('a successful gh call returns the PR url', () => {
  const r = filePr({
    repo: '.', branch: 'b', title: 't', body: 'b',
    run: () => ({ status: 0, stdout: 'https://github.com/o/r/pull/7\n' }),
  });
  assert.equal(r.filed, true);
  assert.equal(r.url, 'https://github.com/o/r/pull/7');
});

test('filePr never throws even when run itself throws', () => {
  assert.doesNotThrow(() => filePr({
    repo: '.', branch: 'b', title: 't', body: 'b',
    run: () => { throw new Error('spawn exploded'); },
  }));
  const r = filePr({
    repo: '.', branch: 'b', title: 't', body: 'b',
    run: () => { throw new Error('spawn exploded'); },
  });
  assert.equal(r.filed, false);
  assert.equal(r.url, null);
});

test('filePr calls run with the gh pr create args, base defaulting to main', () => {
  let calledWith = null;
  filePr({
    repo: '/repo', branch: 'feat/x', title: 'My PR', body: 'body text',
    run: (file, args) => { calledWith = { file, args }; return { status: 0, stdout: 'https://github.com/o/r/pull/1\n' }; },
  });
  assert.equal(calledWith.file, 'gh');
  assert.deepEqual(calledWith.args, [
    'pr', 'create', '--head', 'feat/x', '--base', 'main', '--title', 'My PR', '--body', 'body text',
  ]);
});

test('filePr honors a custom base branch', () => {
  let calledWith = null;
  filePr({
    repo: '/repo', branch: 'feat/x', base: 'develop', title: 'My PR', body: 'body text',
    run: (file, args) => { calledWith = { file, args }; return { status: 0, stdout: 'https://github.com/o/r/pull/1\n' }; },
  });
  assert.ok(calledWith.args.includes('develop'));
});

test('prBody names the run, the gates run and skipped, and the spend', () => {
  const body = prBody({
    runId: 'nightly-20260816',
    items: [{ id: 'a', title: 'Fix the thing' }],
    gateResults: [
      { gateName: 'tests', status: 'pass' },
      { gateName: 'cross-model-critic', status: 'skipped' },
    ],
    spend: { usd: 1.5, tokens: 4000 },
  });
  assert.match(body, /nightly-20260816/);
  assert.match(body, /tests/);
  assert.match(body, /cross-model-critic/);
  assert.match(body, /skipped/i);
  assert.match(body, /1\.5/);
});

test('prBody degrades to a minimal body with no input', () => {
  assert.doesNotThrow(() => prBody({}));
});
