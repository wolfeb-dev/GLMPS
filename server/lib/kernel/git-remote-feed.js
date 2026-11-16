// server/lib/kernel/git-remote-feed.js
// The git-remote feed (K5, D10): per registered checkout, five read-only git
// reads folded into one residency fact row - whether this checkout's work
// also exists somewhere else (pushed) or only on this machine. Async exec
// behind a limiter only; never execFileSync on the event loop (memory
// node-event-loop-git-subprocess-guard).
//
// Separation ruling: this feed also runs against the operator's real
// checkouts (the 2.0 shadow instance reads them as shared, read-only
// input). Every git call this module makes must therefore be strictly
// read-only - including git's own opportunistic index refresh, which
// --no-optional-locks turns off. The one choke point below (`run`, inside
// oneRow) is the only place this module ever calls `exec('git', ...)`, and
// it prepends that flag unconditionally; nothing here ever fetches, pulls,
// pushes, gcs or updates a ref.
import fs from 'node:fs';
import path from 'node:path';
import { gitCommonDir, commonDirKey } from '../orchestration/git-common-dir.js';

// Scan F5 (CWE-212): a remote like https://user:TOKEN@host/o/r carries a
// credential, and rows are served to paired clients. Only the userinfo goes;
// the rest is kept verbatim (not canonicalRemote, which nulls any remote it
// cannot canonicalize and would turn a GitLab subgroup into 'nowhere-else').
// The authority ends at the first / ? or #, and its LAST @ ends the userinfo.
export function stripRemoteUserinfo(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is.exec(raw);
  if (!m) return raw;
  const at = m[2].lastIndexOf('@');
  return at < 0 ? raw : m[1] + m[2].slice(at + 1) + m[3];
}

export function parseRemotes(out) { const m = String(out).match(/^\S+\t(\S+)\s+\(fetch\)/m); return m ? stripRemoteUserinfo(m[1]) : null; }
export function parseAheadBehind(out) { const [a, b] = String(out).trim().split(/\s+/).map(Number); return { ahead: a || 0, behind: b || 0 }; }
export function parseRefs(out) {
  const unpushedBranches = []; const noUpstreamBranches = [];
  for (const line of String(out).split('\n').filter(Boolean)) {
    const [name, upstream = '', track = ''] = line.split('\t');
    if (!upstream) noUpstreamBranches.push(name);
    else if (/ahead \d+/.test(track)) unpushedBranches.push(name);
  }
  return { unpushedBranches, noUpstreamBranches };
}
// The fourth for-each-ref field is the branch tip, which the batched
// local-only check matches its rev-list output against.
export function parseRefTips(out) {
  const tips = new Map();
  for (const line of String(out).split('\n').filter(Boolean)) {
    const [name, , , sha = ''] = line.split('\t');
    tips.set(name, sha.trim());
  }
  return tips;
}
export function parsePorcelain(out) { return String(out).split('\n').filter((l) => l.trim()).length; }

export function classifyResidency(r) {
  if (!r.remote) return 'nowhere-else';
  if (r.dirty > 0) return 'dirty';
  if (r.ahead > 0 && r.behind > 0) return 'diverged';
  if (r.behind > 0) return 'behind';
  if (r.ahead > 0 || (r.unpushedBranches || []).length) return 'ahead';
  return 'synced';
}

// FETCH_HEAD is per-worktree (verified against real git: a linked worktree
// keeps it under <main>/.git/worktrees/<id>/FETCH_HEAD, not the shared
// top-level .git/FETCH_HEAD), so a worktree's own .git is a FILE whose
// `gitdir:` line has to be resolved first.
async function fetchHeadMtime(dir) {
  let gitDir = path.join(dir, '.git');
  const st = await fs.promises.stat(gitDir);
  if (st.isFile()) {
    const m = (await fs.promises.readFile(gitDir, 'utf8')).match(/^gitdir:\s*(.+)$/m);
    if (m) gitDir = path.resolve(dir, m[1].trim());
  }
  return (await fs.promises.stat(path.join(gitDir, 'FETCH_HEAD'))).mtimeMs;
}

