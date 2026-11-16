// server/lib/governance/scope-guard.js
// Pure decision function: should a Stop be blocked because of protected-zone edits?
// No fs/git/process - zero runtime deps beyond zones.js.
import { sessionScope, DEFAULT_ZONE_CONFIG } from '../zones.js';

/**
 * Decide whether a Stop should be blocked based on edited protected paths.
 *
 * @param {object} opts
 * @param {string[]}  opts.changedPaths   - Absolute paths of edited files from git status.
 * @param {string}    opts.projectRoot    - Project root for relative-path classification.
 * @param {object}    [opts.config]       - Zone config (defaults to DEFAULT_ZONE_CONFIG).
 * @param {*}         [opts.override]     - Truthy = skip the block (GLMPS_ALLOW_PROD=1 or GLMPS_DONE_GATE=off in the hook env).
 * @param {object|null} opts.contract     - Parsed acceptance.md contract (null = repo not opted in).
 *
 * @returns {{ action: 'allow'|'block', reason: string, protectedCount: number, protected: {path,zone}[] }}
 */
export function decideScopeGuard({
  changedPaths = [],
  projectRoot,
  config = DEFAULT_ZONE_CONFIG,
  override,
  contract,
}) {
  // Gate only repos that have opted into the done-gate via acceptance.md.
  // This limits blast radius to repos that have explicitly set up acceptance checks.
  if (!contract) {
    return { action: 'allow', reason: '', protectedCount: 0, protected: [] };
  }

  // An explicit override (GLMPS_ALLOW_PROD=1 or GLMPS_DONE_GATE=off in the hook env) bypasses the guard.
  if (override) {
    return {
      action: 'allow',
      reason: 'scope-guard: GLMPS_ALLOW_PROD override active',
      protectedCount: 0,
      protected: [],
    };
  }

  const scope = sessionScope(changedPaths, { projectRoot, config });

  if (scope.protected.length === 0) {
    return { action: 'allow', reason: '', protectedCount: 0, protected: scope.protected };
  }

  const n = scope.protected.length;
  const zones = [...new Set(scope.protected.map(p => p.zone))].join(', ');
  const files = scope.protected.map(p => p.path).join(', ');
  const reason =
    `scope-guard: blocked - ${n} protected (${zones}) file(s) edited: ${files}. ` +
    `Revert them, or have the operator set GLMPS_ALLOW_PROD=1 (or GLMPS_DONE_GATE=off) in the hook environment.`;

  return {
    action: 'block',
    reason,
    protectedCount: n,
    protected: scope.protected,
  };
}
