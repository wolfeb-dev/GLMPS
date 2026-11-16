// apps/shell/src/lib/vendor-card.js
// Runs a card with a non-Claude vendor CLI (agy for Gemini, codex for GPT, grok)
// in the card's worktree, then does everything the agent is not allowed to do
// itself: check what it changed, refresh the graph, run the affected tests,
// commit, push and open the PR. The service kernel has no GitHub sign-in and the
// agent must not push, so the push fence below is what keeps the agent from
// reaching GitHub while this module (unfenced) can. The argv is built here from
// values only; nothing from the record is ever a flag. Everything that touches a
// process is injected so the sequence is testable without starting one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGY_SIGNIN_MARKER, AGY_MODELS, newestGeminiModel } from './agy-runner.js';
import { isQuotaError, fallbackModelFor } from './model-fallback.js';

const ARGV_PROMPT_MAX = 30000;
const TEXT_MAX = 4000;
const TAIL_MAX = 4000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const GRAPHIFY_TIMEOUT_MS = 5 * 60 * 1000;
const TESTS_TIMEOUT_MS = 20 * 60 * 1000;
const MODELS_TIMEOUT_MS = 30 * 1000;
const DEFAULT_AGY_MODEL = newestGeminiModel(AGY_MODELS);
const BINARY = { gemini: 'agy', gpt: 'codex', grok: 'grok' };
const CODE_FILE = /\.(?:js|mjs|cjs|ts|py|cs)$/i;

function capArgvPrompt(prompt) {
  const p = String(prompt ?? '');
  if (p.length <= ARGV_PROMPT_MAX) return p;
  return `${p.slice(0, ARGV_PROMPT_MAX)}\n\n[prompt truncated: the Windows command line limit]`;
}

/** Display names from `agy models` (one "<id>\t<Name>" per line). */
export function parseAgyModels(stdout) {
  return String(stdout ?? '').split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
    .map((p) => p[1].trim());
}

// The operator wants the newest model by default (card glmps-2-0-164): a card
// that names none runs on the newest Gemini agy lists now, which may be newer
// than the allowlist. A named model agy no longer lists is refused before the
// run. An unreadable list keeps the run going on the pinned newest.
export function chooseAgyModel(requested, listed) {
  const live = Array.isArray(listed) ? listed : [];
  if (!live.length) return { model: requested ?? DEFAULT_AGY_MODEL };
  const newest = newestGeminiModel(live) ?? DEFAULT_AGY_MODEL;
  if (!requested) return { model: newest };
  if (live.includes(requested)) return { model: requested };
  return { error: `agy no longer lists the model "${requested}"; the newest it lists is "${newest}". Clear the card's model field to run on the newest, or name one agy lists.` };
}

/** Reads `agy models` through deps.run and picks the model for this run. */
export async function resolveAgyModel(requested, { run, resolveBinary, cwd, env }) {
  const bin = resolveBinary('agy');
  let listed = [];
  if (bin) {
    try {
      const r = await run(bin, ['models'], { cwd, env, stdin: null, timeoutMs: MODELS_TIMEOUT_MS });
      if (r?.status === 0 && !r.timedOut) listed = parseAgyModels(r.stdout);
    } catch { /* the pinned newest is used */ }
  }
  return { ...chooseAgyModel(requested, listed), listed };
}

export const nextAgyModel = (failed, listed) => fallbackModelFor('gemini', failed, listed);

// --model must precede -p for agy, or it ignores the prompt (see agy-runner.js).
export function vendorArgs({ vendor, model = null, cwd, prompt }) {
  if (vendor === 'gemini') {
    return { file: 'agy', args: ['--model', model ?? DEFAULT_AGY_MODEL, '--output-format', 'json', '--sandbox', '-p', capArgvPrompt(prompt)], stdin: null };
  }
  if (vendor === 'gpt') {
    return { file: 'codex', args: ['exec', '--sandbox', 'workspace-write', '--json', '-C', cwd, ...(model ? ['-m', model] : []), '-'], stdin: String(prompt ?? '') };
  }
  if (vendor === 'grok') {
    return {
      file: 'grok',
      args: ['-p', capArgvPrompt(prompt), '--cwd', cwd, '--output-format', 'streaming-json', '--always-approve',
        '--deny', 'Bash(git push*)', '--deny', 'Bash(gh *)', ...(model ? ['-m', model] : [])],
      stdin: null,
    };
  }
  throw new Error(`unknown vendor: ${String(vendor).slice(0, 40)}`);
}

