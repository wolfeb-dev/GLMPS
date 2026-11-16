// server/lib/adapters/editor-roots.js
// Shared per-OS enumeration of VS Code-family editor storage roots (glmps-50,
// register docs/future-changes.md #5). Reused by the cline (globalStorage) and
// copilot-chat (workspaceStorage) adapters so forks are scanned everywhere:
// win32  %APPDATA%/<editor>/User/<kind>
// darwin ~/Library/Application Support/<editor>/User/<kind>
// linux  $XDG_CONFIG_HOME/<editor>/User/<kind> (else ~/.config)
import os from 'node:os';
import path from 'node:path';

/** [storage dir name, display label] - the fork list scanned by default. */
export const EDITORS = [
  ['Code', 'VS Code'],
  ['Code - Insiders', 'VS Code Insiders'],
  ['Cursor', 'Cursor'],
  ['VSCodium', 'VSCodium'],
  ['Windsurf', 'Windsurf'],
  ['Trae', 'Trae'],
];

/** The per-OS parent directory that holds <editor>/User/... trees. */
function storageParent(platform, env, home) {
  if (platform === 'win32') return env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME ?? path.join(home, '.config');
}

/**
 * Enumerate <parent>/<editor>/User/<kind> roots for every known editor.
 * All inputs injectable for tests; `extra` appends editor names (strings or
 * [name, label] pairs) - the config-extension hook.
 * @returns {{ dir: string, label: string }[]} (deduped)
 */
export function editorStorageDirs(kind, {
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  extra = [],
} = {}) {
  const parent = storageParent(platform, env, home);
  const editors = [
    ...EDITORS,
    ...extra.map(e => Array.isArray(e) ? e : [String(e), String(e)]),
  ];
  const out = [];
  const seen = new Set();
  for (const [name, label] of editors) {
    const dir = path.join(parent, name, 'User', kind);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, label });
  }
  return out;
}

/** <editor>/User/globalStorage roots (extension state - Cline/Roo). */
export function globalStorageDirs(opts) { return editorStorageDirs('globalStorage', opts); }

/** <editor>/User/workspaceStorage roots (per-workspace state - Copilot Chat). */
export function workspaceStorageDirs(opts) { return editorStorageDirs('workspaceStorage', opts); }
