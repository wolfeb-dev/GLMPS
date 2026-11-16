import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferObserved, scopeZone } from '../lib/observability/workspace-observe.js';

test('empty events -> null', () => {
  assert.equal(inferObserved([], {}), null);
});

test('extracts recent paths, skills, agents; passes through zone/stage', () => {
  const events = [
    { kind: 'file-edit', path: 'web/a.css', ts: 1 },
    { kind: 'skill', label: 'frontend-design', ts: 2 },
    { kind: 'agent', label: 'general-purpose: do X', ts: 3 },
    { kind: 'file-edit', path: 'web/b.css', ts: 4 },
  ];
  const o = inferObserved(events, { zone: 'dev', stage: 2, ts: 4 });
  assert.deepEqual(o.activePaths, ['web/b.css', 'web/a.css']); // most-recent first
  assert.deepEqual(o.activeSkills, ['frontend-design']);
  assert.deepEqual(o.activeAgents, ['general-purpose']);       // name before ':'
  assert.equal(o.zone, 'dev');
  assert.equal(o.stage, 2);
});

test('caps activePaths at 6 and de-dupes', () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push({ kind: 'file-edit', path: `f${i}.ts`, ts: i });
  events.push({ kind: 'file-edit', path: 'f9.ts', ts: 99 }); // dup of newest
  const o = inferObserved(events, {});
  assert.equal(o.activePaths.length, 6);
  assert.equal(o.activePaths[0], 'f9.ts');
  assert.equal(new Set(o.activePaths).size, o.activePaths.length);
});

test('glmps-100: unsorted event ring is sorted ONCE; output stays newest-first per category', () => {
  // Events deliberately out of ts order. inferObserved now sorts the ring once
  // and buckets per category; recent() no longer re-sorts. Output must still be
  // newest-first for each of paths/skills/agents.
  const events = [
    { kind: 'file-edit', path: 'web/old.css', ts: 1 },
    { kind: 'file-edit', path: 'web/new.css', ts: 9 },
    { kind: 'file-edit', path: 'web/mid.css', ts: 5 },
    { kind: 'skill', label: 'first', ts: 2 },
    { kind: 'skill', label: 'latest', ts: 8 },
    { kind: 'agent', label: 'general-purpose: do X', ts: 7 },
  ];
  const o = inferObserved(events, { zone: 'dev', stage: 1, ts: 9 });
  assert.deepEqual(o.activePaths, ['web/new.css', 'web/mid.css', 'web/old.css']);
  assert.deepEqual(o.activeSkills, ['latest', 'first']);
  assert.deepEqual(o.activeAgents, ['general-purpose']);
});

test('scopeZone: null/empty -> null', () => {
  assert.equal(scopeZone(null), null);
  assert.equal(scopeZone({ zones: [] }), null);
});
test('scopeZone: no prod activity -> most-touched zone name', () => {
  assert.equal(scopeZone({ zones: [{ zone: 'web', env: 'dev', count: 3 }, { zone: 'server', env: 'dev', count: 1 }] }), 'web');
});
test('scopeZone: any prod-env zone -> "prod" token (even if not most-touched)', () => {
  assert.equal(scopeZone({ zones: [{ zone: 'raw', env: 'prod', count: 1 }, { zone: 'web', env: 'dev', count: 5 }] }), 'prod');
});