// The tab mode (AC-6): the vendor CLI's own interactive session, started with
// an initial instruction. Grok's interactive mode is unverified (not installed),
// so it has none and its cards stay headless.
export function interactiveVendorArgs({ vendor, model = null, cwd, instruction }) {
  if (vendor === 'gemini') return { file: 'agy', args: ['--model', model ?? DEFAULT_AGY_MODEL, '--sandbox', '-i', String(instruction ?? '')] };
  if (vendor === 'gpt') return { file: 'codex', args: ['--sandbox', 'workspace-write', '-C', cwd, ...(model ? ['-m', model] : []), String(instruction ?? '')] };
  return null;
}

// An invalid GH_TOKEN stops gh; an unusable pushurl stops `git push` to origin.
// A push to an explicit URL skips the pushurl, so the credential helper list is
// emptied too (an empty helper value resets every lower-scope helper, the Git
// Credential Manager included), and gh gets an empty config dir so it finds no
// keyring login once GH_TOKEN is unset. This keeps a well-meaning agent off
// GitHub; it is not a boundary against one that sets out to undo its own env.
// Appends to a GIT_CONFIG_COUNT the base env already carries.
export function fencedAgentEnv(baseEnv = {}) {
  const env = { ...baseEnv };
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const i = Number.isInteger(n) && n >= 0 ? n : 0;
  env[`GIT_CONFIG_KEY_${i}`] = 'remote.origin.pushurl';
  env[`GIT_CONFIG_VALUE_${i}`] = 'glmps-fence://push-blocked';
  env[`GIT_CONFIG_KEY_${i + 1}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${i + 1}`] = '';
  env.GIT_CONFIG_COUNT = String(i + 2);
  env.GH_TOKEN = 'glmps-vendor-fence-no-github';
  env.GITHUB_TOKEN = 'glmps-vendor-fence-no-github';
  env.GH_CONFIG_DIR = path.join(os.tmpdir(), 'glmps-vendor-fence-gh');
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  // An IDE terminal hands git its own askpass, which answers with the IDE's
  // GitHub login. An empty GIT_ASKPASS makes git skip askpass entirely.
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  for (const k of Object.keys(env)) if (/^VSCODE_GIT_(ASKPASS|IPC)/.test(k)) delete env[k];
  env.GIT_SSH_COMMAND = 'glmps-vendor-fence-no-ssh';
  return env;
}

// The runner executes the affected tests outside any vendor sandbox, so a
// change to what decides or runs them is never executed there.
const TEST_HARNESS = new Set(['package.json', 'package-lock.json', 'test.env', 'scripts/affected-tests.mjs', 'server/lib/orchestration/affected-tests.js']);
export function harnessChanges(paths) {
  return (Array.isArray(paths) ? paths : []).filter((p) => TEST_HARNESS.has(String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()));
}

/** What scripts/affected-tests.mjs says it ran: 'ran', 'none', 'full', or null when it printed no selection. */
export function testSelection(stdout) {
  const s = String(stdout ?? '');
  if (/^affected-tests: node /m.test(s)) return 'ran';
  if (/^affected-tests: nothing to run/m.test(s)) return 'none';
  if (/^affected-tests: .*full suite needed/m.test(s)) return 'full';
  return null;
}

const SECRET_NAME = [/^\.env(?:\..*)?$/, /\.pem$/, /\.key$/, /^id_rsa/, /\.pfx$/, /\.p12$/, /^credentials/, /secret/, /token.*\.json$/, /^\.npmrc$/, /^\.netrc$/];
const INSTRUCTION_NAME = new Set(['claude.md', 'agents.md', 'gemini.md', 'claude.global.md']);
const AGENT_DIRS = new Set(['.claude', '.codex', '.grok', '.gemini']);

