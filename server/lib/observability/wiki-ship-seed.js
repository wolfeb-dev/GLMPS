// server/lib/observability/wiki-ship-seed.js
// The wiki an installer carries (card glmps-2-0-193). The staging step copies the
// published build into <bundle>/wiki/<build> and records it in bundle.json; on
// start the kernel seeds it into <stateDir>/wiki so a fresh install opens with
// the full user guide before any model has run. Written to match
// graph-ship-seed.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publishWikiBuild, readCurrentWiki, wikiPaths } from './wiki-publish.js';

/** Every regular file under dir, as sorted posix paths relative to it. */
export function listFilesSorted(dir) {
  const acc = [];
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) acc.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  rec(dir);
  return acc.sort();
}

/** sha256 over the sorted file list and each file's bytes. */
export function wikiSnapshotSha256(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of listFilesSorted(dir)) {
    h.update(rel).update('\0').update(fs.readFileSync(path.join(dir, ...rel.split('/')))).update('\0');
  }
  return h.digest('hex');
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const BUILD_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Returns { seeded, reason }. Throws only when the copy itself fails; a bundled
 * wiki whose checksum does not match bundle.json is refused, not thrown, so a
 * damaged install still starts. A wiki the loop published after the bundled
 * snapshot was built is left alone, and a source checkout (no bundle.json wiki
 * record) never seeds.
 */
export function seedWikiSnapshot({ bundleDir, stateDir }) {
  const record = readJson(path.join(bundleDir, 'bundle.json'))?.wiki;
  if (!record) return { seeded: false, reason: 'no bundled wiki' };
  if (typeof record.build !== 'string' || !BUILD_NAME.test(record.build) || record.build.startsWith('.')) {
    return { seeded: false, reason: 'bundled wiki names an invalid build' };
  }
  const src = path.join(bundleDir, 'wiki', record.build);
  const srcCurrent = readJson(path.join(bundleDir, 'wiki', 'current.json'));
  if (!srcCurrent || !fs.existsSync(path.join(src, 'manifest.json'))) return { seeded: false, reason: 'bundled wiki is missing' };
  const bundledTs = Date.parse(record.builtAt);

  const p = wikiPaths(stateDir);
  let why;
  let cur = null;
  let unreadable = false;
  try { cur = readCurrentWiki(stateDir); } catch { unreadable = true; }
  if (!unreadable && !cur) why = 'absent';
  else if (unreadable || !Number.isFinite(cur.builtTs) || !fs.existsSync(path.join(p.builds, cur.build, 'manifest.json'))) why = 'unreadable';
  else if (cur.builtTs < bundledTs) why = 'older';
  else return { seeded: false, reason: 'local wiki is current' };

  if (wikiSnapshotSha256(src) !== record.sha256) return { seeded: false, reason: 'bundled wiki fails its bundle.json checksum' };

  fs.mkdirSync(p.builds, { recursive: true });
  const staging = fs.mkdtempSync(path.join(p.builds, '.seed-'));
  try {
    fs.cpSync(src, path.join(staging, record.build), { recursive: true });
    const dest = path.join(p.builds, record.build);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(path.join(staging, record.build), dest);
    publishWikiBuild({
      stateDir, buildDir: dest, now: () => bundledTs,
      meta: {
        builtAtCommit: srcCurrent.builtAtCommit ?? null, graphFingerprint: srcCurrent.graphFingerprint ?? null,
        sections: srcCurrent.sections, llmSections: srcCurrent.llmSections, verifierRef: srcCurrent.verifierRef ?? null,
      },
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { seeded: true, reason: why };
}

/** True when the kernel root holds a readable bundle.json: an installed copy, not a source checkout. */
export function isInstalledBundle(bundleDir) {
  return readJson(path.join(bundleDir, 'bundle.json')) !== null;
}

/**
 * The wiki loop's default (card glmps-2-0-193): on in the kernel service, off on
 * an installed bundle, whose wiki is the shipped snapshot and which has no
 * checkout, graph or model for the loop to work from. An explicit
 * wikiLoop.enabled in config.json always wins.
 */
export function wikiLoopEnabled({ configured, serviceMode, installedBundle }) {
  return configured ?? (serviceMode && !installedBundle);
}
