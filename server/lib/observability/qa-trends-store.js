// server/lib/observability/qa-trends-store.js
//
// QA Trends panel backend (docs/superpowers/specs/2026-07-14-qa-trends-design.md).
// Append-only NDJSON store at <stateDir>/qa-trends/history.ndjson, one point per
// CI run, deduped by runId. Mirrors usage-store.js / event-log.js conventions:
// synchronous fs, tolerant reads (malformed lines skipped, missing file -> []),
// fail-open writes.
//
// Point shape (EXACT, per the design's API contract):
//   { ts, runId, sha, testCount, pass, fail, conclusion, openIssues, source }
//
// `source` ('ci' | 'local', added for "option C" local full-suite capture --
// docs/superpowers/specs/2026-07-14-qa-trends-design.md): the CI sampler below
// tags every point source:'ci'. hooks/qa-trends-local.js (a PostToolUse hook
// on a full-suite `npm test`) writes source:'local' points directly via
// appendPoint, with runId:null -- a local run has no CI run id to dedupe on,
// so appendPoint/readQaTrends both special-case runId===null as "no dedup key,
// always keep" rather than "malformed, drop" (see appendPoint/readQaTrends
// below). A legacy point written before this field existed has no `source` key
// at all; readQaTrends defaults that to 'ci' on read -- no on-disk migration.
//
// This module is split in two halves:
//   1. PURE parsing/shaping logic (parseTestSummary, runToPoint, parseRunListJson,
//      parseOpenIssuesCount) + the plain store (readQaTrends/appendPoint/hasRunId).
//      No I/O beyond fs; fully unit-tested with fixtures, no network.
//   2. The `gh`/git I/O glue (ghRunListJson/ghRunLog/ghOpenIssueCount, unexported)
//      and the orchestrating samplers built on it (sampleLatestRun/backfillHistory/
//      qaTrendsTick, exported for server.js to wire up). These are not covered by
//      network-dependent unit tests, matching hooks/ci-status-surface.js's own
//      pure-core-vs-CLI-glue split.
//
// Event-loop discipline (per this repo's node-event-loop-git-subprocess-guard
// lesson: server/server.js's worktree sweeper used to run execFileSync per repo
// and measured 17+ seconds of blocked event loop): the gh glue here uses
// promisified (async) execFile, never execFileSync. A single sample makes one
// gh call per CI job plus 3; a cold backfill repeats that per run, all timeout-
// bounded and awaited one at a time (never Promise.all - gh's own rate limits
// and log-fetch cost make sequential the safer default), so the event loop is
// only ever briefly touched between awaits, never held for the whole chain.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Bounded per the design/build spec: ~8s for the (potentially large) log fetch;
// list/issue-count calls are small JSON payloads and get a tighter bound.
export const GH_LIST_TIMEOUT_MS = 5000;
export const GH_LOG_TIMEOUT_MS = 8000;
export const GH_ISSUE_TIMEOUT_MS = 5000;
// `gh run view --log` for a 3-leg matrix running the full suite can run to
// several MB; Node's execFile default maxBuffer (1MB) would truncate/throw.
const LOG_MAX_BUFFER = 64 * 1024 * 1024;


export function qaTrendsFile(stateDir) {
  return path.join(stateDir, 'qa-trends', 'history.ndjson');
}

