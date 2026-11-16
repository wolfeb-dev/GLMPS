// server/lib/evaluation/measurable-persist.js
// Pure mappers: shape a guard/skill retire candidate or a workspace-
// divergence signal into a measurables-store.js upsertMeasurable() payload.
// No I/O here - callers (server.js) do the store read/write; kept pure so
// the mapping is testable without a filesystem.
export function measurableFromGuardCandidate(cand, ts) {
  return {
    id: `guard-retire:${cand.code}`,
    kind: 'guard-retire',
    title: `Guard retire candidate: ${cand.code}`,
    detail: cand.reason,
    evidence: { sessionId: null, ref: cand.code },
    metric: { n: cand.n },
    ts,
  };
}

export function measurableFromSkillCandidate(cand, ts) {
  return {
    id: `skill-retire:${cand.id}`,
    kind: 'skill-retire',
    title: `Skill archive candidate: ${cand.name}`,
    detail: cand.reason,
    evidence: { sessionId: null, ref: cand.id },
    metric: { observedDays: cand.observedDays },
    ts,
  };
}

export function measurableFromWorkspaceSignal(wsSig) {
  return {
    id: `workspace-divergence:${wsSig.sessionId}::${wsSig.detail}`,
    kind: 'workspace-divergence',
    title: 'Workspace divergence: declared goal diverging from observed work',
    detail: wsSig.detail,
    evidence: { sessionId: wsSig.sessionId, ref: null },
    metric: null,
    ts: wsSig.ts,
  };
}
