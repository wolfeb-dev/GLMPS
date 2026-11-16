// Nightly backups of the state dir (card glmps-2-0-runtime-42; spec
// docs/specs/2026-11-03-glmps-2-0-runtime-42-state-backups.md). A backup is a
// daily/<date>/ dir of every SQLite file (VACUUM INTO, so rows still in the WAL
// are in the copy) and every other regular file, closed by manifest.json; a dir
// without a manifest is not a backup. Client mirrors are one incremental tree.
// The transcript archive is left out of dailies and added to each weekly.
// Zero dependencies; node:sqlite is loaded lazily like the obligation store.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DAY_MS = 24 * 3600 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const MANIFEST = 'manifest.json';

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date of an epoch ms, from local fields (no tz handling here). */
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO 8601 week key (YYYY-Www) of the local date of an epoch ms. */
export function isoWeekKey(ms) {
  const l = new Date(ms);
  const day = new Date(Date.UTC(l.getFullYear(), l.getMonth(), l.getDate()));
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  day.setUTCDate(day.getUTCDate() - dow + 3); // the Thursday of this ISO week
  const isoYear = day.getUTCFullYear();
  const week = Math.ceil(((day - Date.UTC(isoYear, 0, 1)) / DAY_MS + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

function loadSqlite() {
  let mod = null;
  try { mod = process.getBuiltinModule('node:sqlite'); } catch { mod = null; }
  if (!mod?.DatabaseSync) throw new Error(`node:sqlite unavailable on Node ${process.versions.node}`);
  return mod.DatabaseSync;
}

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const rootOf = (p) => path.parse(path.resolve(p)).root.toLowerCase();
const isInside = (child, parent) => {
  const c = child.toLowerCase(); const p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

function fail(reason, detail = '') {
  return Object.assign(new Error(detail ? `${reason}: ${detail}` : reason), { reason });
}

// Every regular file under root as a posix rel path. Symlinks and junctions are
// neither isFile nor isDirectory on a Dirent, so they drop out here. A file
// that vanishes mid-walk is simply not listed.
async function walk(root, skipDir) {
  const out = [];
  async function visit(abs, rel) {
    let entries;
    try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skipDir(r)) await visit(path.join(abs, e.name), r); }
      else if (e.isFile()) out.push(r);
    }
  }
  await visit(root, '');
  return out;
}

// The transcript archive (2.1 GB live) goes in the weekly set only (card
// glmps-2-0-runtime-152); the second path is where the regrouped layout puts it.
export const WEEKLY_ONLY_DIRS = Object.freeze(['transcript-archive', 'archive/transcript-archive']);
// WSL holds the Headscale distro's vhdx open while it runs and the cache is
// re-fetchable (card glmps-2-0-runtime-148). The CA key never leaves the box: a
// copy lets its holder mint certificates every joined device trusts, and losing
// it only means rerunning the setup.
const REMOTE_ACCESS_SKIP_DIRS = Object.freeze(['remote-access/wsl', 'remote-access/cache']);
const skipStateDir = (rel) => rel === 'runner/worktrees' || rel === 'logs' || /^clients\/[^/]+\/mirror$/.test(rel)
  || WEEKLY_ONLY_DIRS.includes(rel) || REMOTE_ACCESS_SKIP_DIRS.includes(rel);
// Card glmps-2-0-152: the home and client CA keys likewise; a copy would let
// its holder vouch for the server or mint a client certificate. The retired
// Headscale folder keeps its old CA key after the retirement script moves it aside.
const skipStateFile = (rel) => /\.(db-wal|db-shm|tmp)$/i.test(rel)
  || /^remote-access\/headscale[^/]*\/ca\.key(\.bak-[^/]*)?$/.test(rel)
  || /^tls\/(home|client)-ca\.key$/.test(rel);

// VACUUM INTO and integrity_check are synchronous and take seconds on the
// memory stores, so each runs on its own worker thread (card
// glmps-2-0-runtime-146): the kernel's event loop keeps serving meanwhile.
const SQLITE_WORKER = `
const { parentPort, workerData, threadId } = require('node:worker_threads');
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const { op, file, dest } = workerData;
try {
  if (op === 'copy') {
    let db;
    try { db = new DatabaseSync(file, { readOnly: true }); } catch { db = new DatabaseSync(file); }
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
    } finally { db.close(); }
    parentPort.postMessage({ threadId });
  } else {
    const db = new DatabaseSync(file, { readOnly: true });
    try { parentPort.postMessage({ threadId, ok: db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok' }); }
    finally { db.close(); }
  }
} catch (e) { parentPort.postMessage({ threadId, error: e.message, code: e.code ?? null }); }
`;

function onSqliteWorker(workerData) {
  loadSqlite();
  const { Worker } = process.getBuiltinModule('node:worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(SQLITE_WORKER, { eval: true, workerData });
    let settled = false;
    w.once('message', (m) => {
      settled = true;
      if (m.error) reject(Object.assign(new Error(m.error), { code: m.code ?? undefined }));
      else resolve(m);
    });
    w.once('error', (e) => { if (!settled) { settled = true; reject(e); } });
    w.once('exit', (code) => { if (!settled) { settled = true; reject(new Error(`sqlite worker exited with code ${code}`)); } });
  });
}

