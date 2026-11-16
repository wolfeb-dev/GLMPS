#!/usr/bin/env node
// Stop hook: CI-surface. A red CI run on the repo's default branch (Linux CI catching
// a bug local Windows `npm test` misses, e.g. a hardcoded-/state test-isolation bug)
// can sit invisible for a full day because nothing in the loop looks at it. This hook
// closes that gap: on Stop, if the repo has a GitHub remote + a .github/workflows dir,
// it checks the latest run on the default branch and - only if it's a genuine, RECENT
// failure - emits a NON-BLOCKING warning so the agent notices and fixes it in this
// session instead of a future one discovering main has been red all along.
//
// Mirrors hooks/done-gate.js: pure decision/parsing logic is exported and unit-tested
// with no network; the CLI entry holds all I/O (git/gh/fs) and ALWAYS exits 0 - a
// bug here, gh being missing/unauthed, or no network must never block the stop, and
// this fires on every Stop in the repo so it must also stay fast (git calls are local;
// the one gh call is timeout-bounded).
//
// Stdin: Claude Code Stop-hook JSON { cwd, session_id, transcript_path }.
// Exit: always 0. Non-blocking feedback (if any) goes out as
// { hookSpecificOutput: { hookEventName: 'Stop', additionalContext } } on stdout.

// Only warn about a failure whose run started within this window. Long enough to
// still catch a break discovered in a later session (the whole point - the bug this
// hook exists for sat red for a day with nobody noticing), short enough that we never
// nag about an ancient, already-known-about failure every single time someone stops.
export const DEFAULT_RECENT_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Pure decision: given the latest CI run for the default branch (or null/missing),
 * decide whether to surface a non-blocking warning. No I/O - fully unit-testable.
 * @param {object} opts
 * @param {object|null} opts.run - gh run JSON: { databaseId, conclusion, status, headSha, url, workflowName, createdAt } | null
 * @param {number} [opts.now] - ms clock, injected for testability
 * @param {number} [opts.recentMs] - staleness window (see DEFAULT_RECENT_MS)
 * @returns {string|null} warning text, or null to stay silent
 */
// GitHub Actions terminal conclusions that mean "red" in practice, not just the literal
// 'failure' string. timed_out (job hung past its limit) and startup_failure (runner never
// even started) are just as much a broken build as 'failure' - only these three warn.
export const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

export function decideCiWarning({ run, now = Date.now(), recentMs = DEFAULT_RECENT_MS } = {}) {
  if (!run || typeof run !== 'object') return null; // no runs at all, or nothing usable -> silent
  if (run.status !== 'completed') return null; // queued/in_progress -> nothing final to report yet
  if (!RED_CONCLUSIONS.has(run.conclusion)) return null; // success/cancelled/skipped/neutral/action_required/etc -> silent
  const createdMs = Date.parse(run.createdAt);
  if (!Number.isFinite(createdMs)) return null; // can't place it in time -> fail open, stay silent
  if (now - createdMs > recentMs) return null; // stale failure -> don't nag about ancient CI

  const workflow = run.workflowName || 'CI';
  const urlSuffix = run.url ? ` ${run.url}` : '';
  return `CI is red on the default branch: "${workflow}" failed.${urlSuffix} This may be from a change in this session \u2014 check and fix CI now instead of leaving it for later.`;
}

// Parse `gh run list ... --json ...` stdout (a JSON array, newest-first with -L 1
// meaning at most one element) into the single run object decideCiWarning wants, or
// null. Pure - never throws on garbage input.
export function parseGhRunJson(stdout) {
  try {
    const arr = JSON.parse(stdout);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0];
  } catch { return null; }
}

// Pure AND of the three silent-unless-all-true preconditions from the ticket: only a
// git repo, with a GitHub remote, that also has CI configured is worth an API call for.
export function shouldQueryCi({ isRepo, hasGithubRemote, hasWorkflowsDir }) {
  return !!(isRepo && hasGithubRemote && hasWorkflowsDir);
}


import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GIT_TIMEOUT_MS = 3000;
const GH_TIMEOUT_MS = 5000; // the one network call this hook makes; bounded so a slow/unreachable gh can't stall every Stop

function isGitRepo(cwd) {
  // Works for both a normal repo (.git dir) and a worktree (.git is a pointer file) - 
  // existsSync doesn't care which.
  try { return fs.existsSync(path.join(cwd, '.git')); } catch { return false; }
}
function hasGithubRemote(cwd) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    return /github\.com/i.test(url);
  } catch { return false; } // no 'origin' remote, or git missing -> not a GitHub repo as far as we're concerned
}
function hasWorkflowsDir(cwd) {
  try {
    const dir = path.join(cwd, '.github', 'workflows');
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch { return false; }
}
function getDefaultBranch(cwd) {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return ref.split('/').pop() || 'main';
  } catch { return 'main'; } // origin/HEAD not tracked locally (e.g. shallow clone) -> assume main
}
function fetchLatestRun(cwd, branch) {
  try {
    const out = execFileSync('gh', ['run', 'list', '--branch', branch, '-L', '1', '--json',
      'databaseId,conclusion,status,headSha,url,workflowName,createdAt'],
      { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseGhRunJson(out);
  } catch { return null; } // gh missing/unauthed/no network/timeout -> silent
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => {
    try {
      if ((process.env.GLMPS_CI_SURFACE || '').toLowerCase() === 'off') { process.exit(0); }
      const inp = JSON.parse(raw || '{}');
      const cwd = inp.cwd || process.cwd();

      const gate = shouldQueryCi({
        isRepo: isGitRepo(cwd),
        hasGithubRemote: hasGithubRemote(cwd),
        hasWorkflowsDir: hasWorkflowsDir(cwd),
      });
      if (!gate) { process.exit(0); } // no repo / no GitHub remote / no CI configured -> stay completely silent

      const branch = getDefaultBranch(cwd);
      const run = fetchLatestRun(cwd, branch);
      const warning = decideCiWarning({ run, now: Date.now() });
      if (warning) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'Stop', additionalContext: warning },
        }));
      }
      process.exit(0);
    } catch { process.exit(0); } // fail open: a hook bug must never trap the user
  });
  process.stdin.on('error', () => process.exit(0));
}
