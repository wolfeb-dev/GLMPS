// server/test/index-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../lib/index-store.js';
import { extractClaudeEvents } from '../lib/observability/extract-claude.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function tmpIndex() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d);
  return path.join(d, 'index.json');
}

test('upsert merges and persists across reload', () => {
  const file = tmpIndex();
  const s1 = new IndexStore(file);
  s1.upsert('a', { tool: 'claude-code', cwd: 'D:\\', startTs: 1 });
  s1.upsert('a', { title: 'fix the bug', skillsUsed: ['x'] });
  s1.flush();
  const s2 = new IndexStore(file);
  const rec = s2.get('a');
  assert.equal(rec.cwd, 'D:\\');
  assert.equal(rec.title, 'fix the bug');
  assert.deepEqual(rec.skillsUsed, ['x']);
});

test('applyEvents accumulates skill names and titles from events', () => {
  const s = new IndexStore(tmpIndex());
  s.upsert('b', { tool: 'claude-code' });
  s.applyEvents('b', [
    { kind: 'skill', label: 'superpowers:tdd', lane: 'context', ts: 1 },
    { kind: 'skill', label: 'superpowers:tdd', lane: 'context', ts: 2 },
    { kind: 'command', label: 'git status', lane: 'feed', ts: 3 },
  ]);
  assert.deepEqual(s.get('b').skillsUsed, ['superpowers:tdd']);
  assert.equal(s.get('b').eventCount, 3);
});

test('applyEvents sets title from AG user-input marker once', () => {
  const s = new IndexStore(tmpIndex());
  s.applyEvents('c', [
    { kind: 'tool', label: 'User: do the thing', lane: 'feed', ts: 1 },
    { kind: 'tool', label: 'User: second message', lane: 'feed', ts: 2 },
  ]);
  assert.equal(s.get('c').title, 'do the thing');
});

test('list returns records sorted by lastTs desc with filters', () => {
  const s = new IndexStore(tmpIndex());
  s.upsert('a', { tool: 'claude-code', cwd: 'D:\\x', lastTs: 10 });
  s.upsert('b', { tool: 'antigravity', cwd: 'D:\\y', lastTs: 20 });
  assert.deepEqual(s.list({}).map(r => r.id), ['b', 'a']);
  assert.deepEqual(s.list({ tool: 'claude-code' }).map(r => r.id), ['a']);
  assert.deepEqual(s.list({ cwd: 'D:\\y' }).map(r => r.id), ['b']);
});

test('corrupt index file starts empty instead of throwing', () => {
  const file = tmpIndex();
  fs.writeFileSync(file, '{not json');
  const s = new IndexStore(file);
  assert.deepEqual(s.list({}), []);
});

test('applyEvents accumulates agentsUsed per name and model', () => {
  const s = new IndexStore(tmpIndex());
  s.applyEvents('s1', [
    { kind: 'agent', agent: 'web-researcher', model: 'sonnet', ts: 10 },
    { kind: 'agent', agent: 'web-researcher', model: 'sonnet', ts: 20 },
    { kind: 'agent', agent: 'web-researcher', model: 'haiku',  ts: 30 },
  ]);
  const rec = s.get('s1');
  assert.equal(rec.agentsUsed.length, 2);
  const sonnet = rec.agentsUsed.find(a => a.model === 'sonnet');
  assert.equal(sonnet.count, 2);
  assert.equal(sonnet.lastTs, 20);
});

test('agent events without an agent name are ignored', () => {
  const s = new IndexStore(tmpIndex());
  s.applyEvents('s1', [{ kind: 'agent', agent: null, model: null, ts: 10 }]);
  assert.deepEqual(s.get('s1').agentsUsed, []);
});

test('a record persisted before agentsUsed existed is upgraded in place', () => {
  const file = tmpIndex();
  fs.writeFileSync(file, JSON.stringify([{ id: 's1', skillsUsed: [], eventCount: 3 }]));
  const s = new IndexStore(file);
  s.applyEvents('s1', [{ kind: 'agent', agent: 'ui-designer', model: 'sonnet', ts: 5 }]);
  assert.equal(s.get('s1').agentsUsed[0].name, 'ui-designer');
});