function fenceReason(p) {
  const segs = String(p).replace(/\\/g, '/').toLowerCase().split('/').filter((s) => s && s !== '.');
  if (!segs.length) return null;
  const name = segs[segs.length - 1];
  if (SECRET_NAME.some((re) => re.test(name))) return 'secret or credential file';
  if (segs.includes('prod')) return 'prod zone';
  if (INSTRUCTION_NAME.has(name)) return 'instruction file';
  if (segs.some((s) => AGENT_DIRS.has(s)) || segs[0] === 'hooks') return 'hook or agent settings';
  if (segs[0] === '.github' && segs[1] === 'workflows') return 'CI workflow';
  return null;
}

export function fenceViolations(paths) {
  return (Array.isArray(paths) ? paths : []).filter((p) => fenceReason(p) !== null);
}

const cap = (s, n = TEXT_MAX) => String(s ?? '').slice(0, n);
const tryJson = (line) => { try { const v = JSON.parse(line); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const tryJsonArray = (s) => { try { const v = JSON.parse(String(s ?? '').trim()); return Array.isArray(v) ? v : null; } catch { return null; } };
const jsonLines =(s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(tryJson).filter(Boolean);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);

const AUTH_RE = /\b401\b|unauthori[sz]ed|sign[ -]?in|log[ -]?in\b|login|access token could not be refreshed|not authenticated|re-?authenticate/i;
const authText = (s) => AUTH_RE.test(String(s ?? '')) || String(s ?? '').includes(AGY_SIGNIN_MARKER);

function parseAgy(stdout) {
  const whole = tryJson(String(stdout ?? '').trim());
  if (!whole) return { sessionId: null, text: cap(stdout), usage: null, costUsd: null, errorText: String(stdout ?? '') };
  const u = whole.usage;
  const ok = String(whole.status ?? '').toUpperCase() === 'SUCCESS';
  return {
    sessionId: typeof whole.conversation_id === 'string' ? whole.conversation_id : null,
    text: cap(typeof whole.response === 'string' ? whole.response : ''),
    usage: u && typeof u === 'object' ? { input: num(u.input_tokens), output: num(u.output_tokens), total: num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens) } : null,
    costUsd: null,
    errorText: ok ? '' : `${whole.status ?? ''} ${typeof whole.response === 'string' ? whole.response : ''} ${whole.error ?? ''}`,
  };
}

function parseCodex(stdout) {
  let sessionId = null; let text = ''; let input = 0; let output = 0; let seen = false; const errors = [];
  for (const ev of jsonLines(stdout)) {
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') sessionId = ev.thread_id;
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
    else if (ev.type === 'turn.completed' && ev.usage) { seen = true; input += num(ev.usage.input_tokens); output += num(ev.usage.output_tokens); }
    else if (ev.type === 'error' && typeof ev.message === 'string') errors.push(ev.message);
    else if (ev.type === 'turn.failed') errors.push(String(ev.error?.message ?? ev.message ?? ''));
  }
  return { sessionId, text: cap(text), usage: seen ? { input, output, total: input + output } : null, costUsd: null, errorText: errors.join('\n') };
}

// The grok stream shape is unverified, so this takes the last string it can
// find under a few common keys and any usage-like object.
function parseGrok(stdout) {
  let sessionId = null; let text = ''; let usage = null; let costUsd = null; const errors = [];
  const nonJson = [];
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const ev = tryJson(line);
    if (!ev) { nonJson.push(line); continue; }
    for (const k of ['session_id', 'sessionId']) if (typeof ev[k] === 'string') sessionId = ev[k];
    for (const k of ['text', 'result', 'response']) if (typeof ev[k] === 'string' && ev[k]) text = ev[k];
    const u = ev.usage && typeof ev.usage === 'object' ? ev.usage : null;
    if (u && (u.input_tokens != null || u.output_tokens != null || u.inputTokens != null || u.outputTokens != null)) {
      const input = num(u.input_tokens ?? u.inputTokens); const output = num(u.output_tokens ?? u.outputTokens);
      usage = { input, output, total: num(u.total_tokens ?? u.totalTokens) || input + output };
    }
    for (const k of ['cost_usd', 'costUsd', 'total_cost_usd']) if (Number.isFinite(ev[k])) costUsd = ev[k];
    if (ev.type === 'error' || ev.is_error === true) errors.push(String(ev.message ?? ev.error ?? ev.result ?? ''));
  }
  return { sessionId, text: cap(text), usage, costUsd, errorText: [...errors, ...nonJson].join('\n') };
}

