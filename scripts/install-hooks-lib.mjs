// scripts/install-hooks-lib.mjs
// the one registration path for GLMPS hooks. Pure: settings objects
// in, settings objects out. Preserves every entry it did not add; adopts a
// hand-registered entry for the same script instead of duplicating it.
//
// Every generated command below is invoked through Git Bash on Windows (the
// operator's shell for hook commands), so a `$` or a backtick in a path
// would be shell-interpolated rather than treated as a literal character;
// hookCommand rejects both instead of silently building an unsafe command.
import path from 'node:path';
import { isTestProcess } from '../server/lib/test-process.js';
import { homeStateDir } from '../server/lib/state-dir.js';

export const HOOK_MANIFEST = Object.freeze([
  { id: 'capability-reminder', event: 'UserPromptSubmit', matcher: '', script: 'capability-reminder.js' },
  { id: 'concurrency-warn', event: 'SessionStart', matcher: '', script: 'concurrency-warn.js' },
  { id: 'morning-brief', event: 'SessionStart', matcher: '', script: 'morning-brief.js' },
  { id: 'capability-synth-tick', event: 'SessionStart', matcher: '', script: 'capability-synth-tick.js' },
  { id: 'memory-working-set', event: 'SessionStart', matcher: '', script: 'memory-working-set.js' },
  { id: 'pocock-sync', event: 'SessionStart', matcher: '', script: 'pocock-sync.js' },
  // A row lives under hooks/ unless it names another repo dir.
  { id: 'sync-project-dirs', event: 'SessionStart', matcher: '', script: 'sync-project-dirs.mjs', dir: 'scripts' },
  // timeout is in SECONDS (Claude Code's unit): 50000 s mirrors the existing
  // live settings entry (written as if it were ms); see the plan-gate note.
  { id: 'workspace-steer', event: 'PreToolUse', matcher: '*', script: 'workspace-steer.js', timeout: 50000 },
  { id: 'push-lease-guard-pre', event: 'PreToolUse', matcher: 'Bash', script: 'push-lease-guard.js' },
  { id: 'no-emdash-write', event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit', script: 'no-emdash.js' },
  // Scan 2026-10-15 F1: Bash too, or the guard's Bash branch never runs.
  { id: 'live-install-guard', event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', script: 'live-install-guard.js' },
  // Operator decision 5 (card glmps-2-0-runtime-127): agents rename to .old, never delete.
  { id: 'deletion-guard', event: 'PreToolUse', matcher: 'Bash|PowerShell', script: 'deletion-guard.js' },
  // every individual git spawn inside plan-gate.js is
  // capped at 2s (GLMPS_HOOK_GIT_TIMEOUT_MS) and every board HTTP call at its
  // own timeout (default 3s), but they are not mutually exclusive within one
  // invocation - the worst realistic case (symbolic-ref, rev-parse, two
  // ls-tree calls and a show, one fetchChain, one reportRefusal, each
  // independently timing out) is close to 16s, a little OVER this row's own
  // 15s. Claude Code reads a hook's `timeout` in SECONDS (Phase K final
  // corrected; this comment used to cite workspace-steer's 50000 as
  // the same convention, but that row's 50000 was written as if it were
  // milliseconds and is really 50000 s, about 14 hours - kept unchanged here
  // because it mirrors the operator's existing live settings entry, which
  // the installer preserves). That is fine, not a bug: for a `command`-type PreToolUse hook
  // (this one), Claude Code's own per-hook timeout is non-blocking - a
  // timed-out hook is discarded and the tool call proceeds through the
  // normal permission flow, it is never held up by it. This row exists only
  // as a second, independent ceiling well under the 600s default, in case
  // some future code path forgets its own inner timeout.
  { id: 'plan-gate', event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit', script: 'plan-gate.js', timeout: 15 },
  // Same bounded git/board calls as plan-gate, same independent 15 s ceiling.
  { id: 'test-file-guard', event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit', script: 'test-file-guard.js', timeout: 15 },
  { id: 'push-lease-guard-post', event: 'PostToolUse', matcher: 'Bash', script: 'push-lease-guard.js' },
  { id: 'qa-trends-local', event: 'PostToolUse', matcher: 'Bash', script: 'qa-trends-local.js' },
  // The tools are the set the hook's own core reads (park-wake-context.js TOOLS).
  { id: 'park-wake-context', event: 'PostToolUse', matcher: 'Bash|BashOutput|TaskOutput', script: 'park-wake-context.js' },
  { id: 'denial-feed', event: 'PermissionDenied', matcher: '', script: 'denial-feed.js' },
  { id: 'done-gate', event: 'Stop', matcher: '', script: 'done-gate.js' },
  { id: 'capability-feed', event: 'Stop', matcher: '', script: 'capability-feed.js' },
  { id: 'decision-log', event: 'Stop', matcher: '', script: 'decision-log.js' },
  { id: 'ci-status-surface', event: 'Stop', matcher: '', script: 'ci-status-surface.js' },
  { id: 'no-emdash-stop', event: 'Stop', matcher: '', script: 'no-emdash.js' },
  { id: 'pre-compact-archive', event: 'PreCompact', matcher: '', script: 'pre-compact-archive.js' },
]);

const sep = (p) => (p.includes('\\') ? '\\' : '/');

export function hookCommand(nodePath, repoRoot, script, dir = 'hooks') {
  // A double quote would close the quoting this builds the command with.
  if (/[$`"]/.test(nodePath) || /[$`"]/.test(repoRoot)) {
    const err = new Error(`refusing to build a hook command from a path containing $, a backtick or a double quote: ${JSON.stringify({ nodePath, repoRoot })}`);
    err.name = 'UnsafeHookPathError';
    throw err;
  }
  return `"${nodePath}" "${repoRoot}${sep(repoRoot)}${dir}${sep(repoRoot)}${script}"`;
}

// end-anchored so `hooks/done-gate.js.bak` (a stray backup file) never
// counts as an existing registration of `done-gate.js`. Every command this
// module (and its tests) ever builds quotes the path, so the script name is
// followed by either a closing `"` or nothing else; `(?="|$)` accepts both.
// M-c: broadened past a bare closing quote so an
// unquoted hand-registered command with trailing arguments (e.g. `node
// hooks/workspace-steer.js --verbose`) is still adopted - only a longer
// filename sharing the same prefix (M8's done-gate.js.bak) is excluded,
// since the character right after it is neither a quote, an apostrophe,
// whitespace, nor end of string.
const refersTo = (command, script, dir = 'hooks') => new RegExp(`${dir}[\\\\/]${script.replace('.', '\\.')}(?=["'\\s]|$)`).test(String(command));

// cap depth the same way settingsEqual does
// (below). Empirically, JSON.stringify/JSON.parse alone do not crash on a
// pathologically deep plain object the way the hand-written recursion in
// settingsEqual/isEffectivelyEmpty did (verified to 200,000 levels without
// a stack overflow - V8's native JSON path is far more stack-efficient than
// a hand-rolled recursive function). This still refuses rather than
// silently cloning something that deep: a truncated or merely-very-slow
// clone of pathological input is not something planHookInstall/
// planHookUninstall should ever hand back for install.mjs to write to
// settings.json - a refusal here is deliberate defense in depth, not a
// crash fix.
const CLONE_MAX_DEPTH = 1000;
function depthOf(o, depth = 0, seen = new Set()) {
  if (depth > CLONE_MAX_DEPTH) return depth;
  if (!o || typeof o !== 'object' || seen.has(o)) return depth;
  seen.add(o);
  let max = depth;
  for (const k of Object.keys(o)) {
    const d = depthOf(o[k], depth + 1, seen);
    if (d > max) max = d;
    if (max > CLONE_MAX_DEPTH) break;
  }
  return max;
}
function clone(o) {
  if (depthOf(o) > CLONE_MAX_DEPTH) {
    const err = new Error(`settings object exceeds the maximum depth of ${CLONE_MAX_DEPTH}; refusing to clone it`);
    err.name = 'SettingsTooDeepError';
    throw err;
  }
  return JSON.parse(JSON.stringify(o ?? {}));
}

const isWildcard = (m) => m == null || m === '' || m === '*';
// The '|'-joined tools of `wanted` that no matcher in `have` names; '' when all are covered.
function missingTools(wanted, have) {
  if (isWildcard(wanted) || have.some(isWildcard)) return '';
  const covered = new Set(have.flatMap((m) => String(m).split('|')));
  return String(wanted).split('|').filter((t) => !covered.has(t)).join('|');
}

export function planHookInstall(settings, { repoRoot, nodePath, manifest = HOOK_MANIFEST }) {
  const patched = clone(settings); patched.hooks = patched.hooks || {};
  const added = []; const adopted = []; const entries = [];
  for (const row of manifest) {
    const groups = (patched.hooks[row.event] = patched.hooks[row.event] || []);
    const existing = groups.filter((g) => (g.hooks || []).some((h) => refersTo(h.command, row.script, row.dir)));
    // Adopt an entry that already runs this script. Scan 2026-10-15 F1: for a
    // row naming specific tools, adoption covers only the tools the existing
    // matchers name, and a group for the rest is added (an older install
    // registered live-install-guard without Bash). A '' or '*' row is adopted
    // by any entry, whatever its matcher.
    const missing = missingTools(row.matcher, existing.map((g) => g.matcher));
    if (existing.length && !missing) {
      adopted.push(row.id);
      // The command that actually runs, so an adopted copy outside this repo
      // (a loose file in ~/.claude/hooks) shows by its own path.
      const { command } = existing[0].hooks.find((h) => refersTo(h.command, row.script, row.dir));
      entries.push({ id: row.id, event: row.event, matcher: row.matcher, status: 'adopted', command });
      continue;
    }
    const matcher = existing.length ? missing : row.matcher;
    const command = hookCommand(nodePath, repoRoot, row.script, row.dir);
    const hook = { type: 'command', command, ...(row.timeout ? { timeout: row.timeout } : {}) };
    groups.push({ matcher, hooks: [hook] });
    added.push({ id: row.id, event: row.event, matcher, command });
    entries.push({ id: row.id, event: row.event, matcher: row.matcher, status: 'added', command });
  }
  const unchanged = added.length === 0;
  return { patched: unchanged ? settings : patched, added, adopted, entries };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Both slash spellings of `root`, case-insensitive, only at a path boundary,
// so <runtime-checkout> never matches <runtime-checkout>2.
function rootRe(root) {
  const back = String(root).replace(/\//g, '\\').replace(/\\+$/, '');
  const alts = [...new Set([back, back.replace(/\\/g, '/')])].map(escRe).join('|');
  return new RegExp(`(${alts})(?=[\\\\/])`, 'gi');
}
const moveRoot = (command, fromRoot, toRoot) => String(command).replace(rootRe(fromRoot), (hit) => (hit.includes('/') ? toRoot.replace(/\\/g, '/') : toRoot.replace(/\//g, '\\')));
const STATUSLINE_CHAIN = { script: 'statusline-chain.js', dir: 'taps' };

/**
 * Moves every GLMPS hook (a HOOK_MANIFEST script) and the statusline tap that
 * runs from `fromRoot` to the same script under `toRoot`, after a checkout
 * move (the 2026-11-05 cutover left 20 hooks and the tap on the old runtime
 * checkout). Entries for other scripts, or GLMPS scripts already elsewhere,
 * are untouched. `record` (the install record) gets the same rewrite so
 * --uninstall still finds what it added.
 */
export function planHookRepoint(settings, { fromRoot, toRoot, record = null, manifest = HOOK_MANIFEST }) {
  const patched = clone(settings);
  const changes = [];
  const ours = (command) => manifest.some((row) => refersTo(command, row.script, row.dir));
  for (const [event, groups] of Object.entries(patched.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (typeof h?.command !== 'string' || !ours(h.command)) continue;
        const next = moveRoot(h.command, fromRoot, toRoot);
        if (next !== h.command) { changes.push({ where: `hooks.${event}`, from: h.command, to: next }); h.command = next; }
      }
    }
  }
  const sl = patched.statusLine;
  if (typeof sl?.command === 'string' && refersTo(sl.command, STATUSLINE_CHAIN.script, STATUSLINE_CHAIN.dir)) {
    const next = moveRoot(sl.command, fromRoot, toRoot);
    if (next !== sl.command) { changes.push({ where: 'statusLine', from: sl.command, to: next }); sl.command = next; }
  }
  let nextRecord = record;
  if (record && Array.isArray(record.added)) {
    nextRecord = { ...record, added: record.added.map((a) => (typeof a?.command === 'string' ? { ...a, command: moveRoot(a.command, fromRoot, toRoot) } : a)) };
  }
  return { patched: changes.length ? patched : settings, changes, record: nextRecord };
}

// M2/M3: reports which recorded entries it could not find (already removed
// by hand, or edited beyond recognition) instead of silently treating them
// as done - the caller decides whether to keep tracking them.
export function planHookUninstall(settings, added) {
  const patched = clone(settings); let removed = 0; const notFound = [];
  for (const a of added) {
    const groups = patched.hooks?.[a.event];
    if (!groups) { notFound.push(a.id); continue; }
    const i = groups.findIndex((g) => (g.matcher ?? '') === a.matcher && g.hooks?.length === 1 && g.hooks[0].command === a.command);
    if (i >= 0) { groups.splice(i, 1); removed++; } else { notFound.push(a.id); }
    if (!groups.length) delete patched.hooks[a.event];
  }
  if (patched.hooks && !Object.keys(patched.hooks).length) delete patched.hooks;
  return { patched, removed, notFound };
}

// a byte-restore decision must not depend on JSON key order (an object
// spread can reorder keys relative to the file on disk) or on whether an
// empty container was ever created at all - `patched.hooks = patched.hooks
// || {}` and per-event array cleanup mean the same real settings can end up
// as either an absent key or a present-but-empty one, and that difference
// must never masquerade as an unrelated settings change. Two nested empty
// containers ({} vs {}, [] vs []) compare equal to each other and to an
// absent key at the same position; every other value compares structurally,
// with object keys compared as sets (not by their order) and array elements
// compared by index (order still matters within an array of hook groups).
// Recursive: an object all of whose values are themselves effectively empty
// (transitively) is effectively empty too - `{ hooks: { Stop: [] } }` must
// read the same as `{}`, not stop one level short of it. A non-empty ARRAY
// is never effectively empty regardless of what its elements contain (a
// hook group's own emptiness does not erase the group's existence).
// M-d: a depth cap on both mutually-recursive
// helpers. Past the cap, the answer is `false` ("not equal") - the same,
// safe fallback as any other real difference: install.mjs's caller falls
// back to a non-destructive JSON.stringify write rather than trusting a
// byte-for-byte restore it could not actually verify. Without this, a
// pathological (or accidentally very deep) settings object crashes with a
// real, uncaught "Maximum call stack size exceeded" - confirmed by this
// round's own RED run at depth 20000, not a theoretical concern.
const MAX_SETTINGS_DEPTH = 1000;

function isEffectivelyEmpty(v, depth = 0) {
  if (depth > MAX_SETTINGS_DEPTH) return false;
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).every((k) => isEffectivelyEmpty(v[k], depth + 1));
  return false;
}

export function settingsEqual(a, b, depth = 0) {
  if (depth > MAX_SETTINGS_DEPTH) return false;
  if (a === b) return true;
  const aIsObj = a && typeof a === 'object' && !Array.isArray(a);
  const bIsObj = b && typeof b === 'object' && !Array.isArray(b);
  if (aIsObj && bIsObj) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = a[k]; const bv = b[k];
      const aGone = isEffectivelyEmpty(av, depth + 1);
      const bGone = isEffectivelyEmpty(bv, depth + 1);
      if (aGone && bGone) continue;
      if (aGone !== bGone) return false;
      if (!settingsEqual(av, bv, depth + 1)) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => settingsEqual(v, b[i], depth + 1));
  }
  return false;
}

// I2/I6: the one place that turns (env, homedir) into every path the
// installer touches. Pure - homedir is a parameter, never os.homedir()
// called internally - so it is fully testable against a fake home without
// ever touching or stat-ing the real one. Refuses a partial GLMPS_CLAUDE_DIR /
// GLMPS_STATE_DIR override (exactly one set): a mixed real/temp home is
// exactly the shape of misconfiguration that sent a prior run at the real
// settings file, so it is refused before any path is even built, not just
// before any write.
//
// round 1 treated an empty string the same as
// unset, which meant `GLMPS_CLAUDE_DIR=""` (however that came about - a
// scripting bug, a blank field in a launcher) silently fell through to the
// REAL home. That is the same incident's failure mode wearing a different
// shape, so an empty string in EITHER variable is now refused outright,
// never coerced to "unset".
//
// Phase K final review, SHARED HELPER ruling: a backstop for the same
// incident. In a test process (the shared isTestProcess predicate), the home
// fallback itself is refused: a test must name both temp dirs explicitly, so
// no test, however it was launched, can resolve the real home's
// settings.json. processEnv/argv are injectable for tests only.
export function resolveInstallPaths({ env, homedir, processEnv = process.env, argv = process.argv }) {
  if (env.GLMPS_CLAUDE_DIR === '' || env.GLMPS_STATE_DIR === '') {
    const err = new Error('GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR must not be an empty string (an empty override must never fall through to the real home)');
    err.name = 'EmptyHomeOverrideError';
    throw err;
  }
  const claudeSet = typeof env.GLMPS_CLAUDE_DIR === 'string';
  const stateSet = typeof env.GLMPS_STATE_DIR === 'string';
  if (claudeSet !== stateSet) {
    const err = new Error('GLMPS_CLAUDE_DIR and GLMPS_STATE_DIR must be set together, or not at all (partial override refused)');
    err.name = 'PartialHomeOverrideError';
    throw err;
  }
  if (!claudeSet && isTestProcess({ env, processEnv, argv })) {
    const err = new Error('refusing the home fallback in a test process: set GLMPS_CLAUDE_DIR and GLMPS_STATE_DIR to temp dirs');
    err.name = 'TestProcessHomeFallbackError';
    throw err;
  }
  // M-f: resolve a relative override against the current working directory,
  // so two different relative spellings of the same real directory (or the
  // same relative string run from two different cwds) never silently
  // compare unequal later (install.mjs's settingsFile-mismatch refusal, I2).
  const claudeDir = claudeSet ? path.resolve(env.GLMPS_CLAUDE_DIR) : path.join(homedir, '.claude');
  const baseStateDir = stateSet ? path.resolve(env.GLMPS_STATE_DIR) : homeStateDir(homedir);
  const settingsFile = path.join(claudeDir, 'settings.json');
  const stateDir = path.join(baseStateDir, 'state');
  return {
    settingsFile,
    mcBackupFile: `${settingsFile}.mc-backup`,
    hooksBackupFile: `${settingsFile}.glmps-hooks-backup`,
    stateDir,
    delegateFile: path.join(stateDir, 'statusline-delegate.json'),
    hooksRecordFile: path.join(baseStateDir, 'hooks-installed.json'),
    tapOtelRecordFile: path.join(baseStateDir, 'tap-otel-installed.json'),
  };
}
