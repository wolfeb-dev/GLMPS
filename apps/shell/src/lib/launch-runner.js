// apps/shell/src/lib/launch-runner.js
// Opens the terminals the kernel queued (it runs as a service in session 0 and
// cannot). Claims each launch once, spawns it in the operator's session, and
// reports the pid or the error back. Runs only while the kernel is reachable.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { terminalRecipe } from './terminal-recipe.js';
import { createLaunchClient } from './launch-client.js';

const ORIGINS = new Set(['runner', 'resume', 'terminal', 'learning']);

// a generic one-line/absolute-cwd check let the shell
// run ANY command from ANY record. Each origin has its own recognizable
// shape - the exact way the kernel itself builds it (editor-targets.js's
// resumeCommand/seededCommand/resumedCommand, learning-apply.js's
// buildMemoryApplyCommand) - and the shell now checks the record actually
// matches it.
// UUID's own character class covers both cases
// directly, rather than an overall case-insensitive flag on the whole
// regex (which would also have made the leading command token match
// case-insensitively - see the dropped `i` flag below).
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// channel-launch.js's SAFE_TOKEN (what appendArgs leaves unquoted), as a fragment.
const SAFE_TOKEN = '[A-Za-z0-9_:=./-]+';
// editor-targets.js's taskInstruction(), verbatim.
const TASK_INSTRUCTION_PREFIX = 'Read the task described in this file and complete it, then update its backlog card status: ';
// channel-launch.js's channelLaunchPlan args for channel-core.js's SERVER_NAME,
// verbatim (a local copy: the shell must not import server code).
const SCUT_CHANNEL_ARGS = ' --channels server:scut-slack --dangerously-load-development-channels server:scut-slack';
// Backstop (defense in depth, on top of the shape check below, never
// instead of it): refused anywhere in the command, even inside an
// otherwise-matching shape's quoted trailing content.
const METACHARS = /[&|<>^%]/;
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// the round 1 shapes used `.+"$` to match the quoted
// trailing content, which only pins the FIRST character after the quote
// and the LAST character of the whole string - `.` matches a literal `"`
// too, so a command could close the quote early and append arbitrary
// flags before a second, later quote closed the match instead:
//   claude "<task>" --dangerously-skip-permissions --append-system-prompt "run calc"
// still satisfies `^claude "...` + `..."$`. `[^"]+` closes that: the
// captured content can never contain a `"` at all, so there is no
// position left to close the quote early from inside it.
//
// resume/runner/terminal all depend on the allowlist the shell learns from
// the kernel's own /api/config (cfg.terminals) - with nothing learned yet,
// returning null here means "fail closed", never "accept anything".
// learning's shape is fixed (buildMemoryApplyCommand always starts
// `claude -p "`, independent of the operator's configured terminal
// commands), so it alone needs no allowlist at all.
function shapeFor(origin, allowedCommands) {
  if (origin === 'learning') return /^claude -p "[^"]+"$/;
  if (!allowedCommands.length) return null;
  const cmds = allowedCommands.map(escapeRe).join('|');
  if (origin === 'terminal') return new RegExp(`^(?:${cmds})$`);
  if (origin === 'resume') return new RegExp(`^(?:${cmds}) --resume ${UUID}$`);
  // The prompt-path capture group (index 1) is checked separately below -
  // a quote-safe shape alone is not enough; R2-1 also requires the path
  // itself to resolve inside the shell's own state dir.
  // glmps-2-0-61: the kernel then appends --settings <role file> and, for a
  // reviewer, --model <name>, in that order, through channel-launch.js's
  // appendArgs: quoted unless the value is a SAFE_TOKEN (a Windows path never
  // is, a POSIX one can be). Groups 2/3 are the quoted/bare settings path,
  // checked like the prompt path.
  // glmps-2-0-62: with scut.channel on, channel-launch.js's channelLaunchPlan
  // appends its fixed pair last. Accepted only verbatim: the dev-channels flag
  // unlocks nothing but this one server (which the kernel registered in the
  // job worktree's .mcp.json), and Claude Code still makes the operator click
  // through its development-channels warning on every launch.
  if (origin === 'runner') return new RegExp(`^(?:${cmds})(?: --session-id ${UUID}| --resume ${UUID})? "${escapeRe(TASK_INSTRUCTION_PREFIX)}([^"]+)"(?: --settings (?:"([^"]+)"|(${SAFE_TOKEN})))?(?: --model ${SAFE_TOKEN})?(?:${escapeRe(SCUT_CHANNEL_ARGS)})?$`);
  return null;
}

