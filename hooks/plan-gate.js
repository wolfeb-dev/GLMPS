#!/usr/bin/env node
// PreToolUse (Write|Edit|MultiEdit|NotebookEdit): the blocking plan gate
// (program K7, decision 6 borrow c). On a card's branch, the first two
// distinct source files may be edited freely; a source file beyond that
// needs the card's chain: a declared plan committed at HEAD or on any branch
// whose header names a spec that is also committed.
//
// Fail open, never brick. Every error path below (kernel unreachable, a
// board that times out, bad JSON, an unknown card, git unavailable or
// timing out, an unreadable/corrupt per-session tracking file) allows the
// edit and records why - a gate that cannot evaluate lets the work through
// and says why, it never denies on an infrastructure failure. At most one
// fail-open report (log line plus best-effort POST) is made per invocation,
// enforced by reportOnce()'s own once-fired guard inside main() below, not
// merely by the shape of the branches around it (round 1's claim here was
// false: a torn tracking line's own report and a chain-evaluation report
// could both fire in the same call - see reportOnce and the fix-round-2
// report for how this is actually enforced now).
//
// This hook is registered only by the installer, and the live install is
// held until cutover: nothing here registers it in any real settings file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCardId, fetchChain, reportRefusal, boardUrl, envStateDir } from './lib/card-context.js';
import { appendCapped } from '../server/lib/observability/append-log.js';

// only the TOP-level docs/ directory is exempt, not a
// nested one (server/lib/docs/foo.js is source) - case-insensitive so a
// win32 caller that happens to pass 'Docs/...' is still exempted.
export function isSourcePath(p) {
  const s = String(p).replace(/\\/g, '/');
  return !/^docs\//i.test(s) && !/\.md$/i.test(s);
}

// only a BACKTICKED path on the
// plan's **Spec:** line counts as a spec path at all. Real plan headers cited
// by the round-1 review: a backticked absolute path to the separate corpus
// repo (decision D29, e.g. `<repo>\decisions.md`), plain prose with no
// backticked path at all ("the operator's Slack instruction on card ...",
// "this document...", "none; ..."). None of those are a "the spec is
// missing/uncommitted" DENY - they fail open with a named reason instead,
// because this gate cannot verify a spec it was never given a path to.
function specPathFrom(planText) {
  const m = String(planText || '').match(/\*\*Spec:\*\*\s*`([^`]+)`/);
  return m ? m[1] : null;
}

// Absolute (POSIX '/...' or a drive letter, forward or back slash) or a '..'
// escape are both "not inside this repo" - checked as plain strings, no fs,
// so this stays a pure function testable without a real git repo.
function isOutsideRepo(p) {
  const s = String(p).replace(/\\/g, '/');
  return /^([a-zA-Z]:\/|\/)/.test(s) || /^\.\.(\/|$)/.test(s);
}

/**
 * Pure decision over an already-fetched chain. `unavailable` and
 * `unknownCard` are the two ways fetchChain's result can mean "the board did
 * not give a real answer" - both fail open here, distinctly, so the caller's
 * fail-open log names which one happened. `repoCheck.isCommitted`/
 * `readCommitted` may THROW (a git problem, not an answer) - the caller
 * catches that and fails open; this function never itself decides that case.
 */
export function planGateDecision({ chain, unavailable = null, unknownCard = false, files, filePath, repoCheck, boardBaseUrl = boardUrl() }) {
  if (!isSourcePath(filePath)) return { allow: true };
  const set = new Set(files);
  if (set.has(filePath) || set.size < 2) return { allow: true };
  if (unavailable) {
    return { allow: true, failOpen: true, reason: `plan gate skipped: board unreachable (${unavailable}); the edit is allowed and logged` };
  }
  if (unknownCard) {
    return { allow: true, failOpen: true, reason: 'plan gate skipped: unknown card (not found on the board, it may have been deleted or renamed); the edit is allowed and logged' };
  }
  if (!chain) return { allow: true };
  if (!chain.plan) {
    return {
      allow: false,
      reason: `This is a source file beyond the first two on card ${chain.id} and no plan is declared. Write a spec with to-spec, commit it under docs/specs/, and declare it: POST ${boardBaseUrl}/api/backlog/${chain.id}/progress {"plan":"docs/specs/<file>.md"}.`,
    };
  }
  if (!repoCheck.isCommitted(chain.plan)) {
    return { allow: false, reason: `The declared plan ${chain.plan} is not committed at HEAD or on any branch. Commit it first.` };
  }
  // Card glmps-2-0-33: a Pocock spec is the design itself, so it needs no
  // separate **Spec:** line; older plans under docs/superpowers keep the rule.
  if (/^docs\/specs\//.test(String(chain.plan).replace(/\\/g, '/'))) return { allow: true };
  const spec = specPathFrom(repoCheck.readCommitted(chain.plan));
  if (!spec) {
    return { allow: true, failOpen: true, reason: `plan gate skipped: the plan ${chain.plan}'s **Spec:** line names no backticked path (spec not a path); the edit is allowed and logged` };
  }
  if (isOutsideRepo(spec)) {
    return { allow: true, failOpen: true, reason: `plan gate skipped: the spec ${spec} is outside the repo (spec outside repo); the edit is allowed and logged` };
  }
  if (!repoCheck.isCommitted(spec)) {
    return { allow: false, reason: `The plan ${chain.plan} must name a committed spec on its **Spec:** line; the spec ${spec} is not committed.` };
  }
  return { allow: true };
}

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

