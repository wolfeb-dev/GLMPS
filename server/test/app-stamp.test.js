// App rebuild stamp (card glmps-2-0-170): stale means the app folder's tree id
// differs from the one last built, or no stamp exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAppTreeId, writeAppStamp, readAppStamp, appIsStale } from '../lib/kernel/app-stamp.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'app-stamp-'));

test('no stamp file means stale', () => {
  const d = tmp();
  assert.equal(readAppStamp(d), null);
  assert.equal(appIsStale(d, 'tree1'), true);
});

test('a written stamp makes the same tree fresh and a different tree stale', () => {
  const d = tmp();
  writeAppStamp(d, 'tree1');
  assert.equal(readAppStamp(d).treeId, 'tree1');
  assert.equal(appIsStale(d, 'tree1'), false);
  assert.equal(appIsStale(d, 'tree2'), true);
});

test('a corrupt stamp counts as absent', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'app-build-stamp.json'), '{nope');
  assert.equal(appIsStale(d, 'tree1'), true);
});

test('an unknown current tree id is stale so a rebuild is not silently skipped', () => {
  const d = tmp();
  writeAppStamp(d, 'tree1');
  assert.equal(appIsStale(d, null), true);
});

test('readAppTreeId asks git for HEAD:apps/shell in the repo dir', async () => {
  const calls = [];
  const impl = (file, args, opts, cb) => { calls.push({ file, args, cwd: opts.cwd }); cb(null, 'abc123def\n', ''); };
  assert.equal(await readAppTreeId('D:/repo', { execFileImpl: impl }), 'abc123def');
  assert.deepEqual(calls, [{ file: 'git', args: ['rev-parse', 'HEAD:apps/shell'], cwd: 'D:/repo' }]);
  const bad = (file, args, opts, cb) => cb(new Error('x'), '', '');
  assert.equal(await readAppTreeId('D:/repo', { execFileImpl: bad }), null);
});
