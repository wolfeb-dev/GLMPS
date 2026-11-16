// server/lib/observability/alert-learn.js
// Alert -> learning-loop adapter: a code map, not rule-synth (alerts don't
// carry a prompt corpus for rule-synth to mine, see capability-audit's rule
// synthesis for that path). Maps the LEARNABLE subset of dashboard alerts
// (server/lib/observability/alerts.js canonical Alert shape) into the SAME
// gap shape server/lib/observability/gap-detect.js already produces, so the
// existing learning-store / shadow-arm pipeline can consume alert-derived
// items without a fork.
//
// ALERT_CODE_MAP is deliberately EXTENSIBLE (source -> gap code) but wired
// with only ONE entry today: egress -> egress. Every other alert source
// (unmerged-branch, injection, poison, capture, attestation) is intentionally
// left unmapped - informational or too false-positive-prone to turn into a
// standing behavioral guard automatically. An alert whose source has no
// entry here produces no gap/guard at all.
//
// The mapped `code` is the SAME string used end-to-end: the gap code here,
// shadow-arm.js's taskClass bucket, guard-retire.js's counterfactual join,
// and system-changes.js's shadow join all key off this one string - that is
// what lets an alert-derived guard's measuredEffect / retirement flow
// through the existing machinery untouched. Guard proposer cutover (Task
// 10): learning-templates.js's TEMPLATES map (which used to seed a matching
// 'egress' entry's rule text automatically) is deleted - proposing the rule
// text for an alert-derived gap is now the GEPA plugin's job, same as for
// any other gap code.
export const ALERT_CODE_MAP = new Map([
  ['egress', 'egress'],
]);

/** Whether an alert `source` currently maps to a learnable gap code. */
export function isLearnableAlertSource(source) {
  return ALERT_CODE_MAP.has(source);
}

/**
 * @param {Array} alerts  canonical Alert[] (server/lib/observability/alerts.js
 *   normalizeAlert/rankAlerts/dedupAlerts shape: { id, source, severity, title,
 *   detail, target, ts, acknowledged })
 * @returns {Array<{ alertId: string, gap: {code, severity, message}, ctx: {project, sessionId} }>}
 *   one entry per learnable alert, ready for learningStore.upsertGapInto(gap, ctx).
 */
export function alertsToGaps(alerts) {
  const out = [];
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!a || typeof a !== 'object') continue;
    const code = ALERT_CODE_MAP.get(a.source);
    if (!code) continue;
    const target = a.target && typeof a.target === 'object' ? a.target : null;
    const sessionId = target && target.view === 'sessions' && target.id ? String(target.id) : '';
    out.push({
      alertId: a.id,
      gap: { code, severity: a.severity ?? 'warn', message: a.detail || a.title || code },
      ctx: { project: '', sessionId },
    });
  }
  return out;
}
