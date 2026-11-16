import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import {
  parseRemotes, parseAheadBehind, parseRefs, parsePorcelain,
  classifyResidency, collectResidency, createGitRemoteFeedLoop,
} from '../lib/kernel/git-remote-feed.js';

test('parsers', () => {
  assert.equal(parseRemotes('origin\thttps://github.com/o/r.git (fetch)\norigin\thttps://github.com/o/r.git (push)\n'), 'https://github.com/o/r.git');
  assert.equal(parseRemotes(''), null);
  assert.deepEqual(parseAheadBehind('2\t5\n'), { ahead: 2, behind: 5 });
  assert.deepEqual(parseRefs('main\torigin/main\t[ahead 1]\nfeat\t\t\nold\torigin/old\t[gone]\n'), { unpushedBranches: ['main'], noUpstreamBranches: ['feat'] });
  assert.equal(parsePorcelain(' M a.js\n?? b.js\n'), 2);
});

test('classification: absence is a state, and dirt outranks sync', () => {
  assert.equal(classifyResidency({ remote: null }), 'nowhere-else');
  assert.equal(classifyResidency({ remote: 'u', ahead: 0, behind: 0, dirty: 0, unpushedBranches: [] }), 'synced');
  assert.equal(classifyResidency({ remote: 'u', ahead: 1, behind: 0, dirty: 0, unpushedBranches: [] }), 'ahead');
  assert.equal(classifyResidency({ remote: 'u', ahead: 0, behind: 3, dirty: 0, unpushedBranches: [] }), 'behind');
  assert.equal(classifyResidency({ remote: 'u', ahead: 1, behind: 3, dirty: 0, unpushedBranches: [] }), 'diverged');
  assert.equal(classifyResidency({ remote: 'u', ahead: 0, behind: 0, dirty: 2, unpushedBranches: [] }), 'dirty');
  assert.equal(classifyResidency({ remote: 'u', ahead: 0, behind: 0, dirty: 0, unpushedBranches: ['x'] }), 'ahead');
});

// The module's own `run` helper prepends --no-optional-locks to every git
// invocation (the separation ruling: this feed runs read-only against the
// operator's real checkouts, and even git's opportunistic index refresh is
// off-limits). Mocks below strip that fixed first arg before matching on
// the rest, so they read like the plan's original mocks; the dedicated
// guard test after them checks the raw args directly.
function stripLock(args) { return args[0] === '--no-optional-locks' ? args.slice(1) : args; }

test('collectResidency makes one row per checkout, a failing repo included', async () => {
  const exec = async (file, args, { cwd }) => {
    if (cwd === '/broken') throw new Error('not a git repository');
    const a = stripLock(args).join(' ');
    if (a === 'remote -v') return { stdout: cwd === '/local' ? '' : 'origin\thttps://x/r.git (fetch)\n' };
    if (a === 'symbolic-ref --short HEAD') return { stdout: 'main\n' };
    if (a.startsWith('rev-list')) { if (cwd === '/local') throw new Error('no upstream'); return { stdout: '0\t0\n' }; }
    if (a.startsWith('for-each-ref')) return { stdout: 'main\torigin/main\t\n' };
    if (a === 'status --porcelain') return { stdout: '' };
    throw new Error(`unexpected ${a}`);
  };
  const rows = await collectResidency({ checkouts: [{ project: 'a', path: '/a' }, { project: 'local', path: '/local' }, { project: 'broken', path: '/broken' }], exec, now: () => 7, statMtime: async () => 5 });
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.repo === 'a').residency, 'synced');
  assert.equal(rows.find((r) => r.repo === 'local').residency, 'nowhere-else');
  const broken = rows.find((r) => r.repo === 'broken');
  assert.equal(broken.residency, 'unknown'); assert.match(broken.error, /not a git repository/);
  assert.equal(rows[0].lastFetchTs, 5); assert.equal(rows[0].ts, 7);
});

// Ruling (separation): a little extra verbosity is the acceptable cost of
// getting this wrong the safe way; a fetch/push against the operator's real
// checkout is not. Every git call this module ever makes must carry
// --no-optional-locks, and none may be one of the write/network verbs -
// including the call that ends up throwing (no upstream), since the guard
// must be on the argv before git ever gets to decide it has nothing to do.
// Fix round 1, item 3 (fold): extended to also exercise the two new
// rev-list shapes the fix adds - `rev-list --count HEAD --not --remotes`
// (detached) and `rev-list --count <branch> --not --remotes` (a
// no-upstream branch) - so the guard covers every call this module can
// ever make, not just the original five.
test('every git call carries --no-optional-locks, and none touch fetch/pull/push/gc/update-ref', async () => {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd });
    const a = stripLock(args).join(' ');
    if (a === 'remote -v') return { stdout: 'origin\thttps://x/r.git (fetch)\n' };
    if (a === 'symbolic-ref --short HEAD') {
      if (opts.cwd === '/detached') throw new Error('fatal: ref HEAD is not a symbolic ref');
      return { stdout: 'main\n' };
    }
    if (a === 'rev-list --left-right --count HEAD...@{u}') { if (opts.cwd === '/no-up' || opts.cwd === '/detached') throw new Error('no upstream'); return { stdout: '0\t0\n' }; }
    if (a === 'rev-list --count HEAD --not --remotes') return { stdout: '0\n' };
    if (a === 'rev-list --count feature --not --remotes') return { stdout: '0\n' };
    if (a.startsWith('for-each-ref')) return { stdout: opts.cwd === '/no-up' ? 'feature\t\t\n' : 'main\torigin/main\t\n' };
    if (a === 'status --porcelain') return { stdout: '' };
    throw new Error(`unexpected ${a}`);
  };
  await collectResidency({
    checkouts: [{ project: 'a', path: '/a' }, { project: 'b', path: '/no-up' }, { project: 'c', path: '/detached' }],
    exec, now: () => 1, statMtime: async () => null,
  });
  assert.equal(calls.length, 17, `expected 5 (a) + 6 (b, one no-upstream branch) + 6 (c, detached) = 17 git calls, got ${calls.length}`);
  for (const c of calls) {
    assert.equal(c.file, 'git');
    assert.equal(c.args[0], '--no-optional-locks', `missing the lock guard: ${c.args.join(' ')}`);
    assert.doesNotMatch(c.args.join(' '), /\b(fetch|pull|push|gc|update-ref)\b/, `forbidden verb in: ${c.args.join(' ')}`);
  }
});

