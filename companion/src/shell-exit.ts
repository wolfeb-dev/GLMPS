// A runner session is closed by force-killing its claude.exe tree (server
// session-closer.js), which never resets the terminal's mouse tracking. The
// shell it was typed into must exit with it, or that tab is left as a live
// prompt echoing mouse reports (card glmps-2-0-117). Same prompt-file rule the
// closer uses to find runner sessions.
const RUNNER_PROMPT_RE = /[\\/]runner[\\/][a-z0-9][a-z0-9-]*\.prompt\.md/i;
const SEMICOLON_SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'nu']);

export function withShellExit(command: string, shellPath: string | undefined): string {
  if (!command || !RUNNER_PROMPT_RE.test(command)) return command;
  const shell = String(shellPath ?? '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  if (SEMICOLON_SHELLS.has(shell)) return `${command}; exit 0`;
  if (shell === 'cmd') return `${command} & exit 0`;
  return command;
}
