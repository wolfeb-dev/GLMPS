// server/lib/governance/deletion-guard.js
//
// Operator decision 5 (2026-11-01, card glmps-2-0-runtime-127): an agent
// session never deletes a local file. It copies, or renames to <name>.old, and
// the kernel's old-cleanup loop is the only actor that deletes, on a schedule.
// Pure: a command line in, a verdict out. hooks/deletion-guard.js holds the I/O.
// Anything unparseable is allowed (fail open), like the other guards here.
import { simpleCommands } from './shell-commands.js';
import { normalizeRole } from './role-permissions.js';

export const DELETE_ALTERNATIVE = 'Agent sessions may not delete files. Copy the file instead, or rename it to <name>.old '
  + '(mv a.txt a.txt.old, git mv a.txt a.txt.old, Rename-Item a.txt a.txt.old); the scheduled old-cleanup job deletes '
  + '.old files in tracked git repos after 7 days. Untrack without deleting with git rm --cached.';

const DELETE_PROGRAMS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'del', 'erase', 'rd', 'ri', 'remove-item', 'rimraf']);
const WRAPPERS = new Set(['sudo', 'doas', 'xargs', 'nice', 'ionice', 'timeout', 'stdbuf', 'npx', 'pnpx', 'bunx']);
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

const NODE_DELETE = /\.(rm|rmdir|unlink)(Sync)?\s*\(|\b(rmSync|rmdirSync|unlinkSync)\s*\(/;
const PY_DELETE = /\b(os\.(remove|unlink|rmdir|removedirs)|shutil\.rmtree)\s*\(|\.(unlink|rmdir)\s*\(/;
const DOTNET_DELETE = /\[(System\.)?IO\.(File|Directory|FileInfo|DirectoryInfo)\]::Delete\b/i;

function stripWrappers(tokens) {
  let t = tokens;
  while (t.length && WRAPPERS.has(t[0])) {
    t = t.slice(1);
    // timeout takes a duration; every other wrapper here only takes flags.
    while (t.length && (t[0].startsWith('-') || /^\d+[smhd]?$/.test(t[0]))) t = t.slice(1);
    if (t.length) t = [String(t[0]).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, ''), ...t.slice(1)];
  }
  return t;
}

const hasShortFlag = (tokens, ch) => tokens.some((x) => /^-[A-Za-z]+$/.test(x) && x.includes(ch));

function gitVerdict(tokens) {
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) i += GIT_GLOBAL_WITH_VALUE.has(tokens[i]) ? 2 : 1;
  const sub = tokens[i];
  const rest = tokens.slice(i + 1);
  if (sub === 'clean') return !(rest.includes('--dry-run') || hasShortFlag(rest, 'n'));
  if (sub === 'reset') return rest.includes('--hard');
  if (sub === 'rm') return !rest.includes('--cached');
  return false;
}

function codeArg(tokens, flags) {
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (flags.includes(t)) return tokens[i + 1] ?? '';
    const eq = flags.find((f) => f.startsWith('--') && t.startsWith(`${f}=`));
    if (eq) return t.slice(eq.length + 1);
  }
  return null;
}

function deletes(tokens) {
  const t = stripWrappers(tokens);
  if (!t.length) return false;
  const [prog] = t;
  if (DELETE_PROGRAMS.has(prog)) return true;
  if (prog === 'git') return gitVerdict(t);
  if (prog === 'find') {
    if (t.includes('-delete')) return true;
    const at = t.findIndex((x) => x === '-exec' || x === '-execdir' || x === '-ok' || x === '-okdir');
    return at > 0 && t[at + 1] != null && deletes(t.slice(at + 1));
  }
  if (prog === 'node') {
    const code = codeArg(t, ['-e', '-p', '--eval', '--print']);
    return code != null && NODE_DELETE.test(code);
  }
  if (/^(python[\d.]*|py)$/.test(prog)) {
    const code = codeArg(t, ['-c']);
    return code != null && PY_DELETE.test(code);
  }
  return false;
}

/** { block, reason, matched } for a Bash or PowerShell command line. */
export function checkDeleteCommand(command) {
  try {
    const text = typeof command === 'string' ? command : '';
    if (!text.trim()) return { block: false };
    if (DOTNET_DELETE.test(text)) return { block: true, reason: DELETE_ALTERNATIVE, matched: text.match(DOTNET_DELETE)[0] };
    for (const { tokens, seg } of simpleCommands(text)) {
      if (deletes(tokens)) return { block: true, reason: DELETE_ALTERNATIVE, matched: seg };
    }
    return { block: false };
  } catch {
    return { block: false };
  }
}

/** True when this hook environment belongs to an agent session the guard covers. */
export function isGuardedSession(env = {}) {
  const mode = String(env.GLMPS_DELETION_GUARD ?? '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return normalizeRole(env.GLMPS_ROLE) != null;
}
