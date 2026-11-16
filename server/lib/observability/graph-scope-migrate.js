// server/lib/observability/graph-scope-migrate.js
// graphify migration task 3 (card glmps-2-0-93): once the graph timers act only
// on in-scope roots, the sync-health and integrity stores still carry every
// root that ever had a graphify-out (24 on the first machine, 17 of them
// worktrees) and the same root under both separators. This plans the cleanup:
// one key per root, in-scope roots kept with their baselines, everything else
// moved into an archive record appended to the task-1 snapshot. Nothing is
// dropped without landing in that record first.
import fs from 'node:fs';
import path from 'node:path';

export const SCOPE_ARCHIVE_KEY = 'scopeArchives';

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const fold = (p) => norm(p).toLowerCase();
// Sync-health keys that name a graphify version, not a root (graphifyVersionTick).
const isVersionKey = (k) => k.startsWith('graphify@');

function newestBy(entries, tsOf) {
  return entries.reduce((best, e) => (tsOf(e.value) > tsOf(best.value) ? e : best));
}

const syncTs = (v) => (v && typeof v.ts === 'number' ? v.ts : -1);
const shapeTs = (v) => (v && v.last && typeof v.last.ts === 'number' ? v.last.ts : -1);
const verifiedTs = (v) => (v && typeof v.verifiedTs === 'number' ? v.verifiedTs : -1);

function mergeIntegrity(group) {
  const win = newestBy(group, shapeTs);
  const out = { ...win.value };
  const stamped = group.filter((e) => e.value && typeof e.value.verifiedAtCommit === 'string');
  if (stamped.length && !out.collapsed) {
    const v = newestBy(stamped, verifiedTs).value;
    out.verifiedAtCommit = v.verifiedAtCommit;
    out.verifiedTs = v.verifiedTs;
  }
  return out;
}

function planStore(store, { inScope, merge, skipKey }) {
  const kept = {};
  const archived = {};
  const merged = [];
  const groups = new Map();
  for (const [k, value] of Object.entries(store && typeof store === 'object' ? store : {})) {
    if (skipKey(k)) { kept[k] = value; continue; }
    const g = groups.get(fold(k));
    if (g) g.push({ key: k, value }); else groups.set(fold(k), [{ key: k, value }]);
  }
  for (const [f, group] of groups) {
    if (!inScope.has(f)) {
      for (const e of group) archived[e.key] = e.value;
      continue;
    }
    const canonical = inScope.get(f);
    if (group.length === 1 && group[0].key === canonical) { kept[canonical] = group[0].value; continue; }
    const value = merge(group);
    kept[canonical] = value;
    for (const e of group) if (e.key !== canonical || e.value !== value) archived[e.key] = e.value;
    merged.push({ key: canonical, from: group.map((e) => e.key) });
  }
  return { kept, archived, merged };
}

/**
 * Pure plan. `inScope` is the list of roots the graph timers act on (ship plus
 * opted-in machine roots). Returns the new stores, every raw entry removed from
 * them, the keys that were merged, and whether anything changed.
 */
export function planScopeMigration({ syncHealth = {}, integrity = {}, inScope = [] } = {}) {
  const scope = new Map(inScope.map((r) => [fold(r), norm(r)]));
  const s = planStore(syncHealth, {
    inScope: scope, skipKey: isVersionKey,
    merge: (group) => newestBy(group, syncTs).value,
  });
  const i = planStore(integrity, { inScope: scope, skipKey: () => false, merge: mergeIntegrity });
  const changed = Object.keys(s.archived).length > 0 || Object.keys(i.archived).length > 0
    || s.merged.length > 0 || i.merged.length > 0;
  return {
    syncHealth: s.kept,
    integrity: i.kept,
    archive: { syncHealth: s.archived, integrity: i.archived },
    merged: { syncHealth: s.merged, integrity: i.merged },
    changed,
  };
}

/**
 * Appends one archive record to the task-1 snapshot file, keeping every other
 * field of it, atomically. Creates a minimal snapshot document when task 1 has
 * never written one on this machine.
 */
export function appendScopeArchive(snapshotFile, plan, { inScope = [], now = new Date() } = {}) {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`snapshot ${snapshotFile} is unreadable (${e.message}); refusing to archive over it`);
  }
  if (!doc || typeof doc !== 'object') doc = { schema: 1, plan: 'wolfeb-dev/glmps-2.0 docs/specs/2026-10-25-graphify-in-glmps2.md' };
  const list = Array.isArray(doc[SCOPE_ARCHIVE_KEY]) ? doc[SCOPE_ARCHIVE_KEY] : [];
  const record = {
    archivedAt: now.toISOString(),
    inScope: inScope.map(norm),
    syncHealth: plan.archive.syncHealth,
    integrity: plan.archive.integrity,
    merged: plan.merged,
  };
  doc[SCOPE_ARCHIVE_KEY] = [...list, record];
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  const tmp = `${snapshotFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, snapshotFile);
  return record;
}
