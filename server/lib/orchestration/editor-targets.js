// server/lib/orchestration/editor-targets.js
import os from 'node:os';
import path from 'node:path';
import { isSessionUuid } from '../scut/reopen.js';
import { legacyStateDirFor } from '../state-dir.js';

export const TARGET_IDS = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'antigravity', 'native-terminal'];
export const TARGET_LABELS = {
  'vscode': 'VS Code', 'vscode-insiders': 'VS Code Insiders', 'cursor': 'Cursor',
  'windsurf': 'Windsurf', 'antigravity': 'Antigravity', 'native-terminal': 'Native terminal',
};

export function resolveTarget({ item = {}, lastTarget = null, running = [] } = {}) {
  if (item.target && TARGET_IDS.includes(item.target)) return item.target;
  if (lastTarget && TARGET_IDS.includes(lastTarget)) return lastTarget;
  for (const id of TARGET_IDS) if (id !== 'native-terminal' && running.includes(id)) return id;
  return 'native-terminal';
}

// The prompt's content never goes on a command line (which would be re-parsed by
// cmd.exe / PowerShell / .cmd shims and break on quotes, %VAR%, &, or newlines, or
// even inject commands). Instead the seeded command carries only a short, controlled
// ASCII instruction naming the prompt-file PATH; the agent reads the file with its
// own tools. Filesystem paths cannot contain a double-quote, so single-level quoting
// is always safe across cmd, PowerShell, and POSIX sh.
export function taskInstruction(promptFile) {
  return `Read the task described in this file and complete it, then update its backlog card status: ${promptFile}`;
}
// `sessionId`, when given, mints the claude-code session's own id synchronously
// at launch instead of leaving it to be inferred later:
// `claude --session-id <uuid>` is documented in the local CLI reference
// (docs/reference/2026-09-23/claude-code/cli-reference.md) as accepting "a
// valid UUID". A UUID is safe unquoted on every shell this seam targets
// (cmd.exe, PowerShell, POSIX sh): it is pure hex digits and dashes, nothing a
// shell treats specially. Omitted entirely when absent, so every existing
// call site is unaffected. This includes antigravity: its companion runs this
// SAME seeded `claude` command verbatim in an editor terminal, so it mints its
// session id exactly the same way native-terminal does.
export function seededCommand(cmd, promptFile, { sessionId } = {}) {
  const sid = sessionId ? ` --session-id ${sessionId}` : '';
  return `${cmd}${sid} "${taskInstruction(promptFile)}"`;
}

// Reopen by reply (D27 C2, Task 7): continue the SAME Claude Code session. The
// id is the only new thing on the command line and it must be a bare UUID;
// the reply itself goes in the prompt file, never on the command line (same
// rule as seededCommand). CLI: `claude --resume <session> "query"`
// (docs/reference/2026-09-23/claude-code/cli-reference.md, `--resume`/`-r`).
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function resumedCommand(cmd, sessionId, promptFile) {
  if (!SESSION_UUID.test(String(sessionId ?? ''))) throw new Error(`resumedCommand: not a session id: ${String(sessionId).slice(0, 40)}`);
  return `${cmd} --resume ${sessionId} "${taskInstruction(promptFile)}"`;
}

// glmps-2-0-30 reopened D20's session half, glmps-2-0-218 widened it: the
// companion is a plain VS Code extension, so any VS Code family IDE hosts a
// session in an editor terminal when it is live (`live`) or can be started
// (`launchable`); native-terminal never has a companion, and an IDE that can do
// neither is downgraded to native-terminal so the session still opens.
export const IDE_TARGETS = TARGET_IDS.filter((id) => id !== 'native-terminal');
export function launchTargetFor(target, { live = [], launchable = [] } = {}) {
  return IDE_TARGETS.includes(target) && (live.includes(target) || launchable.includes(target)) ? target : 'native-terminal';
}

