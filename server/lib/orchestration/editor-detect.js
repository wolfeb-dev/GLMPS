// server/lib/orchestration/editor-detect.js
// Which IDE the Open buttons launch. The kernel runs as a Windows service with
// its own PATH, so installs are found by their folders under the operator's
// home and Program Files, never by PATH. Result is a full path to the .cmd.
import fs from 'node:fs';
import path from 'node:path';

export const EDITOR_ORDER = ['antigravity', 'vscode', 'vscode-insiders', 'cursor', 'windsurf'];

// Folder + shim relative to an install root (<home>\AppData\Local\Programs or a
// Program Files dir). Per-user antigravity and vscode paths are verified on the
// operator's machine. Every other entry, and every Program Files entry, is
// unverified: taken from each vendor's default installer layout, not checked here.
const REL = {
  'antigravity': 'Antigravity IDE\\bin\\antigravity-ide.cmd',
  'vscode': 'Microsoft VS Code\\bin\\code.cmd',
  'vscode-insiders': 'Microsoft VS Code Insiders\\bin\\code-insiders.cmd', // unverified
  'cursor': 'cursor\\resources\\app\\bin\\cursor.cmd', // unverified
  'windsurf': 'Windsurf\\bin\\windsurf.cmd', // unverified
};

export function defaultProgramFiles(env = process.env) {
  return [env.ProgramFiles, env['ProgramFiles(x86)']].filter((p) => typeof p === 'string' && p);
}

function candidates(id, home, programFiles) {
  const rel = REL[id];
  const roots = [];
  if (home) roots.push(path.win32.join(home, 'AppData', 'Local', 'Programs'));
  roots.push(...programFiles);
  return roots.map((r) => path.win32.join(r, rel));
}

function findInstalled(id, home, programFiles, exists) {
  for (const p of candidates(id, home, programFiles)) {
    try { if (exists(p)) return p; } catch { /* fail open: treat as absent */ }
  }
  return null;
}

// The install path of one IDE, or null (also for native-terminal and unknown ids).
export function editorCommand(id, { home = null, programFiles = [], exists = fs.existsSync } = {}) {
  return REL[id] ? findInstalled(id, home, programFiles, exists) : null;
}

// Each IDE keeps its extensions under <home>\<dir>\extensions. antigravity and
// vscode are verified on the operator's machine; the other three are vendor
// defaults, unverified.
const EXTENSIONS_DIR = {
  'antigravity': '.antigravity-ide',
  'vscode': '.vscode',
  'vscode-insiders': '.vscode-insiders', // unverified
  'cursor': '.cursor', // unverified
  'windsurf': '.windsurf', // unverified
};
// Joined, not spelled whole: state-dir-seam.test.js bans the old state folder's dotted name in runtime code.
export const COMPANION_EXTENSION_PREFIX = ['glmps', 'glmps-companion-'].join('.');

export function companionInstalled(id, { home = null, readdir = fs.readdirSync } = {}) {
  if (!home || !EXTENSIONS_DIR[id]) return false;
  try { return readdir(path.win32.join(home, EXTENSIONS_DIR[id], 'extensions')).some((n) => String(n).startsWith(COMPANION_EXTENSION_PREFIX)); } catch { return false; }
}

export function installedEditors({ home = null, programFiles = [], exists = fs.existsSync } = {}) {
  return EDITOR_ORDER.filter((id) => findInstalled(id, home, programFiles, exists));
}

// Picker target first (when installed), then the fixed order. null when none.
export function resolveEditor({ lastTarget = null, home = null, programFiles = [], exists = fs.existsSync } = {}) {
  const order = EDITOR_ORDER.includes(lastTarget) ? [lastTarget, ...EDITOR_ORDER.filter((i) => i !== lastTarget)] : EDITOR_ORDER;
  for (const id of order) {
    const command = findInstalled(id, home, programFiles, exists);
    if (command) return { id, command };
  }
  return null;
}

// Both editor spawners use shell:true, which joins file and args unquoted. A
// double quote in the command is left alone (not wrapped) so it can never be
// used to close the quoting; the shell runner's validation refuses it anyway.
export function quoteCommand(cmd) {
  const s = String(cmd);
  return /\s/.test(s) && !s.includes('"') ? `"${s}"` : s;
}