// localOnlyCount must not fail open to 0 (a 0 reads as
// "nothing local-only", so a failed sub-query would silently report
// synced/ahead - the exact false negative this feed exists to prevent).
// A failure in either of its two call sites (the detached-HEAD check, a
// no-upstream branch's check) must instead keep everything already
// gathered, name which rev's check failed, and mark the row 'unknown'.
test('fix round 2: a failed local-only check keeps every already-gathered field and marks the row unknown, never a silent synced', async () => {
  const exec = async (file, args, opts) => {
    const a = stripLock(args).join(' ');
    if (a === 'remote -v') return { stdout: 'origin\thttps://x/r.git (fetch)\n' };
    if (a === 'symbolic-ref --short HEAD') {
      if (opts.cwd === '/detached') throw new Error('fatal: ref HEAD is not a symbolic ref');
      return { stdout: 'main\n' };
    }
    if (a === 'rev-list --left-right --count HEAD...@{u}') throw new Error('no upstream');
    if (a === 'rev-list --count HEAD --not --remotes') throw new Error('fatal: exhausted allotted pack memory\nsome trailing detail');
    if (a === 'rev-list --count feature --not --remotes') throw new Error("fatal: bad revision 'feature'");
    if (a.startsWith('for-each-ref')) return { stdout: opts.cwd === '/no-up' ? 'feature\t\t\nmain\torigin/main\t\n' : 'main\torigin/main\t\n' };
    if (a === 'status --porcelain') return { stdout: ' M dirty.txt\n' };
    throw new Error(`unexpected ${a}`);
  };
  const rows = await collectResidency({
    checkouts: [{ project: 'detached', path: '/detached' }, { project: 'no-up', path: '/no-up' }],
    exec, now: () => 5, statMtime: async () => 9,
  });

  const d = rows.find((r) => r.repo === 'detached');
  assert.equal(d.residency, 'unknown', 'a failed local-only check must never read as synced/ahead');
  assert.match(d.error, /local-only check failed for HEAD: fatal: exhausted allotted pack memory/);
  assert.equal(d.remote, 'https://x/r.git', 'remote must survive a failed local-only check');
  assert.equal(d.detached, true, 'detached must survive a failed local-only check');
  assert.equal(d.dirty, 1, 'status must survive a failed local-only check');
  assert.equal(d.lastFetchTs, 9, 'lastFetchTs must survive a failed local-only check');

  const n = rows.find((r) => r.repo === 'no-up');
  assert.equal(n.residency, 'unknown', 'a failed local-only check must never read as synced/ahead');
  assert.match(n.error, /local-only check failed for feature: fatal: bad revision 'feature'/);
  assert.equal(n.remote, 'https://x/r.git', 'remote must survive a failed local-only check');
  assert.ok(n.noUpstreamBranches.includes('feature'), 'refs must survive a failed local-only check');
  assert.equal(n.dirty, 1, 'status must survive a failed local-only check');
});

// Task 12 fix round 2 left a residual fail-open: `Number.isFinite(n) ? n : 0`
// treats non-numeric stdout from the `--not --remotes` call as "0 local-only
// commits", which is exactly the false-negative fix round 2 was meant to
// close (a 0 reads as synced/ahead instead of unknown). localOnlyCount must
// throw a named error instead so the existing catch marks the row 'unknown'.
test('carry-in: non-numeric rev-list --count stdout must not read as zero local-only work', async () => {
  const exec = async (file, args, opts) => {
    const a = stripLock(args).join(' ');
    if (a === 'remote -v') return { stdout: 'origin\thttps://x/r.git (fetch)\n' };
    if (a === 'symbolic-ref --short HEAD') throw new Error('fatal: ref HEAD is not a symbolic ref');
    if (a === 'rev-list --left-right --count HEAD...@{u}') throw new Error('no upstream');
    if (a === 'rev-list --count HEAD --not --remotes') return { stdout: 'not-a-number\n' };
    if (a.startsWith('for-each-ref')) return { stdout: '' };
    if (a === 'status --porcelain') return { stdout: '' };
    throw new Error(`unexpected ${a}`);
  };
  const rows = await collectResidency({
    checkouts: [{ project: 'detached', path: '/detached' }],
    exec, now: () => 1, statMtime: async () => null,
  });
  const d = rows[0];
  assert.equal(d.residency, 'unknown', 'non-numeric stdout must never read as 0 local-only work');
  assert.match(d.error, /local-only check failed for HEAD:.*non-numeric/i);
  assert.equal(d.remote, 'https://x/r.git', 'remote must survive the failed local-only check');
});

// `Number(raw)` accepts far more than
// `rev-list --count` ever legitimately prints (a plain non-negative decimal
// string). Hex, scientific notation, a negative sign, and an empty string
// are all Number.isFinite-true but must never be trusted as a count.
for (const bad of ['', '0x10', '1e3', '-1']) {
  test(`carry-in (M10): rev-list --count stdout ${JSON.stringify(bad)} is rejected, not coerced by Number()`, async () => {
    const exec = async (file, args) => {
      const a = stripLock(args).join(' ');
      if (a === 'remote -v') return { stdout: 'origin\thttps://x/r.git (fetch)\n' };
      if (a === 'symbolic-ref --short HEAD') throw new Error('fatal: ref HEAD is not a symbolic ref');
      if (a === 'rev-list --left-right --count HEAD...@{u}') throw new Error('no upstream');
      if (a === 'rev-list --count HEAD --not --remotes') return { stdout: `${bad}\n` };
      if (a.startsWith('for-each-ref')) return { stdout: '' };
      if (a === 'status --porcelain') return { stdout: '' };
      throw new Error(`unexpected ${a}`);
    };
    const rows = await collectResidency({ checkouts: [{ project: 'detached', path: '/detached' }], exec, now: () => 1, statMtime: async () => null });
    const d = rows[0];
    assert.equal(d.residency, 'unknown', `${JSON.stringify(bad)} must never be trusted as a local-only count`);
    assert.match(d.error, /local-only check failed for HEAD:.*non-numeric/i);
  });
}

