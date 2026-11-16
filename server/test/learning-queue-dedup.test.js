// server/test/learning-queue-dedup.test.js
// Card glmps-2-0-82: worktree gaps fold into their parent repo's row, and a gap
// whose guard line already exists is filed 'covered', not 'pending'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { coveredCodes, coveredCodesFromFile } from '../lib/evaluation/guard-coverage.js';
import { upsertGapAndApply } from '../lib/evaluation/gap-pipeline.js';
import { lastFiredByClass } from '../lib/evaluation/shadow-arm.js';

const { projectKey, normalizeProject, upsertGapInto, emptyState } = learningStore;

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot(), prefix)));
  tmpDirs.push(d);
  return d;
}

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
}

// A real repo with a runner-style worktree outside it and a .claude/worktrees one inside it.
function repoWithWorktrees() {
  const root = tmp('mc-lq-dedup-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const runnerWt = path.join(root, 'runner', 'worktrees', 'repo', 'job-1');
  const claudeWt = path.join(repo, '.claude', 'worktrees', 'lane-x');
  git(repo, 'worktree', 'add', '-q', '-b', 'job-1', runnerWt);
  git(repo, 'worktree', 'add', '-q', '-b', 'lane-x', claudeWt);
  fs.mkdirSync(path.join(runnerWt, 'server'), { recursive: true });
  return { repo, runnerWt, claudeWt };
}

const gap = (code) => ({ code, severity: 'warn', message: code });

test('projectKey: a live worktree (runner or .claude) keys to its parent repo; the repo itself is unchanged', () => {
  const { repo, runnerWt, claudeWt } = repoWithWorktrees();
  const repoKey = normalizeProject(repo);
  assert.equal(projectKey(repo), repoKey);
  assert.equal(projectKey(runnerWt), repoKey);
  assert.equal(projectKey(path.join(runnerWt, 'server')), repoKey, 'a subdir of a worktree still resolves');
  assert.equal(projectKey(claudeWt), repoKey);
});

test('projectKey: a gone .claude/worktrees path or its slug falls back to the parent by pattern', () => {
  assert.equal(projectKey('Z:\\no-such\\glmps\\.claude\\worktrees\\glmps2-ds'), 'Z--no-such-glmps');
  assert.equal(projectKey('D--glmps--claude-worktrees-glmps2-ds'), 'D--glmps');
  assert.equal(projectKey('D--glmps'), 'D--glmps');
  assert.equal(projectKey('D:\\glmps'), 'D--glmps');
});

test('upsertGapInto: the same gap from a repo and two of its worktrees is one row', () => {
  const { repo, runnerWt, claudeWt } = repoWithWorktrees();
  let s = emptyState();
  s = upsertGapInto(s, gap('sleep-poll'), { project: repo, sessionId: 'a' }).state;
  s = upsertGapInto(s, gap('sleep-poll'), { project: runnerWt, sessionId: 'b' }).state;
  s = upsertGapInto(s, gap('sleep-poll'), { project: claudeWt, sessionId: 'c' }).state;
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].count, 3);
  assert.equal(s.items[0].project, normalizeProject(repo));
});

test('coveredCodes: matches guard lines by anchor; a code with no anchor is never covered', () => {
  const text = [
    '- Never poll with sleep N then cat - use run_in_background or Monitor.',
    '- Use the Grep/Read tools instead of Bash grep/cat for searching and reading files.',
  ].join('\n');
  const c = coveredCodes(text);
  assert.ok(c.has('sleep-poll'));
  assert.ok(c.has('bash-grep-over-grep-tool'));
  assert.ok(!c.has('reread-loop'));
  assert.ok(!coveredCodes('ticket closed without gate, before claiming done').has('ticket-closed-without-gate'));
});

test('coveredCodesFromFile: a missing guard file fails open to an empty set', () => {
  assert.equal(coveredCodesFromFile(path.join(tmp('mc-lq-cov-'), 'CLAUDE.global.md')).size, 0);
});

test('upsertGapInto: a covered code is filed as covered and moves with the guard file', () => {
  const covered = new Set(['sleep-poll']);
  let r = upsertGapInto(emptyState(), gap('sleep-poll'), { project: 'p', sessionId: 's1', coveredCodes: covered });
  assert.equal(r.isNew, true);
  assert.equal(r.item.status, 'covered');

  r = upsertGapInto(r.state, gap('sleep-poll'), { project: 'p', sessionId: 's1', coveredCodes: new Set() });
  assert.equal(r.item.status, 'pending', 'guard removed: back to the queue');
  assert.equal(r.changed, true);

  r = upsertGapInto(r.state, gap('sleep-poll'), { project: 'p', sessionId: 's2', coveredCodes: covered });
  assert.equal(r.item.status, 'covered', 'guard present again: out of the queue');
  assert.equal(r.item.count, 2);

  r = upsertGapInto(r.state, gap('sleep-poll'), { project: 'p', sessionId: 's3' });
  assert.equal(r.item.status, 'covered', 'a caller with no coverage info keeps the status');
});

test('upsertGapInto: coverage never reopens a discarded or applied row', () => {
  let s = upsertGapInto(emptyState(), gap('sleep-poll'), { project: 'p', sessionId: 's1' }).state;
  s = learningStore.applyAction(s, s.items[0].id, 'discard').state;
  const r = upsertGapInto(s, gap('sleep-poll'), { project: 'p', sessionId: 's2', coveredCodes: new Set() });
  assert.equal(r.item.status, 'discarded');
  assert.equal(r.changed, false);
});

test('upsertGap (Stop hook path): a new covered row records a shadow fired:true observation', () => {
  const stateDir = tmp('mc-lq-shadow-');
  learningStore.upsertGap(stateDir, gap('sleep-poll'), { project: 'p', sessionId: 's1', coveredCodes: new Set(['sleep-poll']) });
  assert.equal(typeof lastFiredByClass(stateDir)['sleep-poll'], 'number');
  assert.equal(learningStore.load(stateDir).items[0].lastFiredEpisodeId, 's1');
});

test('upsertGapAndApply (poll path): a new covered row records fired:true, an uncovered one fired:false', () => {
  const calls = [];
  const recordShadowFn = (_dir, rec) => calls.push(rec);
  upsertGapAndApply(emptyState(), gap('sleep-poll'), { project: 'p', sessionId: 's1', coveredCodes: new Set(['sleep-poll']) }, { stateDir: 'x', recordShadowFn });
  upsertGapAndApply(emptyState(), gap('ticket-closed-without-gate'), { project: 'p', sessionId: 's1', coveredCodes: new Set(['sleep-poll']) }, { stateDir: 'x', recordShadowFn });
  assert.deepEqual(calls.map((c) => [c.taskClass, c.fired]), [['sleep-poll', true], ['ticket-closed-without-gate', false]]);
});