// every git spawn is capped, fresh per call like
// card-context.js's boardUrl()/envTimeout() (M8's fix applied the same way
// here).
function gitTimeoutMs() { return Number(process.env.GLMPS_HOOK_GIT_TIMEOUT_MS) || 2000; }
const GIT_SHOW_MAX_BUFFER = 5 * 1024 * 1024; // a plan/spec file up to 5 MiB never ENOBUFS

// I1/I2: classifies ANY execFileSync('git', ...) failure.
// Exported and unit-tested directly with synthetic error objects - Node's own
// child_process timeout/kill machinery is not this project's code to
// re-verify; what matters here is that each shape gets the right reason.
//
// I-new-2: a REAL killed-by-timeout error and a REAL ENOBUFS error
// look almost identical on this platform (verified with the round-2
// reviewer's own probe): both carry signal:'SIGTERM' and killed:undefined,
// because Node kills the process the same way for either. The only reliable
// discriminator is `.code`, and it must be checked BEFORE the signal/killed
// fallback, or a genuine buffer overflow is misreported as a timeout.
export function classifyGitError(e, timeoutMs = gitTimeoutMs()) {
  if (e?.code === 'ENOENT') return 'git is not installed or not on PATH';
  if (e?.code === 'ENOBUFS') return 'git output exceeded the read buffer';
  if (e?.code === 'ETIMEDOUT' || e?.killed || e?.signal) return `git did not respond within ${timeoutMs}ms`;
  const detail = (e?.stderr ? String(e.stderr).trim() : '') || e?.code || e?.message || 'unknown error';
  return `git exited with an error (${String(detail).slice(0, 200)})`;
}

// Exported: test-file-guard.js shares this exact bounded spawn
// (and its timeout/classification behavior) rather than a second,
// separately-maintained execFileSync('git', ...) call of its own.
export function gitRun(cwd, args, { maxBuffer } = {}) {
  const timeoutMs = gitTimeoutMs();
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      timeout: timeoutMs, ...(maxBuffer ? { maxBuffer } : {}),
    });
  } catch (e) {
    // Phase K final review I5: the raw spawn error rides along as `cause`,
    // so a caller (branchReadIssue) can tell a definitive git answer from a
    // failure without parsing this message.
    const err = namedError('GitUnavailableError', classifyGitError(e, timeoutMs));
    err.cause = e;
    throw err;
  }
}

// Phase K final review I5: reading the branch with `git symbolic-ref` used to
// treat every failure as "no card", so a timeout or a missing git silently
// switched the gate off. Returns null for a definitive "there is no branch"
// answer from git itself (git ran and said HEAD is detached, or the cwd is
// not a repository): that is still "no card", K7's design. Anything else (a
// timeout, git missing, ENOBUFS, any other git error) returns
// classifyGitError's named reason, which the caller reports as a fail-open.
export function branchReadIssue(err) {
  const cause = err?.cause ?? null;
  if (cause && typeof cause.status === 'number' && !cause.signal) {
    const stderr = String(cause.stderr ?? '');
    if (/is not a symbolic ref|not a git repository/i.test(stderr)) return null;
  }
  return classifyGitError(cause ?? err);
}

