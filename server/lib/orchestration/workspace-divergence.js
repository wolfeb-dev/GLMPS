// server/lib/orchestration/workspace-divergence.js
// Pure, zero-dep. v1 heuristic compare of declared intent vs observed
// behavior. The LLM judge is a later, off-critical-path enhancement.
const STOP = new Set(['the','a','an','and','or','to','of','in','on','for','with','implement','add','fix','build','port','into','this','that','via']);
const FROZEN_ZONES = new Set(['frozen', 'prod', 'live', 'secret']);

function tokens(s) {
  return String(s ?? '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(t => !STOP.has(t)) ?? [];
}

export function computeDivergence(declared, observed) {
  if (!declared || !observed) return null;
  const reasons = [];
  const ts = Math.max(declared.ts ?? 0, observed.ts ?? 0);

  // High: observed activity entered a frozen/prod zone the goal never named.
  if (observed.zone && FROZEN_ZONES.has(String(observed.zone).toLowerCase())) {
    const goalTokens = new Set(tokens(declared.goal));
    if (!goalTokens.has(String(observed.zone).toLowerCase())) {
      reasons.push(`edits entered ${observed.zone} zone but goal "${declared.goal}" did not name it`);
      return { level: 'high', reasons, ts };
    }
  }

  // Low: declared goal shares no salient token with any observed path.
  const goalTokens = tokens(declared.goal);
  const pathTokens = new Set((observed.activePaths ?? []).flatMap(p => tokens(p)));
  const overlap = goalTokens.some(t => pathTokens.has(t));
  if (goalTokens.length && (observed.activePaths ?? []).length && !overlap) {
    reasons.push(`goal "${declared.goal}" shares no term with edited paths (${(observed.activePaths ?? []).join(', ')})`);
    return { level: 'low', reasons, ts };
  }

  return { level: 'none', reasons, ts };
}
