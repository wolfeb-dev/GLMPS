// server/lib/evaluation/skill-lifecycle-config.js
// Config resolution for the glmps-88 scheduled skill-lifecycle routine.
// Mirrors memory-distill-config.js's DEFAULTS-merge shape exactly.
//
// `enabled` (archive-scan) defaults ON: it is cheap, local, no network - the
// same "propose-only, no untrusted content" risk tier as guard-retire.js's
// existing retire-candidates route. `checkUpdates` defaults OFF: it is a NEW
// network-egress surface (the agent-poisoning doc's "lethal trifecta"
// concern: untrusted content + an egress channel), so it must be an explicit
// operator opt-in, never on by default.
export const DEFAULTS = Object.freeze({
  enabled: true,
  minObservationDays: 180,
  exempt: [],
  checkUpdates: false,
  tickMs: 86400000, // daily; far slower than the 60s/5s hot-loop timers already in server.js
});

export function getSkillLifecycleConfig(configJson) {
  const o = (configJson && typeof configJson === 'object' && configJson.skillLifecycle
    && typeof configJson.skillLifecycle === 'object') ? configJson.skillLifecycle : {};
  return { ...DEFAULTS, ...o };
}