// Tolerant read: missing file -> [], malformed/incomplete lines skipped.
// Always returns points sorted ascending by ts (the API contract's ordering).
//
// runId validity: a finite number (CI point, dedup key) OR explicitly null
// (local point, no dedup key) is valid; anything else (missing/undefined,
// string, NaN) is malformed and the record is dropped, same as before this
// field grew a null case.
//
// source defaulting: any record whose `source` isn't exactly 'local' is
// reported as 'ci' -- covers legacy rows with no `source` key at all (no
// on-disk migration needed) as well as any unrecognized/garbage value.
export function readQaTrends(stateDir) {
  let raw;
  try {
    raw = fs.readFileSync(qaTrendsFile(stateDir), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const runIdValid = rec.runId === null || (typeof rec.runId === 'number' && Number.isFinite(rec.runId));
    if (!runIdValid) continue;
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) continue;
    rows.push(rec.source === 'local' ? rec : { ...rec, source: 'ci' });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

const AFFECTED_WINDOW_DAYS = 7;

// The /api/qa-trends body. A narrowed run (scope 'affected', card
// glmps-2-0-155) counts a few hundred tests, so on the chart it would read as
// a suite collapse; it is summarised beside the series instead.
export function qaTrendsView(points, { now = Date.now() } = {}) {
  const since = now - AFFECTED_WINDOW_DAYS * 86400000;
  const series = [];
  let runs = 0, failedRuns = 0, lastTs = null;
  for (const p of points) {
    if (p?.scope !== 'affected') { series.push(p); continue; }
    if (!(p.ts >= since && p.ts <= now)) continue;
    runs += 1;
    if (p.conclusion === 'failure' || p.fail > 0) failedRuns += 1;
    if (lastTs === null || p.ts > lastTs) lastTs = p.ts;
  }
  return { points: series, affected: { runs, failedRuns, lastTs, windowDays: AFFECTED_WINDOW_DAYS } };
}

export function hasRunId(stateDir, runId) {
  return readQaTrends(stateDir).some(p => p.runId === runId);
}

// Append one point, deduped by runId. Fail-open: any I/O error (missing/locked
// dir, read-only FS) is swallowed and returns false, same posture as
// event-log.js's appendEvents. The dedup check + the write below are both
// synchronous with no `await` between them, so concurrent async callers can
// never race each other into writing a duplicate line for the same runId --
// whichever call's synchronous check-then-append turn runs first "wins" and
// every later one observes it via fs before writing.
//
// runId:null (a local full-suite point -- hooks/qa-trends-local.js -- has no
// CI run id to dedupe on) is a valid point shape but is NEVER deduped: every
// local `npm test` run is its own point. Only a genuine numeric runId gets
// the hasRunId dedup check. Anything else (undefined/missing, a string, NaN)
// is still rejected outright, same as before this field grew a null case.
export function appendPoint(stateDir, point) {
  if (!point || typeof point !== 'object') return false;
  const hasNumericRunId = typeof point.runId === 'number' && Number.isFinite(point.runId);
  if (point.runId !== null && !hasNumericRunId) return false;
  try {
    if (hasNumericRunId && hasRunId(stateDir, point.runId)) return false;
    const dir = path.join(stateDir, 'qa-trends');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(qaTrendsFile(stateDir), JSON.stringify(point) + '\n');
    return true;
  } catch {
    return false;
  }
}


// `gh run list ... --json ...` stdout -> array of run objects, newest-first
// per gh's own ordering. Never throws; anything unparseable/non-array -> [].
export function parseRunListJson(stdout) {
  try {
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// `gh issue list --state open --json number` stdout -> open issue count.
// Never throws; anything unparseable/non-array becomes 0.
export function parseOpenIssuesCount(stdout) {
  try {
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

// `gh run view <id> --log` stdout -> { testCount, pass, fail } | null.
// Node's built-in test runner (`node --test`) emits a TAP-style summary block
// with lines like `# tests 2405` / `# pass 2364` / `# fail 0`. gh's --log
// output prefixes every line with `<job>\t<step>\t<timestamp> ` (see the CI
// matrix in .github/workflows/ci.yml: 3 legs all running `npm test` against
// the same commit), so these are matched anywhere in the line, not anchored
// to line-start, and the whole log (all legs concatenated) is scanned.
//
// testCount/pass are taken from the FIRST matching leg (all legs run the
// identical suite on the same checkout, so they should agree); fail takes the
// MAX across legs, per the design spec ("for a failed run, fail comes from
// the failing leg - max fail across legs is acceptable") so one leg's flake/
// failure is never masked by another leg's clean run appearing first.
// glmps-149: `node --test` emits the TAP summary ("# tests N") when its output
// is piped, but the spec reporter's ("i tests N", U+2139) when a leg runs under
// a TTY-ish environment. Measured on run 29954154238's real log: 2 legs printed
// the spec form and 1 printed TAP. Matching only "#" meant a run whose legs all
// used the spec reporter parsed to null and was recorded with no counts.
const MARKER = '(?:#|\u2139)';

export function parseTestSummary(logText) {
  if (typeof logText !== 'string' || !logText) return null;
  const counts = (field) =>
    [...logText.matchAll(new RegExp(`${MARKER}\\s*${field}\\s+(\\d+)`, 'g'))].map(m => Number(m[1]));
  const tests = counts('tests');
  const pass = counts('pass');
  const fail = counts('fail');
  if (!tests.length || !pass.length || !fail.length) return null;
  return {
    testCount: tests[0],
    pass: pass[0],
    fail: Math.max(...fail),
  };
}

// `gh run view --log` can transiently fail on a run that has only just
// completed (GitHub has not finished assembling the log archive). runToPoint
// deliberately still records the point, since conclusion/sha/openIssues are
// real signal on their own -- but hasRunId then made every later tick skip that
// run forever, so a momentary failure became permanent missing data. These two
// let a later tick find and fill in what it missed.

// CI points recorded with no testCount, newest first. Local points are excluded:
// they have no run id and nothing to re-fetch.
export function unparsedRunIds(stateDir, limit = Infinity) {
  const out = [];
  for (const p of readQaTrends(stateDir).slice().reverse()) {
    if (p.source === 'local') continue;
    if (typeof p.runId !== 'number') continue;
    if (p.testCount != null) continue;
    out.push(p.runId);
    if (out.length >= limit) break;
  }
  return out;
}

// Fill in the counts for an already-recorded run. Rewrites the file rather than
// appending, so the store keeps exactly one record per runId and readQaTrends
// needs no last-wins dedup rule. Returns false when the run is unknown or
// already has counts -- repair never overwrites a good parse with a later one.
export function repairPoint(stateDir, runId, summary) {
  if (typeof runId !== 'number' || !Number.isFinite(runId)) return false;
  if (!summary || !Number.isFinite(summary.testCount)) return false;
  const points = readQaTrends(stateDir);
  const target = points.find(p => p.runId === runId);
  if (!target || target.testCount != null) return false;
  const repaired = points.map(p => (p.runId === runId
    ? { ...p, testCount: summary.testCount, pass: summary.pass ?? null, fail: summary.fail ?? null }
    : p));
  try {
    const dir = path.join(stateDir, 'qa-trends');
    fs.mkdirSync(dir, { recursive: true });
    const file = qaTrendsFile(stateDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, repaired.map(p => JSON.stringify(p)).join('\n') + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// A `gh run list --json databaseId,conclusion,status,headSha,createdAt` element
// (+ a parsed test summary + an open-issue count) -> the store's point shape,
// or null if the run isn't usable (not completed, no id, unparseable date).
// summary may be null (log fetch/parse failed) -- the point is still recorded
// with null testCount/pass/fail rather than dropped entirely, since conclusion/
// sha/openIssues are still meaningful signal on their own.
export function runToPoint(run, summary, openIssues) {
  if (!run || typeof run !== 'object') return null;
  if (run.status !== 'completed') return null;
  if (typeof run.databaseId !== 'number' || !Number.isFinite(run.databaseId)) return null;
  const ts = Date.parse(run.createdAt);
  if (!Number.isFinite(ts)) return null;
  const sha = typeof run.headSha === 'string' && run.headSha ? run.headSha.slice(0, 7) : null;
  const s = summary && typeof summary === 'object' ? summary : null;
  return {
    ts,
    runId: run.databaseId,
    sha,
    testCount: Number.isFinite(s?.testCount) ? s.testCount : null,
    pass: Number.isFinite(s?.pass) ? s.pass : null,
    fail: Number.isFinite(s?.fail) ? s.fail : null,
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    openIssues: Number.isFinite(openIssues) ? openIssues : 0,
    source: 'ci',
  };
}


// The argv the sampler issues. The service account has no gh sign-in, so in
// service mode these go through the desktop shell, whose allowlist
// (apps/shell/src/lib/gitops-allow.js) matches these exact shapes: change both
// files together (card glmps-2-0-155). The shell runs gh with no cwd, so every
// call names the repo. A whole-run log is ~12 MB and the shell keeps 256 KB,
// so the log is read per job, and the shell keeps a job log's tail, where a
// test leg prints its summary.
export const QA_RUN_FIELDS = 'databaseId,conclusion,status,headSha,createdAt';
export const qaGhArgs = {
  runs: (repo, limit) => ['run', 'list', '-R', repo, '--workflow=ci.yml', '-L', String(limit), '--json', QA_RUN_FIELDS],
  jobs: (repo, runId) => ['run', 'view', String(runId), '-R', repo, '--json', 'jobs'],
  jobLog: (repo, jobId) => ['run', 'view', '--job', String(jobId), '-R', repo, '--log'],
  issues: (repo) => ['issue', 'list', '-R', repo, '--state', 'open', '--json', 'number'],
};

/** owner/repo from a GitHub remote URL (https or ssh), else null. */
export function repoFromRemote(url) {
  const m = /github\.com[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

// ctx: { cwd, repo, gh? }. gh(file, args) -> { status, stdout, stderr } is the
// server's seam; without it (a dev run) gh is spawned directly.
async function ghCall(ctx, args, { timeoutMs, maxBuffer } = {}) {
  if (!ctx.repo) return null;
  if (ctx.gh) {
    const r = await ctx.gh('gh', args);
    return r && r.status === 0 ? String(r.stdout ?? '') : null;
  }
  const { stdout } = await execFileAsync('gh', args, { cwd: ctx.cwd, timeout: timeoutMs, windowsHide: true, ...(maxBuffer ? { maxBuffer } : {}) });
  return stdout;
}

async function ghRunListJson(ctx, limit, timeoutMs) {
  try {
    return parseRunListJson(await ghCall(ctx, qaGhArgs.runs(ctx.repo, limit), { timeoutMs }));
  } catch {
    return []; // gh missing/unauthed/no network/timeout -> fail-open
  }
}

// Every job's log, concatenated, so parseTestSummary still takes the max fail
// across legs. Null when the job list or every log read fails.
async function ghRunLog(ctx, runId, timeoutMs) {
  try {
    const raw = await ghCall(ctx, qaGhArgs.jobs(ctx.repo, runId), { timeoutMs });
    const jobs = Array.isArray(JSON.parse(raw ?? 'null')?.jobs) ? JSON.parse(raw).jobs : [];
    const logs = [];
    for (const job of jobs) {
      if (!Number.isFinite(job?.databaseId)) continue;
      try {
        const log = await ghCall(ctx, qaGhArgs.jobLog(ctx.repo, job.databaseId), { timeoutMs, maxBuffer: LOG_MAX_BUFFER });
        if (log) logs.push(log);
      } catch { /* fail-open per job */ }
    }
    return logs.length ? logs.join('\n') : null;
  } catch {
    return null; // fail-open: point is still recorded with null test counts
  }
}

async function ghOpenIssueCount(ctx, timeoutMs) {
  try {
    return parseOpenIssuesCount(await ghCall(ctx, qaGhArgs.issues(ctx.repo), { timeoutMs }));
  } catch {
    return 0; // fail-open
  }
}

const ghCtx = (opts) => ({ cwd: opts.cwd ?? process.cwd(), repo: opts.repo ?? null, gh: opts.gh ?? null });


// Sample the single newest CI run and append it if it's new. Never throws.
// Returns the appended point, or null (not completed, already recorded, or a
// bad sample that fail-opened to nothing usable).
export async function sampleLatestRun(stateDir, opts = {}) {
  const ctx = ghCtx(opts);
  try {
    const runs = await ghRunListJson(ctx, 1, opts.listTimeoutMs ?? GH_LIST_TIMEOUT_MS);
    const run = runs[0] ?? null;
    if (!run || run.status !== 'completed') return null;
    if (hasRunId(stateDir, run.databaseId)) return null; // cheap skip before the log fetch
    const log = await ghRunLog(ctx, run.databaseId, opts.logTimeoutMs ?? GH_LOG_TIMEOUT_MS);
    const summary = log ? parseTestSummary(log) : null;
    const openIssues = await ghOpenIssueCount(ctx, opts.issueTimeoutMs ?? GH_ISSUE_TIMEOUT_MS);
    const point = runToPoint(run, summary, openIssues);
    if (!point) return null;
    appendPoint(stateDir, point);
    return point;
  } catch {
    return null;
  }
}

// Seed from the last ~30 completed runs, but ONLY when history is empty (a
// cheap synchronous check up front, so calling this unconditionally on every
// tick is safe -- after the first successful backfill it's a single fs read
// and an immediate return, no gh calls at all). Bounded, fail-open per run:
// one bad run (log fetch/parse failure) never aborts the rest of the backfill.
// The open-issue count is fetched ONCE and reused for every backfilled point
// -- history doesn't exist for issue counts, so this is a best-effort "current
// count applied retroactively" approximation, not a time-accurate one.
export async function backfillHistory(stateDir, opts = {}) {
  const ctx = ghCtx(opts);
  const limit = opts.limit ?? 30;
  try {
    if (readQaTrends(stateDir).length > 0) return 0;
    const runs = await ghRunListJson(ctx, limit, opts.listTimeoutMs ?? GH_LIST_TIMEOUT_MS);
    if (!runs.length) return 0;
    const openIssues = await ghOpenIssueCount(ctx, opts.issueTimeoutMs ?? GH_ISSUE_TIMEOUT_MS);
    let appended = 0;
    for (const run of runs) {
      try {
        if (!run || run.status !== 'completed') continue;
        const log = await ghRunLog(ctx, run.databaseId, opts.logTimeoutMs ?? GH_LOG_TIMEOUT_MS);
        const summary = log ? parseTestSummary(log) : null;
        const point = runToPoint(run, summary, openIssues);
        if (point && appendPoint(stateDir, point)) appended++;
      } catch {
        // fail-open per run -- one bad run in the batch never aborts the rest
      }
    }
    return appended;
  } catch {
    return 0;
  }
}

// The periodic tick server.js wires into setInterval: backfill once (no-op
// fast once history exists) then sample the latest run. Never throws.
export async function qaTrendsTick(stateDir, opts = {}) {
  try {
    await backfillHistory(stateDir, opts);
    await sampleLatestRun(stateDir, opts);
    await repairUnparsedRuns(stateDir, opts);
  } catch {
    // fail-open -- a scheduled tick must never crash the server
  }
}

// Re-fetch the logs of runs that were recorded without counts and fill them in
// (glmps-149). Bounded to a couple of runs per tick: the common case is a run
// sampled seconds after it completed, whose log became available moments later,
// so this converges immediately and then costs nothing (unparsedRunIds is a
// single fs read that returns [] once the history is clean). Fail-open per run.
export async function repairUnparsedRuns(stateDir, opts = {}) {
  const ctx = ghCtx(opts);
  const max = opts.maxRepairsPerTick ?? 2;
  let repaired = 0;
  try {
    for (const runId of unparsedRunIds(stateDir, max)) {
      try {
        const log = await ghRunLog(ctx, runId, opts.logTimeoutMs ?? GH_LOG_TIMEOUT_MS);
        const summary = log ? parseTestSummary(log) : null;
        // Still unavailable or still unparseable: leave it for a later tick
        // rather than writing something invented.
        if (summary && repairPoint(stateDir, runId, summary)) repaired++;
      } catch { /* fail-open per run */ }
    }
  } catch { /* fail-open */ }
  return repaired;
}
