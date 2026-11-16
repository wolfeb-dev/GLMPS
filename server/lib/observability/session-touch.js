// What one session touched, for the Touching band of its detail page (card
// glmps-2-0-runtime-60, session-detail spec section 3.2). The feed is paged to
// 50 rows, so the band cannot fold files from the page it holds; this rollup
// reads the whole log once. Only the latest write's diff rides along per file.
import { tsMs } from './feed-page.js';

const FILE_KINDS = new Set(['file-edit', 'memory', 'context-file']);

// Context-lane events carry `op`; feed-lane edits do not (an Edit or Write is
// a write by its kind), and a plain file read arrives as a Read tool event.
function opOf(e) {
  if (e.op === 'read' || e.op === 'write') return FILE_KINDS.has(e.kind) || e.tool === 'Read' ? e.op : null;
  if (e.kind === 'file-edit') return 'write';
  if (e.kind === 'tool' && e.tool === 'Read') return 'read';
  return null;
}

export function sessionTouch(log) {
  const byPath = new Map();
  const commits = [];
  let pushes = 0;
  let firstTs = null;
  let lastTs = null;
  for (const e of Array.isArray(log) ? log : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.ts != null) {
      if (firstTs == null || tsMs(e.ts) < tsMs(firstTs)) firstTs = e.ts;
      if (lastTs == null || tsMs(e.ts) > tsMs(lastTs)) lastTs = e.ts;
    }
    if (e.kind === 'git') {
      if (e.gitOp === 'commit') commits.push({ subject: String(e.label ?? '').replace(/^commit:\s*/, ''), ts: e.ts ?? null });
      else if (e.gitOp === 'push') pushes++;
      continue;
    }
    const op = opOf(e);
    if (!op || !e.path) continue;
    let f = byPath.get(e.path);
    if (!f) { f = { path: e.path, kind: e.kind, reads: 0, writes: 0, add: 0, del: 0, change: null, lastTs: null }; byPath.set(e.path, f); }
    if (op === 'write') {
      f.writes++;
      f.add += Number(e.add) || 0;
      f.del += Number(e.del) || 0;
      if (e.change) f.change = e.change;
    } else f.reads++;
    if (f.lastTs == null || tsMs(e.ts) >= tsMs(f.lastTs)) f.lastTs = e.ts ?? f.lastTs;
  }
  const files = [...byPath.values()].sort((a, b) =>
    (b.writes > 0) - (a.writes > 0) || tsMs(b.lastTs) - tsMs(a.lastTs));
  const written = files.filter(f => f.writes).length;
  return { files, commits, pushes, span: { firstTs, lastTs }, counts: { written, read: files.length - written, commits: commits.length } };
}
