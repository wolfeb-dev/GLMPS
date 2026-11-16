// server/lib/state-dir.js
// The one place that decides where GLMPS keeps its state. paths.js re-exports
// it; hooks, taps and scripts import it directly because it pulls in nothing
// beyond node builtins. server/test/state-dir-seam.test.js fails the build when
// any other runtime module spells the old folder name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_DIR_NAME = '.glmps2';
export const LEGACY_STATE_DIR_NAME = '.glmps';
// The pre-cutover 2.0 shadow instance's own state folder (D30).
export const SHADOW_STATE_DIR_NAME = `${LEGACY_STATE_DIR_NAME}-2`;

export const STATE_SUBDIRS = Object.freeze({
  logs: 'logs',
  db: 'db',
  queue: 'queue',
  cache: 'cache',
  ledgers: 'ledgers',
  archive: 'archive',
  ops: 'ops',
  backups: 'backups',
});

// The scheduled tasks \GLMPS\<name> run <stateDir>/ops/<name>.cmd. The folder
// and names are pinned (card glmps-2-0-140, operator: "stays in the same
// location and keeps the same name from this point forward"); a move would
// leave a task pointing at a missing file, so every tool asks here.
export const OPS_SCRIPTS = Object.freeze(['deploy-glmps2', 'restart-glmps2', 'rebuild-app']);
export function opsScriptPath(stateDir, name) {
  if (!OPS_SCRIPTS.includes(name)) throw new Error(`unknown ops script: ${name}`);
  return path.join(stateDir, STATE_SUBDIRS.ops, `${name}.cmd`);
}
export function opsTaskName(name) {
  if (!OPS_SCRIPTS.includes(name)) throw new Error(`unknown ops script: ${name}`);
  return `\\GLMPS\\${name}`;
}

export function stateDirFor(home = os.homedir()) { return path.join(home, STATE_DIR_NAME); }
export function legacyStateDirFor(home = os.homedir()) { return path.join(home, LEGACY_STATE_DIR_NAME); }
export function shadowStateDirFor(home = os.homedir()) { return path.join(home, SHADOW_STATE_DIR_NAME); }

// The explicit override alone, or null: callers that layer a profile or a test
// redirect between the env and the home default (getPaths) need it apart.
export function envStateDirOverride(env = process.env) {
  return env.GLMPS_STATE_DIR || env.GLMPS_STATE_DIR || null;
}

// The home default: ~/.glmps2 once it exists (T6 renames the live folder),
// else ~/.glmps. A failed existence check reads as absent.
export function homeStateDir(home = os.homedir(), exists = fs.existsSync) {
  const next = stateDirFor(home);
  let present = false;
  try { present = exists(next) === true; } catch { present = false; }
  return present ? next : legacyStateDirFor(home);
}

export function resolveStateDir({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  return envStateDirOverride(env) || homeStateDir(home, exists);
}

// Both home folder names a state dir can carry, for code that recognises a
// path as "inside the state folder" (runner worktree detection, prod guards).
export function stateDirNames() { return [STATE_DIR_NAME, LEGACY_STATE_DIR_NAME]; }

// A path recorded before the cutover (a card's worktree under the legacy
// folder) rewritten to the same place under the current state folder. The
// junction keeps the old path working on disk, but the desktop app pins card
// launches to the current worktrees root by path text. Anything not under the
// legacy folder comes back unchanged.
export function rebaseLegacyStatePath(p, { stateDir, legacyStateDir, platform = process.platform } = {}) {
  if (typeof p !== 'string' || !p || !stateDir || !legacyStateDir) return p;
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const from = lib.resolve(legacyStateDir);
  const to = lib.resolve(stateDir);
  if (fold(from) === fold(to)) return p;
  const abs = lib.resolve(p);
  const rel = lib.relative(from, abs);
  if (!rel || rel.startsWith('..') || lib.isAbsolute(rel)) return p;
  return lib.join(to, rel);
}

// What a child process needs to agree on the same folder. The folder goes in
// GLMPS_STATE_DIR, and GLMPS_STATE_DIR is blanked rather than set: it outranks
// GLMPS_STATE_DIR, so a value inherited from the parent would beat the folder we
// hand over, and a real value would leak into a grandchild (a test a runner
// session spawns) and beat the temp GLMPS_STATE_DIR that test sets.
export function stateDirEnv(stateDir) {
  return { GLMPS_STATE_DIR: '', GLMPS_STATE_DIR: stateDir };
}

export function stateSubdir(stateDir, kind) {
  const name = STATE_SUBDIRS[kind];
  if (!name) throw new Error(`unknown state subfolder: ${kind}`);
  return path.join(stateDir, name);
}

export function stateSubdirs(stateDir) {
  const out = {};
  for (const kind of Object.keys(STATE_SUBDIRS)) out[kind] = stateSubdir(stateDir, kind);
  return out;
}

// A root-level file that moved into a subfolder. `path` is where it is written
// now; `legacyPath` is the root location readers still accept for one release.
export function stateFile(stateDir, kind, name) {
  return { path: path.join(stateSubdir(stateDir, kind), name), legacyPath: path.join(stateDir, name) };
}

const safeExists = (exists, p) => { try { return exists(p) === true; } catch { return false; } };

// Whole-file stores (caches, queue state): read the new file, else the old one.
export function readPathFor(stateDir, kind, name, exists = fs.existsSync) {
  const f = stateFile(stateDir, kind, name);
  if (safeExists(exists, f.path)) return f.path;
  return safeExists(exists, f.legacyPath) ? f.legacyPath : f.path;
}

// Append-only ledgers: every file that exists, old first, so a reader sees the
// pre-move history followed by what was appended since.
export function ledgerReadPaths(stateDir, name, exists = fs.existsSync) {
  const f = stateFile(stateDir, 'ledgers', name);
  return [f.legacyPath, f.path].filter(p => safeExists(exists, p));
}

// A ledger's whole history as one text, old file first. Unreadable files are
// skipped; each part ends in a newline so a torn last line cannot glue onto
// the first line of the next file.
export function readLedgerText(stateDir, name, { exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  let text = '';
  for (const p of ledgerReadPaths(stateDir, name, exists)) {
    let part = '';
    try { part = String(readFile(p, 'utf8')); } catch { continue; }
    text += part.endsWith('\n') || !part ? part : `${part}\n`;
  }
  return text;
}

export function appendLedger(stateDir, name, text) {
  const f = stateFile(stateDir, 'ledgers', name);
  fs.mkdirSync(path.dirname(f.path), { recursive: true });
  fs.appendFileSync(f.path, text);
  return f.path;
}

// SQLite: keep opening the old file while it exists so a live database is
// never split into two; a fresh state folder gets the new location.
export function dbFileFor(stateDir, name = 'kernel.db', exists = fs.existsSync) {
  const f = stateFile(stateDir, 'db', name);
  return safeExists(exists, f.legacyPath) && !safeExists(exists, f.path) ? f.legacyPath : f.path;
}
