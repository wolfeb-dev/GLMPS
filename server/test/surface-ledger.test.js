import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ledgerModel, lsFilesByRepo } from '../lib/surface/ledger.js';
import { makeFixture } from './fixtures/git-repo-fixture.js';

const rows = [{ repo: 'a', path: 'D:/a', remote: 'git@github.com:x/a.git' }, { repo: 'b', path: 'D:/b', remote: null }];

test('ledgerModel counts each data type and where its copies live', () => {
  const m = ledgerModel({
    rows,
    filesByRepo: { a: ['README.md', 'x.js', 'c.json'], b: ['n.md'] },
    cards: [{ origin: { via: 'slack' } }, { origin: null }],
    tools: [{ id: 'claude-code', sessionsFound: 5 }, { id: 'gemini-cli', sessionsFound: 2 }, { id: 'codex-cli', sessionsFound: 1 }],
    learningCount: 4, alertCount: 3,
  });
  assert.deepEqual(m.types.map((t) => t.id), ['markdown', 'config', 'code', 'projects', 'cards', 'sessions', 'learning', 'alerts']);
  const by = Object.fromEntries(m.types.map((t) => [t.id, t]));
  const gh = [{ player: 'github', count: 1 }];
  assert.deepEqual([by.markdown.count, by.markdown.copies, by.markdown.onlyHere], [2, gh, 1]);
  assert.deepEqual([by.config.count, by.config.copies, by.config.onlyHere], [1, gh, 0]);
  assert.deepEqual([by.code.count, by.code.copies, by.code.onlyHere], [1, gh, 0]);
  assert.deepEqual([by.projects.count, by.projects.copies, by.projects.onlyHere], [2, gh, 1]);
  assert.deepEqual([by.cards.count, by.cards.copies, by.cards.onlyHere], [2, [{ player: 'slack', count: 1 }], 1]);
  assert.deepEqual([by.sessions.count, by.sessions.copies, by.sessions.onlyHere], [8, [{ player: 'anthropic', count: 5 }, { player: 'gcp', count: 2 }], 1]);
  assert.deepEqual([by.learning.count, by.learning.copies, by.learning.onlyHere], [4, [], 4]);
  assert.deepEqual([by.alerts.count, by.alerts.copies, by.alerts.onlyHere], [3, [], 3]);
  for (const t of m.types) assert.equal(typeof t.label, 'string');
  assert.equal(typeof m.ts, 'number');
});

test('ledgerModel tolerates empty inputs', () => {
  const m = ledgerModel({});
  assert.equal(m.types.length, 8);
  assert.ok(m.types.every((t) => t.count === 0 && t.onlyHere === 0 && t.copies.length === 0));
});

test('extension matching is case-insensitive and ignores extensionless files', () => {
  const m = ledgerModel({ rows: [rows[1]], filesByRepo: { b: ['A.MD', 'Makefile', 'x.PY', 'img.png'] } });
  const by = Object.fromEntries(m.types.map((t) => [t.id, t.count]));
  assert.deepEqual([by.markdown, by.code, by.config], [1, 1, 0]);
});

test('lsFilesByRepo reads git ls-files per row; a failed repo counts zero files', async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push(args);
    const dir = args[args.indexOf('-C') + 1];
    if (dir === 'D:/bad') throw new Error('not a repository');
    return { stdout: 'one.md\0two.js\0' };
  };
  const out = await lsFilesByRepo([{ repo: 'ok', path: 'D:/ok' }, { repo: 'bad', path: 'D:/bad' }], exec);
  assert.deepEqual(out, { ok: ['one.md', 'two.js'], bad: [] });
  assert.ok(calls.every((a) => a.includes('ls-files') && a.includes('-z')));
});

test('lsFilesByRepo works against a real repository', async () => {
  const { base, work } = makeFixture();
  try {
    const out = await lsFilesByRepo([{ repo: 'w', path: work }]);
    assert.ok(out.w.includes('a.txt') && out.w.includes('dir/b.txt'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