// "the runner prompt path is unchecked" - a quote-safe
// shape alone does not stop a path like
// C:/Users/evil/../../tmp/payload.md (still a valid, absolute, quote-free
// string) from naming a file nowhere near the runner's own prompt
// directory. The path must already be in its resolved, dot-free form
// (path.resolve(p) === p - a literal '..' or '.' component fails this),
// must live inside the shell's own resolved state dir, and - since a
// symlink INSIDE the state dir could still point somewhere else entirely -
// its REAL path (fs.realpathSync.native, resolving any symlink) must land
// inside the state dir too.
function pathInside(base, p) {
  const rel = path.relative(base, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
// "inside the state dir, no symlink escape" alone never
// asked "is this the SPECIFIC shape writePrompt() (runner-store.js)
// actually produces" - a real, symlink-free file that simply lives
// SOMEWHERE ELSE inside the state dir (the launch-token file itself, a
// stray directory) previously passed outright. The path must now be a
// DIRECT child of <stateDir>/runner, named `*.prompt.md`, and a regular
// file - not a directory, however it is named.
export function validRunnerPath(p, stateDir, { realpathNative = fs.realpathSync.native, statSync = fs.statSync } = {}) {
  if (!stateDir) return { ok: false, reason: 'state dir not resolved yet' };
  if (!path.isAbsolute(p) || path.resolve(p) !== p) return { ok: false, reason: 'runner prompt path is not a clean absolute path' };
  const runnerDir = path.join(stateDir, 'runner');
  const rel = path.relative(runnerDir, p);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return { ok: false, reason: 'runner prompt path is not a direct child of <stateDir>/runner' };
  }
  if (!rel.endsWith('.prompt.md')) return { ok: false, reason: 'runner prompt path does not end in .prompt.md' };
  let real;
  try { real = realpathNative(p); } catch (e) { return { ok: false, reason: `runner prompt path could not be resolved: ${e.message}` }; }
  // Compare real path against real path: a state dir reached through an 8.3
  // short name, a junction or a symlink would otherwise refuse every runner
  // launch. A link inside runner/ pointing out is still caught.
  let realRunnerDir;
  try { realRunnerDir = realpathNative(runnerDir); } catch (e) { return { ok: false, reason: `<stateDir>/runner could not be resolved: ${e.message}` }; }
  if (!pathInside(realRunnerDir, real)) return { ok: false, reason: 'runner prompt path resolves (via a symlink) outside <stateDir>/runner' };
  let st;
  try { st = statSync(real); } catch (e) { return { ok: false, reason: `runner prompt path could not be read: ${e.message}` }; }
  if (!st.isFile()) return { ok: false, reason: 'runner prompt path is not a regular file' };
  return { ok: true };
}

// glmps-2-0-61: the same checks for the --settings file writeRoleSettings()
// (role-permissions.js) produces: <stateDir>/role-settings/<name>.json. A
// settings file can grant permissions, so one from anywhere else is refused.
function validRoleSettingsPath(p, stateDir, { realpathNative = fs.realpathSync.native, statSync = fs.statSync } = {}) {
  if (!stateDir) return { ok: false, reason: 'state dir not resolved yet' };
  if (!path.isAbsolute(p) || path.resolve(p) !== p) return { ok: false, reason: 'role settings path is not a clean absolute path' };
  const dir = path.join(stateDir, 'role-settings');
  const rel = path.relative(dir, p);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return { ok: false, reason: 'role settings path is not a direct child of <stateDir>/role-settings' };
  }
  if (!rel.endsWith('.json')) return { ok: false, reason: 'role settings path does not end in .json' };
  let real; let realDir;
  try { real = realpathNative(p); } catch (e) { return { ok: false, reason: `role settings path could not be resolved: ${e.message}` }; }
  try { realDir = realpathNative(dir); } catch (e) { return { ok: false, reason: `<stateDir>/role-settings could not be resolved: ${e.message}` }; }
  if (!pathInside(realDir, real)) return { ok: false, reason: 'role settings path resolves (via a symlink) outside <stateDir>/role-settings' };
  let st;
  try { st = statSync(real); } catch (e) { return { ok: false, reason: `role settings path could not be read: ${e.message}` }; }
  if (!st.isFile()) return { ok: false, reason: 'role settings path is not a regular file' };
  return { ok: true };
}

