// server/lib/observability/wiki-serve.js
// Map a raw /wiki/<name> request to a file inside the CURRENT published build
// (program plan section 4, D-W4). Works on the RAW request URL: new URL()
// would silently normalize "/wiki/../x" to "/x" and hide the attempt.
import fs from 'node:fs';
import path from 'node:path';
import { wikiPaths, readCurrentWiki } from './wiki-publish.js';

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.(html|json)$/;
const bad = { status: 400, error: 'invalid wiki path' };

// R-M5/M5 fix: shared by resolveWikiRequest
// (the /wiki/* route) AND POST /api/wiki/ask's own section-HTML read -- a
// path-STRING containment check alone is defeated by a symlink/junction
// INSIDE the directory whose target lives outside it (stat/readFileSync
// both follow it). Resolves the REAL path of both the file and its
// containing dir and requires the former to stay inside the latter.
// Throws whatever realpath() throws (ENOENT when the file genuinely does
// not exist), so each caller keeps its own error-shape conventions.
export function realpathContained(file, dir, { realpath = fs.realpathSync.native } = {}) {
  const realFile = realpath(file);
  const realDir = realpath(dir);
  return realFile.startsWith(realDir + path.sep);
}

export function isWikiAssetRequest(rawUrl) {
  const raw = String(rawUrl ?? '').split('?')[0];
  if (!raw.startsWith('/wiki/')) return false;
  const rest = raw.slice('/wiki/'.length);
  return rest.length > 0 && /[.%\\]/.test(rest);
}

export function resolveWikiRequest({ rawUrl, stateDir, stat = fs.statSync, realpath = fs.realpathSync.native }) {
  const rest = String(rawUrl ?? '').split('?')[0].slice('/wiki/'.length);
  if (rest.includes('/') || rest.includes('\\') || /%2e%2e|%2f|%5c/i.test(rest)) return bad;
  let name;
  try { name = decodeURIComponent(rest); }
  catch { return bad; } // malformed percent-encoding is a client error: reported as 400
  if (!NAME.test(name)) return bad;
  let current;
  try { current = readCurrentWiki(stateDir); }
  catch (e) {
    // a malformed current.json (readCurrentWiki, Task 3) throws
    // with the absolute state-dir path in its message. That used to reach the
    // server's outer 500 handler unchanged, leaking server filesystem layout
    // to the client. Same posture as the stat-error case above: a generic
    // 500, the real reason logged server-side only.
    console.error(`wiki-serve: readCurrentWiki failed for ${stateDir}: ${e.message}`);
    return { status: 500, error: 'wiki build unavailable' };
  }
  if (!current) return { status: 404, error: 'no wiki build published yet' };
  const dir = path.join(wikiPaths(stateDir).builds, current.build);
  const file = path.join(dir, name);
  if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) return bad;
  let st;
  try { st = stat(file); }
  catch (e) {
    if (e.code === 'ENOENT') return { status: 404, error: 'not found' };
    // any other stat failure (ENAMETOOLONG, EACCES, EIO, ...) is
    // reported as the same generic 400 as a rejected path -- never the raw fs
    // error message or the absolute build path, which would leak server
    // filesystem layout to the client. Logged server-side so the reason is
    // not lost, just kept out of the response body.
    console.error(`wiki-serve: stat failed for a resolved wiki asset path: ${e.code || e.message}`);
    return bad;
  }
  if (!st.isFile()) return { status: 404, error: 'not found' };
  // the containment check above is a path-
  // STRING comparison, which a single safe path segment (NAME already
  // refuses '/', '\', '..') always passes syntactically -- even when that
  // segment is itself a symlink or junction whose TARGET lives outside the
  // build dir. stat() above follows the link, so without this, a build
  // directory containing such a link would serve whatever is on the other
  // end of it. Resolve the REAL path of both the file and the build dir and
  // require the former stays inside the latter.
  try {
    if (!realpathContained(file, dir, { realpath })) return bad;
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 404, error: 'not found' };
    console.error(`wiki-serve: realpath failed for a resolved wiki asset path: ${e.code || e.message}`);
    return bad;
  }
  return { status: 200, file };
}