// A read-only count of commits reachable from `rev` but not from any
// remote-tracking ref - "work that exists only on this machine", for
// whatever `rev` names (HEAD itself, or a branch). Deliberately does NOT
// swallow its own failure to 0: a 0 reads as "nothing
// local-only", so a failed sub-query defaulting to 0 would report a false
// synced/ahead - exactly the false negative this feed exists to prevent.
// Fix round 2's carry-in: non-numeric stdout is the same class of failure
// as a thrown exec and must not fail open to 0 either, so it throws a named
// error instead of coercing. The caller (oneRow) is what decides what a
// failure here means for the row as a whole.
// `Number(raw)` accepts hex ("0x10"), scientific
// notation ("1e3"), a leading sign ("-1"), and even an empty string (0) as
// finite - none of those are what `git rev-list --count` ever legitimately
// prints (always a plain non-negative decimal string). Validate the raw
// text itself, not what Number() is willing to coerce it into.
async function localOnlyCount(run, rev) {
  const raw = String(await run(['rev-list', '--count', rev, '--not', '--remotes'])).trim();
  if (!/^\d+$/.test(raw)) {
    const err = new Error(`rev-list --count returned non-numeric stdout: ${JSON.stringify(raw)}`);
    err.name = 'NonNumericRevListCountError';
    throw err;
  }
  return Number(raw);
}

// glmps-196: one rev-list per repository for its no-upstream branches
// instead of one per branch (96 of the 315 calls a live run made). A branch
// has local-only commits exactly when its tip is unreachable from every
// remote-tracking ref, and then the tip itself is in the output of
// `rev-list <tips> --not --remotes`. Same fail-closed rule as
// localOnlyCount: an output line that is not an object name throws rather
// than reading as "nothing local-only". Below BATCH_MIN branches, or when
// any tip is unreadable, the per-branch count is no more calls and needs
// no tips, so it stays. Tips go in chunks to stay under the Windows command
// line limit, and the output (every local-only commit, a whole history for
// a repo that was never pushed) gets a buffer well above execFile's 1 MB.
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BATCH_MIN = 3;
const TIP_CHUNK = 200;
function batchable(names, tips) {
  return names.length >= BATCH_MIN && names.every((n) => SHA.test(tips.get(n) || ''));
}
async function localOnlyBranches(run, names, tips) {
  const shas = names.map((n) => tips.get(n));
  const unique = [...new Set(shas)];
  const localOnly = new Set();
  for (let i = 0; i < unique.length; i += TIP_CHUNK) {
    const raw = String(await run(['rev-list', ...unique.slice(i, i + TIP_CHUNK), '--not', '--remotes'], { maxBuffer: 256 * 1024 * 1024 }));
    for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!SHA.test(line)) throw Object.assign(new Error(`rev-list returned a non-object line: ${JSON.stringify(line.slice(0, 80))}`), { name: 'NonObjectRevListLineError' });
      localOnly.add(line);
    }
  }
  return names.filter((_, i) => localOnly.has(shas[i]));
}

// Phase K final review (silent-failure): a git failure is only DATA when it
// is git's own definitive answer. Everything else (a timeout, a missing git,
// a crash) is a named read failure that makes the row 'unknown'.
function gitFailureText(e) {
  if (e?.killed || e?.signal || e?.code === 'ETIMEDOUT') return 'git timed out';
  if (e?.code === 'ENOENT') return 'git is not installed or not on PATH';
  return String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).pop() || 'unknown error';
}
const gitSays = (e, re) => !(e?.killed || e?.signal) && re.test(`${e?.stderr ?? ''}\n${e?.message ?? ''}`);

