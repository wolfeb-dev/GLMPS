// server/lib/observability/session-touch.js: the per-file and commit rollup the
// session page's Touching band reads, computed over the whole log so a paged
// feed does not starve it (card glmps-2-0-runtime-60).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTouch } from '../lib/observability/session-touch.js';

const ev = (o) => ({ lane: 'feed', sessionId: 's1', ...o });

test('files fold reads and writes per path, writes first, latest diff kept', () => {
  const t = sessionTouch([
    ev({ kind: 'file-edit', op: 'read', path: 'D:/r/a.js', ts: 1 }),
    ev({ kind: 'file-edit', op: 'write', path: 'D:/r/b.js', ts: 2, add: 3, del: 1, change: { old: 'x', new: 'y' } }),
    ev({ kind: 'file-edit', op: 'write', path: 'D:/r/b.js', ts: 3, add: 2, del: 0, change: { old: 'y', new: 'z' } }),
    ev({ kind: 'memory', op: 'write', path: 'C:/m/mem.md', ts: 4, add: 5, del: 0 }),
    ev({ kind: 'command', tool: 'Bash', ts: 5 }),
  ]);
  assert.deepEqual(t.files.map(f => f.path), ['C:/m/mem.md', 'D:/r/b.js', 'D:/r/a.js']);
  const b = t.files[1];
  assert.equal(b.writes, 2); assert.equal(b.reads, 0);
  assert.equal(b.add, 5); assert.equal(b.del, 1);
  assert.deepEqual(b.change, { old: 'y', new: 'z' });
  assert.equal(b.lastTs, 3);
  assert.equal(b.kind, 'file-edit');
  assert.equal(t.files[2].change, null);
  assert.deepEqual(t.counts, { written: 2, read: 1, commits: 0 });
});

test('feed-lane edits with no op count as writes and Read tool events as reads', () => {
  const t = sessionTouch([
    ev({ kind: 'file-edit', tool: 'Edit', path: 'D:/r/x.js', ts: 1, add: 2, del: 1 }),
    ev({ kind: 'tool', tool: 'Read', path: 'D:/r/y.js', ts: 2 }),
    ev({ kind: 'tool', tool: 'Grep', path: 'D:/r', ts: 3 }),
  ]);
  assert.deepEqual(t.files.map(f => [f.path, f.writes, f.reads]), [['D:/r/x.js', 1, 0], ['D:/r/y.js', 0, 1]]);
});

test('commits come from git commit events, oldest first, with their subject', () => {
  const t = sessionTouch([
    ev({ kind: 'git', gitOp: 'commit', label: 'commit: Add the thing', ts: 10 }),
    ev({ kind: 'git', gitOp: 'push', label: 'push -> origin/x', ts: 11 }),
    ev({ kind: 'git', gitOp: 'commit', label: 'commit: Fix it', ts: '2026-10-27T00:00:00.000Z' }),
  ]);
  assert.deepEqual(t.commits.map(c => c.subject), ['Add the thing', 'Fix it']);
  assert.equal(t.counts.commits, 2);
  assert.equal(t.pushes, 1);
  assert.deepEqual(t.span, { firstTs: 10, lastTs: '2026-10-27T00:00:00.000Z' });
});

test('an empty or missing log is an empty rollup, not an error', () => {
  for (const log of [[], null, undefined]) {
    assert.deepEqual(sessionTouch(log), { files: [], commits: [], pushes: 0, span: { firstTs: null, lastTs: null }, counts: { written: 0, read: 0, commits: 0 } });
  }
});

test('the per-session response carries touch', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /sessionTouch\(feedLog\)/);
  assert.match(src, /refusals, touch \}/);
});
