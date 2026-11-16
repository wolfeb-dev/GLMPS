// server/lib/adapters/fs-util.js
// Small synchronous fs helpers shared by capture adapters. Every adapter reads
// undocumented, occasionally-absent third-party paths (extension storage,
// session dirs, sqlite files) and needs the same "never throw, just tell me
// no" shape around fs.statSync/lstatSync/readFileSync - this collects that
// shape in one place instead of re-deriving it per adapter (glmps-63).
import fs from 'node:fs';
import path from 'node:path';

/** fs.statSync(p), or null on any error (missing path, permissions, ...). */
export function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

/** True iff p exists and is a directory (follows symlinks). */
export function isDirectory(p) {
  return statSafe(p)?.isDirectory() === true;
}

/** True iff p exists and is a file (follows symlinks). */
export function isFile(p) {
  return statSafe(p)?.isFile() === true;
}

/** True iff p is a real (non-symlink) regular file. */
export function isRealFile(p) {
  try { const s = fs.lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
}

/** mtimeMs of p, or null if it doesn't exist / can't be stat'd. */
export function mtimeMsOf(p) {
  return statSafe(p)?.mtimeMs ?? null;
}

/**
 * Read p as utf-8 and JSON.parse it. Returns `undefined` (never `null`) on
 * any read/parse failure, so a file that legitimately parses to JSON `null`
 * can still be told apart from "couldn't read it".
 */
export function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return undefined; }
}

/**
 * Bounded sync walk of root for files whose name passes `match`. Depth 0 is
 * root's own entries. Symlinks are never followed; `enterDir(name, depth)` can
 * prune a directory; `limit` caps the result so a huge tree cannot stall a poll.
 * Returns absolute paths ([] for a missing or unreadable root).
 */
export function walkFiles(root, { maxDepth = 3, match = () => true, enterDir = () => true, limit = 5000 } = {}) {
  const out = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < maxDepth && enterDir(e.name, depth)) visit(full, depth + 1);
      } else if (e.isFile() && match(e.name, full)) {
        out.push(full);
      }
    }
  };
  visit(root, 0);
  return out;
}

/**
 * First `n` lines of p, reading at most `maxBytes` (a session file can be huge
 * and only its header matters). [] on any read error.
 */
export function readHeadLines(p, n = 8, maxBytes = 16384) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(maxBytes);
    const got = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf-8', 0, got).split(/\r?\n/).slice(0, n);
  } catch { return []; } finally { if (fd != null) { try { fs.closeSync(fd); } catch {} } }
}
