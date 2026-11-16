// web/surface/summary.js
// The Alerts dock's model. The grouping itself is the server's (GET /api/alerts
// `attention`, server/lib/observability/alert-groups.js), the same object the
// Slack alert digest posts; this only resolves its ids to the alerts in the
// same response. No DOM here.

// The criticals (newest first), then the warning groups and how many alerts
// they fold. `gone` holds ids acknowledged here whose refetch has not landed.
export function attentionModel(body, gone = new Set()) {
  const byId = new Map((body?.alerts ?? []).map((a) => [a.id, a]));
  const pick = (ids) => (ids ?? []).filter((id) => !gone.has(id) && byId.has(id)).map((id) => byId.get(id));
  const critical = pick(body?.attention?.critical);
  const groups = (body?.attention?.groups ?? [])
    .map((g) => { const alerts = pick(g.ids); return { key: g.key, source: g.source, label: g.label, count: alerts.length, alerts }; })
    .filter((g) => g.count > 0);
  const warned = groups.reduce((n, g) => n + g.count, 0);
  return { top: critical[0] ?? null, critical, criticalCount: critical.length, warningGroups: groups.length, warningTotal: warned, groups };
}

export function warningsWord({ warningGroups, warningTotal }) {
  if (!warningTotal) return 'No warnings';
  const n = `${warningGroups} warning${warningGroups === 1 ? '' : 's'}`;
  return warningGroups === warningTotal ? n : `${n}, grouped from ${warningTotal}`;
}
