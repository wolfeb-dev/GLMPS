// server/lib/evaluation/routing-compliance.js
// Pure: did a routed card's session actually dispatch the agent the runner
// named? The card -> session bridge is the worktree directory, which the
// runner names after the job id (server.js:4911 documents why the runtime
// session id is not known at launch). A routed card with no worktree is
// reported as `unmeasurable`, never silently as a miss.
//
// norm() strips path separators and a trailing slash, not just case, before
// comparing a ledger worktree `dir` (built with node:path's path.join, so
// native separators) against a session `cwd` (whatever the launched process
// itself reported). worktree-project.js hit this exact cwd-vs-worktree-path
// comparison first (server/lib/orchestration/worktree-project.js) and its own
// norm() does the same backslash-to-forward-slash + trailing-slash strip,
// because a session's cwd can be a Windows path even when the code comparing
// it runs on a POSIX CI host -- so, matching that precedent, this stays
// string/regex only rather than reaching for node:path (whose behavior is
// itself platform-dependent, which would defeat the purpose). Lowercasing
// last is a deliberate false-negative bias: NTFS is case-preserving but
// case-insensitive, so two spellings of the same Windows path must still
// bridge; the cost is a false POSITIVE on two genuinely distinct
// case-sensitive Linux paths differing only in case, which the runner's own
// job-id-derived worktree names never produce.

const norm = (s) => String(s ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();

// A worktree directory is named after the job id (worktrees.js worktreePlan),
// so a RETRIED job reuses the same directory across several sessions -- one
// failed attempt, then a retry that may dispatch differently. `sessions` is
// not guaranteed to arrive newest-first (the caller's sort order is not this
// module's contract to depend on, and IndexStore.list() -- newest-first --
// is only one possible caller), so the bridge below compares `lastTs`
// explicitly rather than trusting "last one wins" on the input array. A
// session with no real `lastTs` never displaces one that has one: an
// unindexed/timestamp-less record is not evidence of being more recent.
//
// `lastTs` arrives in BOTH shapes and both are real. IndexStore.applyEvents
// assigns `rec.lastTs = e.ts`, and a Claude Code transcript's timestamp is an
// ISO-8601 string, so a session whose last poll ingested events carries a
// STRING lastTs; a session record whose lastTs came from a file mtime carries a
// number. Treating the string as absent (plain Number.isFinite) inverted this
// comparison against real data: the LIVE retry session (string) could never
// displace an idle earlier attempt (number), which is exactly the downward bias
// on the compliance metric this tie-break exists to prevent.
function epochMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}

function isNewerSession(candidate, current) {
  const cTs = epochMs(candidate?.lastTs);
  const bTs = epochMs(current?.lastTs);
  if (cTs === null) return false;
  if (bTs === null) return true;
  return cTs > bTs;
}

// glmps-2-0-185: the ROUTING line lets a card work inline on a one- or
// two-file change if it says so in a "Routing note:" devlog line. 44 of 70
// skips measured on 2026-11-13 were such stated calls, which the bare
// complied/routed ratio scored as misses. `explained` counts them separately so
// a real miss (no agent, no reason) stays visible; `complied` is unchanged.
// Matched anywhere, not only at line start: notes written before the prompt
// asked for their own line sit mid-paragraph ("No decision needed. Routing
// note: ...") and are just as much a stated call.
const ROUTING_NOTE = /\bRouting note:/i;

export function computeRoutingCompliance({ ledger = {}, sessions = [], threshold = 0.6, decisionDate = null, notes = {} } = {}) {
  const byDir = new Map();
  for (const s of sessions) {
    if (!s?.cwd) continue;
    const key = norm(s.cwd);
    const current = byDir.get(key);
    if (!current || isNewerSession(s, current)) byDir.set(key, s);
  }
  // byClass answers "is routing working". byAgent answers "is this particular
  // agent earning its place", which is the question a deliberately static
  // roster has to keep answering, and it is the denominator the Capability
  // Registry's lifetime dispatchCount has never had.
  const out = { routed: 0, complied: 0, explained: 0, unmeasurable: 0, byClass: {}, byAgent: {}, threshold, decisionDate };
  for (const [cardId, entry] of Object.entries(ledger ?? {})) {
    const route = entry?.route;
    if (!route?.agent) continue;
    out.routed += 1;
    const cls = route.taskClass ?? 'unknown';
    const slot = out.byClass[cls] ?? (out.byClass[cls] = { routed: 0, complied: 0 });
    slot.routed += 1;
    const aSlot = out.byAgent[route.agent] ?? (out.byAgent[route.agent] = { routed: 0, complied: 0 });
    aSlot.routed += 1;
    const dir = entry?.worktree?.dir;
    const session = dir ? byDir.get(norm(dir)) : null;
    if (!session) { out.unmeasurable += 1; continue; }
    const used = Array.isArray(session.agentsUsed) ? session.agentsUsed : [];
    if (used.some(a => norm(a?.name) === norm(route.agent))) { out.complied += 1; slot.complied += 1; aSlot.complied += 1; continue; }
    const texts = Array.isArray(notes?.[cardId]) ? notes[cardId] : [];
    if (texts.some(t => typeof t === 'string' && ROUTING_NOTE.test(t))) out.explained += 1;
  }
  return out;
}
