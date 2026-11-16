// server/lib/evaluation/replay-launch.js
// Headless replay launcher (glmps-68): runs a frozen replay task under a given
// model (`claude -p --model <id>`) and turns the run into a model-tagged
// OutcomeRow, so cohorts like unit:'model-claude-sonnet-5' feed the existing
// sequential-test/promotion comparison. This is the model-migration harness's
// missing edge: swap the model string, re-run the set, read the verdict.
//
// Safety rails:
// - The PROMPT never touches the command line (Windows shell unsafety rule);
//   it is piped via stdin from the task's promptFile.
// - The model string is allowlist-validated before it becomes an argv element.
// - Runs execute in a disposable git worktree (branch replay/<task>/<ts>) so a
//   headless agent can never dirty the real checkout; the worktree is force-
//   removed afterwards (the outcome row is the only artifact that matters).
// - Injected spawn/exec for tests - never a real claude/git in the suite.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { emptyOutcome } from './outcome-record.js';
import { appendOutcome } from './outcome-store.js';
import {
  worktreeAddRecipe, worktreeRemoveRecipe, worktreePruneRecipe, safeSeg,
} from '../orchestration/worktrees.js';
import { testRealGitWriteRefused } from '../orchestration/test-write-guard.js';

// Model ids are plain tokens (claude-sonnet-5, claude-opus-4-8, ...). Anything
// else is refused before it can become an argv element.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function validModel(model) {
  return typeof model === 'string' && MODEL_RE.test(model);
}

/**
 * argv for a headless replay run. Prompt is NOT here - it goes via stdin.
 */
export function buildReplayArgs({ model = null, maxTurns = 25 } = {}) {
  const args = ['-p', '--output-format', 'json', '--max-turns', String(maxTurns)];
  if (model) {
    if (!validModel(model)) throw new Error(`invalid model id: ${model}`);
    args.push('--model', model);
  }
  return { file: 'claude', args };
}

/**
 * Parse `claude -p --output-format json` stdout into the bits we score.
 * Fail-soft: unparseable output returns { ok: false }.
 */
export function parseReplayOutput(stdout) {
  try {
    const o = JSON.parse(String(stdout ?? '').trim());
    return {
      ok: o.subtype ? o.subtype === 'success' : !o.is_error,
      result: typeof o.result === 'string' ? o.result : null,
      sessionId: o.session_id ?? null,
      turns: typeof o.num_turns === 'number' ? o.num_turns : null,
      durationMs: typeof o.duration_ms === 'number' ? o.duration_ms : null,
      costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
      tokens: {
        in: o.usage?.input_tokens ?? null,
        out: o.usage?.output_tokens ?? null,
      },
    };
  } catch {
    return { ok: false, result: null, sessionId: null, turns: null, durationMs: null, costUsd: null, tokens: { in: null, out: null } };
  }
}

/**
 * Build the OutcomeRow for one finished replay run. Pure.
 * unit = model-<id> when a model override ran, else 'replay-baseline' - the
 * cohort key the promotion evaluator compares.
 */
export function replayOutcomeRow({ task, model = null, parsed, now = Date.now() } = {}) {
  // D23/D24 judge cutover (glmps-159 task 8): classifyTask() is deleted from
  // this path (task-classify.js itself stays for queue-runner.js's
  // resolveRoute, never ported). A replay row starts 'pending' like every
  // other outcome row; nothing currently re-judges replay rows after the
  // fact (only the finalize route's session rows go through the judge), so
  // this stays 'pending' rather than a guessed class.
  const taskClass = 'pending';
  return emptyOutcome({
    id: `replay-${safeSeg(task?.id)}-${model ? safeSeg(model) : 'baseline'}-${now}`,
    unit: model ? `model-${model}` : 'replay-baseline',
    ts: now,
    taskClass,
    model,
    turns: parsed?.turns ?? null,
    wallClockMs: { total: parsed?.durationMs ?? null },
    tokens: parsed?.tokens ?? { in: null, out: null },
    verifier: { exitOk: parsed?.ok ?? null },
    extra: {
      replayTask: task?.id ?? null,
      costUsd: parsed?.costUsd ?? null,
      replaySessionId: parsed?.sessionId ?? null,
    },
  });
}