export function parseAgentOutput(vendor, stdout, stderr) {
  const p = vendor === 'gemini' ? parseAgy(stdout) : vendor === 'gpt' ? parseCodex(stdout) : parseGrok(stdout);
  // Only error output is searched, so a successful answer that talks about
  // logging in is not mistaken for a failed sign-in.
  return {
    sessionId: p.sessionId, text: p.text, usage: p.usage, costUsd: p.costUsd,
    authFailed: authText(p.errorText) || authText(stderr),
    quotaExhausted: isQuotaError(vendor, p.errorText) || isQuotaError(vendor, stderr),
  };
}

// The agent CLI itself, never a .cmd shim (a shim needs a shell, which would
// re-parse the prompt argv). Same search as resolveClaudeBinary.
export function resolveVendorBinary(name, { env = process.env, exists = fs.existsSync, home = os.homedir(), platform = process.platform } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const exe = win ? `${name}.exe` : name;
  const dirs = String(env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const direct = P.join(dir, exe);
    if (exists(direct)) return direct;
  }
  const local = P.join(home, '.local', 'bin', exe);
  return exists(local) ? local : null;
}

// Porcelain v1 with -z: "XY path\0", and a rename or copy adds "oldpath\0".
export function parseStatusZ(out) {
  const parts = String(out ?? '').split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2)) && parts[i + 1]) paths.push(parts[++i]);
  }
  return paths;
}

const tail = (s) => String(s ?? '').slice(-TAIL_MAX);