test('proof it closes: a broken feed alerts and publishes nothing; a good run clears it and publishes', async () => {
  const { createLoopRegistry } = await import('../lib/loops/registry.js');
  const { loopAlerts } = await import('../lib/loops/loop-health.js');
  const stateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-'));
  const reg = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  let mode = 'throw'; const published = [];
  const good = async (file, args) => {
    const a = stripLock(args)[0];
    return { stdout: a === 'remote' ? 'origin\thttps://x/r.git (fetch)\n' : a === 'rev-list' ? '0\t0\n' : a === 'symbolic-ref' ? 'main\n' : '' };
  };
  // Phase K final review minor: the dropRowFor test seam no longer lives on
  // the production loop object; a test injects its own `collect` instead.
  let dropRowFor = null;
  const loop = createGitRemoteFeedLoop({
    gitRepoRoots: () => (mode === 'missing' ? [{ project: 'a', path: '/a' }, { project: 'b', path: '/b' }] : [{ project: 'a', path: '/a' }]),
    exec: async (f, a, o) => { if (mode === 'throw') throw new Error('git exploded'); return good(f, a, o); },
    writeCurrent: (doc) => published.push(doc), statMtime: async () => 1,
    collect: async (opts) => (await collectResidency(opts)).filter((r) => r.path !== dropRowFor),
  });
  assert.equal('dropRowFor' in loop, false, 'no test seam on the production object');
  reg.registerLoop({ name: 'git-remote-feed', trigger: { onEvent: 'tick' }, ...loop, ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 5000 }, sla: { maxAgeMs: 3_600_000, obligation: false } });
  await reg.emit('tick');
  assert.equal(loopAlerts(reg.snapshot()).length, 1, 'every checkout failed: the checker rejects');
  assert.equal(published.length, 0, 'nothing published on a failed check');
  mode = 'missing';
  dropRowFor = '/b';
  await reg.emit('tick');
  assert.match(reg.get('git-remote-feed').lastReason, /no row for 1 checkout/);
  assert.equal(published.length, 0);
  mode = 'good'; dropRowFor = null;
  await reg.emit('tick');
  assert.equal(loopAlerts(reg.snapshot()).length, 0, 'a good run clears the alert');
  assert.equal(published.length, 1);
  assert.equal(published[0].rows[0].residency, 'synced');
  reg.stop();
});

// Real git, real temp repos (never the operator's own checkouts): the parse
// functions above are hand-written assumptions about git's own output
// format (remote -v, for-each-ref's %(upstream:track), rev-list --left-
// right --count, status --porcelain) and about where a worktree keeps its
// own FETCH_HEAD; this is what proves those assumptions against the real
// binary rather than against a fixture that encodes the same assumption
// twice.
function git(args, cwd) { execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] }); }
function realExec(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: 'utf-8', windowsHide: true }, (err, stdout) => { if (err) reject(err); else resolve({ stdout }); });
  });
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', dir], dir);
  git(['config', 'user.email', 't@t.example'], dir);
  git(['config', 'user.name', 'test'], dir);
}

