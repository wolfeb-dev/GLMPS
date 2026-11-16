// server/lib/evaluation/measurables-scoreboard.js
// Pure aggregate rollup over Measurable[] (measurables-store.js's shape).
// Read by GET /api/measurables and the /api/state?session= `fitness` field.
// A measurable's current decision is its LATEST label (labels is an
// append-only history) - an empty labels array means "unlabeled", never
// invented as reject/approve. northStar mirrors system-changes.js's own
// honesty convention: null until a historical rollup source is wired.
function latestDecision(m) {
  const labels = Array.isArray(m?.labels) ? m.labels : [];
  return labels.length ? labels[labels.length - 1].decision : null;
}

export function buildMeasurablesScoreboard(measurables) {
  const list = Array.isArray(measurables) ? measurables : [];
  const byKind = {};
  let approved = 0, rejected = 0, pruned = 0, unlabeled = 0;
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const kind = m.kind ?? 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const d = latestDecision(m);
    if (d === 'approve') approved++;
    else if (d === 'reject') rejected++;
    else if (d === 'prune') pruned++;
    else unlabeled++;
  }
  return { tracked: list.length, byKind, approved, rejected, pruned, unlabeled, northStar: null };
}