async function oneRow({ project, path: dir }, { exec, now, statMtime, shared, signal }) {
  const row = {
    repo: project, path: dir, remote: null, defaultBranch: null, detached: false, ahead: 0, behind: 0,
    unpushedBranches: [], noUpstreamBranches: [], dirty: 0, lastFetchTs: null,
    residency: 'unknown', error: null, ts: now(),
  };
  try {
    // The sole choke point: every git invocation this module makes goes
    // through here, and every one of them carries --no-optional-locks.
    // The signal also reaches exec so the loop's timeout can kill a call
    // already in flight (glmps-2-0-runtime-10). execFile rejects a null
    // signal, so it is only passed when there is one.
    const opts = signal ? { cwd: dir, signal } : { cwd: dir };
    const run = async (args, extra) => (await exec('git', ['--no-optional-locks', ...args], extra ? { ...opts, ...extra } : opts)).stdout;
    // Repo-wide reads (remote config, refs/heads, a named branch's
    // local-only count) give the same answer from every worktree of one
    // repository, so they go through `repoRun` and are issued once per
    // common dir. Status, symbolic-ref, HEAD's ahead/behind and a detached
    // HEAD's count are per worktree and always use `run`.
    const repoRun = (args, extra) => shared(args, () => run(args, extra));
    row.remote = parseRemotes(await repoRun(['remote', '-v']));
    // a detached HEAD (a runner job, a bisect) makes
    // `symbolic-ref` exit non-zero - that is data (no current branch name),
    // not a read failure, and must not abort the rest of the row. Phase K
    // final review: only git's own "not a symbolic ref" answer is a detached
    // HEAD; a timeout or any other failure is a named read failure.
    const readIssues = [];
    try {
      row.defaultBranch = String(await run(['symbolic-ref', '--short', 'HEAD'])).trim() || null;
    } catch (e) {
      if (gitSays(e, /not a symbolic ref/i)) row.detached = true;
      else readIssues.push(`symbolic-ref failed: ${gitFailureText(e)}`);
    }
    // No upstream (or a detached HEAD, which has no @{u} at all) is git's own
    // answer: ahead/behind stay 0. Anything else (a timeout above all) must
    // not leave behind=0 reading as synced.
    try { Object.assign(row, parseAheadBehind(await run(['rev-list', '--left-right', '--count', 'HEAD...@{u}']))); }
    catch (e) {
      if (!gitSays(e, /no upstream|no such branch|does not point to a branch|unknown revision|ambiguous argument/i)) readIssues.push(`ahead/behind read failed: ${gitFailureText(e)}`);
    }
    const refsOut = await repoRun(['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(objectname)', 'refs/heads']);
    Object.assign(row, parseRefs(refsOut));
    row.dirty = parsePorcelain(await run(['status', '--porcelain']));
    // Never fetched (ENOENT) is a plain null. Any other stat failure is
    // named in lastFetchError; lastFetchTs is informational and does not
    // change residency.
    try { row.lastFetchTs = await statMtime(dir); }
    catch (e) {
      row.lastFetchTs = null;
      if (e?.code !== 'ENOENT') row.lastFetchError = `FETCH_HEAD unreadable (${e?.code || e?.message || e})`;
    }
    if (readIssues.length) {
      row.error = readIssues.join('; ');
      row.residency = 'unknown';
      return row;
    }

    // Fix round 1, items 1 and 2, and fix round 2's ruling on how their
    // shared local-only check fails: everything above this point (remote,
    // defaultBranch/detached, the base ahead/behind, refs, dirty,
    // lastFetchTs) is already gathered and must survive regardless of what
    // happens next. A failed local-only check must not read as "nothing
    // local-only" (that is the false negative fix round 1 exists to
    // prevent), so it gets its own try/catch here rather than one that
    // swallows to 0 or one that escapes to the outer catch and discards
    // everything above: on failure, every field already on `row` stays as
    // it is, the reason names which rev's check failed, and the row is
    // honestly 'unknown' instead of a residency guessed from incomplete
    // data.
    let checking = null;
    try {
      if (row.detached) {
        // HEAD...@{u} above never had an upstream to compare against, so
        // ahead/behind are always 0 at this point regardless of real
        // local-only work. Count commits on HEAD unreachable from any
        // remote-tracking ref instead: >0 IS the local-only work a
        // detached checkout can have; classifyResidency already turns
        // that into 'ahead' (or 'nowhere-else' first, with no remote).
        checking = 'HEAD';
        row.ahead = await localOnlyCount(run, 'HEAD');
      }
      // A branch with no upstream configured is not thereby unpushed - it
      // may sit on a commit some OTHER already-pushed ref also reaches (a
      // local alias). Only a no-upstream branch whose OWN commits are
      // unreachable from every remote-tracking ref is real local-only
      // work, checked for every branch in the checkout, not only the one
      // HEAD happens to be on.
      const tips = parseRefTips(refsOut);
      let localOnlyNoUpstream = [];
      if (batchable(row.noUpstreamBranches, tips)) {
        checking = `${row.noUpstreamBranches.length} branches`;
        localOnlyNoUpstream = await localOnlyBranches(repoRun, row.noUpstreamBranches, tips);
      } else {
        for (const name of row.noUpstreamBranches) {
          checking = name;
          if ((await localOnlyCount(repoRun, name)) > 0) localOnlyNoUpstream.push(name);
        }
      }
      row.unpushedBranches = [...row.unpushedBranches, ...localOnlyNoUpstream];
      row.residency = classifyResidency(row);
    } catch (e) {
      row.error = `local-only check failed for ${checking}: ${String(e?.message || e).split('\n')[0]}`;
      row.residency = 'unknown';
    }
  } catch (e) {
    row.error = String(e?.message || e);
  }
  return row;
}