export async function runVendorCard(recipe, deps) {
  const { run, readPrompt, writeTemp, resolveBinary, now = Date.now, env = {}, exists = () => false, nodePath = process.execPath } = deps;
  const startedAt = now();
  const result = {
    agent: { status: null, sessionId: null, text: '', usage: null, costUsd: null, durationMs: 0, authFailed: false, timedOut: false },
    changed: [], fence: { ok: true, violations: [] }, graph: { ran: false, status: null },
    tests: { ran: false, exitCode: null, tail: '' }, commit: null, prUrl: null, error: null,
  };
  const fail = (error) => { result.error = error; result.agent.durationMs = now() - startedAt; return result; };

  const fenced = fencedAgentEnv(env);
  const git = (args, opts = {}) => run('git', args, { cwd: recipe.cwd, env, stdin: null, timeoutMs: GIT_TIMEOUT_MS, ...opts });

  // finishOnly: the agent already worked in its Antigravity tab; only the
  // verification and the push remain.
  if (recipe.finishOnly) {
    Object.assign(result.agent, { status: 0, text: cap(recipe.agentText ?? '') });
  } else {
    const prompt = await readPrompt(recipe.promptFile);
    if (!prompt?.ok) return fail(`prompt could not be read: ${prompt?.reason ?? 'unknown'}`);
    let model = recipe.model ?? null;
    let listed = [];
    if (recipe.vendor === 'gemini') {
      const pick = await resolveAgyModel(model, { run, resolveBinary, cwd: recipe.cwd, env: fenced });
      if (pick.error) return fail(pick.error);
      model = pick.model;
      listed = pick.listed;
      result.agent.model = model;
    }
    let spec = vendorArgs({ vendor: recipe.vendor, model, cwd: recipe.cwd, prompt: prompt.text });
    const bin = resolveBinary(spec.file);
    if (!bin) return fail(`the ${spec.file} CLI was not found on the operator PATH or in ~/.local/bin`);
    let a = await run(bin, spec.args, { cwd: recipe.cwd, env: fenced, stdin: spec.stdin, timeoutMs: recipe.timeoutMs });
    let parsed = parseAgentOutput(recipe.vendor, a.stdout, a.stderr);
    if (recipe.vendor === 'gemini' && parsed.quotaExhausted) {
      // Only a card that left the model to us falls back; a named model is the operator's choice.
      const next = recipe.model ? null : nextAgyModel(model, listed);
      if (!next) {
        result.agent.durationMs = now() - startedAt;
        return fail(`agy's quota ran out for "${model}"${recipe.model ? '; the card names that model, so it was not swapped' : ' and agy lists no other Gemini to fall back to'}. ${tail(a.stderr).slice(-200)}`);
      }
      // The rerun sees whatever the first run already changed in the worktree.
      result.agent.fallbackFrom = model;
      model = next;
      result.agent.model = model;
      spec = vendorArgs({ vendor: recipe.vendor, model, cwd: recipe.cwd, prompt: prompt.text });
      a = await run(bin, spec.args, { cwd: recipe.cwd, env: fenced, stdin: spec.stdin, timeoutMs: recipe.timeoutMs });
      parsed = parseAgentOutput(recipe.vendor, a.stdout, a.stderr);
    }
    Object.assign(result.agent, { status: a.status, sessionId: parsed.sessionId, text: parsed.text, usage: parsed.usage, costUsd: parsed.costUsd, authFailed: parsed.authFailed, timedOut: !!a.timedOut });
    result.agent.durationMs = now() - startedAt;
    if (parsed.authFailed) return fail(`${spec.file} is not signed in for this Windows account; sign in once in a terminal`);
    if (a.timedOut) return fail(`${spec.file} timed out after ${Math.round(recipe.timeoutMs / 1000)}s`);
    if (a.status !== 0) return fail(`${spec.file} exited ${a.status}: ${tail(a.stderr).slice(-300)}`);
  }

  const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (st.status !== 0) return fail(`git status failed: ${tail(st.stderr).slice(-300)}`);
  result.changed = parseStatusZ(st.stdout);
  const violations = fenceViolations(result.changed);
  if (violations.length) { result.fence = { ok: false, violations }; return fail('the agent changed files outside the fence; nothing was committed'); }
  const step = async (label, r) => { if (r.status !== 0) { result.error = `${label} failed: ${tail(`${r.stderr ?? ''}${r.stdout ?? ''}`).slice(-300)}`; return false; } return true; };

  // A clean tree is nothing new only if every commit on it reached origin: an
  // earlier round that committed and then failed to push (or a tab agent that
  // committed on its own) leaves work no later round would otherwise ship.
  if (!result.changed.length) {
    const ahead = await git(['rev-list', 'HEAD', '--not', '--remotes=origin']);
    const unpushed = ahead.status === 0 ? String(ahead.stdout ?? '').split(/\s+/).filter(Boolean) : [];
    if (!unpushed.length) return result;
    // Exactly the files the unpushed commits change: a range diff would also
    // list files from branch commits already on origin (card glmps-2-0-188) or,
    // after a merge of the base, the base's own files (card glmps-2-0-184). A
    // merge contributes only its conflict resolutions (--cc).
    const log = await git(['log', '--format=', '--name-only', '-z', '--cc', 'HEAD', '--not', '--remotes=origin']);
    if (!await step('git log', log)) return fail(result.error);
    result.changed = [...new Set(String(log.stdout ?? '').split('\0').map((p) => p.trim()).filter(Boolean))].sort();
    result.unpushedCommits = unpushed.length;
    const held = fenceViolations(result.changed);
    if (held.length) { result.fence = { ok: false, violations: held }; return fail('an unpushed commit on the branch touches files outside the fence; nothing was pushed'); }
    // Not rerun here (operator decision, card glmps-2-0-180): the merge queue
    // runs the affected tests before anything lands.
    result.tests = { ran: false, exitCode: null, tail: '', skipped: `the ${unpushed.length} commit(s) were already on the branch but never reached origin (an earlier round did not push them), so the runner pushed them without rerunning the tests; the merge queue runs the tests` };
    return pushAndOpenPr();
  }

  // Same rule as the Claude Code Stop hook (hooks/capability-feed.js): refresh a
  // graph the repo already keeps (at its root or under server/), never start one.
  const graphRoot = ['.', 'server'].find((sub) => exists(path.join(recipe.cwd, sub, 'graphify-out', 'graph.json')));
  if (graphRoot && result.changed.some((p) => CODE_FILE.test(p))) {
    const g = resolveBinary('graphify');
    if (g) {
      const r = await run(g, ['update', graphRoot], { cwd: recipe.cwd, env: fenced, stdin: null, timeoutMs: GRAPHIFY_TIMEOUT_MS });
      result.graph = { ran: true, status: r.status };
    }
  }

  const harness = harnessChanges(result.changed);
  if (harness.length) {
    result.tests = { ran: false, exitCode: null, tail: '', skipped: `the change edits the test harness (${harness.join(', ')}), so the runner did not run it; the merge queue runs the tests` };
  } else if (exists(path.join(recipe.cwd, 'scripts', 'affected-tests.mjs'))) {
    const r = await run(nodePath, ['scripts/affected-tests.mjs', '--base', `origin/${recipe.base}`], { cwd: recipe.cwd, env: fenced, stdin: null, timeoutMs: TESTS_TIMEOUT_MS });
    const exitCode = r.timedOut || !Number.isInteger(r.status) ? -1 : r.status;
    result.tests = { ran: true, exitCode, selection: testSelection(r.stdout), tail: tail(`${r.stdout ?? ''}${r.stderr ?? ''}`) };
    if (exitCode !== 0) return fail('the affected tests failed; nothing was pushed');
  }

  if (!await step('git add', await git(['add', '-A']))) return fail(result.error);
  if (!await step('git commit', await git(['commit', '-m', `${recipe.title} (card ${recipe.cardId}, ${recipe.vendor})`]))) return fail(result.error);
  return pushAndOpenPr();

  async function pushAndOpenPr() {
    const head = await git(['rev-parse', 'HEAD']);
    result.commit = head.status === 0 ? String(head.stdout).trim() : null;
    if (!await step('git push', await git(['push', 'origin', `HEAD:refs/heads/${recipe.branch}`]))) return fail(result.error);

    // A rerun (an operator reply, a merge-queue bounce) pushes to a branch that
    // already has its PR; that PR is the one to file again.
    const open = await run('gh', ['pr', 'list', '--head', recipe.branch, '--state', 'open', '--json', 'url', '--limit', '1'], { cwd: recipe.cwd, env, stdin: null, timeoutMs: GIT_TIMEOUT_MS });
    const existing = open.status === 0 ? tryJsonArray(open.stdout)?.find((p) => typeof p?.url === 'string' && /^https:\/\/\S+\/pull\/\d+$/.test(p.url))?.url : null;
    result.prReused = !!existing;
    if (existing) {
      result.prUrl = existing;
      result.agent.durationMs = now() - startedAt;
      return result;
    }
    const body = `${result.agent.text || 'No summary from the agent.'}\n\nRun by ${recipe.vendor} (${recipe.model ?? 'default model'}) for card ${recipe.cardId}.\n`;
    const bodyFile = await writeTemp(body);
    const pr = await run('gh', ['pr', 'create', '--base', recipe.base, '--head', recipe.branch, '--title', `${recipe.title} (card ${recipe.cardId})`, '--body-file', bodyFile], { cwd: recipe.cwd, env, stdin: null, timeoutMs: GIT_TIMEOUT_MS });
    if (pr.status !== 0) return fail(`gh pr create failed: ${tail(`${pr.stderr ?? ''}${pr.stdout ?? ''}`).slice(-300)}`);
    result.prUrl = /https:\/\/\S+\/pull\/\d+/.exec(String(pr.stdout))?.[0] ?? null;
    result.agent.durationMs = now() - startedAt;
    return result;
  }
}
