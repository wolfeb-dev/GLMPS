// apps/shell/src/lib/gitops-runner.js
// Runs the git, gh and test operations the kernel queued for the merge queue.
// The kernel runs as a Windows service in session 0 with no GitHub sign-in, and
// no service may hold the operator's credentials; this shell runs in the
// operator's own session. It claims each 'gitops' launch record through the
// same authenticated protocol the launch runner uses (launch-client.js), checks
// it against the allowlist in gitops-allow.js (the only thing that decides what
// may run), runs it and posts { status, stdout, stderr } back.
//
// Records run concurrently: a 30 minute test run must not stop a `gh pr view`
// for another branch from being claimed within the kernel's claim wait.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLaunchClient } from './launch-client.js';
import { defaultReadLaunchToken, validRunnerPath } from './launch-runner.js';
import { agyChildEnv, defaultKillTree } from './agy-runner.js';
import { validateGitopsOp } from './gitops-allow.js';
import { runVendorCard, resolveVendorBinary } from './vendor-card.js';
import { runRelease } from './release-run.js';

const OUTPUT_CAP = 256 * 1024;
const MAX_IN_FLIGHT = 8;

// No GH_TOKEN and friends: the operator's gh and git sign-ins are found through
// their own profile files and credential store, not through inherited variables,
// and a PR's test suite must not see a token in its environment.
export function gitopsChildEnv(src = process.env) {
  return { ...agyChildEnv(src), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GCM_INTERACTIVE: 'never' };
}

function isTestProcess() {
  return !!(process.env.NODE_TEST_CONTEXT || process.env.GLMPS_TEST === '1' || /\.test\.m?js$/.test(process.argv?.[1] ?? ''));
}
function refusingSpawn() {
  throw new Error('refused: test process, no injected spawnImpl');
}

const PROMPT_MAX = 4 * 1024 * 1024;
const VENDOR_STEP_CAP = 2 * 1024 * 1024;
const RELEASE_STEP_MS = 2 * 60 * 1000;
const RELEASE_CLEANUP_MS = 30 * 1000;

function defaultWriteTemp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-vendor-pr-'));
  const file = path.join(dir, 'body.md');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

// The claude binary itself, never a .cmd shim: a .cmd needs a shell, and the
// review's argv must not be re-parsed by cmd.exe. An npm install puts a
// claude.cmd on PATH whose real target is the package's bin/claude.exe.
export function resolveClaudeBinary({ env = process.env, exists = fs.existsSync, home = os.homedir(), platform = process.platform } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const exe = win ? 'claude.exe' : 'claude';
  const dirs = String(env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const direct = P.join(dir, exe);
    if (exists(direct)) return direct;
    const shimmed = P.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe);
    if (exists(shimmed)) return shimmed;
  }
  const local = P.join(home, '.local', 'bin', exe);
  return exists(local) ? local : null;
}

function defaultReadPrompt(promptFile, stateDir) {
  const v = validRunnerPath(promptFile, stateDir);
  if (!v.ok) return v;
  try {
    const text = fs.readFileSync(promptFile, 'utf8');
    return text.length > PROMPT_MAX ? { ok: false, reason: 'review prompt file is too large' } : { ok: true, text };
  } catch (e) { return { ok: false, reason: `review prompt could not be read: ${e?.message ?? e}` }; }
}

// A test run's or a review's verdict is at the end of its output, and so is a
// CI job log's test summary; any other git or gh read is cut at its end.
const keepsTail = (recipe) => recipe.kind === 'test' || recipe.kind === 'review' || recipe.kind === 'card' || recipe.kind === 'vendor-step'
  || (recipe.kind === 'gh' && recipe.args?.[0] === 'run' && recipe.args?.[2] === '--job' && recipe.args?.at(-1) === '--log');

function collector(tail, max) {
  let buf = '';
  return {
    push(d) {
      buf += d;
      if (buf.length > max * 2) buf = tail ? buf.slice(-max * 2) : buf.slice(0, max * 2);
    },
    text() { return buf.length <= max ? buf : (tail ? buf.slice(-max) : buf.slice(0, max)); },
  };
}

