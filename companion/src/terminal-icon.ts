// Terminal tab icon and label cleanup for Antigravity editor terminals
// (card glmps-2-0-166). VS Code / Antigravity renders TerminalOptions.name as
// plain text in the workbench UI font (it does not parse $(glmps-mark) codicon
// syntax or apply media/glmps-icons.woff to the title string), so the GLMPS
// 2.0 mark is attached via TerminalOptions.iconPath = new vscode.ThemeIcon(
// TERMINAL_ICON_ID) using the contributed "glmps-mark" icon, replacing the
// legacy "mc: " / "mc " text prefix on the tab title.

export const TERMINAL_ICON_ID = 'glmps-mark';

const GLMPS_PREFIX_RE = /^mc(?::\s*|\s+|$)/i;

export function stripMcPrefix(name: string): string {
  return String(name ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .replace(GLMPS_PREFIX_RE, '')
    .trim()
    .slice(0, 60);
}

export function terminalTabTitle(name?: string | null): string {
  return stripMcPrefix(String(name ?? '')) || 'terminal';
}