// `git rev-parse --show-toplevel`, needed to normalize a distinct-file
// path (I4). Any failure (git missing, not a repo, timeout) means this whole
// call cannot be evaluated safely - the caller fails the ENTIRE invocation
// open rather than trying to guess a repo root.
//
// Round 2 (probe F, minor): realpath'd, so a repo reached through a junction
// resolves to the same real path fs.realpathSync.native() gives for a file
// inside it - otherwise the two sides of a later path.relative() belong to
// different (though equivalent) trees and every file looks "outside" it.
//
// CI regression (Windows): `.native`, not the plain (JS-implemented)
// fs.realpathSync - matching the precedent already set by shadow-instance.mjs
// for this exact class of problem. git itself already expands an 8.3
// short-name cwd (e.g. a GitHub Actions runner's `C:\Users\RUNNER~1`, from a
// TEMP env var that names the long profile dir via its short alias) when it
// prints `--show-toplevel`, but the plain fs.realpathSync does NOT expand a
// short name on its own (verified: fs.realpathSync('...\MISSIO~1') returns
// the short name unchanged; only fs.realpathSync.native expands it) - so a
// repoTop computed through git plus the plain realpathSync landed on the
// LONG form while repoRelativePath's own realpath of a short-name cwd (never
// touched by git) stayed on the SHORT form. The two forms of the identical
// directory then looked like different trees to path.relative(), and every
// file under a short-name temp dir read as "outside the repo" - silently, no
// error anywhere, every gate/guard decision below this point became a no-op.
export function gitRepoTop(cwd, { run = gitRun, realpath = fs.realpathSync.native } = {}) {
  // path.resolve() normalizes git's forward-slash output to the native
  // separator (and collapses any redundant segments) before realpath'ing it.
  const top = path.resolve(run(cwd, ['rev-parse', '--show-toplevel']).trim());
  try { return realpath(top); }
  catch (e) {
    // Phase K final review (silent-failure): named, not swallowed. The
    // unresolved path still works for a repo not reached through a junction.
    process.stderr.write(`plan-gate: could not realpath the repo top level ${top} (${e?.code || e?.message}); using the unresolved path\n`);
    return top;
  }
}

// I1/C-new: `git ls-tree`/`git show HEAD:<path>` resolve their PATHSPEC
// relative to the process's cwd, not the repo root (a well-known git
// gotcha) - so this must always be called with `cwd` = the resolved repo
// TOP LEVEL, never the tool call's own cwd. Round 1 passed the tool call's
// raw cwd, which produced a FALSE DENY on a genuinely committed plan/spec
// for any session working from a repo subdirectory (round-2 critical,
// reproduced by the reviewer's probe B/C).
//
// `git ls-tree` (not `cat-file -e`) because ls-tree can actually distinguish
// "the path is not at that commit" (exit 0, empty output - a real "not
// committed" answer) from "git itself could not answer that question" (any
// non-zero exit or spawn error - not a repo, no HEAD yet, a timeout, ...).
// `cat-file -e HEAD:<p>` exits 128 for BOTH, which is exactly the round-1
// finding: a broken repo used to read as "not committed" and deny, instead
// of failing open.
//
// Card glmps-2-0-85: a card's plan often lands on its own spec branch while
// the build runs on a sibling branch cut before that merge, so a plan or spec
// committed on any local or remote branch counts, not only one at HEAD. The
// branch scan runs only when HEAD lacks the file.
function gitRepoCheck(repoTop) {
  const where = new Map();
  const inTree = (rev, p) => gitRun(repoTop, ['ls-tree', '-z', '--name-only', rev, '--', p]).length > 0;
  const locate = (p) => {
    if (!where.has(p)) {
      let rev = inTree('HEAD', p) ? 'HEAD' : null;
      if (!rev) {
        const sha = gitRun(repoTop, ['log', '--branches', '--remotes', '-1', '--format=%H', '--diff-filter=AMR', '--', p]).trim();
        if (sha && inTree(sha, p)) rev = sha;
      }
      where.set(p, rev);
    }
    return where.get(p);
  };
  return {
    isCommitted: (p) => locate(p) !== null,
    readCommitted: (p) => gitRun(repoTop, ['show', `${locate(p) ?? 'HEAD'}:${p}`], { maxBuffer: GIT_SHOW_MAX_BUFFER }),
  };
}

