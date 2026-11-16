import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEpisodeId, episodeIdForSession } from '../lib/evaluation/episode-id.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-episode-id-')); }

test('resolveEpisodeId: ticket wins over branch, worktree, session', () => {
  assert.equal(resolveEpisodeId({ ticketId: 'glmps-34', branch: 'feat/x', worktreePath: 'D:/wt', sessionId: 's1' }), 'glmps-34');
});

test('resolveEpisodeId: falls through in priority order when earlier tiers are absent', () => {
  assert.equal(resolveEpisodeId({ branch: 'feat/x', worktreePath: 'D:/wt', sessionId: 's1' }), 'feat/x');
  assert.equal(resolveEpisodeId({ worktreePath: 'D:/wt', sessionId: 's1' }), 'D:/wt');
  assert.equal(resolveEpisodeId({ sessionId: 's1' }), 's1');
});

test('resolveEpisodeId: all absent/empty -> null, never throws', () => {
  assert.equal(resolveEpisodeId({}), null);
  assert.equal(resolveEpisodeId({ ticketId: '', branch: '', worktreePath: '', sessionId: '' }), null);
  assert.equal(resolveEpisodeId(), null);
});

test('episodeIdForSession: falls back to cwd when no backlog item matches the session', () => {
  const d = tmp();
  assert.equal(episodeIdForSession(d, { sessionId: 'no-such-session', cwd: 'D:/wt-1' }), 'D:/wt-1');
});

test('episodeIdForSession: falls back to sessionId, then null, when cwd is also absent', () => {
  const d = tmp();
  assert.equal(episodeIdForSession(d, { sessionId: 's1' }), 's1');
  assert.equal(episodeIdForSession(d, {}), null);
});

test('episodeIdForSession: finds the backlog ticket whose sessionId matches, even with a cwd present', () => {
  const d = tmp();
  // Seed a backlog item through backlog-store.js's own save()/load() pair so
  // this test stays correct if the on-disk shape ever changes.
  const state = backlogStore.load(d);
  const seeded = { ...state, items: [...state.items, { id: 'glmps-99', sessionId: 'sess-match', project: 'p' }] };
  backlogStore.save(d, seeded);
  assert.equal(episodeIdForSession(d, { sessionId: 'sess-match', cwd: 'D:/wt-1' }), 'glmps-99');
});

test('episodeIdForSession: fail-open when the backlog store is unreadable/corrupt', () => {
  const d = tmp();
  const storeFile = path.join(d, 'backlog', 'store.json');
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, '{not valid json');
  assert.equal(episodeIdForSession(d, { sessionId: 's1', cwd: 'D:/wt-1' }), 'D:/wt-1');
});