export function validateLaunch(r, { exists = fs.existsSync, allowedCommands = [], stateDir = null, realpathNative } = {}) {
  if (!r || !ORIGINS.has(r.origin)) return { ok: false, reason: `unknown origin ${r?.origin}` };
  if (typeof r.command !== 'string' || !r.command || /[\r\n]/.test(r.command) || r.command.length > 4000) return { ok: false, reason: 'command must be one line under 4000 chars' };
  if (!path.isAbsolute(String(r.cwd || '')) || !exists(r.cwd)) return { ok: false, reason: `cwd missing or not absolute: ${r.cwd}` };
  if (METACHARS.test(r.command)) return { ok: false, reason: 'command contains a shell metacharacter' };
  const shape = shapeFor(r.origin, allowedCommands);
  if (!shape) return { ok: false, reason: 'terminal command allowlist not yet loaded' };
  const m = shape.exec(r.command);
  if (!m) return { ok: false, reason: `command does not match the ${r.origin} recipe shape` };
  if (r.origin === 'runner') {
    const check = validRunnerPath(m[1], stateDir, { realpathNative });
    if (!check.ok) return check;
    const settings = m[2] ?? m[3];
    if (settings !== undefined) {
      const s = validRoleSettingsPath(settings, stateDir, { realpathNative });
      if (!s.ok) return s;
    }
  }
  return { ok: true };
}

// the shell's half of the same backstop the kernel's own
// launchNative now carries - a local copy, not an import of server code
// (the shell package must not import server code at runtime). True under
// node --test's own per-process marker or the shared GLMPS_TEST=1 convention
// test.env sets; the same two signals the kernel's own shared predicate
// checks, without pulling that module in.
// m-b: the third signal server/lib/test-process.js also checks - a direct
// `node x.test.js` run outside node --test's own child-process wrapping
// (which is when NODE_TEST_CONTEXT is unset) still carries this in argv.
function isTestProcess() {
  return !!(process.env.NODE_TEST_CONTEXT || process.env.GLMPS_TEST === '1' || /\.test\.m?js$/.test(process.argv?.[1] ?? ''));
}
// The default spawnImpl refuses outright in a test process: a test that
// forgets to inject its own spawnImpl must fail loudly (an error reported
// back through the ordinary POST /result path) rather than silently open a
// real terminal. Every test in this suite injects a fake spawnImpl anyway;
// this is the backstop for the one that someday does not.
function refusingSpawn() {
  throw new Error('refused: test process, no injected spawnImpl');
}

// the shell
// trusts whatever answers on the loopback kernel URL - another local
// account binding the same port while the real service is down could
// otherwise serve launch records (and the allowlist from its own
// /api/config) just as convincingly as the real kernel. This per-install
// token (server/lib/governance/launch-token.js creates it at
// <stateDir>/launch-token) is what proves it is actually talking to ITS
// kernel. Read fresh on every tick (cheap, a small file read) rather than
// cached once: the shell may start before the kernel has created it, and
// this is how it self-heals once the file appears.
// used to collapse EVERY read failure (missing file, a
// permissions error, anything else) into a bare null, so the tick's own
// log line always said the same generic "no launch token found" line
// regardless of why - a persistent EACCES would be indistinguishable from
// the ordinary "the kernel has not booted yet" case. Names the reason
// instead, exported so it can be unit-tested directly.
export function defaultReadLaunchToken(stateDir) {
  if (!stateDir) return { token: null, reason: 'state dir not resolved yet' };
  const file = path.join(stateDir, 'launch-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return t ? { token: t, reason: null } : { token: null, reason: `launch token file is empty: ${file}` };
  } catch (e) {
    if (e?.code === 'ENOENT') return { token: null, reason: `no launch token file at the resolved state dir yet: ${file}` };
    return { token: null, reason: `launch token could not be read (${e?.code || e?.message || e}): ${file}` };
  }
}

