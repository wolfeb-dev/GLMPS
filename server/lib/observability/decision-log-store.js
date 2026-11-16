// server/lib/observability/decision-log-store.js
//
// Append-only JSONL store for the architectural decision log (glmps-143).
//
// JSONL rather than a single JSON document because the writers are a Stop hook
// and the server's sweep tick, which can run at the same time. Appending a line
// is atomic enough for this; a read-modify-write of a JSON array is not, and
// would silently drop one side's rows.
//
// Reads are fail-open PER ROW (a malformed line is skipped, the rest survive),
// matching system-changes.js's per-source fail-open: a corrupt entry must never
// blank the whole history.
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'decisions';

export function logPath(stateDir) { return path.join(stateDir, DIR, 'log.jsonl'); }
export function watermarkPath(stateDir) { return path.join(stateDir, DIR, 'watermarks.json'); }
export function snapshotPath(stateDir) { return path.join(stateDir, DIR, 'config-snapshot.json'); }

function ensureDir(stateDir) {
  fs.mkdirSync(path.join(stateDir, DIR), { recursive: true });
}

/**
 * Append rows. ONE write per call (see the event-ledger-append-batching
 * lesson: per-row sync I/O in a hot path is the mistake this avoids).
 * @param {string} stateDir
 * @param {object[]} rows
 */
export function append(stateDir, rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return;
  ensureDir(stateDir);
  fs.appendFileSync(logPath(stateDir), list.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

/**
 * Read rows, newest first.
 * @param {string} stateDir
 * @param {{repo?:string, since?:number, q?:string, limit?:number}} opts
 */
export function readAll(stateDir, { repo, since, q, limit } = {}) {
  let text;
  try { text = fs.readFileSync(logPath(stateDir), 'utf-8'); }
  catch { return []; }

  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip this row only */ }
  }

  let out = rows;
  if (repo) out = out.filter((r) => r.repo === repo);
  if (Number.isFinite(since)) out = out.filter((r) => Number(r.ts) >= since);
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((r) => `${r.what ?? ''} ${r.why ?? ''}`.toLowerCase().includes(needle));
  }
  out = out.slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
  return out;
}

export function loadWatermarks(stateDir) {
  try { return JSON.parse(fs.readFileSync(watermarkPath(stateDir), 'utf-8')) ?? {}; }
  catch { return {}; }
}

export function saveWatermarks(stateDir, wm) {
  ensureDir(stateDir);
  fs.writeFileSync(watermarkPath(stateDir), JSON.stringify(wm ?? {}, null, 2), 'utf-8');
}

export function loadSnapshot(stateDir) {
  try { return JSON.parse(fs.readFileSync(snapshotPath(stateDir), 'utf-8')); }
  catch { return null; }
}

export function saveSnapshot(stateDir, snap) {
  ensureDir(stateDir);
  fs.writeFileSync(snapshotPath(stateDir), JSON.stringify(snap ?? {}, null, 2), 'utf-8');
}

/**
 * Fold `source:'enrichment'` rows onto their git row by commit sha.
 *
 * Enrichment APPENDS a row rather than rewriting the git row, so history is
 * never edited in place; the join happens at read time. A git row that already
 * has a substantive body wins over enrichment, because a hand-written merge
 * message is better evidence of intent than anything inferred afterwards.
 *
 * @param {object[]} rows
 */
export function joinEnrichment(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byCommit = new Map();
  for (const r of list) {
    if (r?.source === 'enrichment' && r.commit) byCommit.set(r.commit, r.why);
  }
  if (!byCommit.size) return list;

  return list
    .filter((r) => r?.source !== 'enrichment')
    .map((r) => {
      if (r?.source !== 'git') return r;
      const hasBody = String(r.why ?? '').trim().length > 0;
      if (hasBody) return r;
      const why = byCommit.get(r.commit);
      return why ? { ...r, why, enriched: true } : r;
    });
}
