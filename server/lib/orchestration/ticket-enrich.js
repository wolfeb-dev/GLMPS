// Best-effort ticket enrichment at creation time. Failure is always silent - 
// a ticket must never fail to file because graphify is absent or slow.
import { execFile } from 'node:child_process';
import { resolveGraphifyBin } from './graphify-spawn.js';

// Poisoned ticket titles flow through here: strip everything shell-meaningful
// before the query goes anywhere near a command line.
export function sanitizeQuery(s) {
  return String(s ?? '').replace(/[^\w\s./-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function parseGraphifyFiles(out) {
  const seen = new Set();
  for (const m of String(out ?? '').matchAll(/\[src=([^\s\]]+)/g)) seen.add(m[1]);
  return [...seen];
}

export function makeTicketEnrichExec({ resolveBin = resolveGraphifyBin, execFileImpl = execFile } = {}) {
  return async function exec(repo, query) {
    const bin = await resolveBin();
    if (!bin) throw new Error('graphify query refused: no graphify binary on PATH (no shell fallback, F23)');
    return new Promise((resolve, reject) => {
      execFileImpl(bin, ['query', query], { cwd: repo, timeout: 5000, encoding: 'utf-8', windowsHide: true }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout ?? '');
      });
    });
  };
}
const defaultExec = makeTicketEnrichExec();

export async function relevantFilesFor({ repo, title, description, exec = defaultExec } = {}) {
  if (!repo) return [];
  const query = sanitizeQuery(`${title ?? ''} ${description ?? ''}`);
  if (!query) return [];
  try { return parseGraphifyFiles(await exec(repo, query)).slice(0, 15); }
  catch { return []; }
}

// BMAD "deferred items" cross-reference: open held tickets in the same project
// touching any of the same files.
export function deferredRefsFor(items, item) {
  const mine = new Set(item.relevantFiles ?? []);
  if (!mine.size) return [];
  return (items ?? [])
    .filter(i => i.id !== item.id && i.project === item.project && i.state === 'held'
      && (i.relevantFiles ?? []).some(f => mine.has(f)))
    .map(i => i.id);
}
