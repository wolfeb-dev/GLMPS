// the pure lookups behind the Fleet bubble's file button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bubbleFile, findWriteForFile } from '../../web/overview/stage-board.js';

test('bubbleFile reads the file out of "editing <file>" and nothing else', () => {
  assert.equal(bubbleFile('editing gate.json'), 'gate.json');
  assert.equal(bubbleFile('editing my notes.md'), 'my notes.md');
  assert.equal(bubbleFile('editing files'), null);
  assert.equal(bubbleFile('running tests'), null);
  assert.equal(bubbleFile(null), null);
  assert.equal(bubbleFile(''), null);
});

const w = (path, text, extra = {}) => ({ op: 'write', path, change: { old: null, new: { text } }, ...extra });

test('findWriteForFile returns the newest write with a change to that file', () => {
  const events = [
    w('D:/p/a/gate.json', 'v1'), w('D:\p\a\other.js', 'x'), w('D:/p/a/gate.json', 'v2'),
    { op: 'read', path: 'D:/p/a/gate.json' },
  ];
  assert.equal(findWriteForFile(events, 'gate.json').change.new.text, 'v2');
});

test('findWriteForFile skips writes without a change and matches whole basenames only', () => {
  const events = [w('D:/p/gate.json', 'old'), { op: 'write', path: 'D:/p/gate.json' }, w('D:/p/mygate.json', 'no')];
  assert.equal(findWriteForFile(events, 'gate.json').change.new.text, 'old');
  assert.equal(findWriteForFile(events, 'nope.json'), null);
  assert.equal(findWriteForFile(undefined, 'gate.json'), null);
  assert.equal(findWriteForFile(events, null), null);
});

test('findWriteForFile falls back to the label when a write has no path', () => {
  assert.equal(findWriteForFile([{ op: 'write', label: 'gate.json', change: { old: null, new: { text: 'z' } } }], 'gate.json').change.new.text, 'z');
});

test('findEditForFile picks the newest tracked-repo edit of that file by that session', async () => {
  const { findEditForFile } = await import('../../web/overview/stage-board.js');
  const edits = [
    { sessionId: 's1', path: 'D:/r/web/app.js', repo: 'r', rel: 'web/app.js', ts: 1 },
    { sessionId: 's1', path: 'D:/r/web/app.js', repo: 'r', rel: 'web/app.js', ts: 5 },
    { sessionId: 's2', path: 'D:/r/web/app.js', repo: 'r', rel: 'web/app.js', ts: 9 },
    { sessionId: 's1', path: 'C:/tmp/app.js', repo: null, rel: null, ts: 10 },
  ];
  assert.equal(findEditForFile(edits, 's1', 'app.js').ts, 5);
  assert.equal(findEditForFile(edits, 's3', 'app.js'), null);
  assert.equal(findEditForFile(null, 's1', 'app.js'), null);
});
