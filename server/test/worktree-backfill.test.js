// The backfill applies the record-then-remove rule to worktrees already piled up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, formatPlan } from '../../scripts/worktree-backfill.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 23);
const clean = { head: 'a'.repeat(40), pushed: false, merged: true, dirty: 0 };
const entry = (over = {}) => ({
  id: 'c-1', dir: '/w/p/c-1', repo: '/r', branch: 'glmps-runner/p/c-1',
  card: { id: 'c-1', state: 'done', stateEnteredAt: NOW - 10 * DAY },
  leased: false, liveSession: false, facts: clean, ...over,
});
const actionOf = (over) => planBackfill({ entries: [entry(over)], now: NOW }).rows[0];

test('a finished card with a clean, merged worktree is removed', () => {
  assert.deepEqual(actionOf({}), { id: 'c-1', dir: '/w/p/c-1', action: 'remove', reason: 'clean-merged' });
});

test('a clean pushed worktree is removed', () => {
  assert.equal(actionOf({ facts: { ...clean, merged: false, pushed: true } }).reason, 'clean-pushed');
});

test('existing protections win first: ledger lease, live session, unfinished card, retention window', () => {
  assert.deepEqual([actionOf({ leased: true }).action, actionOf({ leased: true }).reason], ['keep', 'leased']);
  assert.equal(actionOf({ liveSession: true }).reason, 'occupied');
  assert.equal(actionOf({ card: { id: 'c-1', state: 'in_progress' } }).reason, 'active-card');
  const fresh = actionOf({ card: { id: 'c-1', state: 'done', stateEnteredAt: NOW - 1 * DAY } });
  assert.deepEqual([fresh.action, fresh.reason], ['keep', 'within-retention']);
});

test('work that would be lost is flagged, not removed', () => {
  assert.deepEqual(
    [actionOf({ facts: { ...clean, dirty: 4 } }).action, actionOf({ facts: { ...clean, dirty: 4 } }).reason], ['flag', 'dirty']);
  assert.equal(actionOf({ facts: { ...clean, merged: false } }).reason, 'unpushed');
  assert.equal(actionOf({ facts: { ...clean, head: null } }).reason, 'unreadable');
});

test('a worktree with no card to record on is flagged', () => {
  const r = actionOf({ card: null });
  assert.deepEqual([r.action, r.reason], ['flag', 'no-card']);
});

test('planBackfill counts removed, kept and flagged', () => {
  const plan = planBackfill({ now: NOW, entries: [
    entry({ id: 'a', dir: '/w/a' }), entry({ id: 'b', dir: '/w/b', leased: true }),
    entry({ id: 'c', dir: '/w/c', facts: { ...clean, dirty: 1 } }), entry({ id: 'd', dir: '/w/d' }),
  ] });
  assert.deepEqual(plan.counts, { remove: 2, keep: 1, flag: 1 });
  const text = formatPlan(plan, { apply: false });
  assert.match(text, /dry run/i);
  assert.match(text, /remove 2, keep 1, flag 1/);
  assert.match(text, /c .*dirty/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runBackfill } from '../../scripts/worktree-backfill.mjs';
import * as backlogStore from '../lib/orchestration/backlog-store.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf-8' });

function fixture() {
  const root = tmp('mc-backfill-');
  const repo = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const worktreesDir = path.join(root, 'wts');
  const projectsDir = path.join(root, 'claude-projects');
  fs.mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) g(repo, 'config', k, v);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'seed');
  // "Merged" is judged against origin/* only, so the seed commit goes to a remote main.
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  g(repo, 'remote', 'add', 'origin', origin);
  g(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const make = (title, edit) => {
    const { item } = backlogStore.addItemTo(stateDir, { title, prompt: 'x', project: 'p' });
    backlogStore.updateItemIn(stateDir, item.id, { state: 'done' });
    const dir = path.join(worktreesDir, 'p', item.id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    g(repo, 'worktree', 'add', '-q', '-b', `glmps-runner/p/${item.id}`, dir);
    edit?.(dir);
    backlogStore.setRunSessionIn(stateDir, item.id, { worktree: { dir, branch: `glmps-runner/p/${item.id}`, repo } });
    return { id: item.id, dir };
  };
  return { root, repo, paths: { stateDir, worktreesDir, projectsDir }, make };
}

test('runBackfill dry run changes nothing (applying is covered in worktree-backfill-apply.test.js)', () => {
  const f = fixture();
  try {
    const clean = f.make('clean');
    const dirty = f.make('dirty', (d) => fs.writeFileSync(path.join(d, 'wip.txt'), 'x\n'));
    const dry = runBackfill({ paths: f.paths, apply: false, now: Date.now() + 30 * DAY });
    assert.deepEqual(dry.counts, { remove: 1, keep: 0, flag: 1 });
    assert.ok(fs.existsSync(clean.dir) && fs.existsSync(dirty.dir), 'dry run touched nothing');
    assert.equal(backlogStore.load(f.paths.stateDir).items.find((i) => i.id === clean.id).runSession.outcome, undefined);
  } finally { try { fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} }
});

test('an empty leftover directory is cleared; it held nothing', () => {
  assert.deepEqual(actionOf({ empty: true, card: null, facts: null, repo: null }), { id: 'c-1', dir: '/w/p/c-1', action: 'remove', reason: 'empty-leftover' });
  assert.equal(actionOf({ empty: true, leased: true, card: null }).reason, 'leased');
});
