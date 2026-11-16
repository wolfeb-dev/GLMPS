// server/lib/kernel/tap-mirror.js
// The file mirror (server-and-client-tap task 10): the fixed table of mirror
// roots, the confinement rules every mirror path must pass, the path set the
// server runs a client's adapters on, and session id namespacing. The store
// (manifest, append, snapshot, quota) is further down in this file.
import fs from 'node:fs';
import path from 'node:path';

const FIXED_ROOTS = ['claude', 'gemini-tmp', 'agy-cli', 'opencode', 'codex', 'copilot-cli', 'hermes'];
const INDEXED_ROOT_RE = /^(?:antigravity|vscode)-\d{1,2}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SEGMENT_MAX = 255;
const PATH_MAX = 1024;
// Characters Windows cannot hold in a file name; refused on every server OS so a
// mirror written on Linux can still be moved to a Windows kernel.
const BAD_CHARS_RE = /[\0-\x1f\x7f\\:<>"|?*]/;

export const isRootId = (id) => FIXED_ROOTS.includes(id) || INDEXED_ROOT_RE.test(id);
export const validClientId = (id) => typeof id === 'string' && CLIENT_ID_RE.test(id) && id !== '.' && id !== '..';

/** null when `p` is an acceptable mirror path (`<rootId>/<rel>`), else the reason it is refused. */
export function validateMirrorPath(p) {
  if (typeof p !== 'string' || !p) return 'path must be a non-empty string';
  if (p.length > PATH_MAX) return `path is longer than ${PATH_MAX} characters`;
  if (p.startsWith('/')) return 'path must not start with a slash';
  if (BAD_CHARS_RE.test(p)) return 'path holds a backslash, colon, control or reserved character';
  const segs = p.split('/');
  if (segs.length < 2) return 'path must name a file under a root';
  if (!isRootId(segs[0])) return 'unknown mirror root';
  for (const s of segs) {
    if (!s) return 'path holds an empty segment';
    if (s === '.' || s === '..') return 'path holds a dot segment';
    if (s.length > SEGMENT_MAX) return `a segment is longer than ${SEGMENT_MAX} characters`;
    if (/[. ]$/.test(s)) return 'a segment ends in a dot or a space';
    if (RESERVED_DEVICE_RE.test(s.split('.')[0])) return 'a segment is a reserved device name';
  }
  return null;
}

function realOrSelf(p) { try { return fs.realpathSync(p); } catch { return null; } }

/** The absolute file for a mirror path, or a thrown 'refused' error when it would leave the mirror dir. */
export function resolveMirrorFile(mirrorDir, p) {
  const bad = validateMirrorPath(p);
  if (bad) throw new Error(`mirror path refused: ${bad}`);
  const base = path.resolve(mirrorDir);
  const file = path.resolve(base, ...p.split('/'));
  const rel = path.relative(base, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('mirror path refused: resolves outside the mirror');
  // A link planted inside the mirror must not carry a write out of it: check the
  // deepest existing ancestor's real location.
  let probe = path.dirname(file);
  while (probe.length >= base.length) {
    const real = realOrSelf(probe);
    if (real) {
      const realBase = realOrSelf(base) ?? base;
      const r = path.relative(realBase, real);
      if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('mirror path refused: resolves outside the mirror');
      break;
    }
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  return file;
}

/** The mirror roots of a getPaths() object, in the spec's table order. The client resolves them on its own paths. */
export function mirrorRoots(P) {
  const out = [{ id: 'claude', dir: P.claudeDir }];
  (P.antigravityDirs ?? []).forEach((dir, i) => out.push({ id: `antigravity-${i}`, dir }));
  (P.vscodeStorageDirs ?? []).forEach((dir, i) => out.push({ id: `vscode-${i}`, dir }));
  out.push({ id: 'gemini-tmp', dir: P.geminiTmpDir }, { id: 'agy-cli', dir: P.agyCliDir }, { id: 'opencode', dir: P.opencodeDir },
    { id: 'codex', dir: P.codexDir }, { id: 'copilot-cli', dir: P.copilotCliDir }, { id: 'hermes', dir: P.hermesDir });
  return out.filter((r) => typeof r.dir === 'string' && r.dir);
}

const norm = (p) => path.resolve(p);
const sameOrInside = (dir, file) => {
  const rel = path.relative(norm(dir), norm(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** `<rootId>/<rel>` for a file under one of `roots`, else null. The longest matching root wins. */
export function rootIdOfFile(roots, file) {
  let best = null;
  for (const r of roots) {
    if (!sameOrInside(r.dir, file)) continue;
    if (!best || norm(r.dir).length > norm(best.dir).length) best = r;
  }
  if (!best) return null;
  return `${best.id}/${path.relative(norm(best.dir), norm(file)).split(path.sep).join('/')}`;
}

export function clientMirrorDir(stateDir, clientId) {
  if (!validClientId(clientId)) throw new TypeError('invalid client id');
  return path.join(stateDir, 'clients', clientId, 'mirror');
}

function indexedDirs(mirrorDir, prefix) {
  let names = [];
  try { names = fs.readdirSync(mirrorDir); } catch { /* no mirror yet */ }
  const idx = names.map((n) => new RegExp(`^${prefix}-(\\d{1,2})$`).exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  return (idx.length ? idx : [0]).map((i) => path.join(mirrorDir, `${prefix}-${i}`));
}

/**
 * The path set a client's poll runs on. Mirrored fields point into `mirrorDir`;
 * every other data field points at a path that does not exist inside it, so a
 * client's poll can never fall back to the server's own disk.
 */
export function serverPathsFor(P, mirrorDir) {
  const claudeDir = path.join(mirrorDir, 'claude');
  const antigravityDirs = indexedDirs(mirrorDir, 'antigravity');
  const out = {};
  for (const [k, v] of Object.entries(P)) {
    if (typeof v === 'string') out[k] = path.join(mirrorDir, '_absent', k);
    else if (Array.isArray(v)) out[k] = [];
    else out[k] = v && typeof v === 'object' && k === 'zoneConfig' ? v : null;
  }
  Object.assign(out, {
    claudeDir,
    projectsDir: path.join(claudeDir, 'projects'),
    activeSessionsFile: path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    antigravityDirs,
    antigravityDir: antigravityDirs[0],
    brainDir: path.join(antigravityDirs[0], 'brain'),
    vscodeStorageDirs: indexedDirs(mirrorDir, 'vscode'),
    geminiTmpDir: path.join(mirrorDir, 'gemini-tmp'),
    agyCliDir: path.join(mirrorDir, 'agy-cli'),
    opencodeDir: path.join(mirrorDir, 'opencode'),
    codexDir: path.join(mirrorDir, 'codex'),
    copilotCliDir: path.join(mirrorDir, 'copilot-cli'),
    hermesDir: path.join(mirrorDir, 'hermes'),
  });
  return out;
}

export const namespaceSessionId = (clientId, sessionId) => `${clientId}:${sessionId}`;
export function splitNamespacedId(id) {
  const s = String(id ?? '');
  const i = s.indexOf(':');
  if (i <= 0 || !validClientId(s.slice(0, i)) || !s.slice(0, i).startsWith('cli_')) return null;
  return { clientId: s.slice(0, i), sessionId: s.slice(i + 1) };
}
