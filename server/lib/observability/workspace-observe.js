// server/lib/observability/workspace-observe.js
// Pure, zero-dep. Infers the "observed" side of a session's workspace from
// the events MC already classifies. Zero agent cost - runs out-of-process.
const tsVal = t => typeof t === 'string' ? (Date.parse(t) || 0) : (t ?? 0);

// glmps-100: input is ALREADY sorted newest-first by the caller. inferObserved
// sorts the event ring ONCE and buckets per category, instead of recent()
// re-sorting the full ring 3x (once each for paths/skills/agents).
function recent(sortedEvents, kind, project, cap) {
  const seen = new Set();
  const out = [];
  for (const e of sortedEvents) {
    if (e.kind !== kind) continue;
    const v = project(e);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

// Map a sessionScope() result to a single zone token for the divergence heuristic.
// Prod/protected activity (env==='prod') surfaces as the 'prod' token - a zone the
// divergence high-branch recognizes - so frozen/prod drift actually fires; otherwise
// the most-touched zone name (a dev zone, which the high-branch ignores).
export function scopeZone(scope) {
  const zones = scope?.zones ?? [];
  if (zones.some(z => z && z.env === 'prod')) return 'prod';
  return zones[0]?.zone ?? null;
}

export function inferObserved(events = [], { zone = null, stage = null, ts = 0 } = {}) {
  if (!events.length) return null;
  // glmps-100: sort the ring ONCE here, then bucket per category (recent() no
  // longer re-sorts the full ring once per activePaths/activeSkills/activeAgents).
  const sorted = [...events].sort((a, b) => tsVal(b.ts) - tsVal(a.ts)); // newest first
  return {
    activePaths:  recent(sorted, 'file-edit', e => e.path, 6),
    activeSkills: recent(sorted, 'skill', e => e.label, 8),
    activeAgents: recent(sorted, 'agent', e => (typeof e.label === 'string' ? e.label.split(':')[0].trim() : null), 6),
    zone,
    stage,
    ts,
  };
}
