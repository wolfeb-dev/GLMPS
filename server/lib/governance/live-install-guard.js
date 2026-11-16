// server/lib/governance/live-install-guard.js
// Pure decision core for the live-install write guard. A poisoned/queued agent
// job must not be able to push changes straight into a live-trading install
// (e.g. the live NinjaTrader bin\Custom directory). The PreToolUse hook
// (hooks/live-install-guard.js) feeds tool calls here and blocks writes into
// configured live-install paths unless the operator has explicitly approved.
//
// No I/O. The hook supplies livePaths (from config) and handles the override.

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function norm(p) { return String(p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''); }

// Scan 2026-10-15 F1: a write-verb denylist misses any verb it does not list
// (a redirect inside a subshell, an interpreter one-liner, a copy tool by
// another name), so the Bash branch is default-deny on REFERENCE: a command
// that names a live root under any spelling is blocked, reads included (the
// Read tool still reads it). Spellings folded here: quotes and the cmd '^' /
// PowerShell backtick escapes, either slash style, repeated slashes, case,
// Git Bash / WSL / Cygwin drive prefixes, and a home-directory variable when
// the root sits under home. Residual: a path assembled from another
// variable, an 8.3 short name, a symlink or a relative path after a 'cd' is
// not resolved here.
function bashSpelling(cmd, home) {
  let c = String(cmd ?? '').replace(/["'`^]/g, '').replace(/\\/g, '/').toLowerCase();
  c = c.replace(/(^|[\s=(;&|<>])\/(?:mnt\/|cygdrive\/)?([a-z])(?=\/)/g, '$1$2:');
  if (home) {
    const h = norm(home);
    c = c.replace(/(^|[\s=(;&|<>])~(?=\/|$|\s)/g, `$1${h}`)
      .replace(/\$\{?home\}?|\$env:userprofile|\$env:home|%userprofile%|%home%/g, h);
  }
  return c.replace(/\/{2,}/g, '/');
}

// Parse a ';' / ',' / newline separated list of live-install path prefixes.
export function parseLivePaths(str) {
  return String(str ?? '')
    .split(/[;,\n]/)
    .map(s => norm(s.trim()))
    .filter(Boolean);
}

function underPrefix(target, prefix) {
  const t = norm(target);
  return t === prefix || t.startsWith(prefix + '/');
}

// A relative file_path means nothing until it is joined to the cwd, and a
// '..' segment can step out of or into a root, so collapse both first.
function resolveTarget(target, cwd) {
  let t = norm(target);
  const abs = /^[a-z]:\//.test(t) || t.startsWith('/');
  if (!abs) {
    if (!cwd) return t;
    t = norm(cwd) + '/' + t;
  }
  const parts = t.split('/');
  const root = parts.shift();
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return [root, ...out].join('/');
}

// A root only matches where a path segment ends, so 'c:/nt' does not hit 'c:/nt2'.
function mentionsRoot(cmd, root) {
  let from = 0;
  for (;;) {
    const at = cmd.indexOf(root, from);
    if (at < 0) return false;
    if (!/[a-z0-9_.-]/.test(cmd[at + root.length] ?? '')) return true;
    from = at + 1;
  }
}

/**
 * Decide whether a tool call writes into a live-install path.
 * @returns {{ blocked: boolean, reason?: string, target?: string }}
 */
export function guardLiveWrite({ tool_name, tool_input = {}, livePaths = [], home = '', cwd = '' } = {}) {
  if (!livePaths.length) return { blocked: false };

  if (WRITE_TOOLS.has(tool_name)) {
    const target = tool_input.file_path || tool_input.notebook_path || tool_input.path;
    if (!target) return { blocked: false };
    const hit = livePaths.find(lp => underPrefix(resolveTarget(target, cwd), lp));
    if (hit) return { blocked: true, target: String(target), reason: `${tool_name} into live-install path: ${target}` };
    return { blocked: false };
  }

  if (tool_name === 'Bash') {
    const c = bashSpelling(tool_input.command, home);
    const hit = livePaths.find(lp => mentionsRoot(c, lp));
    if (hit) return { blocked: true, target: hit, reason: `Bash command references a live-install path (${hit}); use the Read tool to read it` };
    return { blocked: false };
  }

  return { blocked: false };
}

/**
 * operator approval for a deliberate live deploy. Only the hook's OWN
 * environment counts (set in settings.json's hook env or the operator's
 * shell), never a file in the agent's working directory, which the guarded
 * agent can write itself.
 */
export function liveInstallApproved(env = process.env) {
  return env?.GLMPS_ALLOW_LIVE_INSTALL === '1';
}
