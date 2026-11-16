// server/lib/governance/real-path.js
// Realpath of the nearest EXISTING ancestor of a path, with the not-yet-created
// tail re-appended. A lexical prefix check cannot see a symlink or junction in
// the middle of a path, and a write target usually does not exist yet, so
// fs.realpathSync on the whole path would throw. Falls back to the plain
// resolved path when nothing can be resolved: a guard must not throw.
import fs from 'node:fs';
import path from 'node:path';

export function realpathNearest(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInsideReal(child, parent) {
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const c = norm(realpathNearest(child));
  const r = norm(realpathNearest(parent));
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
