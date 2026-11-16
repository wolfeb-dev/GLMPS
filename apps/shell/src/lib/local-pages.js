// apps/shell/src/lib/local-pages.js
// URL-to-file resolution for the shell's own pages, served from the
// glmps-shell scheme because file:// inside app.asar is blank once the
// GrantFileProtocolExtraPrivileges fuse is off. No electron import.
import path from 'node:path';

export const SCHEME = 'glmps-shell';
export const HOST = 'renderer';

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
});

export const localPageUrl = (name) => `${SCHEME}://${HOST}/${name}`;

// Returns { file, contentType } or null (the caller answers 404).
export function resolveLocalPage(url, rendererDir) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SCHEME}:` || u.hostname !== HOST || u.port || u.username || u.password) return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname.slice(1)); } catch { return null; }
  // A backslash is refused outright: on Linux it is no separator, so the
  // segment check below would pass `..\main.js` through as a file name.
  if (!rel || /[\\:\0]/.test(rel)) return null;
  if (rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  const contentType = TYPES[path.extname(rel).toLowerCase()];
  if (!contentType) return null;
  const root = path.resolve(rendererDir);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return null;
  return { file, contentType };
}