// Walks up from `p` to the nearest EXISTING ancestor, realpath's that
// ancestor (resolving any junction/symlink in it), then rejoins the
// non-existent tail segments. A plain `exists(p) ? realpath(p) : p`
// left a NEW file's path unresolved when reached through a junction (probe
// F): the file does not exist yet, so realpath on it fails outright, and the
// raw junction-relative path never matches the resolved repo top level -
// the file reads as "outside the repo" and silently bypasses the gate
// entirely, rather than being counted like any other in-repo file.
function realpathNearestExisting(p, { exists, realpath }) {
  let cur = p;
  const tail = [];
  while (!exists(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached a filesystem root: give up, cur stays as-is
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try { cur = realpath(cur); }
  catch (e) {
    process.stderr.write(`plan-gate: could not realpath ${cur} (${e.code || e.message}); using the unresolved path\n`);
  }
  return tail.length ? path.join(cur, ...tail) : cur;
}

// normalizes an absolute file path to a path relative to
// the repo top level, for the "distinct file" count. `exists`/`realpath` are
// injectable so this stays testable without touching a real filesystem.
// Returns null when the file is outside the repo top level (a different
// drive counts as outside too, since path.relative cannot cross drives on
// win32 and returns an absolute path instead) - callers never count it.
//
// CI regression (Windows): `.native`, same reasoning as gitRepoTop's own
// fix just above - this is the other side of that exact comparison, and both
// sides must resolve an 8.3 short-name path (or a junction) to the identical
// canonical form, or a real in-repo file reads as "outside the repo".
export function repoRelativePath({ abs, repoTop, platform = process.platform, exists = fs.existsSync, realpath = fs.realpathSync.native }) {
  const real = realpathNearestExisting(abs, { exists, realpath });
  let rel = path.relative(repoTop, real).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  if (platform === 'win32') rel = rel.toLowerCase();
  return rel;
}

// append-only per-session tracking. Every "this file was
// touched" fact is its own ndjson line (appendFileSync), never a whole-file
// read-modify-write - two subagents sharing a session_id can each append
// without racing to clobber the other's update. M5: a line's cardId is part
// of the record, so switching cards on the same session_id naturally drops
// the old card's lines from the count (filtered on read) with no explicit
// reset step. A torn/corrupt line is skipped, never treated as corrupting
// the rest of the session's history.
function trackingFile(stateDir, sessionId) {
  return path.join(stateDir, 'guards', 'plan-gate', `${sessionId || 'nosession'}.ndjson`);
}

function readTouchedFiles(stateDir, sessionId, cardId) {
  const f = trackingFile(stateDir, sessionId);
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { files: new Set(), issue: null };
    return { files: new Set(), issue: `the per-session tracking file is unreadable or corrupt (${e.code || e.message})` };
  }
  const files = new Set();
  const validRecords = []; // every structurally-valid record, any card - kept on repair
  let torn = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { torn++; continue; }
    if (!rec || typeof rec.path !== 'string' || typeof rec.cardId !== 'string') { torn++; continue; }
    validRecords.push(rec);
    if (rec.cardId === cardId) files.add(rec.path);
  }
  // I-new-1: repair the file THE FIRST TIME a torn line is
  // seen (rewrite keeping only the structurally-valid lines, atomic
  // temp+rename) - round 1 left the torn line in place forever, so the SAME
  // corruption was reported again on every later tool call for the rest of
  // the session (reproduced by the reviewer's probe D2).
  if (torn > 0) repairTrackingFile(f, validRecords);
  return { files, issue: torn > 0 ? `the per-session tracking file is unreadable or corrupt (${torn} torn line(s) skipped and repaired)` : null };
}