export const copySqlite = (src, dest) => onSqliteWorker({ op: 'copy', file: src, dest });
export const checkSqlite = (file) => onSqliteWorker({ op: 'check', file });

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { return null; }
}

function completeDirs(parent, nameRe) {
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return []; }
  return names.filter((n) => nameRe.test(n) && exists(path.join(parent, n, MANIFEST))).sort();
}

export async function verifyBackup(dir) {
  const m = readManifest(dir);
  if (!m || !Array.isArray(m.files)) return { ok: false, reason: `no readable manifest in ${dir}` };
  for (const f of m.files) {
    const file = path.join(dir, ...f.rel.split('/'));
    let st;
    try { st = fs.statSync(file); } catch { return { ok: false, reason: `missing file ${f.rel}` }; }
    if (st.size !== f.size) return { ok: false, reason: `size mismatch for ${f.rel}` };
    if (await hashFile(file) !== f.sha256) return { ok: false, reason: `hash mismatch for ${f.rel}` };
    if (f.kind === 'sqlite') {
      let ok = false;
      try { ok = (await checkSqlite(file)).ok; } catch (e) { return { ok: false, reason: `integrity_check failed on ${f.rel}: ${e.message}` }; }
      if (!ok) return { ok: false, reason: `integrity_check not ok on ${f.rel}` };
    }
  }
  return { ok: true, checked: m.files.length };
}

/**
 * Copy a verified backup into an empty dir. liveStateDir, when given, is never
 * a valid destination. The client mirror tree beside daily/ and weekly/ comes
 * back too when the backup sits in a standard target layout.
 */
