// server/lib/observability/spine.js
//
// Typed platform events on the existing event spine.
//
// GLMPS has exactly one durable append-only event ledger
// (<stateDir>/events/log.ndjson, written by event-log.js and fed by
// server.js's pushEvents). Everything captured from a session lands there.
// The platform-autonomy layer (nightly runs, lesson
// lifecycle, promotion gates, autonomy telemetry) needs to record events that
// are NOT session capture: they have no sessionId, they are produced by the
// server or by an autonomous runner, and they are typed rather than free-form.
//
// Rather than open an eighth parallel ledger, those events go into the SAME
// spine, distinguished by three things:
//   1. `kind` is one of the closed SPINE_KINDS set (dotted, e.g. 'run.started')
//   2. `lane` is 'spine'
//   3. `sessionId` is null
//
// That is safe against every existing reader, which was verified before this
// module was written: server.js's readEvents call sites either filter
// kind==='skill' or pass a concrete sessionId, and memory-usage-store.js
// filters kind==='memory'. No SPINE_KIND equals 'skill' or 'memory', and a
// test in spine.test.js pins that invariant so a future kind cannot silently
// break those consumers.
//
// `kind` in this codebase is otherwise entirely unschematized (~35 free-form
// strings across the adapters, no enum anywhere). SPINE_KINDS is the schema for
// the typed subset: emitSpineEvent throws on anything outside it, so a typo
// fails loudly at the write instead of producing an event nothing will ever
// read.
//
// The envelope carries `actor`, which mirrors what pushEvents already stamps
// on captured events (server.js, glmps-72).
//
// Zero runtime dependencies.
import { appendEvent, readEvents, tsToMs } from './event-log.js';

// The closed set of typed platform event kinds.
export const SPINE_KINDS = Object.freeze({
  // Nightly run (handoff Part A, A2)
  RUN_STARTED: 'run.started',
  RUN_PLANNED: 'run.planned',
  RUN_GATE_RESULT: 'run.gate_result',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',

  // Reviews and reconciliation (Part B)
  REVIEW_COMPLETED: 'review.completed',
  RECONCILIATION_INTEGRITY: 'reconciliation.integrity_finding',

  // Learning integrity (Part A0, A0.5)
  LESSON_CREATED: 'lesson.created',
  LESSON_RECONFIRMED: 'lesson.reconfirmed',
  LESSON_DECAYED: 'lesson.decayed',
  LESSON_INVALIDATED: 'lesson.invalidated',
  ARTIFACT_ORPHANED: 'artifact.orphaned',
  DECISION_RECORDED: 'decision.recorded',
  PROMOTION_REQUESTED: 'promotion.requested',
  PROMOTION_APPROVED: 'promotion.approved',
  PROMOTION_DENIED: 'promotion.denied',
  PROMOTION_REVOKED: 'promotion.revoked',

  // Autonomy telemetry (Part C)
  HUMAN_TOUCH: 'human.touch',

  // The old-cleanup loop, the only actor that deletes agent-renamed .old
  // paths (card glmps-2-0-runtime-127).
  CLEANUP_OLD_DELETED: 'cleanup.old_deleted',
  CLEANUP_OLD_REFUSED: 'cleanup.old_refused',

  // Obligations (GLMPS 2.0 phase K4). Prefixed obligation.* so they never
  // collide with the decision.recorded learning-integrity family.
  OBLIGATION_OPENED: 'obligation.opened',
  OBLIGATION_CLOSED: 'obligation.closed',
  OBLIGATION_EXPIRED: 'obligation.expired',
  OBLIGATION_ESCALATED: 'obligation.escalated',
  // A wall-clock gap the kernel heartbeat read as a host sleep (glmps-2-0-64);
  // the obligation rows it rebased are in the payload.
  HOST_RESUMED: 'host.resumed',

  // Huddle (glmps-2.0 corpus, document 7, spike 1). A huddle is a
  // conversation, not a session capture, so it is typed like the other
  // platform events; its sessionId is 'huddle:<id>' so the spine can show it
  // as a trace without any session index ever matching it.
  HUDDLE_STARTED: 'huddle.started',
  HUDDLE_UTTERANCE: 'huddle.utterance',
  HUDDLE_ENDED: 'huddle.ended',
  HUDDLE_DECISIONS: 'huddle.decisions',
  HUDDLE_METRIC: 'huddle.metric',
  HUDDLE_KICKOFF: 'huddle.kickoff',
});

const KIND_SET = new Set(Object.values(SPINE_KINDS));

export function isSpineKind(kind) {
  return KIND_SET.has(kind);
}

// Append one typed platform event to the spine and return the record written.
// Throws TypeError on an unknown kind - a typo must fail at the write, not
// become an event no reader will ever match.
export function emitSpineEvent(stateDir, {
  kind,
  label = null,
  actor = 'operator',
  sessionId = null,
  payload = {},
  ts,
} = {}) {
  if (!isSpineKind(kind)) {
    throw new TypeError(`unknown spine event kind: ${String(kind)}`);
  }
  const event = {
    kind,
    lane: 'spine',
    label: label ?? kind,
    path: null,
    tool: null,
    ts: ts ?? new Date().toISOString(),
    sessionId,
    actor,
    payload,
  };
  appendEvent(stateDir, event);
  return event;
}

// Read typed platform events back, optionally filtered by kind and
// since (ts). Capture events sharing the ledger are never returned: the
// isSpineKind filter is what keeps this read separate from session capture
// even though both live in one file.
// Kind is narrowed before since: the since check parses every row's ts, and
// spine rows are a small slice of the ledger (glmps-193).
export function readSpineEvents(stateDir, { kind, since } = {}) {
  const sinceMs = since === undefined ? undefined : tsToMs(since);
  return readEvents(stateDir)
    .filter((e) => e && isSpineKind(e.kind))
    .filter((e) => kind === undefined || e.kind === kind)
    .filter((e) => sinceMs === undefined || (tsToMs(e.ts) !== null && tsToMs(e.ts) > sinceMs));
}