// a concurrent append (a second
// hook invocation for the same session, mid-flight) landed between this
// function's read and its rename can be overwritten by the rewrite below,
// losing that one append - accepted rather than fixed with a re-read-and-
// merge immediately before the rename, since the failure mode is strictly
// "one file briefly under-counted" (a wider free pass), never an incorrect
// deny, and repairs only ever run on the rare torn-line path, not every call.
function repairTrackingFile(f, records) {
  const dir = path.dirname(f);
  const tmp = path.join(dir, `.${path.basename(f)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const body = records.map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(tmp, records.length ? `${body}\n` : '');
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort cleanup only */ }
    process.stderr.write(`plan-gate: could not repair the tracking file ${f} (${e.message})\n`);
  }
}

function appendTouchedFile(stateDir, sessionId, cardId, filePath) {
  appendCapped(trackingFile(stateDir, sessionId), { cardId, path: filePath, ts: Date.now() });
}

// I3/M2: atomic temp+rename, and a torn/corrupt counters
// file is left ALONE (skip this update, log it) rather than reset to `{}` -
// resetting would silently zero out every OTHER hook's historical counts
// over one bad read.
//
// Exported: test-file-guard.js shares this exact counters file and
// increment shape, so it reuses this function rather than a second,
// separately-maintained copy of the same atomic-write logic.
export function bumpCounter(stateDir, hook, refused) {
  const f = path.join(stateDir, 'guards', 'counters.json');
  let c;
  try {
    const raw = fs.readFileSync(f, 'utf8');
    c = JSON.parse(raw);
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw namedError('CountersCorruptError', 'top level is not an object');
  } catch (e) {
    if (e.code === 'ENOENT') { c = {}; }
    else {
      process.stderr.write(`plan-gate: counters file is unreadable or corrupt (${e.code || e.message}); skipping this update rather than resetting it\n`);
      return;
    }
  }
  c[hook] = { checks: (c[hook]?.checks || 0) + 1, refusals: (c[hook]?.refusals || 0) + refused };
  const dir = path.dirname(f);
  // CI regression (Windows): mkdirSync was OUTSIDE this try/catch, the one
  // write path in this file that was not treated as best-effort. A transient
  // Windows fs condition here (observed: a stale/colliding 'guards' path;
  // real-world equivalents include an AV/Defender lock on a just-created
  // directory) throws synchronously, uncaught, straight out of main() into
  // its top-level catch-all - which, unlike every named fail-open path here,
  // never emits the hookSpecificOutput JSON on stdout. The caller then sees
  // empty stdout instead of a fail-open decision (reproduced: a colliding
  // 'guards' path turns this hook's exit-0, always-allow contract into exit
  // 0 with NO output at all). Counting a check is strictly best-effort, same
  // as every other write below - it must never be the reason a tool call's
  // decision is lost.
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(f)}.tmp-${process.pid}-${Date.now()}`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(c));
      fs.renameSync(tmp, f);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* best effort cleanup only */ }
      throw e;
    }
  } catch (e) {
    process.stderr.write(`plan-gate: could not write the counters file (${e.message})\n`);
  }
}

// rotation lives in appendCapped; this just names the file and the hook.
function logFailOpen(stateDir, entry) {
  try {
    appendCapped(path.join(stateDir, 'guards', 'fail-open.ndjson'), { ts: Date.now(), hook: 'plan-gate', ...entry });
  } catch (e) {
    process.stderr.write(`plan-gate: could not write the fail-open log (${e.message})\n`);
  }
}

