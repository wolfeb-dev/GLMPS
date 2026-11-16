// server/lib/evaluation/agent-retire.js
// Pure: propose ARCHIVE candidates for installed agents never dispatched
// across a long observation window. Mirrors skill-retire.js in structure and
// guarantees: pure, propose-only, fail-open on missing evidence. There is no
// filesystem-mutation code path in this module at all, so it cannot delete an
// agent definition; a human decides.
//
// 180 days, for skill-retire.js's reason: dispatchCount is all-time
// cumulative, so 0 means "never dispatched since logging began", not "unused
// for N days". The window spans two full quarters so a quarterly-cadence
// agent is not flagged the day before its next legitimate use.

const MS_PER_DAY = 86400000;
export const DEFAULT_MIN_OBSERVATION_DAYS = 180;

/**
 * @param {Array<{name,source,dispatchCount,lastUsed}>} agents  /api/agents rows
 * @param {Record<string, number>} observedSince
 * @param {string[]} [exempt]  config.json agentLifecycle.exempt
 * @param {{ now?: number, minObservationDays?: number }} [opts]
 */
export function agentRetireCandidates(agents = [], observedSince = {}, exempt = [], opts = {}) {
  const now = opts.now ?? Date.now();
  const minDays = opts.minObservationDays ?? DEFAULT_MIN_OBSERVATION_DAYS;
  const exemptSet = new Set(exempt ?? []);
  const out = [];
  for (const a of agents) {
    const name = a?.name;
    if (!name) continue;
    if (exemptSet.has(name)) continue;                  // honored BEFORE the window check
    if ((a.dispatchCount ?? 0) > 0) continue;
    const firstSeen = observedSince[name];
    if (firstSeen == null) continue;                    // never watched: fail open, propose nothing
    const observedDays = (now - firstSeen) / MS_PER_DAY;
    if (observedDays < minDays) continue;
    out.push({
      id: `agent-retire:${name}`,
      kind: 'agent-retire',
      title: `Agent retire candidate: ${name}`,
      detail: `Never dispatched in ${Math.floor(observedDays)} days of observation.`,
      evidence: { sessionId: null, ref: name },
      metric: { dispatchCount: 0, observedDays: Math.floor(observedDays), source: a.source ?? null },
    });
  }
  return out;
}
