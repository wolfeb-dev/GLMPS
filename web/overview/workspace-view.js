// web/overview/workspace-view.js
// Pure data-shaping for the workspace panel. No DOM access here (importable
// under Node for tests); the DOM build lives in web/surface/panels.js's
// observed panel (workspaceSummary) and web/shared/roster.js's fleet
// drift chip (fleetDriftCount), which call this.
export function workspaceSummary(ws) {
  if (!ws) return { goal: '', lines: [], drift: 'none', paths: [] };
  const d = ws.declared ?? {};
  const lines = [];
  for (const k of ['hypothesis', 'nextStep', 'blockedOn']) {
    if (d[k]) lines.push({ k, v: String(d[k]) });
  }
  return {
    goal: d.goal ? String(d.goal) : '',
    lines,
    drift: ws.divergence?.level ?? 'none',
    paths: (ws.observed?.activePaths ?? []).slice(0, 6),
  };
}

export function isEmptyWorkspaceSummary(summary) {
  return !summary.goal && summary.lines.length === 0 && summary.paths.length === 0 && summary.drift === 'none';
}

export function fleetDriftCount(list) {
  return (list ?? []).filter(x => x.divergence && x.divergence.level && x.divergence.level !== 'none').length;
}