export function createGitopsRunner({
  kernelUrl, fetchImpl = fetch, spawnImpl, stateDir = null, readLaunchToken = defaultReadLaunchToken, log = () => {},
  intervalMs = 500, env = gitopsChildEnv(), killTree = defaultKillTree,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, nowImpl = Date.now,
  resolveClaude = () => resolveClaudeBinary(), readPrompt = defaultReadPrompt, worktreesDir = null,
  realpath = fs.realpathSync.native, resolveBinary = (n) => resolveVendorBinary(n), exists = fs.existsSync,
  writeTemp = defaultWriteTemp, runReleaseImpl = runRelease,
}) {
  const realSpawn = spawnImpl ?? (isTestProcess() ? refusingSpawn : spawn);
  const { authedRequest, verifiedJson } = createLaunchClient({ kernelUrl, fetchImpl });
  let timer = null; let busy = false; let lastLogged = '';
  const inFlight = new Set();
  const cancels = new Map(); // record id -> { cancel() } for runs in flight

  // One operation. Resolves { result } or { error }; never throws.
  // `input`, when given, is written to the child's stdin (the review prompt).
  // `ctl.cancel` is set once the child exists; the kernel's cancel request calls it.
  function execute(recipe, maxOutput, input = null, ctl = {}) {
    return new Promise((resolve) => {
      let child;
      const started = recipe.kind === 'test'
        ? () => realSpawn(recipe.command, [], { cwd: recipe.cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
        : () => realSpawn(recipe.file, recipe.args, { ...(recipe.cwd ? { cwd: recipe.cwd } : {}), windowsHide: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: recipe.env ?? env });
      try { child = started(); } catch (e) { return resolve({ error: e?.message ?? String(e) }); }
      if (input != null) {
        child.stdin?.on('error', () => { /* the child exited before reading it all */ });
        child.stdin?.end(input);
      }
      const out = collector(keepsTail(recipe), maxOutput);
      const err = collector(keepsTail(recipe), maxOutput);
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeoutImpl(limit); resolve(v); };
      // Resolve at the timeout rather than on 'close': a killed shell can leave
      // grandchildren holding the pipes open, and 'close' would never come.
      const limit = setTimeoutImpl(() => {
        try { killTree(child); } catch { /* already gone */ }
        finish({ result: { status: -1, stdout: out.text(), stderr: err.text(), timedOut: true } });
      }, recipe.timeoutMs);
      ctl.cancel = () => {
        try { killTree(child); } catch { /* already gone */ }
        finish({ result: { status: -2, stdout: out.text(), stderr: err.text(), timedOut: false, cancelled: true } });
      };
      child.stdout?.on('data', (d) => out.push(d.toString()));
      child.stderr?.on('data', (d) => err.push(d.toString()));
      child.on('error', (e) => finish({ error: `${recipe.kind === 'test' ? 'test command' : recipe.file} failed to start: ${e?.message ?? e}` }));
      child.on('close', (code) => finish({ result: { status: Number.isInteger(code) ? code : 1, stdout: out.text(), stderr: err.text(), timedOut: false } }));
    });
  }

  async function executeReview(recipe, maxOutput, ctl) {
    const prompt = readPrompt(recipe.promptFile, stateDir);
    if (!prompt.ok) return { error: prompt.reason };
    const claude = resolveClaude();
    if (!claude) return { error: 'the claude binary was not found on the operator PATH or in ~/.local/bin' };
    return execute({ ...recipe, file: claude }, maxOutput, prompt.text, ctl);
  }

  // The vendor card is a fixed sequence of processes (agent, git, graphify,
  // tests, gh), each run through execute(). The kernel gets one small JSON
  // document, so the per-step output cap is far above the agent's JSON.
  async function executeVendorCard(recipe, ctl) {
    let cancelled = false;
    let current = {};
    ctl.cancel = () => { cancelled = true; current.cancel?.(); };
    const run = async (file, args, o) => {
      if (cancelled) return { status: -2, stdout: '', stderr: 'cancelled', timedOut: false };
      current = {};
      const out = await execute({ kind: 'vendor-step', file, args, cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs }, VENDOR_STEP_CAP, o.stdin, current);
      return out.error ? { status: -3, stdout: '', stderr: out.error, timedOut: false } : out.result;
    };
    let doc;
    try {
      doc = await runVendorCard(recipe, { run, readPrompt: (f) => readPrompt(f, stateDir), writeTemp, resolveBinary, exists, env });
    } catch (e) {
      return { result: { status: 1, stdout: JSON.stringify({ error: String(e?.message ?? e).slice(0, 500) }), stderr: '', timedOut: false } };
    }
    return { result: { status: 0, stdout: JSON.stringify(doc), stderr: '', timedOut: false } };
  }

  // The release after a merge (card glmps-2-0-216): a fixed git and gh sequence
  // in release-run.js, unfenced, since pushing the version commit is its job.
  // recipe.timeoutMs is the whole release's deadline, kept below the broker's
  // release timeout: past it the kernel lifts the merge queue's release hold,
  // so nothing may still push after that (card glmps-2-0-223).
  async function executeRelease(recipe, ctl) {
    let cancelled = false;
    let expired = false;
    let current = {};
    const deadline = nowImpl() + recipe.timeoutMs;
    ctl.cancel = () => { cancelled = true; current.cancel?.(); };
    const overall = setTimeoutImpl(() => { expired = true; ctl.cancel(); }, recipe.timeoutMs);
    // A cleanup step (worktree remove, local tag delete) pushes nothing, so it
    // runs even after a cancel or the deadline, under its own short cap.
    const run = async (file, args, o = {}) => {
      const left = deadline - nowImpl();
      if (left <= 0) expired = true;
      if (o.cleanup === true) {
        const out = await execute({ kind: 'release-step', file, args, cwd: o.cwd, timeoutMs: RELEASE_CLEANUP_MS }, VENDOR_STEP_CAP, null, {});
        return out.error ? { status: -3, stdout: '', stderr: out.error, timedOut: false } : out.result;
      }
      if (cancelled || expired) return { status: -2, stdout: '', stderr: expired ? 'release deadline passed' : 'cancelled', timedOut: expired };
      current = {};
      const out = await execute({ kind: 'release-step', file, args, cwd: o.cwd, timeoutMs: Math.min(RELEASE_STEP_MS, left) }, VENDOR_STEP_CAP, null, current);
      return out.error ? { status: -3, stdout: '', stderr: out.error, timedOut: false } : out.result;
    };
    let doc;
    try { doc = await runReleaseImpl(recipe, { run, worktreesDir }); } catch (e) { doc = { ok: false, reason: String(e?.message ?? e).slice(0, 500) }; }
    finally { clearTimeoutImpl(overall); }
    if (expired) doc = { ok: false, reason: `release stopped at its ${Math.round(recipe.timeoutMs / 60000)} minute deadline: ${String(doc?.reason ?? 'finished late').slice(0, 300)}` };
    return { result: { status: 0, stdout: JSON.stringify(doc), stderr: '', timedOut: false } };
  }

  async function handle(token, r) {
    const v = validateGitopsOp(r.op, { roots: r.op?.roots, stateDir, worktreesDir, realpath });
    const cap = Number.isFinite(r.op?.maxOutput) && r.op.maxOutput > 0 ? Math.min(r.op.maxOutput, OUTPUT_CAP) : OUTPUT_CAP;
    let outcome;
    const ctl = {};
    cancels.set(r.id, ctl);
    try {
      if (!v.ok) outcome = { error: `refused by shell: ${v.reason}` };
      else if (v.recipe.kind === 'vendor-card') outcome = await executeVendorCard(v.recipe, ctl);
      else if (v.recipe.kind === 'release') outcome = await executeRelease(v.recipe, ctl);
      else if (v.recipe.kind === 'review' || v.recipe.kind === 'card') outcome = await executeReview(v.recipe, cap, ctl);
      else outcome = await execute(v.recipe, cap, null, ctl);
    } finally { cancels.delete(r.id); }
    await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/result`, {
      method: 'POST', body: outcome.error ? { error: String(outcome.error).slice(0, 500) } : { result: outcome.result },
    });
  }

  const logOnce = (key, message) => { if (key === lastLogged) return; lastLogged = key; log(message); };

  async function tick() {
    if (busy) return; busy = true;
    try {
      const { token, reason } = readLaunchToken(stateDir);
      if (!token) { logOnce(`token:${reason}`, `gitops: ${reason} - refusing to run any queued git, gh or test operation`); return; }
      const { res: pollRes, target: pollTarget } = await authedRequest(token, '/api/launches?state=pending');
      if (!pollRes.ok) { logOnce(`status:${pollRes.status}`, `gitops: kernel answered ${pollRes.status}`); return; }
      const verifiedPoll = await verifiedJson(token, pollRes, pollTarget);
      if (!verifiedPoll.ok) { logOnce('unverified', `gitops: ${verifiedPoll.reason}`); return; }
      lastLogged = '';
      const pending = Array.isArray(verifiedPoll.body?.pending) ? verifiedPoll.body.pending : [];
      const cancel = Array.isArray(verifiedPoll.body?.cancel) ? verifiedPoll.body.cancel : [];
      for (const id of cancel) { if (typeof id === 'string') cancels.get(id)?.cancel?.(); }
      for (const r of pending) {
        if (r?.origin !== 'gitops' || typeof r.id !== 'string') continue;
        if (inFlight.size >= MAX_IN_FLIGHT) break;
        try {
          const { res: claimRes, target: claimTarget } = await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/claim`, { method: 'POST', body: { by: 'desktop-shell' } });
          if (!claimRes.ok) continue;
          const verifiedClaim = await verifiedJson(token, claimRes, claimTarget);
          if (!verifiedClaim.ok) { log(`gitops call ${r.id} refused: ${verifiedClaim.reason}`); continue; }
          const job = handle(token, r)
            .catch((e) => log(`gitops call ${r.id} failed: ${e.message}`))
            .finally(() => inFlight.delete(job));
          inFlight.add(job);
        } catch (e) {
          log(`gitops call ${r.id} failed: ${e.message}`);
        }
      }
    } catch (e) { logOnce(`error:${e.message}`, `gitops: ${e.message}`); } finally { busy = false; }
  }

  return {
    tick,
    idle: async () => { while (inFlight.size) await Promise.all([...inFlight]); },
    start() { if (!timer) timer = setInterval(() => { void tick(); }, intervalMs); },
    stop() { clearInterval(timer); timer = null; },
  };
}