function runProcess({ file, args, cwd, stdin, timeoutMs, spawnFn }) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    const done = (code) => { if (!settled) { settled = true; resolve({ code, stdout: out, stderr: err }); } };
    let child;
    try {
      child = spawnFn(file, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch { return done(-1); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(-2); }, timeoutMs);
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { err += d; });
    child.on('error', () => { clearTimeout(timer); done(-1); });
    child.on('close', (code) => { clearTimeout(timer); done(code ?? -1); });
    try { child.stdin?.write(stdin ?? ''); child.stdin?.end(); } catch {}
  });
}

/**
 * Run ONE replay task headlessly and append its OutcomeRow.
 * @param stateDir  outcome/replay state dir
 * @param task      { id, project, promptFile } (+ optional prompt inline)
 * @param repo      absolute path of the task's project repo (caller resolves)
 * @param model     optional model override (validated)
 * @param spawnFn / execFn injected for tests
 * @returns { row } or { row: null, error }
 */
export async function runReplayTask({
  stateDir, task, repo, model = null,
  worktreesDir = null, timeoutMs = 15 * 60 * 1000,
  spawnFn = nodeSpawn,
  execFn = (file, args) => execFileSync(file, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }),
  now = Date.now,
  // true refuses the run. Default is the shared
  // test-write guard (false outside a test process); the server passes its
  // own injected env through.
  gitWriteRefused = (r) => testRealGitWriteRefused(r),
} = {}) {
  if (model && !validModel(model)) return { row: null, error: 'invalid model' };
  // Every git write below (worktree add, worktree remove --force, branch -D,
  // prune) and the headless run itself target `repo`. In a test process a
  // real, non-temp repo is refused before any of them.
  if (repo && gitWriteRefused(repo)) {
    return { row: null, error: `refused: this is a test process and the replay repo is not a temp fixture (${repo})` };
  }
  let prompt = task?.prompt ?? null;
  if (!prompt && task?.promptFile) {
    try { prompt = fs.readFileSync(task.promptFile, 'utf-8'); } catch { return { row: null, error: 'prompt file unreadable' }; }
  }
  if (!prompt) return { row: null, error: 'no prompt' };

  // Disposable worktree so a headless agent can't dirty the real checkout.
  let cwd = repo;
  let wt = null;
  if (repo && worktreesDir) {
    const plan = {
      dir: path.join(worktreesDir, safeSeg(path.basename(repo)), `replay-${safeSeg(task.id)}-${now()}`),
      branch: `replay/${safeSeg(path.basename(repo))}/${safeSeg(task.id)}-${now()}`,
    };
    try {
      fs.mkdirSync(path.dirname(plan.dir), { recursive: true });
      const r = worktreeAddRecipe({ repo, dir: plan.dir, branch: plan.branch });
      execFn(r.file, r.args);
      cwd = plan.dir; wt = plan;
    } catch { /* fail-open: run in the repo root rather than not at all */ }
  }

  try {
    const { file, args } = buildReplayArgs({ model });
    const res = await runProcess({ file, args, cwd, stdin: prompt, timeoutMs, spawnFn });
    const parsed = parseReplayOutput(res.stdout);
    if (res.code !== 0 && !parsed.sessionId) parsed.ok = false;
    const row = replayOutcomeRow({ task, model, parsed, now: now() });
    appendOutcome(stateDir, row);
    return { row };
  } finally {
    if (wt) {
      // Replay worktrees are disposable by design (--force, -D): the outcome
      // row is the artifact; any file edits the headless run made are noise.
      try { const r = worktreeRemoveRecipe({ repo, dir: wt.dir }); execFn(r.file, r.args); } catch {}
      try { execFn('git', ['-C', repo, 'branch', '-D', wt.branch]); } catch {}
      try { const r = worktreePruneRecipe({ repo }); execFn(r.file, r.args); } catch {}
    }
  }
}

/**
 * Serial sweep over many tasks (parallel would thrash quota and correlate
 * failures). Never throws; per-task failures land as { error } entries.
 */
export async function runReplaySet({ stateDir, tasks = [], repoFor, model = null, ...opts } = {}) {
  const results = [];
  for (const task of tasks) {
    const repo = typeof repoFor === 'function' ? repoFor(task) : null;
    try {
      results.push({ task: task.id, ...(await runReplayTask({ stateDir, task, repo, model, ...opts })) });
    } catch (e) {
      results.push({ task: task.id, row: null, error: String(e?.message ?? e) });
    }
  }
  return results;
}