// Task 15, SF-1 (silent-failure hunt, Critical): the runner used to read
// child.pid synchronously and report it as a success before the child could
// say anything; an async 'error' (ENOENT, EACCES, a policy block) or a
// launcher that exited non-zero was then only ever a line in shell.log while
// the kernel's ledger said done and the operator was told a terminal opened.
//
// the launch succeeds when the child emits 'spawn' and does not exit
// non-zero within the settle window (the win32 recipe's outer `cmd /c start`
// opens the window and exits 0 at once, so the normal case settles in
// milliseconds). It fails on 'error' before that, on a non-zero exit inside
// the window, or when the child reports neither spawn nor error at all. The
// caller posts the result only once this settles, so a failure can never
// arrive after a success was already reported: anything the child emits
// later (an interactive terminal the operator closes, say) is by definition
// not a launch failure and is only logged.
export function awaitSpawnOutcome(child, { settleMs = 3000, onLate = () => {} } = {}) {
  return new Promise((resolve) => {
    if (!child || typeof child.on !== 'function') { resolve({ error: 'the spawn returned no observable child process' }); return; }
    let spawned = false; let settled = false;
    const finish = (outcome) => { if (settled) return; settled = true; clearTimeout(timer); resolve(outcome); };
    const timer = setTimeout(() => finish(spawned ? { ok: true } : { error: `the terminal did not report starting within ${settleMs} ms` }), settleMs);
    child.on('spawn', () => { spawned = true; });
    child.on('error', (e) => {
      const msg = e?.message || String(e);
      if (settled) { onLate(`error after the launch settled: ${msg}`); return; }
      finish({ error: `the terminal could not start: ${msg}` });
    });
    child.on('exit', (code, signal) => {
      const how = code !== null && code !== undefined ? `code ${code}` : `signal ${signal}`;
      if (settled) { onLate(`exited with ${how} after the launch settled`); return; }
      finish(code === 0 ? { ok: true } : { error: `the terminal launcher exited with ${how}` });
    });
    child.unref?.();
  });
}

