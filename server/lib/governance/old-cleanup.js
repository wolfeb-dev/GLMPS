// server/lib/governance/old-cleanup.js
//
// The one actor allowed to delete (operator decision 5, 2026-11-01, card
// glmps-2-0-runtime-127): agent sessions rename to <name>.old instead of
// deleting, and this sweep deletes those .old paths once they have been seen
// for maxAgeMs. Boundaries, all enforced here rather than trusted from the
// caller: only roots whose realpath holds a .git entry; never into .git,
// node_modules or a nested repository; never through a symlink or junction;
// every candidate's realpath must sit inside its root's realpath; a .old
// directory holding any link is refused whole.
//
// First-seen, not mtime, is the age: a rename keeps the file's old mtime, so a
// fresh rename would otherwise look ancient and go on the next run.
//
// The first run (no state file) only takes a baseline: every .old path that
// already exists predates the policy, may be something the operator kept on
// purpose, and is never deleted. Remove a path from `baseline` in the state
// file to let the sweep take it.
import fs from 'node:fs';
import path from 'node:path';

export const OLD_CLEANUP_DEFAULTS = Object.freeze({
  everyMs: 6 * 3_600_000,
  maxAgeMs: 7 * 24 * 3_600_000,
  maxEntries: 200_000,
  maxDeletes: 500,
});

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const isOld = (name) => /\.old$/i.test(name);
const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

export function isInside(root, p) {
  const rel = path.relative(key(root), key(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function exists(p) {
  try { await fs.promises.lstat(p); return true; } catch { return false; }
}

const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// null when there is no state file yet (the baseline run); a corrupt file
// throws, so the run fails visibly rather than re-baselining or forgetting.
function loadState(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const s = JSON.parse(raw);
  return { seen: asMap(s?.seen), refused: asMap(s?.refused), baseline: asMap(s?.baseline) };
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// The first link inside dir, or null. Bounded so a huge .old tree cannot stall
// the loop; running out of budget counts as "cannot prove it is link-free".
async function firstLinkInside(dir, budget = 50_000) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
      if (--budget < 0) return path.join(d, e.name);
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) return p;
      const st = await fs.promises.lstat(p);
      if (st.isSymbolicLink()) return p;
      if (st.isDirectory()) stack.push(p);
    }
  }
  return null;
}

async function collect(rootReal, limits, counter) {
  const candidates = [];
  const stack = [rootReal];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (counter.entries >= limits.maxEntries) { counter.truncated = true; return candidates; }
      counter.entries += 1;
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { if (isOld(e.name)) candidates.push({ path: p, type: 'link' }); continue; }
      if (e.isDirectory()) {
        if (isOld(e.name)) { candidates.push({ path: p, type: 'dir' }); continue; }
        if (await exists(path.join(p, '.git'))) continue;
        // A reparse point readdir did not flag as a link still has to resolve inside.
        let real;
        try { real = await fs.promises.realpath(p); } catch { continue; }
        if (isInside(rootReal, real)) stack.push(p);
        continue;
      }
      if (e.isFile() && isOld(e.name)) candidates.push({ path: p, type: 'file' });
    }
  }
  return candidates;
}

// Why a candidate may not be deleted, or null when it may.
async function refusal(rootReal, c) {
  let real;
  try { real = await fs.promises.realpath(c.path); } catch { return 'realpath does not resolve'; }
  if (!isInside(rootReal, real)) return `realpath ${real} is outside the tracked root`;
  const st = await fs.promises.lstat(c.path);
  const now = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
  if (now !== c.type) return `changed from ${c.type} to ${now} during the sweep`;
  if (c.type === 'dir') {
    const link = await firstLinkInside(c.path).catch(() => c.path);
    if (link) return `directory holds a link or could not be fully read (${link})`;
  }
  return null;
}

/**
 * Delete .old paths seen for at least maxAgeMs inside the given git roots.
 * emit(kind, payload) records each deletion and each first refusal.
 */
export async function sweepOldFiles({ roots = [], stateFile, now = Date.now(), emit = () => {}, ...opts } = {}) {
  const limits = { ...OLD_CLEANUP_DEFAULTS, ...opts };
  const loaded = loadState(stateFile);
  const firstRun = loaded == null;
  const prev = loaded ?? { seen: {}, refused: {}, baseline: {} };
  const next = { seen: {}, refused: {}, baseline: { ...prev.baseline } };
  const out = { deleted: [], refused: [], pending: 0, baselined: 0, scanned: 0, truncated: false, roots: [], firstRun };
  const counter = { entries: 0, truncated: false };
  const done = new Set();

  for (const root of roots) {
    let rootReal;
    try { rootReal = await fs.promises.realpath(root); } catch { out.roots.push({ root, status: 'unresolvable' }); continue; }
    if (done.has(key(rootReal))) continue;
    done.add(key(rootReal));
    if (!(await exists(path.join(rootReal, '.git')))) { out.roots.push({ root, status: 'not-a-git-repo' }); continue; }
    out.roots.push({ root, status: 'swept' });

    for (const c of await collect(rootReal, limits, counter)) {
      const k = key(c.path);
      if (firstRun) next.baseline[k] = now;
      if (next.baseline[k]) { out.baselined += 1; continue; }
      const why = await refusal(rootReal, c).catch((e) => `could not be checked: ${e?.message ?? e}`);
      if (why) {
        out.refused.push({ path: c.path, root: rootReal, reason: why });
        next.refused[k] = prev.refused[k] ?? now;
        if (!prev.refused[k]) emit('cleanup.old_refused', { path: c.path, root: rootReal, reason: why });
        continue;
      }
      const firstSeen = Number(prev.seen[k]) || now;
      if (now - firstSeen < limits.maxAgeMs || out.deleted.length >= limits.maxDeletes) {
        next.seen[k] = firstSeen;
        out.pending += 1;
        continue;
      }
      try {
        await fs.promises.rm(c.path, { recursive: c.type === 'dir', force: false });
      } catch (e) {
        next.seen[k] = firstSeen;
        out.refused.push({ path: c.path, root: rootReal, reason: `delete failed: ${e?.code ?? e?.message ?? e}` });
        continue;
      }
      const row = { path: c.path, root: rootReal, type: c.type, firstSeen: new Date(firstSeen).toISOString() };
      out.deleted.push(row);
      emit('cleanup.old_deleted', row);
    }
  }
  out.scanned = counter.entries;
  out.truncated = counter.truncated;
  saveState(stateFile, next);
  return out;
}
