// web/evaluation/agent-rows.js
// Task 10 (glmps-138 agent-routing plan): pure /api/agents rows -> Capability
// Registry rows. Kept out of the DOM layer (registry.js) so it is unit-
// testable under node:test with no browser, mirroring how registry-state.js's
// mapToLifecycle is pure for the same reason.
//
// STATE_ORDER is not extended: agents reuse the existing
// proposed/active/deprecated/retired vocabulary rather than growing a new
// state, so the Capability Registry filter chips need no change.
//
// buildActions is deliberately absent from this module: it is a DOM closure
// (button elements, event wiring) and belongs in registry.js, which is what
// keeps this mapper importable with no `document` at all.

const MODEL_KEYS = ['sonnet', 'haiku', 'opus'];

// Guards an explicitly-null/non-object split, not just the undefined default
// parameter handles: `modelSplit: null` (a plausible /api/agents shape) still
// reaches this body since default params only fire on undefined.
function modelSubLabel(split) {
  const s = split && typeof split === 'object' ? split : {};
  const parts = MODEL_KEYS.filter(k => (s[k] ?? 0) > 0).map(k => `${k} ${s[k]}`);
  return parts.join(', ');
}

// An agent that has never been dispatched has no last-use timestamp at all.
// `lastUsed ?? null` was not enough: `??` does not catch 0, and 0 IS a finite
// number, so capability-row.js's staleInfo() accepted it as a real timestamp
// and rendered every such row as 1970 + "stale". A non-positive epoch is not a
// last-use observation; it is the absence of one.
function lastUsedOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * @param {Array<{name,source,dispatchCount,lastUsed,modelSplit}>} agents  GET /api/agents rows
 * @param {Array<object>} measurables  GET /api/measurables rows, filtered here for kind:'agent-retire'
 * @returns {Array<object>} unified Capability Registry rows, kind:'agent'
 */
export function agentRows(agents = [], measurables = []) {
  const retireByName = new Map();
  for (const m of measurables) {
    if (m?.kind === 'agent-retire' && m.evidence?.ref) retireByName.set(m.evidence.ref, m);
  }
  // Fail-open per registry-state.js's documented contract (registry-state.js:6-8):
  // a malformed entry (null/undefined/non-object/no name) is skipped, not
  // thrown on, mirroring every sibling builder's guard in registry.js
  // (buildGuardRows/buildSkillRows/buildMemoryRows/buildCrossAgentRows all
  // `continue` past a malformed item before reading its fields). rows[] in
  // renderRegistry() is assembled with no surrounding try/catch, so an
  // unguarded throw here would take down every kind's rows, not just agent's.
  return agents
    .filter(a => a && typeof a === 'object' && a.name)
    .map((a) => {
      const cand = retireByName.get(a.name);
      const approved = (cand?.labels ?? []).some(l => l?.decision === 'approve');
      let state = 'proposed';
      if ((a.dispatchCount ?? 0) > 0) state = 'active';
      if (cand) state = approved ? 'retired' : 'deprecated';
      return {
        kind: 'agent',
        id: `agent:${a.name}`,
        name: a.name,
        state,
        subLabel: modelSubLabel(a.modelSplit),
        provenance: a.source ?? 'unknown',
        lastUsedTs: lastUsedOrNull(a.lastUsed),
        detail: `${a.dispatchCount ?? 0} dispatches`,
        tier: 'free',
        // `retireCandidate` is consumed by registry.js's buildAgentRows, which
        // wires it into buildRetireLabelActions so a deprecated agent row can be
        // approved/rejected/pruned like every other kind's.
        retireCandidate: cand ?? null,
      };
    });
}
