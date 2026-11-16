// server/lib/loops/loop-health.js
// Renders the loop registry snapshot as dashboard alerts. Failures only: an
// overdue loop is an expired obligation (source 'obligation', Task 11).
export function loopAlerts(snapshot) {
  const out = [];
  for (const [name, h] of Object.entries(snapshot && typeof snapshot === 'object' ? snapshot : {})) {
    if (!h || !h.consecutiveFailures) continue;
    out.push({
      source: 'loop',
      severity: h.consecutiveFailures >= 3 ? 'critical' : 'warn',
      title: `Loop failing: ${name}`,
      detail: `${h.lastReason || 'failed'} (${h.consecutiveFailures} consecutive)`,
      target: { view: 'loops', loop: name },
      ts: h.lastRunTs ?? 0,
    });
  }
  return out;
}