async function main() {
  // Phase K final review I6: GLMPS_STATE_DIR, else ~/.glmps-2 (the 2.0
  // kernel's own state dir; the cutover flips it, see card-context.js).
  const stateDir = envStateDir();
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let input = {};
  try {
    input = JSON.parse(raw) || {};
  } catch (e) {
    // no card is even resolved yet at this point, so
    // this is not a guard fail-open to log or report - stderr only.
    process.stderr.write(`plan-gate: could not parse the tool-call payload (${e.message}); allowing (failing open)\n`);
    return;
  }
  const cwd = input.cwd || process.cwd();
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  // a non-string file_path (an object, a number, ...) would otherwise
  // reach path.resolve() and throw - guard it the same way a missing one is.
  if (!target || typeof target !== 'string') return;

  // Minor, fixed again in round 3 (I-r2-1): a
  // *.md file never needs the gate at all, checked here directly on the raw
  // target path before any git call runs - so a documentation edit costs
  // nothing and is never reported, even outside a repo or from a
  // subdirectory. This checks ONLY the file extension (cwd-independent).
  //
  // The docs/ DIRECTORY exemption is deliberately NOT checked here anymore.
  // Round 2 reused isSourcePath() against a cheap cwd-RELATIVE path, on the
  // premise that being cwd-relative could only ever be MORE permissive, never
  // less correct - that premise was wrong: a NESTED docs/ directory can look
  // TOP-LEVEL from a subdirectory cwd (server/docs/y.js, edited with
  // cwd=server/, computes as "docs/y.js"), which wrongly exempted a real
  // source file from the gate entirely (round-3 finding, reopening M6;
  // reproduced by the reviewer's probe G). The docs/ directory exemption is
  // left entirely to the repo-root-relative isSourcePath(rel) check below,
  // which is the only place that can tell "top-level" from "nested" correctly.
  if (/\.md$/i.test(target)) return;

  // Routed through gitRun (I-new-2) so this spawn shares gitRun's one timeout.
  // Phase K final review I5: only a definitive no-branch answer (a detached
  // HEAD, a cwd outside any repository) is "no card"; resolveCardId still
  // honors GLMPS_CARD_ID then. Any other failure is a named fail-open below,
  // never a silent "no card" that switches the gate off.
  let branch = '';
  let branchIssue = null;
  try {
    branch = gitRun(cwd, ['symbolic-ref', '--short', 'HEAD']).trim();
  } catch (e) {
    branchIssue = branchReadIssue(e);
  }
  const cardId = resolveCardId({ branch });

  // rel is filled in once repoTop resolves; reportOnce reports whichever is
  // known yet (the raw target before that, the normalized repo-relative path
  // after) via closure. `reported` makes this a TRUE once-per-invocation
  // guard: round 1's comment claimed this by construction
  // and was wrong - a torn-tracking-file report and a chain-evaluation
  // report could both fire in the same call (reviewer's probe D). Now only
  // the FIRST call to reportOnce ever logs or POSTs; every later call in the
  // same invocation is a silent no-op.
  let rel = null;
  let reported = false;
  const emit = (o) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } }));
  const reportOnce = async (reason, failOpen) => {
    if (reported) return;
    reported = true;
    logFailOpen(stateDir, { cardId, reason });
    await reportRefusal({ hook: 'plan-gate', cardId, sessionId: input.session_id, tool: input.tool_name, path: rel ?? target, reason, failOpen }, { stateDir });
  };

  if (branchIssue) {
    const reason = `plan gate skipped: could not read the current branch (${branchIssue}); the edit is allowed and logged`;
    await reportOnce(reason, true);
    emit({ additionalContext: reason });
    return;
  }
  if (!cardId) return; // no card on this branch. The gate does nothing.

  const sessionId = input.session_id;
  const { files: touchedFiles, issue: stateIssue } = readTouchedFiles(stateDir, sessionId, cardId);

  // repo-root resolution failing means nothing below can be evaluated
  // safely (no basis to normalize the path, no basis to check commits
  // either) - fail this whole call open rather than guessing.
  let repoTop;
  try {
    repoTop = gitRepoTop(cwd);
  } catch (e) {
    const reason = `plan gate skipped: ${e.message}; the edit is allowed and logged`;
    await reportOnce(reason, true);
    emit({ additionalContext: reason });
    return;
  }

  rel = repoRelativePath({ abs: path.resolve(cwd, target), repoTop });

  // The state-file issue (if any) is reported here, up front - reportOnce's
  // own guard (above) is what actually keeps this from stacking with a
  // second report later in this same call for the chain-evaluation outcome.
  // this must run BEFORE the outside-repo early
  // return just below, not after - round 2 had it after, so a repair that
  // happened to coincide with an outside-repo edit (rel === null) returned
  // before ever being reported, leaving a real anomaly (a torn tracking
  // line rewritten out) completely silent. The tool call itself is
  // unaffected either way (an outside-repo file is never gated); only the
  // reporting was the gap.
  if (stateIssue) {
    await reportOnce(`plan gate skipped: ${stateIssue}; file tracking restarts for this call, and the edit is allowed and logged`, true);
  }

  if (rel == null) return; // outside the repo top level (e.g. a scratchpad file) - never counts, never blocked

  const needsChain = isSourcePath(rel) && !touchedFiles.has(rel) && touchedFiles.size >= 2;

  let chain = null;
  let unavailable = null;
  let unknownCard = false;
  if (needsChain) {
    const res = await fetchChain(cardId);
    chain = res.chain ?? null;
    unavailable = res.unavailable ?? null;
    unknownCard = !!res.unknownCard;
  }

  let d;
  try {
    // C-new: gitRepoCheck runs from repoTop, never the tool call's raw cwd -
    // ls-tree/show interpret their pathspec relative to cwd, and chain.plan/
    // the spec path are always repo-root-relative strings.
    d = planGateDecision({ chain, unavailable, unknownCard, files: [...touchedFiles], filePath: rel, repoCheck: gitRepoCheck(repoTop), boardBaseUrl: boardUrl() });
  } catch (e) {
    d = { allow: true, failOpen: true, reason: `plan gate skipped: git is unavailable (${e.message}); the edit is allowed and logged` };
  }

  bumpCounter(stateDir, 'plan-gate', d.allow ? 0 : 1);

  if (d.failOpen) {
    await reportOnce(d.reason, true);
    emit({ additionalContext: d.reason });
    return;
  }
  if (!d.allow) {
    await reportRefusal({ hook: 'plan-gate', cardId, sessionId: input.session_id, tool: input.tool_name, path: rel, reason: d.reason, failOpen: false }, { stateDir });
    emit({ permissionDecision: 'deny', permissionDecisionReason: d.reason });
    return;
  }
  if (isSourcePath(rel) && !touchedFiles.has(rel)) {
    // Phase K final review I5: a failed append under-counts this file on
    // every later call (a wider free pass), so it is a named fail-open
    // through reportOnce, not stderr only.
    try { appendTouchedFile(stateDir, sessionId, cardId, rel); }
    catch (e) {
      const reason = `plan gate: could not record the touched file ${rel} (${e?.code || e?.message}); it will not count toward this card's file budget`;
      process.stderr.write(`plan-gate: ${reason}\n`);
      await reportOnce(reason, true);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    // the last-resort safety net now logs too, not just
    // stderr - anything reaching here is still a fail-open worth the
    // dashboard seeing, even though it is not one of the named paths above.
    const reason = `plan gate skipped: unexpected error (${e?.message || e}); the edit is allowed and logged`;
    process.stderr.write(`plan-gate: ${reason} (failing open)\n`);
    try {
      logFailOpen(envStateDir(), { cardId: null, reason });
    } catch { /* stderr above already recorded this; never let logging itself crash the exit */ }
    // CI regression (Windows): this safety net used to stop at stderr/the
    // log file, never writing the hookSpecificOutput JSON every OTHER
    // fail-open path here emits on stdout. A caller that parses stdout for a
    // decision (this project's own hook tests; reportedly Claude Code itself)
    // saw EMPTY stdout instead of a fail-open decision whenever something
    // unexpected threw this late (reproduced via a transient fs failure in
    // bumpCounter - now fixed at the source, but this is the documented
    // "fail open, never brick" contract's own last line of defense, so it
    // must hold even for a cause nobody has named yet). Every call to the
    // in-main `emit` is immediately followed by `return`, so main() can never
    // reach this catch after already having written to stdout.
    //
    // The exit() is deferred to the write's own callback, not fired right
    // after: stdout is a PIPE here (Claude Code reads it, same as every test
    // below), and a pipe write on Windows is asynchronous - process.exit()
    // called immediately after queuing it can tear the process down before
    // that write ever reaches the pipe, silently truncating this exact
    // output to empty again, just one line lower than the bug above.
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason } }),
      () => process.exit(0),
    );
  });
}
