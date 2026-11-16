// server/test/backlog-sessionid.test.js
// Follow-up attribution: addItem now captures the filing session's id so the
// stage board can count follow-ups per session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addItem } from '../lib/orchestration/backlog-store.js';

const empty = () => ({ items: [], seq: 0, seqs: {} });

test('addItem captures a provided sessionId', () => {
  const { item } = addItem(empty(), { project: 'p', title: 't', prompt: 'x', sessionId: 'sess-123' });
  assert.equal(item.sessionId, 'sess-123');
});

test('sessionId defaults to null when absent', () => {
  const { item } = addItem(empty(), { project: 'p', title: 't' });
  assert.equal(item.sessionId, null);
});

test('sessionId "unknown" and blank normalize to null', () => {
  assert.equal(addItem(empty(), { project: 'p', title: 't1', sessionId: 'unknown' }).item.sessionId, null);
  assert.equal(addItem(empty(), { project: 'p', title: 't2', sessionId: '   ' }).item.sessionId, null);
  assert.equal(addItem(empty(), { project: 'p', title: 't3', sessionId: 42 }).item.sessionId, null);
});

test('sessionId is trimmed', () => {
  const { item } = addItem(empty(), { project: 'p', title: 't', sessionId: '  sess-x  ' });
  assert.equal(item.sessionId, 'sess-x');
});
