// server/lib/observability/wiki-publish.js
// The wiki's state-dir layout, the atomic current.json swap, and retention
// (program plan section 4, D-W3). A build is published only after the checker
// passes (wiki-loop.js onVerified). current.json is written to a temp file and
// renamed over the old one, so a crash at any point leaves a valid pointer.
import fs from 'node:fs';
import path from 'node:path';

const BUILD_NAME = /^[A-Za-z0-9._-]+$/;

export function wikiPaths(stateDir) {
  const root = path.join(stateDir, 'wiki');
  return {
    root,
    builds: path.join(root, 'builds'),
    current: path.join(root, 'current.json'),
    cache: path.join(root, 'cache.json'),
    lastVerify: path.join(root, 'last-verify.json'),
  };
}

export function buildIdFor(sha, ts) { return `${String(sha).slice(0, 12)}-${ts}`; }
const buildTs = (name) => { const m = /-(\d+)$/.exec(name); return m ? Number(m[1]) : 0; };

export function writeJsonAtomic(file, obj, { rename = fs.renameSync, unlink = fs.unlinkSync } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    rename(tmp, file);
  } catch (e) {
    // Best-effort cleanup of the orphaned temp file. If that cleanup also
    // fails, the failure is named in the thrown error's message rather than
    // swallowed; the original rename error is what propagates either way.
    try { unlink(tmp); }
    catch (cleanupErr) { e.message += ` (cleanup of ${tmp} also failed: ${cleanupErr.message})`; }
    throw e;
  }
}

export function readCurrentWiki(stateDir) {
  const file = wikiPaths(stateDir).current;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let cur;
  try { cur = JSON.parse(raw); }
  catch { throw new Error(`wiki current.json is malformed: ${file}`); }
  if (!cur || typeof cur.build !== 'string' || !BUILD_NAME.test(cur.build) || cur.build.startsWith('.')) {
    throw new Error(`wiki current.json is malformed: ${file}`);
  }
  return cur;
}

export function pruneWikiBuilds({ stateDir, keep = 3, current, rm = fs.rmSync, readdir = fs.readdirSync } = {}) {
  const p = wikiPaths(stateDir);
  const cur = current === undefined ? (readCurrentWiki(stateDir)?.build ?? null) : current;
  let names;
  try {
    names = readdir(p.builds, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (e) {
    // A readdir failure never throws out of retention: it is a named
    // retention error, same as an rm failure below, so a caller mid-publish
    // (after the pointer swap already happened) never sees an exception here.
    if (e.code === 'ENOENT') return { removed: [], retentionErrors: [] };
    return { removed: [], retentionErrors: [`readdir ${p.builds}: ${e.message}`] };
  }
  const others = names.filter(n => n !== cur).sort((a, b) => buildTs(b) - buildTs(a));
  const keepOthers = Math.max(0, keep - (cur ? 1 : 0));
  const removed = [];
  const retentionErrors = [];
  for (const n of others.slice(keepOthers)) {
    try { rm(path.join(p.builds, n), { recursive: true, force: true }); removed.push(n); }
    catch (e) { retentionErrors.push(`${n}: ${e.message}`); }
  }
  return { removed, retentionErrors };
}

export function publishWikiBuild({ stateDir, buildDir, meta, keep = 3, now = Date.now, rename = fs.renameSync, rm = fs.rmSync, readdir = fs.readdirSync } = {}) {
  const p = wikiPaths(stateDir);
  const rel = path.relative(p.builds, path.resolve(buildDir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || !BUILD_NAME.test(rel)) {
    throw new Error(`refusing to publish a build outside ${p.builds}: ${buildDir}`);
  }
  if (!fs.existsSync(path.join(buildDir, 'manifest.json'))) throw new Error(`refusing to publish a build with no manifest: ${buildDir}`);
  const current = {
    build: rel, builtAtCommit: meta.builtAtCommit, graphFingerprint: meta.graphFingerprint ?? null, builtTs: now(),
    sections: meta.sections, llmSections: meta.llmSections, verifierRef: meta.verifierRef ?? null,
  };
  writeJsonAtomic(p.current, current, { rename });
  // Past this point current.json already points at the new build; retention
  // is best-effort and must never throw, so pruneWikiBuilds folds every
  // failure (readdir or rm) into retentionErrors instead.
  const { removed, retentionErrors } = pruneWikiBuilds({ stateDir, keep, current: rel, rm, readdir });
  return { current, removed, retentionErrors };
}
