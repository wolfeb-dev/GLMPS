// server/lib/orchestration/test-write-guard.js
// one predicate, used by every automatic
// git-writing path (the worktree sweep, the runner's own createWorktree, and
// reconcileNow's removeWorktree) - round 2's backstop lived inside
// sweepWorktrees alone and read only the injected env.NODE_TEST_CONTEXT, so
// ~17 test files that build env as a bare literal (never spreading
// process.env) still ran the real sweep against real repos, and a direct
// `node x.test.js` run (no NODE_TEST_CONTEXT at all - that is node --test's
// own child-process marker) bypassed it entirely too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUnderDir } from './worktrees.js';
import { isTestProcess } from '../test-process.js';

// Fix round 3 M2 / fix round 4 M1: ENOENT (the path does not exist yet -
// e.g. this module's own pure-function tests, which pass paths never
// actually created on disk) is the one expected case and falls back
// silently to the raw path, which isUnderDir then compares with its own
// case/separator-insensitive normalization. Any OTHER failure (EPERM, ELOOP,
// ...) is reported with a named reason and returns null: the caller treats
// an unresolvable path as NOT under tmpdir, so the predicate refuses - the
// safe direction. Never throws.
function realOrNull(p, realpath, onResolveError) {
  try {
    return realpath(p);
  } catch (e) {
    // A path not created yet resolves through its nearest existing ancestor,
    // so it lands in the same (native, long-name) form as the temp dir.
    if (e?.code === 'ENOENT') return realAncestorJoin(p, realpath) ?? p;
    onResolveError(`realpath-failed:${e?.code ?? 'unknown'} for ${p}: ${e?.message ?? e}`);
    return null;
  }
}

// Walks up from `p` to the first ancestor that realpath resolves, then
// re-appends the missing tail. Null when nothing up to the root resolves (the
// caller then keeps the raw path, as before).
function realAncestorJoin(p, realpath) {
  let dir = path.dirname(p);
  let tail = path.basename(p);
  while (dir !== path.dirname(dir)) {
    try { return path.join(realpath(dir), tail); }
    catch (e) {
      if (e?.code !== 'ENOENT') return null;
      tail = path.join(path.basename(dir), tail);
      dir = path.dirname(dir);
    }
  }
  return null;
}

function defaultOnResolveError(reason) {
  console.error(`[test-write-guard] ${reason} - refusing the git write`);
}

// The test-process signals live in the kernel's one shared predicate (Phase K
// SHARED HELPER ruling; switched at the trunk merge). Re-exported so the
// migration script's existing import keeps working - see
// testRealGitWriteRefused below for what each signal is and why it exists.
export { isTestProcess };

/**
 * True when a git-writing call against `repoRoot` must be refused.
 *
 * Refuses when BOTH hold:
 *   (a) this is a TEST PROCESS - any ONE of four independent signals:
 *       - processEnv.NODE_TEST_CONTEXT - node --test's own marker, set in
 *         every CHILD process it spawns (the ordinary `npm test` / `node
 *         --test` path, one process per file).
 *       - env.NODE_TEST_CONTEXT - the INJECTED env a caller passes to
 *         startServer(), which about 17 test files build as a bare literal
 *         ({GLMPS_STATE_DIR: ..., ...}) rather than spreading process.env, so
 *         the ambient signal above never reaches server.js's own `env` at
 *         all. This is the signal for exactly those files.
 *       - processEnv.GLMPS_TEST === '1' - test.env sets this; every `npm test`
 *         run loads it via --env-file, so it is present even under
 *         `--test-isolation=none` (which runs every file in ONE process,
 *         never spawning the child node --test itself marks) and even for
 *         a bare-literal-env caller, since this reads process.env directly.
 *       - env.GLMPS_TEST === '1' - the injected-env equivalent of the above,
 *         for the same bare-literal-env case NODE_TEST_CONTEXT's injected
 *         form covers.
 *       - argv[1] matching /\.test\.m?js$/ - a direct `node x.test.js` run
 *         outside the test runner entirely (never spawned by `node --test`,
 *         so NODE_TEST_CONTEXT was never set; may not have loaded test.env
 *         either), or any other invocation node --test's own child-process
 *         wrapping never touched.
 *   (b) `repoRoot` does NOT resolve (realpath) under the system temp
 *       directory - a real, persistent repo, never a test's own throwaway
 *       fixture (`fs.mkdtempSync`-based repos always resolve under it).
 * An explicit opt-in (GLMPS_TEST_ALLOW_REAL_SWEEP=1, from either processEnv or
 * the injected env) always answers false, regardless of (a)/(b).
 *
 * Every signal input is injectable (env, processEnv, argv, tmpDir) so this
 * can be exercised as a pure function, signal by signal, without ever
 * reading or depending on this actual process's own real env/argv - never
 * dressing up a global-state test as a pure one.
 */
export function testRealGitWriteRefused(repoRoot, {
  env = process.env,
  processEnv = process.env,
  argv = process.argv,
  tmpDir = os.tmpdir(),
  // injectable so a test can drive EPERM/ELOOP without a
  // real filesystem; onResolveError receives the named reason.
  // .native: the plain fs.realpathSync leaves an 8.3 short-name component
  // (a CI runner's C:\Users\RUNNER~1 TEMP) unexpanded, so a git-reported
  // long-form fixture path would read as NOT under tmpdir.
  realpath = fs.realpathSync.native,
  onResolveError = defaultOnResolveError,
} = {}) {
  if (!isTestProcess({ env, processEnv, argv })) return false;
  const optedIn = processEnv.GLMPS_TEST_ALLOW_REAL_SWEEP === '1' || env.GLMPS_TEST_ALLOW_REAL_SWEEP === '1';
  if (optedIn) return false;
  const realRepo = realOrNull(repoRoot, realpath, onResolveError);
  const realTmp = realOrNull(tmpDir, realpath, onResolveError);
  if (realRepo === null || realTmp === null) return true;
  return !isUnderDir(realRepo, realTmp);
}
