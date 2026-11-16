// server/test/personality-model.test.js
// The Personality page's filter logic (web/personality/model.js), a pure module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterGroups, DEFAULT_FILTERS, relTime, fmtSize } from '../../web/personality/model.js';

const card = (id, over = {}) => ({ id, name: id, controls: '', readBy: ['claude'], shapes: ['personality'], text: null, ...over });
const data = {
  groups: [
    { id: 'machine', cards: [card('a', { text: 'Reporting altitude rules' }), card('b', { readBy: ['gemini'], shapes: ['guardrail'] })] },
    { id: 'project', cards: [card('c', { readBy: ['claude', 'gemini'], shapes: ['memory'], rows: [{ name: 'chair', description: 'owns the question' }] })] },
    { id: 'runtime', cards: [] },
  ],
};
const ids = (r) => r.map((g) => g.cards.map((c) => c.id));

test('no filters keeps every card', () => {
  assert.deepEqual(ids(filterGroups(data, DEFAULT_FILTERS)), [['a', 'b'], ['c'], []]);
});

test('the AI filter keeps cards read by that AI', () => {
  assert.deepEqual(ids(filterGroups(data, { ...DEFAULT_FILTERS, ai: 'gemini' })), [['b'], ['c'], []]);
  assert.deepEqual(ids(filterGroups(data, { ...DEFAULT_FILTERS, ai: 'claude' })), [['a'], ['c'], []]);
});

test('the shape filter keeps cards that shape that thing', () => {
  assert.deepEqual(ids(filterGroups(data, { ...DEFAULT_FILTERS, shape: 'guardrail' })), [['b'], [], []]);
});

test('search matches names, contents and collection rows, case-insensitively', () => {
  assert.deepEqual(ids(filterGroups(data, { ...DEFAULT_FILTERS, q: 'ALTITUDE' })), [['a'], [], []]);
  assert.deepEqual(ids(filterGroups(data, { ...DEFAULT_FILTERS, q: 'owns the' })), [[], ['c'], []]);
});

test('each group reports whether it has cards left, so the strip can dim its icon', () => {
  const r = filterGroups(data, { ...DEFAULT_FILTERS, shape: 'guardrail' });
  assert.deepEqual(r.map((g) => g.empty), [false, true, true]);
});

test('size and age read at a glance', () => {
  assert.equal(fmtSize(15000), '14.6 KB');
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(null), '-');
  assert.equal(relTime(1_000_000, 1_000_000 + 30_000), 'just now');
  assert.equal(relTime(1_000_000, 1_000_000 + 3 * 3600_000), '3 h ago');
  assert.equal(relTime(1_000_000, 1_000_000 + 5 * 86400_000), '5 d ago');
  assert.equal(relTime(null, 1), '-');
});

test('search matches the names of the loops and graphs a card is used by', () => {
  const d = { groups: [{ id: 'runtime', cards: [card('p', { usedBy: ['launch-queue'], usedByGraphs: ['Machine graph'] }), card('q', { usedBy: [] })] }] };
  assert.deepEqual(filterGroups(d, { ...DEFAULT_FILTERS, q: 'launch-queue' })[0].cards.map((c) => c.id), ['p']);
  assert.deepEqual(filterGroups(d, { ...DEFAULT_FILTERS, q: 'machine graph' })[0].cards.map((c) => c.id), ['p']);
});