// Windows image names (lower case, no .exe), one list per IDE. Matched whole so
// 'code' never claims 'code - insiders'.
const IMAGE = {
  'vscode': ['code'], 'vscode-insiders': ['code - insiders'], 'cursor': ['cursor'],
  'windsurf': ['windsurf'], 'antigravity': ['antigravity ide', 'antigravity'],
};
export function liveIdeTargets(tasklistCsv) {
  const names = new Set();
  for (const line of String(tasklistCsv ?? '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase().replace(/\.exe$/, ''));
  }
  return IDE_TARGETS.filter((id) => IMAGE[id].some((n) => names.has(n)));
}

// Each IDE drains its own queue, or every IDE would race for one file and the
// wrong one would open the session. antigravity keeps the original name so a
// companion installed before this change still finds its requests.
export function companionFileName(target) {
  if (target === 'antigravity') return 'resume.jsonl';
  return IDE_TARGETS.includes(target) ? `resume.${target}.jsonl` : null;
}

// The file an installed companion (companion/src/extension.ts) drains. It is
// fixed to the home dir there, not derived from the server's stateDir, so a
// server running on any state dir must write here for its launch to be seen.
export function companionRequestsFile(home = os.homedir(), target = 'antigravity') {
  return path.join(legacyStateDirFor(home), 'requests', companionFileName(target) ?? 'resume.jsonl');
}

// The companion runs `command` verbatim in a new editor-area terminal, titled
// `name` when given (a companion built before names titles it by command).
export function companionRecord({ command, cwd, now, name = null, target = 'antigravity' }) {
  return { type: 'terminal', target, command, cwd: cwd ?? null, location: 'editor', ts: now, ...(name ? { name } : {}) };
}

// The session a companion line opens, from the id seededCommand/resumedCommand/
// resumeCommand put on it; null for a command that names no session.
export function sessionIdOfCommand(command) {
  const m = /--(?:session-id|resume)\s+(\S+)/.exec(String(command ?? ''));
  return m && isSessionUuid(m[1]) ? m[1] : null;
}

// Lines still in the request file past maxAgeMs: the companion drains on change
// and every 30 s, so one this old means nothing is draining (card glmps-2-0-156).
export function staleCompanionRequests({ text, now, maxAgeMs }) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || !Number.isFinite(rec.ts) || now - rec.ts <= maxAgeMs) continue;
    out.push({ sessionId: sessionIdOfCommand(rec.command), cwd: rec.cwd ?? null, ts: rec.ts, ageMs: now - rec.ts });
  }
  return out;
}

// Resume: a plain `<cmd> --resume <id>` with no prompt file -
// the History "Resume" button and the terminal launcher use this for an
// interactive resume, as opposed to resumedCommand's reopen-by-reply (which
// always seeds a fresh prompt file). Same UUID rule as resumedCommand and
// Phase C's isSessionUuid (scut/reopen.js): anything else is refused, never
// resumed as something else.
export function resumeCommand(sessionId, cmd = 'claude') {
  return isSessionUuid(sessionId) ? `${cmd} --resume ${sessionId}` : null;
}

// cwd used to be interpolated unquoted into the AppleScript
// string's own `cd ${cwd} && ...` shell command - a space in cwd breaks the
// `cd` argument split, and a `"` or `\` breaks out of the "do script" string
// entirely. Quoted for BOTH layers: single-quoted for the POSIX shell (the
// standard `'\''` idiom closes/escapes/reopens the quote for an embedded
// single quote), then that whole single-quoted expression's own backslashes
// and double quotes are escaped so it cannot break out of the enclosing
// AppleScript string literal either.
// Pre-step (b), Task 12b review: a raw newline/carriage-return used to pass
// straight through unescaped. AppleScript's `do script` runs its string as
// if it had been typed into Terminal, so an embedded newline is not merely
// an AppleScript syntax break - it would execute whatever follows it as a
// SECOND, independent shell command. Refused by name rather than escaped:
// there is no AppleScript string-literal escape that turns a real newline
// back into literal text once `do script` has it, so the only safe answer
// is to never build the recipe at all.
function appleScriptQuote(s) {
  const str = String(s);
  if (/[\r\n]/.test(str)) {
    throw new Error('appleScriptQuote: refuses a cwd/command containing a newline or carriage-return');
  }
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// cmd.exe searches the CURRENT directory before PATH for a bare program
// name, so the launch cwd used to decide which `claude` (or which inner `cmd`)
// ran. cmd.exe is now started by absolute path, outer and inner, and
// NoDefaultCurrentDirectoryInExePath=1 keeps the cwd out of every lookup in
// both cmd processes and whatever they start.
export function windowsCmdPath(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
}

export function nativeTerminalRecipe({ platform, seededCmd, cwd, env = process.env }) {
  const options = { cwd, detached: true, stdio: 'ignore', windowsHide: true, shell: false };
  if (platform === 'win32') {
    // verified with a harmless no-window probe
    // (spawnSync('cmd', ['/c', 'echo', seededCmd], { shell: false }),
    // inspecting cmd.exe's own echoed command line) that Node's DEFAULT
    // Windows argv-to-command-line conversion re-escapes an argv element
    // containing an embedded `"` (wraps it in an extra pair of quotes,
    // backslash-escapes the inner ones) before cmd.exe ever sees it -
    // `cmd /k seededCmd` would then run on a MANGLED command line, not
    // the literal text this module built (seededCmd/resumedCommand/
    // resumeCommand already quote their OWN embedded content on the
    // assumption that it survives verbatim). windowsVerbatimArguments
    // stops Node from doing that extra pass; the args array is simply
    // joined with spaces and passed through as-is.
    const cmdExe = windowsCmdPath(env);
    return {
      file: cmdExe,
      args: ['/c', 'start', '""', `"${cmdExe}"`, '/k', seededCmd],
      options: { ...options, shell: false, windowsVerbatimArguments: true, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' } },
    };
  }
  if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script "cd ${appleScriptQuote(shSingleQuote(cwd))} && ${appleScriptQuote(seededCmd)}"`;
    return { file: 'osascript', args: ['-e', script], options };
  }
  return { file: 'x-terminal-emulator', args: ['-e', `sh -c '${seededCmd}'`], options };
}
