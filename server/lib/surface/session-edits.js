// Recent file writes by running or idle sessions, one row per (session, path),
// for the Surface edits window. Pure: the route supplies sessions, events,
// residency rows, stat and the FileApi allow check.
const WINDOW_MS = 24 * 3600 * 1000;

const norm = (p) => String(p).replace(/\\/g, '/');
const isWrite = (e) => e && typeof e.path === 'string' && e.path
  && (e.kind === 'file-edit' || (e.op === 'write' && (e.kind === 'context-file' || e.kind === 'memory')));

function repoFor(rows, abs) {
  const lower = abs.toLowerCase();
  let best = null;
  for (const r of rows) {
    if (!r || typeof r.path !== 'string') continue;
    const root = norm(r.path).replace(/\/+$/, '');
    const rl = root.toLowerCase();
    if (lower === rl || lower.startsWith(rl + '/')) {
      if (!best || root.length > best.root.length) best = { repo: r.repo, root };
    }
  }
  return best;
}

export function collectSessionEdits({ sessions, eventsOf, rows = [], statOf, allowed, now, cap = 60 }) {
  const out = [];
  for (const s of sessions ?? []) {
    if (s.state !== 'working' && s.state !== 'idle') continue;
    const byPath = new Map();
    for (const e of eventsOf(s.id) ?? []) {
      if (!isWrite(e)) continue;
      const p = norm(e.path);
      const ts = Date.parse(e.ts);
      const cur = byPath.get(p) ?? { ts: -Infinity, add: null, del: null, change: null };
      if (Number.isFinite(e.add)) cur.add = (cur.add ?? 0) + e.add;
      if (Number.isFinite(e.del)) cur.del = (cur.del ?? 0) + e.del;
      if (Number.isFinite(ts) && ts >= cur.ts) { cur.ts = ts; cur.change = e.change ?? cur.change; }
      byPath.set(p, cur);
    }
    for (const [p, a] of byPath) {
      if (!Number.isFinite(a.ts)) continue;
      let ok = false;
      try { ok = allowed(p); } catch { ok = false; }
      if (!ok) continue;
      const hit = repoFor(rows, p);
      let st = null;
      try { st = statOf(p); } catch { st = null; }
      out.push({
        path: p, repo: hit?.repo ?? null, rel: hit ? (p.length > hit.root.length ? p.slice(hit.root.length + 1) : '') : null,
        ts: a.ts, add: a.add, del: a.del,
        sessionId: s.id, title: s.title ?? null, tool: s.tool, state: s.state,
        size: st?.size ?? null, mtimeMs: st?.mtimeMs ?? null,
        change: a.change ?? null,
      });
    }
  }
  out.sort((x, y) => y.ts - x.ts);
  return { ts: now, windowMs: WINDOW_MS, edits: out.slice(0, cap) };
}
