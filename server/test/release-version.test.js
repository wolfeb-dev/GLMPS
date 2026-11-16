import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpKind, requestRelease } from '../lib/orchestration/release-version.js';

test('a feature card raises the minor number, every other class the patch number', () => {
  assert.equal(bumpKind('feature'), 'minor');
  for (const c of ['debug', 'docs', 'ops', 'refactor', 'ui', 'other', undefined]) assert.equal(bumpKind(c), 'patch');
});

const mr = { repo: 'wolfeb-dev/glmps-2.0', base: 'main', number: 212, prUrl: 'https://github.com/wolfeb-dev/glmps-2.0/pull/212' };
const card = { id: 'glmps-2-0-214', title: ', can we implement version numbers? raw chat text', summary: 'Delivered.' };

function fakeRun(reply) {
  const ops = [];
  return { ops, run: async (op) => { ops.push(op); return typeof reply === 'function' ? reply(op) : reply; } };
}

test('requestRelease sends the desktop app values only: checkout, repo, base, PR, card id, bump and summary, never the card title', async () => {
  const f = fakeRun({ status: 0, stdout: JSON.stringify({ ok: true, version: '2.1.0', sha: 'c'.repeat(40) }), stderr: '' });
  const r = await requestRelease({ run: f.run, repoPath: 'D:\\glmps-2.0', mr, card, taskClass: 'feature' });
  assert.deepEqual(r, { ok: true, version: '2.1.0', sha: 'c'.repeat(40) });
  assert.deepEqual(f.ops, [{ kind: 'release', cwd: 'D:\\glmps-2.0', repo: mr.repo, base: 'main', number: 212, cardId: card.id, bump: 'minor', summary: 'Delivered.' }]);
  assert.ok(!JSON.stringify(f.ops).includes('raw chat'), 'the card title never leaves the kernel');
});

test('requestRelease passes a skipped or failed result through and names an unreadable one', async () => {
  const skip = await requestRelease({ run: fakeRun({ status: 0, stdout: '{"ok":true,"skipped":true,"reason":"package name x is not glmps"}' }).run, repoPath: 'D:\\r', mr, card, taskClass: 'docs' });
  assert.deepEqual(skip, { ok: true, skipped: true, reason: 'package name x is not glmps' });
  const fail = await requestRelease({ run: fakeRun({ status: 0, stdout: '{"ok":false,"reason":"push rejected"}' }).run, repoPath: 'D:\\r', mr, card, taskClass: 'docs' });
  assert.deepEqual(fail, { ok: false, reason: 'push rejected' });
  const junk = await requestRelease({ run: fakeRun({ status: 1, stdout: 'not json', stderr: 'boom' }).run, repoPath: 'D:\\r', mr, card, taskClass: 'docs' });
  assert.equal(junk.ok, false);
  assert.match(junk.reason, /desktop app.*boom/);
});

test('a refused or unclaimed call is a named not-ok result, never a throw', async () => {
  const refused = await requestRelease({ run: async () => { throw Object.assign(new Error('refused by shell: release base must be a safe git ref'), { code: 'REFUSED' }); }, repoPath: 'D:\\r', mr, card, taskClass: 'docs' });
  assert.deepEqual(refused, { ok: false, reason: 'refused by shell: release base must be a safe git ref' });
  const bad = await requestRelease({ run: async () => ({ status: 0, stdout: '{}' }), repoPath: 'D:\\r', mr: { ...mr, number: undefined }, card, taskClass: 'docs' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /PR number/);
});
