// server/lib/orchestration/merge-tests.js
//
// The testing stage of the GLMPS 2.0 merge queue (spec:
// docs/specs/2026-10-17-glmps2-merge-queue.md). Finds the local checkout for a
// merge request, builds a throwaway detached worktree at the PR head, merges
// the base into it locally (never pushes), runs the repo's test command and
// reports an outcome. Fails closed: any git or executor error is an 'error'
// outcome, never a pass.
//
// Git and the test command run behind two injectable async seams so the
// planning is testable without a process; the defaults are the real thing.

import fs from 'node:fs';
import path from 'node:path';
import { transition } from './merge-queue.js';
import { isGitopsInfraError } from './gitops-broker.js';
import { short, errText, defaultGit, defaultRunTest, resolveTestCommand, TAIL_CHARS } from './merge-util.js';
import { selectAffectedTests, affectedCommands, isTestFile } from './affected-tests.js';
import { failingFiles } from './main-suite.js';
import { redPauseReason } from './merge-queue.js';

const NO_COMMAND = 'no test command configured';

function defaultReadPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

function defaultReadTest(dir, file) {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * Every file under `dir` as a forward-slash relative path, skipping .git and
 * node_modules. Not git ls-files: the desktop shell's git allowlist refuses
 * it (glmps-2-0-runtime-112). The worktree is a fresh checkout, so this is the
 * tracked set. Symlinked directories are not followed.
 */
export function defaultListFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out;
}

/**
 * F6 (glmps-2-0-runtime-98): narrow the repo's own `npm test` to the test
 * files the change affects. Resolves { selection, commands?, none? }; any
 * doubt runs the full suite, so a git failure here never fails the stage.
 */
