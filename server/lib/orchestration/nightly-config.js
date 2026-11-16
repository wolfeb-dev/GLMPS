// server/lib/orchestration/nightly-config.js
//
// Config resolution + kill switch for the nightly autonomous run (handoff Part
// A). Mirrors gate-config.js's shape: a pure defaults-merge function plus one
// small filesystem check, no class, no singleton, no I/O in nightlyConfig
// itself.
import fs from 'node:fs';
import path from 'node:path';

/**
 * `nightlyConfig(cfg) -> { enabled, hour, repoAllowlist, budget, maxItems,
 * killFile, target }`. Defaults are the safest possible starting point: OFF,
 * with no repo it may touch and no budget cap configured (a null budget means
 * unbounded, so an operator who wants a cap must say so; the allowlist, by
 * contrast, defaults to empty and empty means DENY, not unbounded - see
 * checkGuardrails in nightly-run.js for why that asymmetry is deliberate).
 */
export function nightlyConfig(cfg) {
  const n = (cfg && typeof cfg === 'object' && cfg.nightly && typeof cfg.nightly === 'object') ? cfg.nightly : {};
  const b = (n.budget && typeof n.budget === 'object') ? n.budget : {};
  return {
    enabled: n.enabled === true,
    hour: Number.isFinite(n.hour) ? n.hour : 22,
    repoAllowlist: Array.isArray(n.repoAllowlist)
      ? n.repoAllowlist.filter((r) => typeof r === 'string' && r.trim())
      : [],
    budget: {
      maxUsd: Number.isFinite(b.maxUsd) ? b.maxUsd : null,
      maxTokens: Number.isFinite(b.maxTokens) ? b.maxTokens : null,
    },
    maxItems: Number.isFinite(n.maxItems) && n.maxItems > 0 ? Math.floor(n.maxItems) : 1,
    killFile: typeof n.killFile === 'string' && n.killFile.trim() ? n.killFile.trim() : 'nightly.kill',
    target: typeof n.target === 'string' && n.target.trim() ? n.target.trim() : 'native-terminal',
  };
}

/**
 * True when the nightly run must not proceed: either the config says so
 * (`enabled:false`, no I/O needed to know that) or an operator has dropped
 * the kill file at `<stateDir>/nightly/<killFile>`. The file check is a
 * deliberate escape hatch that needs no config edit and no server restart:
 * touch one file on disk to stop tonight's run.
 *
 * A missing/undefined stateDir (a caller that has not resolved one yet) is
 * not an error here: there is simply nothing on disk to check, so the file
 * half of the switch reads as not-engaged while the config half still
 * applies.
 */
export function killSwitchEngaged(stateDir, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return true;
  if (!stateDir) return false;
  const killFile = typeof cfg.killFile === 'string' && cfg.killFile.trim() ? cfg.killFile.trim() : 'nightly.kill';
  const file = path.join(stateDir, 'nightly', killFile);
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}
