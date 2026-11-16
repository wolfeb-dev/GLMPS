// server/lib/orchestration/asset-deploy.js
import fs from 'node:fs';
import path from 'node:path';

function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function sameContent(a, b) { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } }

function linkResolvesTo(dest, src) {
  const st = lstat(dest);
  if (!st || !st.isSymbolicLink()) return false;
  try { return path.resolve(fs.realpathSync(dest)) === path.resolve(fs.realpathSync(src)); }
  catch { return false; }
}

// The managed mappings derived from the asset store.
function plan(assetsDir, claudeDir) {
  const items = [];
  const agentsSrc = path.join(assetsDir, 'agents');
  for (const name of safeReaddir(agentsSrc))
    if (name.endsWith('.md') && isFile(path.join(agentsSrc, name)))
      items.push({ kind: 'file', src: path.join(agentsSrc, name), dest: path.join(claudeDir, 'agents', name) });
  const skillsSrc = path.join(assetsDir, 'skills');
  for (const name of safeReaddir(skillsSrc)) {
    const s = path.join(skillsSrc, name);
    if (isDir(s)) items.push({ kind: 'dir', src: s, dest: path.join(claudeDir, 'skills', name) });
  }
  const gmd = path.join(assetsDir, 'CLAUDE.global.md');
  if (isFile(gmd)) items.push({ kind: 'file', src: gmd, dest: path.join(claudeDir, 'CLAUDE.md') });
  return items;
}

// Add-on packs (addons/<pack>/addon.json + agents/ + skills/). Agents and skills
// only: a pack never carries CLAUDE.global.md. Core items win every collision.
function planAddons(addonsDir, claudeDir, coreItems, report, planned) {
  const claimed = new Map(coreItems.map((it) => [it.dest, it.src]));
  const items = [];
  for (const name of safeReaddir(addonsDir).sort()) {
    const packDir = path.join(addonsDir, name);
    if (!isDir(packDir)) continue;
    const manifest = path.join(packDir, 'addon.json');
    let error = null;
    try {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!m || typeof m !== 'object' || Array.isArray(m)) error = `${manifest} is not a JSON object`;
      else if (m.name !== name) error = `${manifest} name ${JSON.stringify(m.name)} does not match directory ${JSON.stringify(name)}`;
    } catch (e) {
      error = `${manifest} unreadable or not valid JSON: ${(e && e.message) || e}`;
    }
    if (error) {
      report.failed.push({ dest: packDir, error, addon: name });
      planned.push({ dest: packDir, src: manifest, action: 'invalid-pack' });
      continue;
    }
    const entry = { name, dests: [] };
    report.addons.push(entry);
    for (const it of plan(packDir, claudeDir)) {
      if (path.basename(it.src) === 'CLAUDE.global.md') continue;
      const owner = claimed.get(it.dest);
      if (owner) {
        report.failed.push({ dest: it.dest, error: `add-on ${name} item ${it.src} collides with ${owner}; not linked`, addon: name });
        planned.push({ dest: it.dest, src: it.src, action: 'collision' });
        continue;
      }
      claimed.set(it.dest, it.src);
      entry.dests.push(it.dest);
      items.push({ ...it, addon: name });
    }
  }
  return items;
}

function within(p, dir) {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Links into the stores we own whose source has since gone (a deleted skill,
// or a rollback past the commit that added it). Real files, copies and links
// to anywhere else belong to the operator and are never touched.
function planPrune(stores, claudeDir, placed) {
  const out = [];
  const cands = [path.join(claudeDir, 'CLAUDE.md')];
  for (const sub of ['agents', 'skills']) for (const n of safeReaddir(path.join(claudeDir, sub))) cands.push(path.join(claudeDir, sub, n));
  for (const dest of cands) {
    if (placed.has(dest)) continue;
    const st = lstat(dest);
    if (!st || !st.isSymbolicLink()) continue;
    let target;
    try { target = path.resolve(path.dirname(dest), fs.readlinkSync(dest)); } catch { continue; }
    if (lstat(target) || !stores.some((d) => within(target, path.resolve(d)))) continue;
    out.push({ dest, target });
  }
  return out;
}

export function deployAssets({ assetsDir, claudeDir, addonsDir, dryRun = false, prune = false }) {
  const report = { linked: [], skipped: [], backedUp: [], copied: [], failed: [], addons: [], pruned: [] };
  const planned = [];
  let backupDir = null;
  const ensureBackup = () => {
    if (!backupDir) { backupDir = path.join(claudeDir, `.backup-pre-consolidation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); fs.mkdirSync(backupDir, { recursive: true }); }
    return backupDir;
  };

  const core = plan(assetsDir, claudeDir);
  const items = core.concat(addonsDir ? planAddons(addonsDir, claudeDir, core, report, planned) : []);
  for (const it of items) {
    try {
      const st = lstat(it.dest);
      if (st && st.isSymbolicLink() && linkResolvesTo(it.dest, it.src)) { report.skipped.push(it.dest); planned.push({ dest: it.dest, src: it.src, action: 'skip' }); continue; }
      if (st) {
        // already-synced copy fallback (real file, identical) -> skip, no churn
        if (it.kind === 'file' && !st.isSymbolicLink() && sameContent(it.dest, it.src)) { report.skipped.push(it.dest); planned.push({ dest: it.dest, src: it.src, action: 'skip' }); continue; }
        if (it.kind === 'dir' && !st.isSymbolicLink() && isDir(it.dest)) { report.skipped.push(it.dest); planned.push({ dest: it.dest, src: it.src, action: 'skip' }); continue; }
      }
      planned.push({ dest: it.dest, src: it.src, action: st ? 'relink' : 'link' });
      if (dryRun) {
        if (st) report.backedUp.push({ dest: it.dest, backup: null });
        report.linked.push(it.dest);
        continue;
      }
      if (st) {
        const bdir = ensureBackup();
        const rel = path.relative(claudeDir, it.dest).replace(/[\\/]/g, '__');
        const bpath = path.join(bdir, rel);
        fs.cpSync(it.dest, bpath, { recursive: true });
        fs.rmSync(it.dest, { recursive: true, force: true });
        report.backedUp.push({ dest: it.dest, backup: bpath });
      }
      fs.mkdirSync(path.dirname(it.dest), { recursive: true });
      try {
        fs.symlinkSync(it.src, it.dest, it.kind === 'dir' ? 'junction' : 'file');
        report.linked.push(it.dest);
      } catch {
        // symlink not permitted (e.g. Windows without Developer Mode) -> copy fallback
        fs.cpSync(it.src, it.dest, { recursive: true });
        report.copied.push(it.dest);
      }
    } catch (e) {
      report.failed.push({ dest: it.dest, error: String((e && e.message) || e) });
    }
  }
  if (prune) {
    const stores = addonsDir ? [assetsDir, addonsDir] : [assetsDir];
    for (const { dest, target } of planPrune(stores, claudeDir, new Set(items.map((it) => it.dest)))) {
      planned.push({ dest, src: target, action: 'prune' });
      try {
        if (!dryRun) fs.rmSync(dest);
        report.pruned.push(dest);
      } catch (e) {
        report.failed.push({ dest, error: `prune: ${String((e && e.message) || e)}` });
      }
    }
  }
  if (dryRun) report.planned = planned;
  return report;
}
