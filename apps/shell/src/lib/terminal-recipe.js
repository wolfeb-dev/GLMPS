// apps/shell/src/lib/terminal-recipe.js
// A copy of the kernel's win32 nativeTerminalRecipe (parity-tested): the shell
// package must not import server code at runtime.
//
// verified with a harmless no-window probe
// (spawnSync('cmd', ['/c', 'echo', command], { shell: false }), inspecting
// cmd.exe's own echoed command line - never claude, never /k, never a
// visible window) that Node's DEFAULT Windows argv-to-command-line
// conversion re-escapes an argv element containing an embedded `"` (wraps
// it in an extra pair of quotes, backslash-escapes the inner ones) before
// cmd.exe ever sees it - `cmd /k command` would then run on a MANGLED
// command line, not the literal text the kernel's own
// editor-targets.js/learning-apply.js built (and the shell's own
// validateLaunch shape-checked). windowsVerbatimArguments stops Node from
// doing that extra pass.
import path from 'node:path';

// F18 parity copy of the kernel's windowsCmdPath/nativeTerminalRecipe (win32).
export function windowsCmdPath(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
}

export function terminalRecipe({ command, cwd, env = process.env }) {
  const cmdExe = windowsCmdPath(env);
  return {
    file: cmdExe,
    args: ['/c', 'start', '""', `"${cmdExe}"`, '/k', command],
    options: { cwd, detached: true, stdio: 'ignore', windowsHide: true, shell: false, windowsVerbatimArguments: true, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' } },
  };
}