export function createLaunchRunner({ kernelUrl, fetchImpl = fetch, spawnImpl, exists = fs.existsSync, stateDir = null, readLaunchToken = defaultReadLaunchToken, log, notify, intervalMs = 2000, now = Date.now, logWindowMs = 10 * 60_000, spawnSettleMs = 3000 }) {
  // M-3: the same reason is logged once, not on every single tick - a
  // shell left running against an unreadable token file would otherwise
  // write the identical line to the log forever.
  // that covered only the token reason, and its set never
  // cleared. Every tick-level failure (no token, a non-ok poll, a poll that
  // did not verify, a connection error) now goes through one limiter: at
  // most once per reason per logWindowMs, and the whole limiter is cleared
  // by a verified poll, so a failure that comes back after a recovery is
  // reported at once.
  const lastLogged = new Map(); // reason -> time last logged
  function logLimited(reason, message) {
    const t = now();
    const last = lastLogged.get(reason);
    if (last !== undefined && t - last < logWindowMs) return;
    lastLogged.set(reason, t);
    log(message);
  }
  const realSpawnImpl = spawnImpl ?? (isTestProcess() ? refusingSpawn : spawn);
  let timer = null; let busy = false;
  // the terminal-command allowlist resume/runner/
  // terminal all validate against. Sticky across ticks: a transient poll
  // hiccup must not retroactively refuse every launch this runner already
  // knew the allowed commands for; only ever overwritten by a
  // SUCCESSFUL, VERIFIED poll that actually names at least one command.
  //
  // this used to come from a separate, unauthenticated
  // /api/config fetch - an impostor on the loopback port could serve a
  // forged allowlist there even if /api/launches itself were somehow
  // guarded. It is now folded into the SAME authenticated poll response
  // below, so there is no unauthenticated source for it left at all.
  let allowedCommands = [];

  // The authenticated protocol (nonce, HMAC proof out, verified proof back) is
  // shared with the agy runner; see launch-client.js and launch-auth.js.
  const { authedRequest, verifiedJson } = createLaunchClient({ kernelUrl, fetchImpl });

  async function tick() {
    if (busy) return; busy = true;
    try {
      // refused outright when there is no token to even send - no
      // point letting the kernel's own 401 be the only defense (and no
      // point polling a kernel that is not even guaranteed to be ours).
      //
      // M-3: the reason is named (not a generic "no launch token found"
      // for every kind of failure) and logged once per distinct reason,
      // not on every tick.
      const { token, reason } = readLaunchToken(stateDir);
      if (!token) {
        logLimited(`token:${reason}`, `launches: ${reason} - refusing to run any queued launch`);
        return;
      }
      const { res: pollRes, target: pollTarget } = await authedRequest(token, '/api/launches?state=pending');
      if (!pollRes.ok) { logLimited(`status:${pollRes.status}`, `launches: kernel answered ${pollRes.status}`); return; }
      const verifiedPoll = await verifiedJson(token, pollRes, pollTarget);
      if (!verifiedPoll.ok) { logLimited('unverified', `launches: ${verifiedPoll.reason}`); return; }
      lastLogged.clear();
      const pending = Array.isArray(verifiedPoll.body?.pending) ? verifiedPoll.body.pending : [];
      const nextAllowed = Array.isArray(verifiedPoll.body?.allowedCommands) ? verifiedPoll.body.allowedCommands.filter((c) => typeof c === 'string' && c) : [];
      if (nextAllowed.length) allowedCommands = nextAllowed;
      // Fix round 1, I3 (controller ruling: the brief's own test's claim-
      // all-first order was the brief's error, not the sample code - claim
      // THEN process, per record). Each record is wrapped in its own
      // try/catch: one record's claim or result POST throwing (a network
      // hiccup) must not abandon every record after it in the same batch -
      // a claimed-but-never-reported record would otherwise sit there
      // until the kernel's own launch-queue loop times it out.
      for (const r of pending) {
        // agy, gitops and editor calls are their own runners': claiming one here would fail it as an unknown origin
        if (r.origin === 'agy' || r.origin === 'gitops' || r.origin === 'editor') continue;
        try {
          const { res: claimRes, target: claimTarget } = await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/claim`, { method: 'POST', body: { by: 'desktop-shell' } });
          if (!claimRes.ok) continue;
          const verifiedClaim = await verifiedJson(token, claimRes, claimTarget);
          if (!verifiedClaim.ok) { log(`launch ${r.id} refused: ${verifiedClaim.reason}`); continue; }
          const v = validateLaunch(r, { exists, allowedCommands, stateDir });
          if (!v.ok) { log(`launch ${r.id} refused: ${v.reason}`); await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/result`, { method: 'POST', body: { error: `refused by shell: ${v.reason}` } }); continue; }
          let pid = null; let error = null;
          try {
            const rec = terminalRecipe({ command: r.command, cwd: r.cwd });
            const child = realSpawnImpl(rec.file, rec.args, rec.options);
            // Task 15, SF-1: the outcome is awaited BEFORE anything is
            // reported - a synchronous throw, an async 'error' and an early
            // non-zero exit are all failures, the same three cases the
            // kernel's own guarded-spawn.js handles.
            const outcome = await awaitSpawnOutcome(child, { settleMs: spawnSettleMs, onLate: (m) => log(`launch ${r.id} ${m}`) });
            if (outcome.error) error = outcome.error; else pid = child.pid ?? null;
          } catch (e) { error = e.message; }
          await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/result`, { method: 'POST', body: error ? { error } : { pid } });
          notify?.(error ? `Could not open a terminal: ${error}` : `Opened a terminal (${r.origin}) in ${r.cwd}`);
        } catch (e) {
          log(`launch ${r.id} failed: ${e.message}`);
        }
      }
    } catch (e) { logLimited(`error:${e.message}`, `launches: ${e.message}`); } finally { busy = false; }
  }
  return { tick, start() { if (!timer) timer = setInterval(() => { void tick(); }, intervalMs); }, stop() { clearInterval(timer); timer = null; } };
}
