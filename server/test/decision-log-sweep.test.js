// server/test/decision-log-sweep.test.js
// glmps-143 Task 4. The sweep spans ~16 repos. Git subprocesses MUST be async
// and concurrency-limited: execFileSync on the event loop is a mistake already
// recorded in memory (node-event-loop-git-subprocess-guard), so the cap is
// asserted here rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepRepos, normalizeRepoList, MAX_CONCURRENCY } from '../lib/observability/decision-log-sweep.js';
import { readAll, loadWatermarks } from '../lib/observability/decision-log-store.js';
import { FORMAT } from '../lib/observability/decision-log-git.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sweep-'));
const rec = (sha, ts, subject, body) => `${sha}\x1f${ts}\x1f${subject}\x1f${body}\x1e`;

// A fake git that answers the three call shapes the sweep makes.
function makeGit({ merges = {}, onCall } = {}) {
  return async (cwd, args) => {
    if (onCall) onCall(cwd, args);
    if (args.includes('symbolic-ref')) return 'origin/main\n';
    if (args[0] === 'branch') return 'main\n';
    if (args.includes('--merges')) return merges[cwd] ?? '';
    return '';
  };
}

test('normalizeRepoList collapses separator-only spelling differences', () => {
  // Caught on the first real sweep: REPO_ROOT is 'D:\\glmps' while
  // the synced additionalDirectories carry 'D:/glmps'. A bare Set
  // kept both, so every glmps entry was written twice.
  const out = normalizeRepoList(['D:\\glmps', 'D:/glmps', 'D:/Harbor-App']);
  assert.deepEqual(out, ['D:/glmps', 'D:/Harbor-App']);
});

test('normalizeRepoList folds case only where the filesystem does', () => {
  assert.deepEqual(normalizeRepoList(['D:/Repo', 'D:/repo'], { caseInsensitive: true }), ['D:/Repo']);
  assert.deepEqual(normalizeRepoList(['D:/Repo', 'D:/repo'], { caseInsensitive: false }), ['D:/Repo', 'D:/repo']);
});

test('normalizeRepoList drops trailing slashes, blanks and non-strings', () => {
  assert.deepEqual(normalizeRepoList(['D:/a/', 'D:/a', '', null, 42, '  ']), ['D:/a']);
});

test('sweeps repos and writes git rows', async () => {
  const sd = tmp();
  const repo = 'D:/repo-a';
  const runGit = makeGit({ merges: { [repo]: rec('aaa1111', '1753220000', 'merge: did a thing', 'because reasons') } });

  const res = await sweepRepos({ repos: [repo], stateDir: sd, runGit, now: 1753300000000 });
  assert.equal(res.added, 1);

  const rows = readAll(sd);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repo, repo);
  assert.equal(rows[0].what, 'merge: did a thing');
  assert.equal(rows[0].why, 'because reasons');
  assert.equal(rows[0].source, 'git');
});

test('the git format string actually used is the one from decision-log-git', async () => {
  const seen = [];
  const runGit = makeGit({ onCall: (_c, args) => seen.push(args.join(' ')) });
  await sweepRepos({ repos: ['D:/r'], stateDir: tmp(), runGit, now: Date.now() });
  assert.ok(seen.some((a) => a.includes(FORMAT)), 'sweep must use the shared FORMAT, not a local copy');
});

test('concurrency never exceeds MAX_CONCURRENCY', async () => {
  const sd = tmp();
  const repos = Array.from({ length: 12 }, (_, i) => `D:/repo-${i}`);
  let inFlight = 0;
  let peak = 0;

  const runGit = async (cwd, args) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (args.includes('symbolic-ref')) return 'origin/main\n';
    if (args[0] === 'branch') return 'main\n';
    return '';
  };

  await sweepRepos({ repos, stateDir: sd, runGit, now: Date.now() });
  assert.ok(peak <= MAX_CONCURRENCY, `peak in-flight ${peak} exceeded cap ${MAX_CONCURRENCY}`);
  assert.ok(peak > 1, 'should actually run in parallel, not serially');
});

test('one failing repo is skipped and does not abort the sweep', async () => {
  const sd = tmp();
  const good = 'D:/good';
  const bad = 'D:/bad';
  const runGit = async (cwd, args) => {
    if (cwd === bad) throw new Error('not a git repository');
    if (args.includes('symbolic-ref')) return 'origin/main\n';
    if (args[0] === 'branch') return 'main\n';
    if (args.includes('--merges')) return rec('ggg1111', '1753220000', 'merge: fine', '');
    return '';
  };

  const res = await sweepRepos({ repos: [bad, good], stateDir: sd, runGit, now: Date.now() });
  assert.equal(readAll(sd).length, 1, 'the good repo still landed');
  assert.ok(res.skipped.some((s) => s.repo === bad), 'the failure is reported, not swallowed');
});

test('a repo with no resolvable default branch is skipped WITH a reason', async () => {
  const sd = tmp();
  const runGit = async (cwd, args) => {
    if (args.includes('symbolic-ref')) return '';
    if (args[0] === 'branch') return 'feature/x\n';
    return '';
  };
  const res = await sweepRepos({ repos: ['D:/odd'], stateDir: sd, runGit, now: Date.now() });
  assert.equal(readAll(sd).length, 0);
  assert.match(res.skipped.find((s) => s.repo === 'D:/odd').reason, /default branch/i);
});

test('watermarks advance so a second sweep adds nothing', async () => {
  const sd = tmp();
  const repo = 'D:/repo-a';
  const runGit = makeGit({ merges: { [repo]: rec('aaa1111', '1753220000', 'merge: once', '') } });

  const first = await sweepRepos({ repos: [repo], stateDir: sd, runGit, now: 1753300000000 });
  assert.equal(first.added, 1);
  assert.ok(loadWatermarks(sd)[repo] >= 1753220000000);

  const second = await sweepRepos({ repos: [repo], stateDir: sd, runGit, now: 1753300000000 });
  assert.equal(second.added, 0, 'already-seen commits are not re-added');
  assert.equal(readAll(sd).length, 1);
});

test('the backfill cap is applied AND reported, never silent', async () => {
  const sd = tmp();
  const repo = 'D:/repo-a';
  const runGit = makeGit();
  const res = await sweepRepos({ repos: [repo], stateDir: sd, runGit, now: 1753300000000, backfillDays: 30 });
  const note = res.notes.find((n) => n.repo === repo);
  assert.ok(note, 'first-run backfill must be reported');
  assert.match(note.reason, /backfill/i);
  assert.ok(note.reason.includes('30'), 'the actual cap value is stated');
});