function abortError() { return Object.assign(new Error('residency run aborted'), { name: 'AbortError', code: 'ABORT_ERR' }); }

// glmps-192: rows go through a bounded pool, and the loop's signal is
// checked before every git call. Under Promise.all a timed-out run left all
// of its rows' calls queued in the shared git limiter, and the next run
// queued behind them. An aborted run rejects rather than returning the rows
// it got through, so a partial set is never published.
// Every checkout keeps its own row (session-edits and the surface routes
// map files and repo names to rows per checkout), but linked worktrees of
// one repository share its repo-wide reads, memoised per run by git common
// dir. A checkout whose common dir cannot be read shares with nothing.
// glmps-196: `stats`, when given, is filled in as the run goes, so a run
// the loop abandons on its ceiling still says where its time went: calls
// that reached exec, the summed and worst limiter wait (`queuedMs`, which
// the server's exec adapter reports on its result or error) and the
// summed and worst time spent after that, plus timeouts, other failures
// and calls cut short by the abort. A long wall time with small sums is a
// stall of the host or the event loop, not slow git.
export function newRunStats() {
  return { gitCalls: 0, gitQueueMs: 0, gitExecMs: 0, maxQueueMs: 0, maxExecMs: 0, gitTimeouts: 0, gitFailures: 0, gitAborted: 0 };
}
function timedExec(exec, stats, clock) {
  const tally = (t0, queuedMs, err) => {
    const total = Math.max(0, clock() - t0);
    const queue = Math.min(total, Math.max(0, Number(queuedMs) || 0));
    stats.gitCalls += 1;
    stats.gitQueueMs += queue; stats.maxQueueMs = Math.max(stats.maxQueueMs, queue);
    stats.gitExecMs += total - queue; stats.maxExecMs = Math.max(stats.maxExecMs, total - queue);
    if (!err) return;
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR') stats.gitAborted += 1;
    else if (err.killed || err.signal || err.code === 'ETIMEDOUT') stats.gitTimeouts += 1;
    else stats.gitFailures += 1;
  };
  return async (f, a, o) => {
    const t0 = clock();
    let r;
    try { r = await exec(f, a, o); } catch (e) { tally(t0, e?.queuedMs, e || {}); throw e; }
    tally(t0, r?.queuedMs, null);
    return r;
  };
}