test('real git: synced after push, ahead after an unpushed commit, dirty outranks ahead, no remote reads as nowhere-else, and a worktree resolves its own FETCH_HEAD', async () => {
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-real-'));
  try {
    const bareDir = path.join(root, 'bare.git');
    git(['init', '-q', '--bare', bareDir], root);

    const repoDir = path.join(root, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'one\n');
    git(['add', 'a.txt'], repoDir);
    git(['commit', '-q', '-m', 'init'], repoDir);
    git(['remote', 'add', 'origin', bareDir], repoDir);
    git(['push', '-q', '-u', 'origin', 'main'], repoDir);

    const noRemoteDir = path.join(root, 'no-remote');
    initRepo(noRemoteDir);
    fs.writeFileSync(path.join(noRemoteDir, 'b.txt'), 'x\n');
    git(['add', 'b.txt'], noRemoteDir);
    git(['commit', '-q', '-m', 'init'], noRemoteDir);

    const rows1 = await collectResidency({
      checkouts: [{ project: 'repo', path: repoDir }, { project: 'no-remote', path: noRemoteDir }],
      exec: realExec, now: () => 42,
    });
    const r1 = rows1.find((r) => r.repo === 'repo');
    assert.equal(r1.error, null, `unexpected error: ${r1.error}`);
    assert.equal(r1.residency, 'synced');
    assert.match(r1.remote, /bare\.git/);
    assert.equal(r1.defaultBranch, 'main');
    assert.equal(rows1.find((r) => r.repo === 'no-remote').residency, 'nowhere-else');

    // an unpushed local commit: ahead (and for-each-ref's real track field
    // parses as unpushed for main)
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'two\n');
    git(['commit', '-q', '-am', 'second'], repoDir);
    const rows2 = await collectResidency({ checkouts: [{ project: 'repo', path: repoDir }], exec: realExec, now: () => 1 });
    assert.equal(rows2[0].residency, 'ahead');
    assert.equal(rows2[0].ahead, 1);
    assert.ok(rows2[0].unpushedBranches.includes('main'), `expected main in unpushedBranches, got ${JSON.stringify(rows2[0].unpushedBranches)}`);

    // an uncommitted edit on top of the unpushed commit: dirty outranks ahead
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'three\n');
    const rows3 = await collectResidency({ checkouts: [{ project: 'repo', path: repoDir }], exec: realExec, now: () => 1 });
    assert.equal(rows3[0].residency, 'dirty');
    assert.ok(rows3[0].dirty > 0);
    git(['checkout', '--', 'a.txt'], repoDir); // clean the working copy back up before the worktree add below

    // a linked worktree keeps its OWN FETCH_HEAD under .git/worktrees/<id>/,
    // not under the main checkout's .git/ - the real fetchHeadMtime default
    // (not injected) must resolve through the worktree's .git FILE's
    // `gitdir:` line to find it.
    const wtDir = path.join(root, 'wt');
    git(['worktree', 'add', '-q', '-b', 'wtbranch', wtDir], repoDir);
    git(['fetch', '-q', 'origin'], wtDir);
    const rows4 = await collectResidency({ checkouts: [{ project: 'wt', path: wtDir }], exec: realExec, now: () => 99 });
    assert.equal(rows4[0].error, null, `unexpected error: ${rows4[0].error}`);
    assert.equal(typeof rows4[0].lastFetchTs, 'number');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// a detached HEAD made `symbolic-ref --short HEAD`
// exit 128 unguarded, which aborted oneRow's whole try block and turned
// the row into residency:'unknown', error:'...', discarding remote, refs
// and status too. Detached is data (a checkout can legitimately be there -
// a runner job, a bisect), not a read failure. Zero local-only work should
// still read as synced; real local-only work (a commit made while
// detached, unreachable from any branch) should read as ahead.
test('real git: a detached HEAD is data, not an error - synced with no local-only work, ahead with some', async () => {
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-detached-'));
  try {
    const bareDir = path.join(root, 'bare.git');
    git(['init', '-q', '--bare', bareDir], root);
    const repoDir = path.join(root, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'one\n');
    git(['add', 'a.txt'], repoDir);
    git(['commit', '-q', '-m', 'init'], repoDir);
    git(['remote', 'add', 'origin', bareDir], repoDir);
    git(['push', '-q', '-u', 'origin', 'main'], repoDir);

    git(['checkout', '-q', '--detach', 'main'], repoDir);
    const synced = await collectResidency({ checkouts: [{ project: 'repo', path: repoDir }], exec: realExec, now: () => 1 });
    assert.equal(synced[0].error, null, `unexpected error: ${synced[0].error}`);
    assert.equal(synced[0].defaultBranch, null);
    assert.equal(synced[0].detached, true);
    assert.equal(synced[0].residency, 'synced');

    fs.writeFileSync(path.join(repoDir, 'c.txt'), 'local only\n');
    git(['add', 'c.txt'], repoDir);
    git(['commit', '-q', '-m', 'local-only, made while detached'], repoDir);
    const ahead = await collectResidency({ checkouts: [{ project: 'repo', path: repoDir }], exec: realExec, now: () => 1 });
    assert.equal(ahead[0].error, null, `unexpected error: ${ahead[0].error}`);
    assert.equal(ahead[0].detached, true);
    assert.equal(ahead[0].residency, 'ahead');
    assert.equal(ahead[0].ahead, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// classifyResidency never looked at noUpstreamBranches,
// so a branch with no upstream configured at all (never pushed, never
// tracked) read as synced as long as the CHECKED-OUT branch happened to be
// clean - even though that other branch's commits exist only on this
// machine. Only a no-upstream branch whose own commits are unreachable
// from every remote-tracking ref is actually local-only work; one that
// merely lacks a configured upstream while sitting on an already-pushed
// commit (a local alias) is harmless and must not flip the row to ahead.
test('real git: a no-upstream branch only counts as local-only work when its commits are not reachable from any remote', async () => {
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-noupstream-'));
  try {
    const bareDir = path.join(root, 'bare.git');
    git(['init', '-q', '--bare', bareDir], root);
    const repoDir = path.join(root, 'repo');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'one\n');
    git(['add', 'a.txt'], repoDir);
    git(['commit', '-q', '-m', 'init'], repoDir);
    git(['remote', 'add', 'origin', bareDir], repoDir);
    git(['push', '-q', '-u', 'origin', 'main'], repoDir);

    // A local alias with no upstream, sitting on the already-pushed tip:
    // contained in a remote ref, so it must stay harmless.
    git(['branch', 'alias'], repoDir);
    const contained = await collectResidency({ checkouts: [{ project: 'repo', path: repoDir }], exec: realExec, now: () => 1 });
    assert.equal(contained[0].error, null, `unexpected error: ${contained[0].error}`);
    assert.ok(contained[0].noUpstreamBranches.includes('alias'));
    assert.ok(!contained[0].unpushedBranches.includes('alias'), 'a no-upstream branch fully contained in a remote ref is not unpushed work');
    assert.equal(contained[0].residency, 'synced');

    // A feature branch with a real local-only commit, no upstream, and
    // never checked out again after main - proves the check covers every
    // no-upstream branch, not just the one HEAD happens to be on.
    git(['branch', 'feature'], repoDir);
    git(['checkout', '-q', 'feature'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'f.txt'), 'feature work\n');
    git(['add', 'f.txt'], repoDir);
    git(['commit', '-q', '-m', 'local-only feature work'], repoDir);
    git(['checkout', '-q', 'main'], repoDir);

    const rows = await collectResidency({ checkouts: [{ project: 'repo', path: repoDir }], exec: realExec, now: () => 1 });
    assert.equal(rows[0].error, null, `unexpected error: ${rows[0].error}`);
    assert.ok(rows[0].noUpstreamBranches.includes('feature'));
    assert.ok(rows[0].unpushedBranches.includes('feature'), `expected feature in unpushedBranches, got ${JSON.stringify(rows[0].unpushedBranches)}`);
    assert.equal(rows[0].residency, 'ahead', 'main itself is synced, but feature carries local-only work');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Fix round 1, item 3 (fold): a fresh repo with zero commits has an unborn
// HEAD - symbolic-ref still resolves it (it names the future branch, e.g.
// 'main', without requiring the ref to point at a real object yet), so
// this was never the detached case, but every other command here
// (rev-list, for-each-ref, status) has to tolerate "nothing exists yet"
// without crashing the row.
test('real git: an unborn HEAD (a fresh repo with zero commits) reads as nowhere-else, never a crash', async () => {
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-unborn-'));
  try {
    const emptyDir = path.join(root, 'empty');
    initRepo(emptyDir);
    const rows = await collectResidency({ checkouts: [{ project: 'empty', path: emptyDir }], exec: realExec, now: () => 1 });
    assert.equal(rows[0].error, null, `unexpected error: ${rows[0].error}`);
    assert.equal(rows[0].detached, false);
    assert.equal(rows[0].residency, 'nowhere-else');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// GET /api/residency, against the real server plumbing (route registry +
// stateDir), never against a live checkout: the loop's own correctness is
// covered above, so this only proves the route reads the published file,
// 404s honestly before the first publish, and never echoes a raw fs error
// (which on a real error would carry the stateDir path) to the caller.
test('GET /api/residency: 404 before any run, 200 with the published rows, 500 with a named reason on a corrupt file', async () => {
  const { startServer } = await import('../server.js');
  const stateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-route-'));
  const claudeDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-claude-'));
  const env = {
    ...process.env,
    GLMPS_STATE_DIR: stateDir,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_UNMERGED_SCAN: 'off',
  };
  const h = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  const base = `http://127.0.0.1:${h.port}`;
  try {
    let r = await fetch(`${base}/api/residency`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'no residency yet' });

    const doc = { ts: 123, rows: [{ repo: 'x', path: '/x', residency: 'synced' }] };
    const residencyDir = path.join(stateDir, 'residency');
    fs.mkdirSync(residencyDir, { recursive: true });
    fs.writeFileSync(path.join(residencyDir, 'current.json'), JSON.stringify(doc));

    r = await fetch(`${base}/api/residency`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), doc);

    fs.writeFileSync(path.join(residencyDir, 'current.json'), 'not json{{{');
    r = await fetch(`${base}/api/residency`);
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(typeof body.error, 'string');
    assert.doesNotMatch(body.error, /[\\/]/, 'error must not echo a raw fs path');
    assert.doesNotMatch(body.error, /Unexpected token/, 'error must not echo the raw JSON.parse message');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// symbolic-ref's catch read ANY failure as a detached HEAD, the ahead/behind
// catch read any failure as "no upstream" (behind=0, so a timeout could read
// synced), and the FETCH_HEAD stat swallowed every error. Each is now named:
// only git's own definitive answer ("not a symbolic ref", "no upstream") is
// data; anything else marks the row 'unknown' with the reason.
const timeoutErr = () => Object.assign(new Error('Command failed: git'), { killed: true, signal: 'SIGTERM', code: null });
function feedExec({ symRef = null, aheadBehind = null } = {}) {
  return async (f, args) => {
    const a = stripLock(args).join(' ');
    if (a === 'remote -v') return { stdout: 'origin\thttps://x/r.git (fetch)\n' };
    if (a === 'symbolic-ref --short HEAD') { if (symRef) throw symRef(); return { stdout: 'main\n' }; }
    if (a === 'rev-list --left-right --count HEAD...@{u}') { if (aheadBehind) throw aheadBehind(); return { stdout: '0\t0\n' }; }
    if (a.startsWith('for-each-ref')) return { stdout: 'main\torigin/main\t\n' };
    if (a === 'status --porcelain') return { stdout: '' };
    if (a.startsWith('rev-list --count')) return { stdout: '0\n' };
    throw new Error(`unexpected ${a}`);
  };
}

test('silent-failure: a symbolic-ref timeout is not a detached HEAD; the row is unknown with the reason', async () => {
  const [row] = await collectResidency({ checkouts: [{ project: 'p', path: '/p' }], exec: feedExec({ symRef: timeoutErr }), statMtime: async () => 1 });
  assert.equal(row.detached, false);
  assert.equal(row.residency, 'unknown');
  assert.match(row.error, /symbolic-ref/);
  assert.match(row.error, /timed out|did not respond/);
});

test('silent-failure: an ahead/behind timeout never leaves behind=0 reading synced', async () => {
  const [row] = await collectResidency({ checkouts: [{ project: 'p', path: '/p' }], exec: feedExec({ aheadBehind: timeoutErr }), statMtime: async () => 1 });
  assert.equal(row.residency, 'unknown');
  assert.match(row.error, /ahead\/behind/);
});

test('silent-failure: "no upstream" stays data (synced), a real git answer, not an error', async () => {
  const noUp = () => new Error("fatal: no upstream configured for branch 'main'");
  const [row] = await collectResidency({ checkouts: [{ project: 'p', path: '/p' }], exec: feedExec({ aheadBehind: noUp }), statMtime: async () => 1 });
  assert.equal(row.error, null);
  assert.equal(row.residency, 'synced');
});

test('silent-failure: a FETCH_HEAD stat failure other than ENOENT is named; ENOENT (never fetched) is just null', async () => {
  const exec = feedExec();
  const [denied] = await collectResidency({ checkouts: [{ project: 'p', path: '/p' }], exec,
    statMtime: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
  assert.equal(denied.lastFetchTs, null);
  assert.match(denied.lastFetchError, /EACCES/);
  assert.equal(denied.residency, 'synced', 'lastFetchTs is informational: it does not change residency');
  const [never] = await collectResidency({ checkouts: [{ project: 'p', path: '/p' }], exec,
    statMtime: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(never.lastFetchTs, null);
  assert.equal(never.lastFetchError ?? null, null);
});


// glmps-192: a timed-out run used to leave every row's git calls queued in
// the shared limiter (Promise.all over all rows), so the next run queued
// behind them. Rows now go through a bounded pool, and once the loop's
// signal aborts no further git call is issued and no partial result returns.
test('bounded concurrency: never more than `concurrency` rows in flight at once', async () => {
  let inFlight = 0; let peak = 0;
  const base = feedExec();
  const exec = async (f, args, o) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight -= 1;
    return base(f, args, o);
  };
  const checkouts = Array.from({ length: 10 }, (_, i) => ({ project: `p${i}`, path: `/p${i}` }));
  const rows = await collectResidency({ checkouts, exec, statMtime: async () => 1, concurrency: 3 });
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.path), checkouts.map((c) => c.path), 'rows keep checkout order');
  assert.ok(peak <= 3, `peak in-flight git calls ${peak} exceeded the bound`);
});

test('abort stops enqueue: no git call is issued after the signal aborts, and the run rejects', async () => {
  const ac = new AbortController();
  const calls = [];
  const base = feedExec();
  const exec = async (f, args, o) => {
    calls.push(o.cwd);
    if (calls.length === 3) ac.abort();
    return base(f, args, o);
  };
  const checkouts = Array.from({ length: 20 }, (_, i) => ({ project: `p${i}`, path: `/p${i}` }));
  await assert.rejects(
    collectResidency({ checkouts, exec, statMtime: async () => 1, concurrency: 2, signal: ac.signal }),
    (e) => e.name === 'AbortError',
  );
  const atAbort = calls.length;
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, atAbort, 'no git call after the run settled');
  assert.ok(atAbort <= 4, `expected at most the in-flight calls after abort, got ${atAbort} of ${20 * 5}`);
});

test('an already-aborted signal issues no git call at all', async () => {
  const ac = new AbortController(); ac.abort();
  let n = 0;
  await assert.rejects(
    collectResidency({ checkouts: [{ project: 'p', path: '/p' }], exec: async () => { n += 1; return { stdout: '' }; }, statMtime: async () => 1, signal: ac.signal }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(n, 0);
});

test('the loop maker hands ctx.signal to collect', async () => {
  let seen;
  const loop = createGitRemoteFeedLoop({
    gitRepoRoots: () => [{ project: 'a', path: '/a' }],
    exec: async () => ({ stdout: '' }), writeCurrent: () => {},
    collect: async (opts) => { seen = opts.signal; return []; },
  });
  const ac = new AbortController();
  await loop.maker({ signal: ac.signal });
  assert.equal(seen, ac.signal);
});

// glmps-192 review round: every checkout keeps its own row (session-edits and
// the surface tree/diff routes map files and repo names to rows per
// checkout, and dirt and a detached HEAD's local-only commits are per
// worktree), but the repo-wide reads (remote, refs/heads, per-branch
// local-only checks) run once per git common dir and are shared.
test('real git: a dirty linked worktree of a clean primary keeps its own row; repo-wide reads run once', async () => {
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-resshare-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main', repo], repo);
    git(['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
    git(['remote', 'add', 'origin', 'https://example.invalid/r.git'], repo);
    const wt = path.join(root, 'repo-wt-feature');
    git(['worktree', 'add', '-q', '-b', 'feature', wt], repo);
    fs.writeFileSync(path.join(wt, 'wip.txt'), 'uncommitted\n');
    const seen = [];
    const exec = (f, args, o) => { seen.push(`${o.cwd}|${stripLock(args).join(' ')}`); return realExec(f, args, o); };
    const rows = await collectResidency({ checkouts: [{ project: 'repo', path: repo }, { project: 'repo-wt-feature', path: wt }], exec, now: () => 1 });
    assert.deepEqual(rows.map((r) => r.path), [repo, wt], 'one row per checkout');
    assert.equal(rows[0].dirty, 0, 'primary is clean');
    assert.ok(rows[1].dirty > 0, 'the linked worktree reports its own uncommitted work');
    assert.equal(rows[1].residency, 'dirty');
    assert.equal(rows[1].defaultBranch, 'feature');
    const count = (re) => seen.filter((s) => re.test(s.split('|')[1])).length;
    assert.equal(count(/^for-each-ref/), 1, 'refs/heads read once per repository');
    assert.equal(count(/^remote -v$/), 1, 'remote read once per repository');
    assert.equal(count(/^status --porcelain$/), 2, 'status stays per checkout');
    assert.equal(count(/^rev-list --count (main|feature) /), 2, 'each no-upstream branch checked once, not once per checkout');
    assert.deepEqual(rows[0].unpushedBranches, rows[1].unpushedBranches, 'shared repo-wide answer on both rows');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('shared reads: a detached HEAD local-only count stays per checkout; unrelated roots share nothing', async () => {
  const calls = [];
  const exec = async (f, args, { cwd }) => {
    const a = stripLock(args).join(' ');
    calls.push(`${cwd}|${a}`);
    if (a === 'remote -v') return { stdout: 'origin\thttps://x/r.git (fetch)\n' };
    if (a === 'symbolic-ref --short HEAD') { if (cwd === '/r/wt') throw new Error('fatal: ref HEAD is not a symbolic ref'); return { stdout: 'main\n' }; }
    if (a === 'rev-list --left-right --count HEAD...@{u}') return { stdout: '0\t0\n' };
    if (a.startsWith('for-each-ref')) return { stdout: 'main\torigin/main\t\nfeat\t\t\n' };
    if (a === 'status --porcelain') return { stdout: '' };
    if (a === 'rev-list --count HEAD --not --remotes') return { stdout: '2\n' };
    if (a === 'rev-list --count feat --not --remotes') return { stdout: '1\n' };
    throw new Error(`unexpected ${a}`);
  };
  const common = { '/r': '/r/.git', '/r/wt': '/r/.git', '/s': '/s/.git' };
  const rows = await collectResidency({
    checkouts: [{ project: 'r', path: '/r' }, { project: 'wt', path: '/r/wt' }, { project: 's', path: '/s' }],
    exec, statMtime: async () => 1, commonDirOf: (p) => common[p],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[1].detached, true);
  assert.equal(rows[1].ahead, 2, 'detached HEAD local-only commits counted in that worktree');
  assert.equal(rows[0].ahead, 0);
  for (const r of rows) assert.deepEqual(r.unpushedBranches, ['feat']);
  const n = (cwd, a) => calls.filter((c) => c === `${cwd}|${a}`).length;
  assert.equal(calls.filter((c) => c.endsWith('|rev-list --count feat --not --remotes')).length, 2, 'once for /r and once for /s');
  assert.equal(n('/s', 'remote -v'), 1, 'an unrelated repo still reads its own remote');
  assert.equal(calls.filter((c) => c.endsWith('|remote -v')).length, 2);
});

// Review finding 1: the rows are read per checkout by session-edits
// (longest-prefix path match) and by the surface tree/diff routes (lookup
// by repo name). Feed real rows from a repo with a nested and a sibling
// linked worktree into both consumers.
test('real git: residency rows still resolve linked-worktree edits and repo names', async () => {
  const { collectSessionEdits } = await import('../lib/surface/session-edits.js');
  const { resolveResidencyRepo } = await import('../lib/surface/repo-tree.js');
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-rescons-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main', repo], repo);
    git(['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
    const nested = path.join(repo, '.claude', 'worktrees', 'x');
    git(['worktree', 'add', '-q', '-b', 'x', nested], repo);
    const sibling = path.join(root, 'repo-runtime');
    git(['worktree', 'add', '-q', '-b', 'rt', sibling], repo);
    const checkouts = [repo, nested, sibling].map((p) => ({ project: path.basename(p), path: p }));
    const rows = await collectResidency({ checkouts, exec: realExec, now: () => 1 });
    const fwd = (p) => p.split(path.sep).join('/');
    const edits = collectSessionEdits({
      sessions: [{ id: 's', state: 'working', tool: 'claude' }],
      eventsOf: () => [path.join(nested, 'a.js'), path.join(sibling, 'b.js')].map((p) => ({ kind: 'file-edit', path: p, ts: '2026-10-26T00:00:00Z' })),
      rows, statOf: () => null, allowed: () => true, now: 1,
    }).edits;
    const byPath = Object.fromEntries(edits.map((e) => [e.path, e]));
    assert.equal(byPath[fwd(path.join(nested, 'a.js'))].repo, 'x', 'nested worktree edit maps to its own row');
    assert.equal(byPath[fwd(path.join(nested, 'a.js'))].rel, 'a.js');
    assert.equal(byPath[fwd(path.join(sibling, 'b.js'))].repo, 'repo-runtime', 'sibling worktree edit is not repo:null');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(path.join(stateDir, 'residency'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'residency', 'current.json'), JSON.stringify({ ts: 1, rows }));
    assert.equal(resolveResidencyRepo(stateDir, 'repo-runtime').row?.path, sibling, 'surface lookup by a worktree board project still resolves');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// glmps-2-0-runtime-10: a run the registry aborted on its ceiling timeout must
// stop queuing git calls on the shared limiter instead of draining into the
// next run. Since glmps-192 the aborted maker rejects rather than returning
// a partial row set.
test('an aborted maker issues no further git calls, and every exec carries the signal', async () => {
  const ac = new AbortController(); const calls = []; const signals = new Set();
  const exec = async (_f, args, opts) => {
    calls.push(args); signals.add(opts.signal);
    if (calls.length === 3) ac.abort();
    if (args.includes('remote')) return { stdout: 'origin\thttps://x/r.git (fetch)\n' };
    if (args.includes('symbolic-ref')) return { stdout: 'main\n' };
    if (args.includes('--left-right')) return { stdout: '0\t0\n' };
    return { stdout: '' };
  };
  const loop = createGitRemoteFeedLoop({
    gitRepoRoots: () => [{ project: 'a', path: '/a' }, { project: 'b', path: '/b' }],
    exec, writeCurrent: () => {}, statMtime: async () => 0,
  });
  await assert.rejects(loop.maker({ signal: ac.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 3, `no git call after the abort (saw ${calls.length})`);
  assert.deepEqual([...signals], [ac.signal]);
  const before = calls.length;
  await assert.rejects(loop.maker({ signal: ac.signal }), { name: 'AbortError' });
  assert.equal(calls.length, before, 'a maker started on an already-aborted signal issues no git call at all');
});

// glmps-196: the registry records a ceiling breach only as "timeout", so each
// run carries its own record: limiter wait vs time after the slot, call
// count, timeouts, and the run's wall time, for a run that finished and for
// one the loop abandoned.
test('run stats: calls, limiter wait vs exec time, timeouts and failures are counted per run', async () => {
  let t = 0;
  const clock = () => t;
  const base = feedExec();
  const exec = async (f, args, o) => {
    const a = stripLock(args).join(' ');
    t += 10;
    if (a === 'status --porcelain' && o.cwd === '/slow') throw Object.assign(timeoutErr(), { queuedMs: 4 });
    const r = await base(f, args, o);
    return { ...r, queuedMs: 4 };
  };
  const stats = (await import('../lib/kernel/git-remote-feed.js')).newRunStats();
  const rows = await collectResidency({
    checkouts: [{ project: 'p', path: '/p' }, { project: 'slow', path: '/slow' }],
    exec, statMtime: async () => 1, concurrency: 1, stats, clock,
    commonDirOf: (p) => `${p}/.git`,
  });
  assert.equal(rows[1].residency, 'unknown', 'the timed-out status read still fails the row');
  assert.equal(stats.gitCalls, 10, '5 reads per checkout, none shared across unrelated repos');
  assert.equal(stats.gitQueueMs, 40);
  assert.equal(stats.gitExecMs, 60);
  assert.equal(stats.maxQueueMs, 4);
  assert.equal(stats.maxExecMs, 6);
  assert.equal(stats.gitTimeouts, 1);
  assert.equal(stats.gitFailures, 0);
  assert.equal(stats.gitAborted, 0);
});

test('run stats: a git failure that is git\'s own answer counts as a failure, not a timeout', async () => {
  const stats = (await import('../lib/kernel/git-remote-feed.js')).newRunStats();
  const noUp = () => new Error("fatal: no upstream configured for branch 'main'");
  await collectResidency({ checkouts: [{ project: 'p', path: '/p' }], exec: feedExec({ aheadBehind: noUp }), statMtime: async () => 1, stats });
  assert.equal(stats.gitCalls, 5);
  assert.equal(stats.gitFailures, 1);
  assert.equal(stats.gitTimeouts, 0);
  assert.equal(stats.gitQueueMs, 0, 'an exec that reports no queuedMs counts as no limiter wait');
});

test('the loop publishes its run record and hands it to onRun after a finished run', async () => {
  let t = 100;
  const runs = []; const docs = [];
  const loop = createGitRemoteFeedLoop({
    gitRepoRoots: () => [{ project: 'p', path: '/p' }],
    exec: async (f, args, o) => { t += 7; return { ...(await feedExec()(f, args, o)), queuedMs: 2 }; },
    writeCurrent: (d) => docs.push(d), onRun: (r) => runs.push(r),
    statMtime: async () => 1, now: () => 42, clock: () => t,
  });
  const made = await loop.maker({ signal: new AbortController().signal });
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.outcome, 'done');
  assert.equal(run.startedTs, 42);
  assert.equal(run.checkouts, 1);
  assert.equal(run.gitCalls, 5);
  assert.equal(run.wallMs, 35);
  assert.equal(run.gitQueueMs, 10);
  assert.equal(run.gitExecMs, 25);
  const verdict = await loop.checker(made.result);
  assert.equal(verdict.ok, true);
  await loop.onVerified(made.result, verdict);
  assert.deepEqual(docs[0].run, run, 'the published document carries the same record');
});

test('an aborted run still reports its record: outcome aborted, its wall time, and no git call after the abort', async () => {
  const ac = new AbortController();
  let t = 0; let n = 0; const runs = [];
  const loop = createGitRemoteFeedLoop({
    gitRepoRoots: () => Array.from({ length: 10 }, (_, i) => ({ project: `p${i}`, path: `/p${i}` })),
    exec: async (f, args, o) => {
      n += 1; t += 1000;
      if (n === 4) ac.abort();
      return feedExec()(f, args, o);
    },
    writeCurrent: () => { throw new Error('an aborted run must publish nothing'); },
    onRun: (r) => runs.push(r), statMtime: async () => 1, clock: () => t,
  });
  await assert.rejects(loop.maker({ signal: ac.signal }), { name: 'AbortError' });
  const afterAbort = n;
  await new Promise((r) => setImmediate(r));
  assert.equal(n, afterAbort, 'no git call once the maker has settled');
  assert.ok(n <= 4 + 3, `at most the calls already in flight finish after the abort, saw ${n}`);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, 'aborted');
  assert.equal(runs[0].gitCalls, n, 'every call that reached git is counted');
  assert.equal(runs[0].wallMs, n * 1000);
  assert.match(runs[0].error, /aborted/);
});

test('a throwing onRun never changes the run outcome', async () => {
  const loop = createGitRemoteFeedLoop({
    gitRepoRoots: () => [{ project: 'p', path: '/p' }],
    exec: feedExec(), writeCurrent: () => {}, statMtime: async () => 1,
    onRun: () => { throw new Error('disk full'); },
  });
  const made = await loop.maker({ signal: new AbortController().signal });
  assert.equal(made.outcome, 'done');
  assert.equal(made.result.rows.length, 1);
});

// glmps-196 AC-3: a repository with several no-upstream branches answers
// their local-only checks with one `rev-list <tips> --not --remotes` instead
// of one `rev-list --count <branch>` each. A branch is local-only exactly
// when its own tip is unreachable from every remote-tracking ref, so the
// expected answer below comes from git's per-branch count, not the module.
test('real git: several no-upstream branches are checked in one batched rev-list per repository, same answer as per branch', async () => {
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-resbatch-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const commit = (m, cwd = repo) => git(['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', m], cwd);
    git(['init', '-q', '-b', 'main', repo], repo);
    commit('init');
    git(['remote', 'add', 'origin', 'https://example.invalid/r.git'], repo);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo);
    git(['branch', 'alias1'], repo);
    git(['branch', 'alias2'], repo);
    for (const b of ['wip1', 'wip2']) { git(['checkout', '-q', '-b', b, 'main'], repo); commit(b); }
    git(['checkout', '-q', 'main'], repo);
    const wt = path.join(root, 'repo-wt');
    git(['worktree', 'add', '-q', '--detach', wt, 'main'], repo);
    const truth = ['alias1', 'alias2', 'main', 'wip1', 'wip2'].filter((b) =>
      Number(execFileSync('git', ['rev-list', '--count', b, '--not', '--remotes'], { cwd: repo, encoding: 'utf-8' }).trim()) > 0);
    assert.deepEqual(truth, ['wip1', 'wip2']);
    const seen = [];
    const exec = (f, args, o) => { seen.push(stripLock(args).join(' ')); return realExec(f, args, o); };
    const rows = await collectResidency({ checkouts: [{ project: 'repo', path: repo }, { project: 'wt', path: wt }], exec, now: () => 1 });
    for (const r of rows) {
      assert.equal(r.error, null);
      assert.deepEqual(r.unpushedBranches, truth);
      assert.equal(r.residency, 'ahead');
    }
    assert.equal(seen.filter((s) => /^rev-list --count (?!HEAD )\S+ --not --remotes$/.test(s)).length, 0, 'no per-branch count');
    assert.equal(seen.filter((s) => /^rev-list [0-9a-f]{40}/.test(s)).length, 1, 'one batched read shared by both worktrees');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function batchExec({ refs, batch }) {
  return async (f, args) => {
    const a = stripLock(args).join(' ');
    if (a === 'remote -v') return { stdout: 'origin\thttps://x/r.git (fetch)\n' };
    if (a === 'symbolic-ref --short HEAD') return { stdout: 'main\n' };
    if (a === 'rev-list --left-right --count HEAD...@{u}') return { stdout: '0\t0\n' };
    if (a.startsWith('for-each-ref')) return { stdout: refs };
    if (a === 'status --porcelain') return { stdout: '' };
    if (/^rev-list [0-9a-f]{40}/.test(a)) return batch(a);
    const m = a.match(/^rev-list --count (\S+) --not --remotes$/);
    if (m) return { stdout: m[1].startsWith('wip') ? '1\n' : '0\n' };
    throw new Error(`unexpected ${a}`);
  };
}
const tip = (c) => c.repeat(40);
const threeNoUpstream = `main\torigin/main\t\t${tip('0')}\nalias\t\t\t${tip('a')}\nwip1\t\t\t${tip('b')}\nwip2\t\t\t${tip('c')}\n`;

test('batched local-only check: a failed batch read makes the row unknown, never zero local-only', async () => {
  const rows = await collectResidency({
    checkouts: [{ project: 'p', path: '/p' }], statMtime: async () => 1,
    exec: batchExec({ refs: threeNoUpstream, batch: () => { throw new Error('fatal: out of memory'); } }),
  });
  assert.equal(rows[0].residency, 'unknown');
  assert.match(rows[0].error, /local-only check failed/);
  assert.deepEqual(rows[0].noUpstreamBranches, ['alias', 'wip1', 'wip2'], 'fields read before the check survive');
});

test('batched local-only check: a rev-list line that is not an object name makes the row unknown', async () => {
  const rows = await collectResidency({
    checkouts: [{ project: 'p', path: '/p' }], statMtime: async () => 1,
    exec: batchExec({ refs: threeNoUpstream, batch: () => ({ stdout: `${tip('b')}\nwarning: something\n` }) }),
  });
  assert.equal(rows[0].residency, 'unknown');
  assert.match(rows[0].error, /local-only check failed/);
});

test('batched local-only check: the tips in the output are the local-only branches', async () => {
  const calls = [];
  const rows = await collectResidency({
    checkouts: [{ project: 'p', path: '/p' }], statMtime: async () => 1,
    exec: batchExec({ refs: threeNoUpstream, batch: (a) => { calls.push(a); return { stdout: `${tip('b')}\n${tip('d')}\n${tip('c')}\n` }; } }),
  });
  assert.equal(rows[0].error, null);
  assert.deepEqual(rows[0].unpushedBranches, ['wip1', 'wip2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `rev-list ${tip('a')} ${tip('b')} ${tip('c')} --not --remotes`);
});

test('batched local-only check: a branch with no readable tip falls back to the per-branch count', async () => {
  const calls = [];
  const refs = `alias\t\t\t${tip('a')}\nwip1\t\t\t\nwip2\t\t\t${tip('c')}\n`;
  const rows = await collectResidency({
    checkouts: [{ project: 'p', path: '/p' }], statMtime: async () => 1,
    exec: batchExec({ refs, batch: (a) => { calls.push(a); return { stdout: '' }; } }),
  });
  assert.equal(calls.length, 0, 'no batch when any tip is missing');
  assert.deepEqual(rows[0].unpushedBranches, ['wip1', 'wip2']);
  assert.equal(rows[0].residency, 'ahead');
});

// Security scan F5 (card glmps-2-0-runtime-105, CWE-212): a remote URL with
// embedded credentials must never reach current.json or GET /api/residency.
test('F5: stripRemoteUserinfo drops URL credentials, keeps every other remote form unchanged', async () => {
  const { stripRemoteUserinfo } = await import('../lib/kernel/git-remote-feed.js');
  assert.equal(stripRemoteUserinfo('https://user:TOKEN@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(stripRemoteUserinfo('https://TOKEN@github.com/o/r'), 'https://github.com/o/r');
  assert.equal(stripRemoteUserinfo('https://user:p@ss@github.com/o/r.git'), 'https://github.com/o/r.git', 'the last @ in the authority ends the userinfo');
  assert.equal(stripRemoteUserinfo('ssh://git:pw@host:2222/o/r.git'), 'ssh://host:2222/o/r.git');
  assert.equal(stripRemoteUserinfo('https://gitlab.example/g/sub/r.git'), 'https://gitlab.example/g/sub/r.git');
  assert.equal(stripRemoteUserinfo('https://host/o/r@v1'), 'https://host/o/r@v1', 'an @ in the path is not userinfo');
  assert.equal(stripRemoteUserinfo('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.equal(stripRemoteUserinfo('D:/repos/r.git'), 'D:/repos/r.git');
  assert.equal(stripRemoteUserinfo(null), null);
});

test('F5: collectResidency never stores a remote URL\'s userinfo', async () => {
  const exec = async (f, args) => {
    const a = stripLock(args).join(' ');
    if (a === 'remote -v') return { stdout: 'origin\thttps://bob:ghp_SECRET@github.com/o/r.git (fetch)\norigin\thttps://bob:ghp_SECRET@github.com/o/r.git (push)\n' };
    return feedExec()(f, args);
  };
  const [row] = await collectResidency({ checkouts: [{ project: 'a', path: '/a' }], exec, now: () => 1, statMtime: async () => 1 });
  assert.equal(row.remote, 'https://github.com/o/r.git');
  assert.equal(row.residency, 'synced');
  assert.doesNotMatch(JSON.stringify(row), /SECRET|bob/);
});

test('F5: GET /api/residency redacts userinfo in a file written before the fix', async () => {
  const { startServer } = await import('../server.js');
  const stateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-f5-'));
  const claudeDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-residency-f5-claude-'));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    fs.mkdirSync(path.join(stateDir, 'residency'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'residency', 'current.json'), JSON.stringify({ ts: 1, rows: [
      { repo: 'x', path: '/x', remote: 'https://bob:ghp_SECRET@github.com/o/r.git', residency: 'synced' },
      { repo: 'y', path: '/y', remote: null, residency: 'nowhere-else' },
    ] }));
    const r = await fetch(`http://127.0.0.1:${h.port}/api/residency`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.rows[0].remote, 'https://github.com/o/r.git');
    assert.equal(body.rows[1].remote, null);
    assert.doesNotMatch(JSON.stringify(body), /SECRET|bob/);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