// Every agentsUsed test above hand-writes a NUMERIC `ts`, which no real
// transcript ever produces: extract-claude.js sets `ts = obj.timestamp` and a
// Claude Code transcript carries that as an ISO-8601 STRING. The old counter
// did `(e.ts ?? 0) > row.lastTs`, a string-vs-number relational compare that
// coerces to NaN and is ALWAYS false, so against real data every agentsUsed row
// kept lastTs 0 - /api/agents reported lastUsed 0 for every agent and the
// Capability Registry rendered every row as 1970 + stale. Feeding the REAL
// extractor is the only thing that catches it, so these tests do exactly that
// rather than trusting a fixture that agrees with the code.
function assistantLine(timestamp, toolUses) {
  return JSON.stringify({
    type: 'assistant', sessionId: 's-real', timestamp,
    message: { role: 'assistant', content: toolUses.map(t => ({ type: 'tool_use', ...t })) },
  });
}
const taskUse = (subagent_type, model) => ({ id: 't1', name: 'Task', input: { subagent_type, description: 'do the thing', model } });

test('agentsUsed lastTs is a finite epoch when the events come from the REAL extractor (ISO ts)', () => {
  const ISO = '2026-06-05T10:00:00.000Z';
  const events = extractClaudeEvents(assistantLine(ISO, [taskUse('web-researcher', 'sonnet')]), 's-real');
  assert.equal(typeof events[0].ts, 'string', 'a real transcript ts is an ISO string, not a number');

  const s = new IndexStore(tmpIndex());
  s.applyEvents('s-real', events);
  const row = s.get('s-real').agentsUsed[0];
  assert.equal(row.name, 'web-researcher');
  assert.ok(Number.isFinite(row.lastTs), `lastTs must be a finite epoch, got ${JSON.stringify(row.lastTs)}`);
  assert.equal(row.lastTs, Date.parse(ISO));
});

test('a later ISO ts advances lastTs and an earlier one does not roll it back', () => {
  const EARLY = '2026-06-05T10:00:00.000Z';
  const LATE = '2026-06-05T12:00:00.000Z';
  const s = new IndexStore(tmpIndex());
  s.applyEvents('s-real', extractClaudeEvents(assistantLine(EARLY, [taskUse('ui-designer', 'sonnet')]), 's-real'));
  s.applyEvents('s-real', extractClaudeEvents(assistantLine(LATE, [taskUse('ui-designer', 'sonnet')]), 's-real'));
  s.applyEvents('s-real', extractClaudeEvents(assistantLine(EARLY, [taskUse('ui-designer', 'sonnet')]), 's-real'));
  const row = s.get('s-real').agentsUsed[0];
  assert.equal(row.count, 3);
  assert.equal(row.lastTs, Date.parse(LATE));
});

test('an unparseable ts leaves lastTs at 0 rather than writing NaN into the index', () => {
  const s = new IndexStore(tmpIndex());
  s.applyEvents('s1', [{ kind: 'agent', agent: 'x', model: null, ts: 'not-a-date' }]);
  const row = s.get('s1').agentsUsed[0];
  assert.equal(row.count, 1);
  assert.equal(row.lastTs, 0);
});

// Real Claude Code transcripts carry `timestamp` as an ISO-8601 STRING and
// extract-claude.js passes it through as e.ts. applyEvents assigned it raw,
// which made `list({sinceTs})`'s `(r.lastTs ?? 0) >= sinceTs` a string-vs-number
// compare that coerces to NaN and is ALWAYS false, and made the sort
// comparator NaN too.
//
// Note on severity, because the ticket overstates it: in the shipped poll this
// is currently MASKED, because server.js follows applyEvents with an
// index.upsert({ lastTs: desc.mtimeMs }) carrying a real number, and the live
// index.json contains no string lastTs at all. It is a landmine rather than an
// active outage: any caller that applies events without that trailing upsert
// gets the broken shape. Normalising at the write chokepoints removes it.

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-idx-ts-')), 'index.json'); }

