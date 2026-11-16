import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normPath } from '../lib/orchestration/path-norm.js';

test('normPath folds separators, strips trailing slashes and lowercases by default', () => {
  assert.equal(normPath('D:\\Repo\\Sub\\\\'), 'd:/repo/sub');
  assert.equal(normPath('/Home/User/'), '/home/user');
});

test('normPath keeps case when asked', () => {
  assert.equal(normPath('D:\\Repo\\Sub\\', { lower: false }), 'D:/Repo/Sub');
});

test('normPath leaves a UNC leading double slash alone unless collapse is on', () => {
  assert.equal(normPath('\\\\host\\share\\x'), '//host/share/x');
  assert.equal(normPath('\\\\host\\share\\x', { collapse: true }), '/host/share/x');
  assert.equal(normPath('a//b///c', { collapse: true }), 'a/b/c');
});

test('normPath maps absent input to the empty string', () => {
  assert.equal(normPath(null), '');
  assert.equal(normPath(undefined), '');
  assert.equal(normPath(''), '');
});
