// server/lib/observability/reconciliation.js
//
// The reconciliation-monitor registry (handoff B5). This is the piece B5
// assumes exists and this codebase does not otherwise have: neither
// alert-sources.js's collectAlerts nor gap-detect.js's detectGaps is a
// registry today - both are hand-written if-blocks inside one big function.
// CHECKS (integrity-checks.js) is the declarative list this module drives; every
// check is individually toggleable through reconciliationConfig, which is
// what makes per-check attribution possible (the "single-mechanism
// evaluation window" concern the Schmidhuber-survey comparison raised).
//
// Finding field names deliberately match the handoff's B3 event-payload
// table literally (check_name, desk, severity, details) rather than this
// codebase's usual camelCase, because morning-brief.js (already shipped)
// already reads findings in that exact shape: buildBrief's integrity param is
// documented as `[{ check_name, severity, details }]`. Matching an
// already-live consumer beats a blanket style rule.
//
// Zero runtime dependencies.
import { CHECKS, DEFAULT_CHECK_CONFIG } from './integrity-checks.js';
import { emitSpineEvent, SPINE_KINDS } from './spine.js';

export { CHECKS };

// Resolve the full check-registry config from the loaded app config, the
// same "whole config in, fully-defaulted block out" idiom as
// learningIntegrityConfig / nightlyConfig. `cfg.reconciliation.checks.<name>`
// overrides merge onto that check's defaults rather than replacing the
// whole checks map, so disabling one check never silently disables the rest.
export function reconciliationConfig(cfg = {}) {
  const overrides = cfg?.reconciliation ?? {};
  const checkOverrides = overrides.checks ?? {};
  const checks = {};
  for (const name of Object.keys(DEFAULT_CHECK_CONFIG)) {
    checks[name] = { ...DEFAULT_CHECK_CONFIG[name], ...(checkOverrides[name] ?? {}) };
  }
  return { checks };
}

/**
 * Run every ENABLED check over ctx, emit one reconciliation.integrity_finding spine
 * event per finding (when ctx.stateDir is supplied - emission is skipped,
 * not thrown, when it is absent, matching this module's fail-open posture),
 * and return the full findings array.
 *
 * ctx.config, when supplied, is used as-is (so a caller can pre-resolve it
 * once and reuse it); otherwise it is resolved fresh via reconciliationConfig().
 */
// Render a check's structured details into one readable clause. Kept
// deliberately plain (key=value, comma separated) rather than per-check prose:
// bespoke formatters would drift out of sync with the checks themselves,
// and the structured form is right there in `data` for anything that needs
// more than a glance.
function renderDetails(details) {
  if (details === null || details === undefined) return null;
  if (typeof details === 'string') return details;
  if (typeof details !== 'object') return String(details);
  const parts = [];
  for (const [k, v] of Object.entries(details)) {
    if (v === null || v === undefined) continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.length ? parts.join(', ') : null;
}

export function runReconciliation(ctx = {}) {
  const config = ctx.config ?? reconciliationConfig();
  const runCtx = { ...ctx, config };
  const findings = [];

  for (const check of CHECKS) {
    const checkConfig = config.checks?.[check.name];
    const enabled = checkConfig ? checkConfig.enabled !== false : true;
    if (!enabled) continue;

    const raw = check.run(runCtx) ?? [];
    for (const f of raw) {
      const finding = {
        check_name: check.name,
        desk: f.desk ?? null,
        severity: f.severity ?? check.severity,
        // Checks emit STRUCTURED details, which is right for programmatic
        // consumers. Every renderer (the morning brief) reads
        // `details` as a string, and left unreconciled that puts
        // "[object Object]" in front of the operator. So `details` is the
        // rendered string and `data` keeps the structure - both consumers get
        // what they need, and neither has to know about the other.
        details: renderDetails(f.details),
        data: (f.details !== null && typeof f.details === 'object') ? f.details : null,
      };
      if (ctx.stateDir) {
        emitSpineEvent(ctx.stateDir, {
          kind: SPINE_KINDS.RECONCILIATION_INTEGRITY,
          actor: ctx.actor ?? 'reconciliation-monitor',
          payload: finding,
        });
      }
      findings.push(finding);
    }
  }

  return findings;
}
