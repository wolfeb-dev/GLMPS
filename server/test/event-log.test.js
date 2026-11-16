import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, appendEvents, readEvents, eventLogFile } from '../lib/observability/event-log.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-eventlog-')); }

test('appendEvents writes a whole batch in one call and reads all back', () => {
  const d = tmp();
  const batch = [
    { kind: 'tool', lane: 'feed', label: 'a', ts: 1, sessionId: 's1' },
    { kind: 'command', lane: 'feed', label: 'b', ts: 2, sessionId: 's1' },
    { kind: 'skill', lane: 'feed', label: 'c', ts: 3, sessionId: 's2' },
  ];
  appendEvents(d, batch);
  const rows = readEvents(d);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.label), ['a', 'b', 'c']);
});

test('appendEvents on an empty batch is a no-op (no file created)', () => {
  const d = tmp();
  appendEvents(d, []);
  assert.equal(fs.existsSync(eventLogFile(d)), false);
  assert.deepEqual(readEvents(d), []);
});

test('append then read round-trips an event', () => {
  const d = tmp();
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'Read foo.js', tool: 'Read', path: 'foo.js', ts: 100, sessionId: 's1' });
  const rows = readEvents(d);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 's1');
  assert.equal(rows[0].label, 'Read foo.js');
});

test('readEvents filters by sessionId', () => {
  const d = tmp();
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'a', ts: 1, sessionId: 's1' });
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'b', ts: 2, sessionId: 's2' });
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'c', ts: 3, sessionId: 's1' });
  const rows = readEvents(d, { sessionId: 's1' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.sessionId === 's1'));
});

test('readEvents filters by since (ts)', () => {
  const d = tmp();
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'a', ts: 100, sessionId: 's1' });
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'b', ts: 200, sessionId: 's1' });
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'c', ts: 300, sessionId: 's1' });
  const rows = readEvents(d, { since: 150 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.ts), [200, 300]);
});

test('readEvents combines sessionId and since filters', () => {
  const d = tmp();
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'a', ts: 100, sessionId: 's1' });
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'b', ts: 200, sessionId: 's2' });
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'c', ts: 300, sessionId: 's1' });
  const rows = readEvents(d, { sessionId: 's1', since: 150 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'c');
});

test('readEvents since filter also works with ISO-string ts (real event shape)', () => {
  const d = tmp();
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'a', ts: '2026-07-09T21:00:00.000Z', sessionId: 's1' });
  appendEvent(d, { kind: 'tool', lane: 'feed', label: 'b', ts: '2026-07-09T21:00:10.000Z', sessionId: 's1' });
  const rows = readEvents(d, { since: '2026-07-09T21:00:05.000Z' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'b');
});

test('missing dir reads empty; malformed lines skipped', () => {
  const d = tmp();
  assert.deepEqual(readEvents(d), []);
  fs.mkdirSync(path.join(d, 'events'), { recursive: true });
  fs.writeFileSync(eventLogFile(d), '{bad\n{"kind":"tool","sessionId":"ok","ts":1}\n');
  assert.equal(readEvents(d).length, 1);
});

test('appendEvent fails open when the write throws', () => {
  const d = tmp();
  // Point stateDir at a path where mkdirSync/appendFileSync will fail: a file, not a dir.
  const bogus = path.join(d, 'not-a-dir');
  fs.writeFileSync(bogus, 'x');
  assert.doesNotThrow(() => appendEvent(bogus, { kind: 'tool', sessionId: 's1', ts: 1 }));
});

test('events survive an in-memory cache being dropped (durability)', () => {
  const d = tmp();
  let cache = new Map();
  cache.set('s1', [{ kind: 'tool', label: 'a', ts: 1, sessionId: 's1' }]);
  appendEvent(d, { kind: 'tool', label: 'a', ts: 1, sessionId: 's1' });
  appendEvent(d, { kind: 'tool', label: 'b', ts: 2, sessionId: 's1' });
  // Simulate a restart: drop the in-memory cache entirely.
  cache = new Map();
  assert.equal(cache.size, 0);
  const rows = readEvents(d, { sessionId: 's1' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.label), ['a', 'b']);
});

// glmps-193: readEvents re-parsed the whole log (53 MB, 175k rows, ~250 ms) on
// every call, twice per GET /api/alerts. It now parses only appended bytes.
test('readEvents reuses rows already parsed and picks up appended ones', () => {
  const d = tmp();
  appendEvents(d, [{ kind: 'tool', label: 'a', ts: 1, sessionId: 's1' }]);
  const first = readEvents(d);
  appendEvents(d, [{ kind: 'tool', label: 'b', ts: 2, sessionId: 's1' }]);
  const second = readEvents(d);
  assert.deepEqual(second.map(r => r.label), ['a', 'b']);
  assert.equal(second[0], first[0], 'the unchanged prefix is not re-parsed');
});

test('readEvents holds back a partial trailing line until it is completed', () => {
  const d = tmp();
  appendEvents(d, [{ kind: 'tool', label: 'a', ts: 1, sessionId: 's1' }]);
  fs.appendFileSync(eventLogFile(d), '{"kind":"tool","label":"b"');
  assert.deepEqual(readEvents(d).map(r => r.label), ['a']);
  fs.appendFileSync(eventLogFile(d), ',"ts":2}\n');
  assert.deepEqual(readEvents(d).map(r => r.label), ['a', 'b']);
});

test('readEvents re-reads a log that was rewritten or truncated', () => {
  const d = tmp();
  appendEvents(d, [{ kind: 'tool', label: 'a', ts: 1 }, { kind: 'tool', label: 'b', ts: 2 }]);
  readEvents(d);
  fs.writeFileSync(eventLogFile(d), JSON.stringify({ kind: 'tool', label: 'x', ts: 3 }) + '\n');
  assert.deepEqual(readEvents(d).map(r => r.label), ['x']);
  const longer = ['p', 'q', 'r'].map((label, i) => JSON.stringify({ kind: 'tool', label, ts: i }) + '\n').join('');
  fs.writeFileSync(eventLogFile(d), longer);
  assert.deepEqual(readEvents(d).map(r => r.label), ['p', 'q', 'r']);
  fs.rmSync(eventLogFile(d));
  assert.deepEqual(readEvents(d), []);
});