export async function restoreBackup(backupDir, newStateDir, { liveStateDir = null } = {}) {
  const dest = realOr(newStateDir);
  if (liveStateDir && dest.toLowerCase() === realOr(liveStateDir).toLowerCase()) throw fail('live-state', 'refusing to restore over the live state dir');
  if (exists(newStateDir) && fs.readdirSync(newStateDir).length) throw fail('not-empty', newStateDir);
  const v = await verifyBackup(backupDir);
  if (!v.ok) throw fail('verify', v.reason);
  const m = readManifest(backupDir);
  fs.mkdirSync(newStateDir, { recursive: true });
  for (const f of m.files) {
    const to = path.join(newStateDir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    await fs.promises.copyFile(path.join(backupDir, ...f.rel.split('/')), to);
  }
  const tree = path.resolve(backupDir, '..', '..', 'mirror');
  let mirrored = 0;
  if (['daily', 'weekly'].includes(path.basename(path.resolve(backupDir, '..'))) && exists(tree)) {
    for (const rel of await walk(tree, () => false)) {
      const to = path.join(newStateDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      await fs.promises.copyFile(path.join(tree, ...rel.split('/')), to);
      mirrored += 1;
    }
  }
  return { files: m.files.length, mirrored };
}

async function linkOrCopy(from, to) {
  try { fs.linkSync(from, to); } catch { await fs.promises.copyFile(from, to); }
}

/**
 * createStateBackup({ stateDir, targetDir, now, hour, keepDaily, keepWeekly,
 *   requireSecondDisk, sameVolume }) -> { run, maybeRun, verify, newestDaily, checkTarget }.
 * sameVolume(a, b) overrides the volume-root comparison (tests run with both
 * dirs under one tmpdir).
 */
export function createStateBackup({
  stateDir, targetDir, now = Date.now, hour = 3, keepDaily = 14, keepWeekly = 8,
  requireSecondDisk = true, sameVolume = null, afterBacklogSnapshot = () => {}, staleMs = 36 * 3600 * 1000,
}) {
  const state = stateDir ? realOr(stateDir) : null;

  function checkTarget() {
    if (!targetDir) throw fail('target-missing', 'backup.targetDir is not set');
    if (isInside(realOr(targetDir), state)) throw fail('target-inside-state', path.resolve(targetDir));
    if (!exists(targetDir)) throw fail('target-missing', path.resolve(targetDir));
    const target = realOr(targetDir);
    if (requireSecondDisk) {
      const same = sameVolume ? sameVolume(state, target) : rootOf(state) === rootOf(target);
      if (same) throw fail('target-same-volume', `${state} and ${target}`);
    }
    return target;
  }

  const newestDaily = () => {
    if (!targetDir) return null;
    const names = completeDirs(path.join(targetDir, 'daily'), DATE_RE);
    return names.length ? path.join(targetDir, 'daily', names.at(-1)) : null;
  };

  async function syncMirror(target) {
    let copied = 0;
    let clients = [];
    try { clients = fs.readdirSync(path.join(state, 'clients'), { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return 0; }
    for (const c of clients) {
      const base = path.join(state, 'clients', c.name, 'mirror');
      for (const rel of await walk(base, () => false)) {
        const relFromState = `clients/${c.name}/mirror/${rel}`;
        const src = path.join(state, ...relFromState.split('/'));
        const dest = path.join(target, 'mirror', ...relFromState.split('/'));
        let s; try { s = fs.statSync(src); } catch { continue; }
        let d = null; try { d = fs.statSync(dest); } catch { d = null; }
        if (d && d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 1000) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(src, dest);
        fs.utimesSync(dest, s.atime, s.mtime);
        copied += 1;
      }
    }
    return copied;
  }

  function prune(target) {
    const pruned = [];
    const cutoff = now() - DAY_MS;
    for (const [sub, re, keep] of [['daily', DATE_RE, keepDaily], ['weekly', WEEK_RE, keepWeekly]]) {
      const parent = path.join(target, sub);
      let names = [];
      try { names = fs.readdirSync(parent).filter((n) => re.test(n)); } catch { continue; }
      const complete = names.filter((n) => exists(path.join(parent, n, MANIFEST))).sort();
      const drop = complete.slice(0, Math.max(0, complete.length - keep));
      for (const n of names) {
        if (complete.includes(n)) continue;
        let m = Infinity; try { m = fs.statSync(path.join(parent, n)).mtimeMs; } catch {}
        if (m < cutoff) drop.push(n);
      }
      for (const n of drop) { fs.rmSync(path.join(parent, n), { recursive: true, force: true }); pruned.push(`${sub}/${n}`); }
    }
    return pruned;
  }

  async function promoteWeekly(target, dailyDir) {
    const key = isoWeekKey(now());
    const wk = path.join(target, 'weekly', key);
    if (exists(path.join(wk, MANIFEST))) return null;
    fs.rmSync(wk, { recursive: true, force: true });
    const m = readManifest(dailyDir);
    for (const f of m.files) {
      const to = path.join(wk, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      await linkOrCopy(path.join(dailyDir, ...f.rel.split('/')), to);
    }
    // Archive files are mostly append-once, so one unchanged since the last
    // weekly is linked to that copy rather than copied again.
    const prevName = completeDirs(path.join(target, 'weekly'), WEEK_RE).filter((n) => n !== key).at(-1);
    const prevDir = prevName ? path.join(target, 'weekly', prevName) : null;
    const prev = new Map((prevDir ? readManifest(prevDir)?.files ?? [] : []).map((f) => [f.rel, f]));
    const extra = [];
    for (const root of WEEKLY_ONLY_DIRS) {
      for (const sub of (await walk(path.join(state, ...root.split('/')), () => false)).sort()) {
        const rel = `${root}/${sub}`;
        if (skipStateFile(rel)) continue;
        const src = path.join(state, ...rel.split('/'));
        const dest = path.join(wk, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        let size; let sha;
        try { size = fs.statSync(src).size; sha = await hashFile(src); } catch (e) { if (e?.code === 'ENOENT') continue; throw e; }
        const p = prev.get(rel);
        let linked = false;
        if (p && p.size === size && p.sha256 === sha) {
          try { fs.linkSync(path.join(prevDir, ...rel.split('/')), dest); linked = true; } catch { linked = false; }
        }
        if (!linked) {
          try { await fs.promises.copyFile(src, dest); } catch (e) { if (e?.code === 'ENOENT') continue; throw fail('copy-failed', `${rel}: ${e.message}`); }
          size = fs.statSync(dest).size; sha = await hashFile(dest);
        }
        extra.push({ rel, size, sha256: sha, kind: 'file' });
      }
    }
    const files = [...m.files, ...extra];
    fs.writeFileSync(path.join(wk, MANIFEST), JSON.stringify({ ...m, files, bytes: files.reduce((a, f) => a + f.size, 0) }));
    return key;
  }

  // The backlog snapshot replays only store.<logGen>.log, and a compaction can
  // swap the generation and delete older logs while the walk runs. So the
  // snapshot is copied first, then the log it names, and the pair is retaken
  // until the live snapshot still names that generation afterwards.
  async function copyBacklog(dir) {
    const src = path.join(state, 'backlog');
    const snap = path.join(src, 'store.json');
    if (!exists(snap)) return [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dest = path.join(dir, 'backlog');
      fs.mkdirSync(dest, { recursive: true });
      await fs.promises.copyFile(snap, path.join(dest, 'store.json'));
      afterBacklogSnapshot();
      let gen = null;
      try { gen = JSON.parse(fs.readFileSync(path.join(dest, 'store.json'), 'utf8')).logGen ?? null; } catch { gen = null; }
      const out = ['backlog/store.json'];
      if (gen) {
        const log = `store.${gen}.log`;
        try { await fs.promises.copyFile(path.join(src, log), path.join(dest, log)); } catch (e) { if (e?.code === 'ENOENT') continue; throw e; }
        out.push(`backlog/${log}`);
      }
      let liveGen = null;
      try { liveGen = JSON.parse(fs.readFileSync(snap, 'utf8')).logGen ?? null; } catch { liveGen = undefined; }
      if (liveGen === gen) return out;
    }
    throw fail('backlog-unstable', 'the backlog snapshot changed generation on every one of 5 attempts');
  }

  async function run() {
    const target = checkTarget();
    const date = localDate(now());
    const dir = path.join(target, 'daily', date);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    // A file whose content matches the previous complete daily becomes a hard
    // link to that copy, so the rarely-changing model and stores take disk
    // once across all dailies (card glmps-2-0-runtime-146). The link goes in
    // under a temp name and replaces the copy only once it exists.
    const prevName = completeDirs(path.join(target, 'daily'), DATE_RE).filter((n) => n !== date).at(-1);
    const prevDir = prevName ? path.join(target, 'daily', prevName) : null;
    const prev = new Map((prevDir ? readManifest(prevDir)?.files ?? [] : []).map((f) => [f.rel, f]));
    let linked = 0;
    const files = [];
    async function record(rel, kind) {
      const dest = path.join(dir, ...rel.split('/'));
      const entry = { rel, size: fs.statSync(dest).size, sha256: await hashFile(dest), kind };
      const p = prev.get(rel);
      if (p && p.size === entry.size && p.sha256 === entry.sha256) {
        const from = path.join(prevDir, ...rel.split('/'));
        const tmp = `${dest}.link`;
        try {
          if (fs.statSync(from).size === entry.size) { fs.linkSync(from, tmp); fs.renameSync(tmp, dest); linked += 1; }
        } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
      }
      files.push(entry);
    }
    const backlog = new Set(await copyBacklog(dir));
    for (const rel of backlog) await record(rel, 'file');
    for (const rel of (await walk(state, skipStateDir)).sort()) {
      if (skipStateFile(rel) || rel === 'backlog/store.json' || backlog.has(rel)) continue;
      const src = path.join(state, ...rel.split('/'));
      const dest = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const kind = /\.db$/i.test(rel) ? 'sqlite' : 'file';
      try {
        if (kind === 'sqlite') await copySqlite(src, dest); else await fs.promises.copyFile(src, dest);
      } catch (e) {
        // deleted mid-run; sqlite reports a vanished file in its own words
        if ((e?.code === 'ENOENT' || kind === 'sqlite') && !exists(src)) continue;
        throw fail('copy-failed', `${rel}: ${e.message}`);
      }
      await record(rel, kind);
    }
    const bytes = files.reduce((a, f) => a + f.size, 0);
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ createdAt: new Date(now()).toISOString(), stateDir: state, files, bytes }));

    const weekly = await promoteWeekly(target, dir);
    const mirrored = await syncMirror(target);
    const pruned = prune(target);
    return { dir, date, files: files.length, bytes, linked, weekly, mirrored, pruned };
  }

  // The registry counts nothing-to-do as a fresh run, so a newest backup
  // older than staleMs (the loop's 36 h SLA) fails instead (card
  // glmps-2-0-runtime-146). No backup at all is a fresh install, not stale.
  function assertFresh() {
    const newest = newestDaily();
    if (!newest) return;
    const created = Date.parse(readManifest(newest)?.createdAt ?? '');
    if (Number.isFinite(created) && now() - created > staleMs) {
      throw fail('backup-stale', `newest complete backup is ${path.basename(newest)}, ${Math.round((now() - created) / 3600_000)} h old`);
    }
  }

  async function maybeRun() {
    const target = checkTarget();
    if (new Date(now()).getHours() < hour) { assertFresh(); return { outcome: 'nothing-to-do', result: { reason: 'before-hour' } }; }
    if (exists(path.join(target, 'daily', localDate(now()), MANIFEST))) return { outcome: 'nothing-to-do', result: { reason: 'already-done' } };
    return { outcome: 'done', result: await run() };
  }

  const verify = (dir = newestDaily()) => (dir ? verifyBackup(dir) : Promise.resolve({ ok: false, reason: 'no complete daily backup' }));

  return { run, maybeRun, verify, newestDaily, checkTarget };
}
