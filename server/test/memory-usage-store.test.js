import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvents } from '../lib/observability/event-log.js';
import { readUsage, refreshUsage, usageFile } from '../lib/evaluation/memory-usage-store.js';

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-memusage-'));
}

const memEvent = (file, op, sessionId, ts) => ({
  kind: 'memory',
  op,
  tool: op === 'read' ? 'Read' : 'Write',
  lane: 'context',
  path: `C:\\Users\\x\\.claude\\projects\\p\\memory\\${file}`,
  sessionId,
  ts,
});

test('ingests reads and writes per fact, keyed by basename', () => {
  const dir = tmpState();
  appendEvents(dir, [
    memEvent('a.md', 'read', 's1', '2026-07-10T00:00:00.000Z'),
    memEvent('a.md', 'read', 's2', '2026-07-11T00:00:00.000Z'),
    memEvent('a.md', 'write', 's2', '2026-07-11T00:01:00.000Z'),
    memEvent('b.md', 'read', 's1', '2026-07-10T00:00:30.000Z'),
  ]);
  const usage = refreshUsage(dir);
  assert.equal(usage.facts['a.md'].reads, 2);
  assert.equal(usage.facts['a.md'].writes, 1);
  assert.equal(usage.facts['b.md'].reads, 1);
  assert.equal(usage.facts['b.md'].writes, 0);
});

test('re-running ingests nothing (watermark makes it idempotent)', () => {
  const dir = tmpState();
  appendEvents(dir, [memEvent('a.md', 'read', 's1', '2026-07-10T00:00:00.000Z')]);
  const first = refreshUsage(dir);
  const second = refreshUsage(dir);
  assert.equal(first.facts['a.md'].reads, 1);
  assert.equal(second.facts['a.md'].reads, 1, 'double counting would inflate every count');
});

test('a later ingest adds only the new events', () => {
  const dir = tmpState();
  appendEvents(dir, [memEvent('a.md', 'read', 's1', '2026-07-10T00:00:00.000Z')]);
  refreshUsage(dir);
  appendEvents(dir, [memEvent('a.md', 'read', 's2', '2026-07-12T00:00:00.000Z')]);
  assert.equal(refreshUsage(dir).facts['a.md'].reads, 2);
});

// The whole point of a separate aggregate: the event log is append-only and
// will eventually rotate. Counts must survive that.
test('counts survive the event log being rotated away', () => {
  const dir = tmpState();
  appendEvents(dir, [
    memEvent('a.md', 'read', 's1', '2026-07-10T00:00:00.000Z'),
    memEvent('a.md', 'read', 's2', '2026-07-11T00:00:00.000Z'),
  ]);
  refreshUsage(dir);
  fs.writeFileSync(path.join(dir, 'events', 'log.ndjson'), '');
  const after = refreshUsage(dir);
  assert.equal(after.facts['a.md'].reads, 2, 'rotation must not reset accumulated evidence');
});

test('exposureSessions counts only sessions observed at or after firstSeen', () => {
  const dir = tmpState();
  appendEvents(dir, [
    // s1 and s2 touch memory before c.md ever appears
    memEvent('a.md', 'read', 's1', '2026-07-10T00:00:00.000Z'),
    memEvent('a.md', 'read', 's2', '2026-07-11T00:00:00.000Z'),
    // c.md is created later, then one more session runs
    memEvent('c.md', 'write', 's3', '2026-07-12T00:00:00.000Z'),
    memEvent('a.md', 'read', 's4', '2026-07-13T00:00:00.000Z'),
  ]);
  const usage = refreshUsage(dir);
  assert.equal(usage.facts['a.md'].exposureSessions, 4, 'present the whole time');
  assert.equal(usage.facts['c.md'].exposureSessions, 2, 'only s3 and s4 postdate it');
});

test('a brand-new fact has minimal exposure, protecting it from eviction', () => {
  const dir = tmpState();
  appendEvents(dir, [
    memEvent('old.md', 'read', 's1', '2026-07-01T00:00:00.000Z'),
    memEvent('old.md', 'read', 's2', '2026-07-05T00:00:00.000Z'),
    memEvent('old.md', 'read', 's3', '2026-07-09T00:00:00.000Z'),
    memEvent('new.md', 'write', 's4', '2026-07-23T00:00:00.000Z'),
  ]);
  const usage = refreshUsage(dir);
  assert.ok(usage.facts['new.md'].exposureSessions < usage.facts['old.md'].exposureSessions);
});

test('records firstSeen and lastRead', () => {
  const dir = tmpState();
  appendEvents(dir, [
    memEvent('a.md', 'write', 's1', '2026-07-10T00:00:00.000Z'),
    memEvent('a.md', 'read', 's2', '2026-07-14T00:00:00.000Z'),
  ]);
  const f = refreshUsage(dir).facts['a.md'];
  assert.equal(f.firstSeen, Date.parse('2026-07-10T00:00:00.000Z'));
  assert.equal(f.lastRead, Date.parse('2026-07-14T00:00:00.000Z'));
});

test('non-memory events are ignored', () => {
  const dir = tmpState();
  appendEvents(dir, [
    { kind: 'file-edit', tool: 'Edit', path: 'D:\\repo\\src\\a.js', sessionId: 's1', ts: '2026-07-10T00:00:00.000Z' },
    { kind: 'tool', tool: 'Bash', sessionId: 's1', ts: '2026-07-10T00:00:01.000Z' },
  ]);
  assert.deepEqual(refreshUsage(dir).facts, {});
});

test('MEMORY.md itself is excluded (it is the index, not a fact)', () => {
  const dir = tmpState();
  appendEvents(dir, [
    memEvent('MEMORY.md', 'read', 's1', '2026-07-10T00:00:00.000Z'),
    memEvent('a.md', 'read', 's1', '2026-07-10T00:00:01.000Z'),
  ]);
  const usage = refreshUsage(dir);
  assert.ok(!usage.facts['MEMORY.md']);
  assert.ok(usage.facts['a.md']);
});

test('events without a parseable ts are skipped rather than poisoning the watermark', () => {
  const dir = tmpState();
  appendEvents(dir, [
    { kind: 'memory', op: 'read', path: 'x\\memory\\a.md', sessionId: 's1', ts: 'not-a-date' },
    memEvent('b.md', 'read', 's1', '2026-07-10T00:00:00.000Z'),
  ]);
  const usage = refreshUsage(dir);
  assert.ok(!usage.facts['a.md']);
  assert.equal(usage.facts['b.md'].reads, 1);
});

test('readUsage on a fresh state dir returns an empty aggregate, not a throw', () => {
  const dir = tmpState();
  const usage = readUsage(dir);
  assert.deepEqual(usage.facts, {});
  assert.equal(usage.watermark, 0);
});

test('a corrupt usage file fails open to an empty aggregate', () => {
  const dir = tmpState();
  fs.mkdirSync(path.dirname(usageFile(dir)), { recursive: true });
  fs.writeFileSync(usageFile(dir), '{ not json');
  assert.deepEqual(readUsage(dir).facts, {});
});

test('POSIX-style paths are handled as well as Windows ones', () => {
  const dir = tmpState();
  appendEvents(dir, [
    { kind: 'memory', op: 'read', path: '/home/x/.claude/projects/p/memory/a.md', sessionId: 's1', ts: '2026-07-10T00:00:00.000Z' },
  ]);
  assert.equal(refreshUsage(dir).facts['a.md'].reads, 1);
});
