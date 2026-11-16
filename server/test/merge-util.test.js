import { test } from 'node:test';
import assert from 'node:assert/strict';
import { short, errText } from '../lib/orchestration/merge-util.js';

test('short keeps the first seven characters of a sha and tolerates absence', () => {
  assert.equal(short('0123456789abcdef'), '0123456');
  assert.equal(short(null), '');
  assert.equal(short(undefined), '');
});

test('errText prefers the message, then the value, then a placeholder', () => {
  assert.equal(errText(new Error('boom')), 'boom');
  assert.equal(errText('plain'), 'plain');
  assert.equal(errText(null), 'unknown error');
});