async function selectForRun({ g, workDir, mergedBaseSha, override, fallback, pkg, readTest, listFiles, extraTests = [] }) {
  const full = (reason) => ({ selection: { mode: 'full', reason } });
  if (override?.test || fallback) return full('the test command is not the repo test script');
  const diff = await g(['diff', '--name-only', mergedBaseSha, 'HEAD'], workDir);
  if (diff.status !== 0) return full(`git diff failed: ${String(diff.stderr || `exit ${diff.status}`).trim().slice(0, 200)}`);
  let testFiles;
  try { testFiles = listFiles(workDir).filter(isTestFile); } catch (e) {
    return full(`could not list the test files: ${errText(e).slice(0, 200)}`);
  }
  const lines = (s) => String(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const picked = selectAffectedTests({ changed: lines(diff.stdout), testFiles, readFile: (f) => readTest(workDir, f) });
  if (picked.full) return full(picked.full);
  // glmps-2-0-runtime-125: on a red base the red run's failing files run too,
  // so a pass proves the PR leaves them green. One the PR deleted is skipped.
  const present = new Set(testFiles);
  const redFiles = [...new Set(extraTests)].filter((f) => present.has(f)).sort();
  const files = [...new Set([...picked.files, ...redFiles])].sort();
  const selection = { mode: 'affected', files: files.length, of: testFiles.length, ...(extraTests.length ? { redFiles } : {}) };
  if (!files.length) return { selection, none: true };
  const commands = affectedCommands(pkg?.scripts?.test, files);
  if (!commands) return full(`${files.length} affected test files, but the test script cannot be narrowed to them`);
  return { selection: commands.length > 1 ? { ...selection, commands: commands.length } : selection, commands };
}

const MERGE_IDENTITY =['-c', 'user.name=merge-queue', '-c', 'user.email=merge-queue@localhost', '-c', 'commit.gpgsign=false'];

/**
 * Run the testing stage for one merge request. Never throws. Resolves an
 * outcome: { kind: 'pass'|'fail'|'error'|'conflict', tests?, headSha?,
 * headMoved?, conflict? }. The throwaway worktree is always removed.
 */
export async function runMergeTests({
  mr, repoPath, workDir, override = null, extraTests = [],
  git = defaultGit, runTest = defaultRunTest, readPkg = defaultReadPkg, readTest = defaultReadTest, listFiles = defaultListFiles,
}) {
  const ctx = { headSha: mr.headSha };
  const fail = (step, r) => ({
    kind: 'error', tests: { status: 'error', reason: `git ${step} failed: ${String(r?.stderr || r?.stdout || `exit ${r?.status}`).trim().slice(0, 300)}` },
    ...(ctx.headMoved ? { headSha: ctx.headSha, headMoved: ctx.headMoved } : {}),
  });
  // When the desktop shell cannot make a git call (not running, refused) the
  // request is held, not failed: that is no verdict on the PR. Cleanup is quiet.
  const g = async (args, cwd, { quiet = false } = {}) => {
    try { return await git(args, { cwd }); } catch (e) {
      if (!quiet && isGitopsInfraError(e)) throw Object.assign(new Error(errText(e)), { hold: true });
      return { status: 1, stdout: '', stderr: errText(e) };
    }
  };
  let added = false;
  try {
    // A leftover from a crashed run is ours (a merge-queue subfolder), so it is removed forcibly.
    await g(['worktree', 'remove', '--force', workDir], repoPath);
    try { if (fs.existsSync(workDir)) await fs.promises.rm(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    await g(['worktree', 'prune'], repoPath);

    const fetched = await g(['fetch', '-q', 'origin'], repoPath);
    if (fetched.status !== 0) return fail('fetch', fetched);

    const add = await g(['worktree', 'add', '--detach', workDir, `origin/${mr.head}`], repoPath);
    if (add.status !== 0) return fail('worktree add', add);
    added = true;

    const head = await g(['rev-parse', 'HEAD'], workDir);
    const headSha = head.stdout.trim();
    if (head.status !== 0 || !headSha) return fail('rev-parse HEAD', head);
    if (headSha !== mr.headSha) { ctx.headSha = headSha; ctx.headMoved = { from: mr.headSha, to: headSha }; }

    const baseRev = await g(['rev-parse', `origin/${mr.base}`], workDir);
    const mergedBaseSha = baseRev.stdout.trim();
    if (baseRev.status !== 0 || !mergedBaseSha) return fail(`rev-parse origin/${mr.base}`, baseRev);

    const merge = await g([...MERGE_IDENTITY, 'merge', '--no-ff', '-m', `merge-queue test merge of ${mr.base}`, `origin/${mr.base}`], workDir);
    if (merge.status !== 0) {
      const unmerged = await g(['diff', '--name-only', '--diff-filter=U'], workDir);
      const files = unmerged.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await g(['merge', '--abort'], workDir);
      if (files.length) {
        return { kind: 'conflict', conflict: { files }, headSha: ctx.headSha, ...(ctx.headMoved ? { headMoved: ctx.headMoved } : {}) };
      }
      return fail('merge', merge);
    }

    // The tested-tree record (tested-trees.js) keys on this. Unreadable is no
    // record, not a failed stage: promotion then runs the suite itself.
    const tree = await g(['rev-parse', 'HEAD^{tree}'], workDir);
    const treeSha = tree.status === 0 && /^[0-9a-f]{40,64}$/.test(tree.stdout.trim()) ? tree.stdout.trim() : null;

    const pkg = readPkg(workDir);
    const { command, timeoutMs, fallback } = resolveTestCommand({ override, pkg });
    const stamp = { treeSha, headSha: ctx.headSha, mergedBaseSha, ...(fallback ? { command } : {}) };
    const extra = ctx.headMoved ? { headMoved: ctx.headMoved, command } : { command };
    if (!command) {
      return { kind: 'pass', headSha: ctx.headSha, ...extra, tests: { status: 'skipped', reason: NO_COMMAND, ...stamp } };
    }
    const sel = await selectForRun({ g, workDir, mergedBaseSha, override, fallback, pkg, readTest, listFiles, extraTests });
    stamp.selection = sel.selection;
    const commands = sel.commands ?? [command];
    if (sel.none) {
      return { kind: 'pass', headSha: ctx.headSha, ...extra, tests: { status: 'skipped', reason: 'no test file is affected by the change', ...stamp } };
    }
    // A long affected list is several commands; they share the one ceiling.
    const runAll = async () => {
      const t0 = Date.now();
      let last = null;
      for (let i = 0; i < commands.length; i += 1) {
        const left = i === 0 ? timeoutMs : timeoutMs - (Date.now() - t0);
        if (left <= 0) return { exitCode: null, timedOut: true, tail: last?.tail ?? '', durationMs: Date.now() - t0 };
        last = await runTest({ command: commands[i], cwd: workDir, timeoutMs: left });
        if (last.timedOut || last.exitCode !== 0) break;
      }
      return commands.length === 1 ? last : { ...last, durationMs: Date.now() - t0 };
    };
    const runOnce = async () => {
      try { return { run: await runAll() }; }
      catch (e) {
        if (isGitopsInfraError(e)) return { out: { kind: 'held', reason: errText(e), headSha: ctx.headSha, ...extra } };
        return { out: { kind: 'error', headSha: ctx.headSha, ...extra, tests: { status: 'error', reason: `test executor failed: ${errText(e)}`, ...stamp } } };
      }
    };
    let r = await runOnce();
    if (r.out) return r.out;
    let flaky = null;
    // One rerun absorbs a flaky test in a large suite, which would otherwise
    // bounce an innocent PR and spend one of its rounds. A timeout is not rerun.
    if (!r.run.timedOut && r.run.exitCode !== 0) {
      flaky = { firstExitCode: r.run.exitCode, firstTail: String(r.run.tail ?? '').slice(-TAIL_CHARS) };
      r = await runOnce();
      if (r.out) return r.out;
    }
    const run = r.run;
    const base = { ...stamp, durationMs: run.durationMs ?? null, timeoutMs, tail:String(run.tail ?? '').slice(-TAIL_CHARS) };
    if (run.timedOut) {
      return { kind: 'timeout', headSha: ctx.headSha, ...extra, tests: { status: 'fail', timedOut: true, reason: `timed out after ${timeoutMs} ms`, ...base } };
    }
    if (run.exitCode !== 0) {
      return { kind: 'fail', headSha: ctx.headSha, ...extra, tests: { status: 'fail', reason: `exit code ${run.exitCode} (failed again on a rerun)`, ...base } };
    }
    const why = fallback ? { reason: `no test command; ran the ${fallback} script` } : {};
    return { kind: 'pass', headSha: ctx.headSha, ...extra, tests: { status: 'pass', ...why, ...base, ...(flaky ? { flaky } : {}) } };
  } catch (e) {
    if (e?.hold) return { kind: 'held', reason: errText(e), ...(ctx.headMoved ? { headSha: ctx.headSha, headMoved: ctx.headMoved } : {}) };
    return { kind: 'error', tests: { status: 'error', reason: errText(e) } };
  } finally {
    if (added) {
      await g(['worktree', 'remove', '--force', workDir], repoPath, { quiet: true });
      // A just-killed test process can still hold the directory on Windows.
      // Async: rmSync's linear-backoff retries would block the loop for up to 11 s.
      try {
        if (fs.existsSync(workDir)) {
          await fs.promises.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
          await g(['worktree', 'prune'], repoPath, { quiet: true });
        }
      } catch { /* best effort */ }
    }
  }
}

/**
 * Fold an outcome into the merge request. Returns { mergeRequest, text } where
 * text is the devlog line. Pass goes to merging, a conflict back to the author,
 * anything else bounces (or holds in the last round, per the queue rule).
 */
export function applyOutcome(mr, outcome, { now, queue, id, red = null } = {}) {
  let cur = mr;
  if (outcome.headMoved) {
    cur = {
      ...cur, headSha: outcome.headSha,
      history: [...cur.history, { ts: now, from: cur.stage, to: cur.stage, reason: `head moved ${short(outcome.headMoved.from)} -> ${short(outcome.headMoved.to)}` }],
    };
  }
  const t = outcome.tests ?? null;
  const go = (to, reason, extra = {}) => {
    const r = transition({ ...cur, ...extra }, to, { now, reason, queue, id });
    if (r.error) return { mergeRequest: { ...cur, ...extra }, text: `merge queue could not move to ${to}: ${r.error}`, error: r.error };
    return r;
  };

  if (outcome.kind === 'held') {
    const r = go('held', outcome.reason);
    return { ...r, text: `tests held: ${outcome.reason}; held for the operator` };
  }
  if (outcome.kind === 'conflict') {
    const files = outcome.conflict?.files ?? [];
    const r = go('bounced', `merge conflict with ${cur.base} in ${files.join(', ')}`, { conflict: { files } });
    const held = r.mergeRequest?.stage === 'held';
    return { ...r, text: `merge conflict with ${cur.base} in ${files.join(', ')}; ${held ? 'held, round cap reached' : 'bounced to the author to merge the base and re-file'}` };
  }
  // glmps-2-0-runtime-125: the base is red, so only a proven fix merges into it.
  const redHold = (why) => {
    const reason = `paused: ${redPauseReason(cur.base, red)}`;
    const r = go('requested', `${reason}; ${why}`, { tests: t, queuedAt: now, redHold: red.sha });
    return { ...r, text: `${reason}. ${why}; it waits, no round spent, author not relaunched, and is tested again once the red changes` };
  };
  if (red && outcome.kind === 'pass') {
    const sel = t?.selection ?? {};
    const want = red.files ?? [];
    const ranAll = want.length > 0 && want.every((f) => (sel.redFiles ?? []).includes(f));
    const proven = t?.status === 'pass' && (ranAll || sel.mode === 'full' || (red.cardId && red.cardId === id));
    if (!proven) return redHold('the tests passed but do not show the red files green');
    const r = go('merging', 'tests passed and fix the red full suite', { tests: t, redFix: red.sha });
    return { ...r, text: `tests passed on ${short(t?.headSha)} merged with ${short(t?.mergedBaseSha)} and fixes the red full suite on ${cur.base}; on to merging` };
  }
  if (red && outcome.kind === 'fail') {
    const failed = failingFiles(t?.tail);
    if (failed.length && failed.every((f) => (red.files ?? []).includes(f))) return redHold(`it fails only in the base's red files (${failed.join(', ')})`);
  }
  if (outcome.kind === 'pass') {
    const r = go('merging', t?.status === 'skipped' ? `tests skipped: ${t.reason}` : 'tests passed', { tests: t });
    const text = t?.status === 'skipped'
      ? `tests skipped (${t.reason}); on to merging`
      : `tests passed${t?.command ? ` (${t.command}, no test script)` : ''} on ${short(t?.headSha)} merged with ${short(t?.mergedBaseSha)}${t?.durationMs != null ? ` in ${t.durationMs} ms` : ''}${load(t)}${t?.flaky ? ` (on a rerun: the first run exited ${t.flaky.firstExitCode}, likely a flaky test)` : ''}; on to merging`;
    return { ...r, text };
  }
  // F1 (glmps-2-0-runtime-98): a timeout is load until the same head times
  // out again after some other request passed inside the ceiling.
  if (outcome.kind === 'timeout') {
    const reason = t?.reason ?? 'timed out';
    const prior = (cur.loadHolds ?? []).filter((h) => h.headSha === cur.headSha).at(-1);
    const passer = prior ? passedSince(queue, id, prior.ts) : null;
    if (passer) {
      const r = go('bounced', `tests fail: ${reason} twice on ${short(cur.headSha)} while ${passer} passed in between`, { tests: t });
      const held = r.mergeRequest?.stage === 'held';
      return { ...r, text: `tests timed out twice on ${short(cur.headSha)} while ${passer} passed in between, so it is the change, not load; ${held ? 'held, round cap reached' : 'bounced to the author'}` };
    }
    const r = go('requested', `tests timed out (${reason}); load hold, no round spent`, {
      tests: t, queuedAt: now, loadHolds: [...(cur.loadHolds ?? []), { ts: now, headSha: cur.headSha }],
    });
    return { ...r, text: `tests timed out on ${short(cur.headSha)} (${reason}${load(t)}); load hold: requeued at the back of the queue, no round spent, author not relaunched` };
  }
  const kind = outcome.kind === 'fail' ? 'fail' : 'error';
  const failedFiles = kind === 'fail' ? failingFiles(t?.tail) : [];
  const reason = `${t?.reason ?? 'unknown'}${failedFiles.length ? ` in ${failedFiles.join(', ')}` : ''}`;
  const tests = t ? (kind === 'fail' ? { ...t, failedFiles } : t) : { status: 'error', reason };
  const r = go('bounced', `tests ${kind}: ${reason}`, { tests });
  const held = r.mergeRequest?.stage === 'held';
  return { ...r, text: `tests ${kind}: ${reason}; ${held ? 'held, round cap reached' : 'bounced to the author'}` };
}

const load = (t) => (Number.isInteger(t?.concurrentTests) ? `, ${t.concurrentTests} node --test running at start` : '');

/** The id of another request whose tests passed after `since`, else null. */
function passedSince(queue, id, since) {
  for (const c of Array.isArray(queue) ? queue : []) {
    if (!c?.mergeRequest || c.id === id) continue;
    const hit = (c.mergeRequest.history ?? []).some((h) => h.from === 'testing' && (h.to === 'merging' || h.to === 'reviewing') && /^tests passed/.test(h.reason ?? '') && h.ts > since);
    if (hit) return c.id;
  }
  return null;
}

/** A request found in testing with no in-flight job: note it and keep the stage. */
export function markRestarted(mr, { now }) {
  return { ...mr, history: [...mr.history, { ts: now, from: mr.stage, to: mr.stage, reason: 'restarted after server restart' }] };
}
