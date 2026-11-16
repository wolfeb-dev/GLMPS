// server/test/adapters-openclaw.test.js
// Tests for the SPECULATIVE openclaw adapter (fixture-based - no live data required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as openclaw from '../lib/adapters/openclaw.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-oclaw-')); tmpDirs.push(d); return d; }

test('openclaw detect: no P.openclawDirs scans nothing (never the real home)', () => {
  assert.deepEqual(openclaw.detect({}), { installed: false, dataDirs: [] });
  assert.deepEqual(openclaw.discover({}), []);
});

test('openclaw detect: installed when the first existing root is present, dataDirs lists all candidates', () => {
  const root = mkTmp();
  const absent = path.join(root, '.openclaw');
  const present = path.join(root, '.clawdbot');
  fs.mkdirSync(present);
  const { installed, dataDirs } = openclaw.detect({ openclawDirs: [absent, present] });
  assert.equal(installed, true);
  assert.deepEqual(dataDirs, [absent, present]);
  assert.equal(openclaw.detect({ openclawDirs: [absent] }).installed, false);
});

test('openclaw discover: agents/<id>/sessions and flat sessions/ -> jsonl-tail descriptors with store labels', () => {
  const root = mkTmp();
  const sessions = path.join(root, 'agents', 'main', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'abc.jsonl'), '{"role":"user","content":"hi"}\n');
  fs.writeFileSync(path.join(sessions, 'sessions.json'), JSON.stringify({ abc: { label: 'Triage inbox' } }));
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.writeFileSync(path.join(root, 'sessions', 'flat.jsonl'), '{}\n');
  const descs = openclaw.discover({ openclawDirs: [root] });
  assert.deepEqual(descs.map(d => d.id).sort(), ['openclaw:main:abc', 'openclaw:main:flat']);
  const abc = descs.find(d => d.id === 'openclaw:main:abc');
  assert.equal(abc.kind, 'jsonl-tail');
  assert.equal(abc.label, 'Triage inbox');
});

test('openclaw extractLine: role=user -> user feed event', () => {
  const line = JSON.stringify({
    role: 'user',
    content: 'Refactor the auth module',
    timestamp: '2026-01-01T00:00:00Z',
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].lane, 'feed');
  assert.equal(events[0].tool, 'user');
  assert.ok(events[0].label.includes('Refactor'));
});

test('openclaw extractLine: type=user -> user feed event', () => {
  const line = JSON.stringify({
    type: 'user',
    content: 'Write a test for this',
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.ok(events[0].label.includes('Write a test'));
});

test('openclaw extractLine: type=message role=user -> user feed event', () => {
  const line = JSON.stringify({
    type: 'message',
    role: 'user',
    text: 'Summarize the diff',
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.ok(events[0].label.includes('Summarize'));
});

test('openclaw extractLine: type=toolCall -> tool event with name', () => {
  const line = JSON.stringify({
    type: 'toolCall',
    name: 'read_file',
    timestamp: null,
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].label, 'read_file');
});

test('openclaw extractLine: tool_use field present -> tool event', () => {
  const line = JSON.stringify({
    tool_use: { name: 'bash' },
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].label, 'bash');
});

test('openclaw extractLine: type=tool_result -> tool event', () => {
  const line = JSON.stringify({
    type: 'tool_result',
    tool: 'bash',
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
});

test('openclaw extractLine: junk line -> no events', () => {
  const line = JSON.stringify({ something_else: true, value: 42 });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});

test('openclaw extractLine: malformed JSON -> no throw, no events', () => {
  assert.doesNotThrow(() => {
    const events = openclaw.extractLine('{bad json}}}', 'sid1');
    assert.equal(events.length, 0);
  });
});

test('openclaw extractLine: user with array content -> concatenates text', () => {
  const line = JSON.stringify({
    role: 'user',
    content: [{ text: 'Hello' }, { text: ' world' }],
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.ok(events[0].label.includes('Hello'));
});

test('openclaw extractLine: user with no text -> no event', () => {
  const line = JSON.stringify({ role: 'user', content: '' });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});