export async function collectResidency({ checkouts, exec, now = Date.now, statMtime = fetchHeadMtime, signal = null, concurrency = 4, commonDirOf = gitCommonDir, stats = null, clock = Date.now }) {
  if (signal?.aborted) throw abortError();
  const counted = stats ? timedExec(exec, stats, clock) : exec;
  const guarded = (f, a, o) => (signal?.aborted ? Promise.reject(abortError()) : counted(f, a, o));
  const memo = new Map();
  const sharedFor = (dir) => {
    let cd = null;
    try { cd = commonDirOf(dir); } catch { cd = null; }
    const group = cd ? `cd:${commonDirKey(cd)}` : `dir:${dir}`;
    return (args, read) => {
      const k = JSON.stringify([group, ...args]);
      if (!memo.has(k)) memo.set(k, read());
      return memo.get(k);
    };
  };
  const rows = new Array(checkouts.length);
  let next = 0;
  const worker = async () => {
    while (next < checkouts.length && !signal?.aborted) {
      const i = next++;
      rows[i] = await oneRow(checkouts[i], { exec: guarded, now, statMtime, shared: sharedFor(checkouts[i].path), signal });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, checkouts.length)) }, worker));
  if (signal?.aborted) throw abortError();
  return rows;
}

// The loop's parts, testable without the server. The checker is a
// different actor from the maker (it counts rows against the checkouts it
// was asked for), and the publish (onVerified) happens only after it
// passes.
// `collect` is injectable (Phase K final review minor: replaces the old
// dropRowFor test seam that lived on this production object).
// glmps-196: every run, finished or not, ends in one `onRun(run)` call with
// its stats and wall time. The registry stops waiting for the maker when the
// ceiling fires, so a timed-out run's numbers only exist if the maker itself
// hands them over once its in-flight calls settle; the published document
// carries the same record for a run that finished.
export function createGitRemoteFeedLoop({ gitRepoRoots, exec, writeCurrent, onRun = () => {}, now = Date.now, clock = Date.now, statMtime = fetchHeadMtime, collect = collectResidency }) {
  const self = {
    maker: async (ctx) => {
      const checkouts = gitRepoRoots();
      const run = { startedTs: now(), checkouts: checkouts.length, outcome: 'running', wallMs: null, ...newRunStats() };
      const t0 = clock();
      try {
        const rows = await collect({ checkouts, exec, now, statMtime, signal: ctx?.signal, stats: run, clock });
        run.outcome = 'done';
        return { outcome: 'done', result: { expected: checkouts.map((c) => c.path), rows, run } };
      } catch (e) {
        run.outcome = e?.name === 'AbortError' ? 'aborted' : 'failed';
        run.error = String(e?.message || e);
        throw e;
      } finally {
        run.wallMs = Math.max(0, clock() - t0);
        try { onRun({ ...run }); } catch { /* reporting must never fail the run */ }
      }
    },
    checker: async ({ expected, rows }) => {
      const missing = expected.filter((p) => !rows.some((r) => r.path === p));
      const broken = rows.filter((r) => r.error);
      if (missing.length) return { ok: false, reason: `no row for ${missing.length} checkout(s): ${missing.slice(0, 3).join(', ')}` };
      if (rows.length && broken.length > rows.length / 2) return { ok: false, reason: `${broken.length} of ${rows.length} checkouts failed to read` };
      return { ok: true, verifierRef: `residency@${rows.length}` };
    },
    onVerified: async ({ rows, run }) => { writeCurrent(run ? { ts: now(), rows, run } : { ts: now(), rows }); },
  };
  return self;
}
