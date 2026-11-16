// web/evaluation/registry-state.js
//
// Pure native-status to unified-4-state-lifecycle mapper for the Capability
// Registry view (glmps-138 Task 1). No DOM, no I/O - importable identically
// under node:test (server/test/registry-state.test.js) and in the browser.
// Fail-open: an unrecognized `type` or `status` NEVER throws, it falls back
// to state:'proposed' with the raw status echoed as subLabel so an operator
// can still see what actually came back instead of silently disappearing.
//
// mapToLifecycle({ type, status, retireCandidate }) -> { kind, state, subLabel } | null
//   kind:    passthrough of the input `type` (whatever string was given).
//   state:   'proposed' | 'active' | 'deprecated' | 'retired'
//   subLabel: the native status string, verbatim, for display.
//   retireCandidate: true (guard/skill kinds only) forces state to
//     'deprecated' regardless of the underlying status - a guard-retire.js /
//     skill-retire.js candidate riding on an otherwise-active row. Per the
//     design spec's "key unification": the candidate is NOT a separate
//     registry row, it's this row's own deprecated-state + inline action.
//   Returns null for a row whose native status means "this never became, or
//   is no longer, a real capability" (guard 'discarded', skill 'rejected')
//   so the caller should drop these rows entirely, not render them.

const GUARD_STATE = {
  pending: 'proposed',
  dispatched: 'proposed',
  applied: 'active',
  retired: 'retired',
};
// failed/skipped are treated the same as discarded (dropped from the
// registry / terminal, never a real capability) - consistent with
// system-changes.js's GUARD_STATUS, which maps both discarded and failed to
// 'reverted' (glmps-138 I7 fix). Without this, a guard whose apply attempt
// permanently failed fell through to the fail-open default state:'proposed',
// implying it was still awaiting action.
// 'covered' (glmps-2-0-82) is a detection of a guard line that already
// existed, not a learned capability, so it is dropped too.
const GUARD_DROPPED = new Set(['discarded', 'failed', 'skipped', 'covered']);

// skill-adopt-store.js's 7-state vocab (discovered..rejected) plus the two
// "installed inventory" statuses ('installed', 'archived') that live outside
// that state machine (skills-view.js / a future human-executed archive
// action) but still need a registry mapping per the design spec's table.
const SKILL_STATE = {
  discovered: 'proposed',
  quarantined: 'proposed',
  'pending-approval': 'proposed',
  approved: 'proposed',
  trialing: 'proposed',
  kept: 'active',
  installed: 'active',
  archived: 'retired',
};
const SKILL_DROPPED = new Set(['rejected']);

// glmps-155/156 completed memory's lifecycle. It used to stop at 'written'
// (adopt only), which is why memory was the one capability kind with no
// retire path: usage telemetry now supplies the measure stage, and eviction
// supplies the retire one.
const MEMORY_STATE = {
  proposal: 'proposed',
  written: 'active',
  evicted: 'retired',
};

const CROSS_AGENT_MEMORY_STATE = {
  quarantined: 'proposed',
  trialing: 'proposed',
  kept: 'active',
  retired: 'retired',
};
const CROSS_AGENT_MEMORY_DROPPED = new Set(['rejected']);

const TABLES = {
  guard: { table: GUARD_STATE, dropped: GUARD_DROPPED, retireCandidateEligible: true },
  skill: { table: SKILL_STATE, dropped: SKILL_DROPPED, retireCandidateEligible: true },
  // retireCandidateEligible flipped true (glmps-155): an eviction plan entry
  // is a genuine, evidence-backed retire candidate, the same shape guard-retire
  // and skill-retire already produce.
  memory: { table: MEMORY_STATE, dropped: null, retireCandidateEligible: true },
  'cross-agent-memory': { table: CROSS_AGENT_MEMORY_STATE, dropped: CROSS_AGENT_MEMORY_DROPPED, retireCandidateEligible: false },
};

export function mapToLifecycle(row) {
  const type = row?.type;
  const status = row?.status;
  const entry = TABLES[type];

  if (entry?.dropped?.has(status)) return null;

  let state = entry?.table?.[status] ?? 'proposed'; // fail-open default
  if (entry?.retireCandidateEligible && row?.retireCandidate === true) {
    state = 'deprecated';
  }

  return { kind: type, state, subLabel: status };
}
