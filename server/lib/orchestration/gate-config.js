// server/lib/orchestration/gate-config.js
// Pure config resolution for approval gates (glmps-29).
//
// Lives here, not in the hook, because BOTH sides need it: the PreToolUse hook
// decides whether to gate and how long to wait, and the server quotes the same
// wait back to the operator in chat. This repo's convention is pure, tested core
// under server/lib with a thin wrapper in hooks/ (see live-install-guard), and a
// server/ -> hooks/ import would invert that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, resolved the same way server.js's CLI entry resolves its own
// configFile, so both land on the same config.json.
export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// How long a gate waits before giving up, in HOURS. Default 12h: an approval
// gate should wait as long as a person plausibly takes, not as long as some
// unrelated default happened to allow.
const DEFAULT_WAIT_HOURS = 12;

/**
 * Gate config (`control.gates`). Absent, unreadable or malformed = OFF, so a
 * broken config can never silently arm a gate that stalls tool calls.
 *
 * Read from the REPO-ROOT config.json: the same file the server reads. One
 * product, one config file. An earlier version read `<stateDir>/config.json`
 * instead, so an operator following the setup docs could edit one file while the
 * hook read the other and the feature stayed silently off. The repo-root file is
 * gitignored, so naming private or prod paths in it never reaches the public
 * mirror.
 *
 * `<stateDir>/config.json` still WINS when present: that is the GLMPS_* isolation
 * pattern used throughout this codebase, and it is what lets a test point the
 * hook at a scratch config without touching the real one.
 *
 * Gated paths are the config's `prodRoots` (the same declaration
 * hooks/done-gate.js readProdRoots consumes, from this same file) PLUS anything
 * in `control.gates.paths`. Making the operator re-list prod roots would put one
 * fact twice in one file. `prodRoots` alone never enable gates: that would arm
 * the feature for anyone who declared prod roots for done-gate or zones, and
 * default-off is the promise.
 */
export function gateConfig({ repoRoot = REPO_ROOT, stateDir } = {}) {
  const readFile = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
  };
  const stateCfg = stateDir ? readFile(path.join(stateDir, 'config.json')) : null;
  const repoCfg = readFile(path.join(repoRoot, 'config.json'));
  const gates = stateCfg?.control?.gates ?? repoCfg?.control?.gates ?? null;

  // prodRoots always come from the repo-root config: they describe the MACHINE,
  // not whichever file happened to switch gates on.
  const prodRoots = Array.isArray(repoCfg?.prodRoots) ? repoCfg.prodRoots.filter(r => typeof r === 'string' && r) : [];
  const extra = Array.isArray(gates?.paths) ? gates.paths.filter(r => typeof r === 'string' && r) : [];
  return {
    enabled: !!gates?.enabled,
    paths: [...new Set([...prodRoots, ...extra])],
    includeBash: !!gates?.includeBash,
    waitHours: Number(gates?.waitHours) > 0 ? Number(gates.waitHours) : undefined,
  };
}

/**
 * Why the wait is bounded at all, when a real approval gate ought to wait
 * forever: MEASURED 2026-07-29, a PreToolUse hook that exceeds its configured
 * `timeout` is CANCELLED AND THE TOOL RUNS ANYWAY. (A probe hook wrote a
 * sentinel on entry, was killed before its completion line, and the Glob it
 * guarded still returned its result.) So the cliff at the hook timeout is
 * FAIL-OPEN: blocking past it converts the gate into a long delay followed by
 * exactly the unreviewed write it existed to prevent.
 *
 * The deny is therefore a BACKSTOP against that cliff, not a policy about how
 * long approval may take. Set `waitHours` as high as you like and give the hook
 * entry in settings.json a `timeout` comfortably above it; this returns a real
 * decision just before the harness would stop asking.
 *
 * A zero or negative value falls back to the default rather than being honoured:
 * a zero deadline denies instantly, which silently turns every gate into a
 * refusal, and refusing is the one behaviour nobody would configure on purpose.
 */
export function gateDeadlineMs(cfg) {
  const h = Number(cfg?.waitHours);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_WAIT_HOURS) * 3600_000;
}

/** Human phrasing for the wait, so the room message and the denial agree. */
export function describeWait(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}
