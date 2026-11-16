import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSessionEdits } from '../lib/surface/session-edits.js';

const rows = [{ repo: 'mc', path: 'D:/mc' }, { repo: 'mc-assets', path: 'D:/mc-assets' }];
const ev = (path, ts, extra = {}) => ({ kind: 'file-edit', path, ts: new Date(ts).toISOString(), add: 1, del: 0, ...extra });

test('one row per session and path, latest first, ended sessions and refused paths excluded', () => {
  const sessions = [
    { id: 'a', tool: 'claude-code', title: 'A', state: 'working' },
    { id: 'b', tool: 'claude-code', title: 'B', state: 'idle' },
    { id: 'c', tool: 'claude-code', title: 'C', state: 'ended' },
  ];
  const events = {
    a: [ev('D:\\mc\\web\\x.js', 1000), ev('D:/mc/web/x.js', 3000, { add: 2, del: 1 }), ev('D:/mc/.env', 4000)],
    b: [ev('D:/mc-assets/y.md', 2000), { kind: 'context-file', op: 'write', path: 'C:/u/.claude/CLAUDE.md', ts: new Date(2500).toISOString(), change: { old: { text: 'a', truncated: false }, new: { text: 'b', truncated: false } } }, { kind: 'context-file', op: 'read', path: 'C:/u/r.md', ts: new Date(2600).toISOString() }],
    c: [ev('D:/mc/z.js', 9000)],
  };
  const out = collectSessionEdits({
    sessions, eventsOf: (id) => events[id] ?? [], rows,
    statOf: (p) => (p.endsWith('y.md') ? null : { size: 10, mtimeMs: 5 }),
    allowed: (p) => !p.endsWith('.env'), now: 10000,
  });
  assert.deepEqual(out.edits.map((e) => [e.sessionId, e.path]), [
    ['a', 'D:/mc/web/x.js'], ['b', 'C:/u/.claude/CLAUDE.md'], ['b', 'D:/mc-assets/y.md'],
  ]);
  const x = out.edits[0];
  assert.equal(x.repo, 'mc'); assert.equal(x.rel, 'web/x.js'); assert.equal(x.add, 3); assert.equal(x.del, 1); assert.equal(x.ts, 3000); assert.equal(x.state, 'working');
  assert.equal(out.edits[1].repo, null); assert.equal(out.edits[1].change.new.text, 'b');
  assert.equal(out.edits[2].repo, 'mc-assets', 'mc-assets is not matched as a child of mc');
  assert.equal(out.edits[2].size, null); assert.equal(out.edits[2].mtimeMs, null);
});

test('cap keeps the newest rows', () => {
  const sessions = [{ id: 'a', tool: 't', title: null, state: 'working' }];
  const evs = Array.from({ length: 80 }, (_, i) => ev(`D:/mc/f${i}.js`, i));
  const out = collectSessionEdits({ sessions, eventsOf: () => evs, rows, statOf: () => null, allowed: () => true, now: 0, cap: 60 });
  assert.equal(out.edits.length, 60); assert.equal(out.edits[0].path, 'D:/mc/f79.js');
});