test('applyEvents normalises an ISO ts to epoch ms', () => {
  const s = new IndexStore(tmpFile());
  s.applyEvents('s1', [{ kind: 'tool', label: 'x', ts: '2026-08-21T12:00:00.000Z' }]);
  assert.equal(typeof s.get('s1').lastTs, 'number');
  assert.equal(s.get('s1').lastTs, Date.parse('2026-08-21T12:00:00.000Z'));
});

test('sinceTs filtering keeps the freshest sessions instead of dropping them', () => {
  const s = new IndexStore(tmpFile());
  const fresh = '2026-08-21T12:00:00.000Z';
  const old = '2026-08-01T12:00:00.000Z';
  s.applyEvents('fresh', [{ kind: 'tool', label: 'a', ts: fresh }]);
  s.applyEvents('old', [{ kind: 'tool', label: 'b', ts: old }]);
  const got = s.list({ sinceTs: Date.parse('2026-08-15T00:00:00.000Z') }).map(r => r.id);
  assert.deepEqual(got, ['fresh'], 'the ISO-stamped session must survive the filter');
});

test('list sorts newest-first across ISO-sourced timestamps', () => {
  const s = new IndexStore(tmpFile());
  s.applyEvents('a', [{ kind: 'tool', label: 'a', ts: '2026-08-01T00:00:00.000Z' }]);
  s.applyEvents('c', [{ kind: 'tool', label: 'c', ts: '2026-08-21T00:00:00.000Z' }]);
  s.applyEvents('b', [{ kind: 'tool', label: 'b', ts: '2026-08-10T00:00:00.000Z' }]);
  assert.deepEqual(s.list({}).map(r => r.id), ['c', 'b', 'a']);
});

test('upsert normalises a string lastTs too, so every writer goes through one rule', () => {
  const s = new IndexStore(tmpFile());
  s.upsert('s1', { lastTs: '2026-08-21T12:00:00.000Z' });
  assert.equal(s.get('s1').lastTs, Date.parse('2026-08-21T12:00:00.000Z'));
  s.upsert('s2', { lastTs: 1234 });
  assert.equal(s.get('s2').lastTs, 1234, 'a number passes through untouched');
});

test('a legacy index.json holding string lastTs is repaired on load', () => {
  // The fix must repair state already on disk, not only new writes.
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([
    { id: 'legacy', lastTs: '2026-08-21T12:00:00.000Z', skillsUsed: [], agentsUsed: [], eventCount: 1 },
  ]));
  const s = new IndexStore(file);
  assert.equal(s.get('legacy').lastTs, Date.parse('2026-08-21T12:00:00.000Z'));
});

test('an unparseable ts leaves the previous value rather than writing NaN', () => {
  const s = new IndexStore(tmpFile());
  s.applyEvents('s1', [{ kind: 'tool', label: 'a', ts: '2026-08-21T12:00:00.000Z' }]);
  const good = s.get('s1').lastTs;
  s.applyEvents('s1', [{ kind: 'tool', label: 'b', ts: 'not a date' }]);
  assert.equal(s.get('s1').lastTs, good);
});

// Card glmps-2-0-runtime-133: pre-132 OpenCode rows carried a local path in the id.
test('IndexStore: a legacy path-bearing id loads as its public id, the newer of a colliding pair wins, and the file is rewritten', () => {
  const f = tmpIndex();
  const legacy = (lastTs) => ({ id: 'opencode:p:s|@dir@|/home/u/storage/message/s', tool: 'opencode', lastTs, title: 'old' });
  const fresh = (lastTs) => ({ id: 'opencode:p:s', tool: 'opencode', lastTs, title: 'new' });
  for (const [rows, title] of [[[legacy(1)], 'old'], [[legacy(5), fresh(9)], 'new'], [[fresh(9), legacy(5)], 'new'], [[fresh(1), legacy(5)], 'old']]) {
    fs.writeFileSync(f, JSON.stringify(rows));
    const s = new IndexStore(f);
    assert.deepEqual(s.list().map((r) => [r.id, r.title]), [['opencode:p:s', title]]);
    s.flush();
    assert.ok(!fs.readFileSync(f, 'utf-8').includes('@dir@'), 'migration persists');
  }
});
