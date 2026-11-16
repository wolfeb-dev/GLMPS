// server/lib/observability/capability-feed-core.js
// Pure, testable core for the per-session capability feeder.
// No fs, no process - takes everything as args for unit testability.
import { detectGaps } from './gap-detect.js';
import { scanTranscriptForGaps } from './transcript-gaps.js';
import { scanTranscriptForCorrections } from './correction-signals.js';
import { stateDirNames } from '../state-dir.js';

// Code extensions that count as "code changed" for triggering a graphify refresh.
const CODE_EXT_RE = /\.(js|mjs|cjs|ts|py|cs)$/i;

// Deferral-ticket detection (glmps-75)
//
// The Stop feeder used to fire on ANY text containing loose words like
// "deferred"/"backlog this"/"not now", tested against whatever text happened
// to be last in the transcript (assistant OR relayed tool-result/user
// content). Two real misfires from one orchestration session showed why that
// was too broad:
//   1. An assistant's completed-work recap ("Yes - fully built and on main...
//      Nothing here was deferred or skipped...") - a bare mention of
//      "deferred" in prose describing DONE work, not a real deferral.
//   2. A raw `<task-notification>` block (a relayed async-subagent status,
//      not something the operator/assistant said) that happened to contain
//      ticket/defer-ish words.
//
// The fix is three independent guards, all conservative (fail toward NOT
// filing a ticket):
//   (a) reject harness/system noise outright (isHarnessNoise)
//   (b) require a narrow, first-person deferral phrase (DEFERRAL_RE)
//   (c) suppress entirely when the transcript is orchestration-dominated
//       (isOrchestrationDominated) - a coordinator's "deferrals" are almost
//       always relayed subagent status, not the operator deferring work.

// Harness/system wrapper content that must never be treated as deferral text,
// however it got into `lastText` (e.g. a background subagent's completion
// notification landing after the assistant's real last turn). "Contains" is
// enough to reject the whole candidate - we do not try to salvage a phrase
// found inside a relayed/system block.
const HARNESS_BLOCK_RE = /<task-notification\b|<system-reminder\b|<\/?tool_use\b|<\/?tool_result\b|\btool_use\b|\btool_result\b|Async agent launched|agentId\s*:/i;

// Narrow, first-person deferral phrases only. Deliberately does NOT match a
// bare "ticket"/"backlog"/"later"/"not now" mention - those fire constantly in
// prose that merely *describes* the backlog/ticket system or recaps completed
// work (this is GLMPS; its own docs are full of the words "ticket"
// and "backlog"). Every alternative here requires the assistant to be
// actively announcing a deferral, not discussing one.
const DEFERRAL_RE = /\b(I'?ll (defer|leave|skip|come back)|deferring|will defer|fil(e|ing) (a )?ticket|out of scope for (now|this)|leaving (this|that) for later|not (doing|building) (this|that) now)\b/i;

// Textual/structural signals that a tool_use block or line is a subagent
// dispatch (Task/Agent tool call, or an "Async agent launched"/"agentId:"
// status line for background dispatches that don't show up as a plain
// tool_use in this line).
const ASYNC_MARKER_RE = /Async agent launched|agentId\s*:/i;

// Orchestration-domination thresholds (glmps-75 spec #3). A session is
// treated as a coordinator/orchestration session - and deferral auto-filing
// is suppressed - when subagent-dispatch signals are BOTH at least
// ORCHESTRATION_MIN_DISPATCHES in absolute count AND make up at least
// ORCHESTRATION_DISPATCH_RATIO of the transcript's lines. The ratio guard is
// what makes this "relative to length": the same 5-8 dispatches in a 4,000-line
// transcript should NOT suppress filing, only when they dominate a short one.
const ORCHESTRATION_MIN_DISPATCHES = 5;
const ORCHESTRATION_DISPATCH_RATIO = 0.03; // >=3% of transcript lines are dispatch signals

function isHarnessNoise(text) {
  return HARNESS_BLOCK_RE.test(String(text ?? ''));
}

// Counts subagent-dispatch signals across raw JSONL transcript lines: Task/Agent
// tool_use blocks, plus textual "Async agent launched"/"agentId:" markers for
// background dispatches that aren't captured as a tool_use in this line.
function countOrchestrationSignals(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  let count = 0;
  for (const raw of arr) {
    const line = String(raw ?? '');
    if (!line.trim()) continue;
    if (ASYNC_MARKER_RE.test(line)) { count++; continue; }
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const item of obj.message.content) {
          if (item?.type === 'tool_use' && (item.name === 'Agent' || item.name === 'Task')) count++;
        }
      }
    } catch { /* unparseable line already checked for the textual marker above */ }
  }
  return count;
}

function isOrchestrationDominated(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const total = arr.length;
  if (total === 0) return false;
  const dispatches = countOrchestrationSignals(arr);
  return dispatches >= ORCHESTRATION_MIN_DISPATCHES &&
    (dispatches / total) >= ORCHESTRATION_DISPATCH_RATIO;
}

// Extracts a tighter ticket title from the clause following the deferral verb
// ("I'll defer THE RETRY-BACKOFF REFACTOR to a follow-up session") instead of
// an arbitrary 80-char slice of the whole message. Falls back to the slice
// when no such clause is found (e.g. the "fil(e|ing) a ticket" / "out of scope"
// / "leaving ... for later" alternatives, which don't have a clean "verb + X"
// shape to capture).
function extractDeferralTitle(text) {
  const clause = text.match(/\b(?:I'?ll (?:defer|leave|skip|come back to)|deferring|will defer)\s+(.+?)(?:[.;!\n]|$)/i);
  if (clause && clause[1] && clause[1].trim()) return clause[1].trim().slice(0, 80);
  return text.slice(0, 80);
}

// Dispatched-worktree gap suppression (glmps-97)
//
// Agent(isolation:"worktree") dispatches spin up a SEPARATE Claude Code
// process rooted at .claude/worktrees/<agent-*|lane-*>/ inside the parent
// repo. That child process inherits the same global Stop hook
// (hooks/capability-feed.js -> feedFromTranscript -> detectGaps), which scans
// ONLY the child's own transcript - it has zero visibility into skills the
// ORCHESTRATOR already invoked before dispatching. A dispatched subagent that,
// say, edits UI without itself invoking a UI design skill gets flagged even
// though the parent used the skill (and often briefed the child accordingly).
//
// This is false-positive-prone specifically for gaps that gate on "was a
// skill invoked in THIS transcript" - the parent's skill invocation is
// invisible to the child. It is NOT a problem for gaps that are purely about
// THIS session's own behavior regardless of what the parent did
// (reread-loop): those stay live for dispatched sessions too, and must NOT
// be suppressed here.
//
// The in-process Task tool path is unaffected by any of this: the parent
// process merges the child's events into its OWN transcript/event stream
// before detectGaps ever runs there, so the parent's skill invocations are
// already visible. This suppression only applies to the isolated-worktree
// dispatch path, detected purely from cwd (no flag/env var required - it
// matches whatever on-disk pattern Agent(isolation:"worktree") actually
// creates).

// Matches a cwd under .claude/worktrees/agent-* (background Agent-tool
// dispatches) or .claude/worktrees/lane-* (hand-launched isolated lanes).
// Deliberately does NOT match MC's own queue-runner worktree layout
// (state/runner/worktrees/<project>/<job-id>, see worktree-project.js) - that
// is a different mechanism (glmps-71) with its own session, not a dispatched
// child of an orchestrator that already ran skills in this same transcript.
const DISPATCHED_WORKTREE_RE = /\/\.claude\/worktrees\/(?:agent|lane)-/i;

// Skill-gated gap codes: each one fires because a specific skill wasn't seen
// as invoked IN THIS TRANSCRIPT. Suppressed for dispatched-worktree sessions
// only - everything else from detectGaps/scanTranscriptForGaps stays live.
const SKILL_GATED_GAP_CODES = new Set([
  'ui-without-frontend-design',
  'ui-design-too-late',
  'plan-skipped-on-large-change',
  'done-without-verification',
]);

/**
 * isDispatchedWorktreeCwd(cwd) -> boolean
 * Detects a session whose cwd lives under a `.claude/worktrees/agent-*` or
 * `.claude/worktrees/lane-*` directory - the on-disk layout produced by
 * Agent(isolation:"worktree") dispatches. Platform-independent: normalizes
 * backslashes before testing (same approach as worktree-project.js's `norm`).
 */
export function isDispatchedWorktreeCwd(cwd) {
  const norm = String(cwd ?? '').replace(/\\/g, '/');
  return DISPATCHED_WORKTREE_RE.test(norm);
}

// Either state folder name, so a runner worktree is recognised before and
// after the live folder is renamed.
const RUNNER_WORKTREE_RE = new RegExp(`/(?:${stateDirNames().map(n => n.replace(/[.]/g, '[.]')).join('|')})/runner/worktrees/`);
const CLOSING_REPORT_RE = /^\s*(I approved|I reviewed|I requested changes|# Review of)\b/i;

/**
 * filterDispatchedWorktreeGaps(gaps, cwd) -> object[]
 * Returns `gaps` unchanged unless `cwd` is a dispatched-worktree session, in
 * which case the four skill-gated codes (SKILL_GATED_GAP_CODES) are removed.
 * Exported standalone - not only used inside feedFromTranscript - so
 * server.js's two direct detectGaps(...) call sites (the dashboard gapCount
 * badge and the learning-store upsert loop) can apply the same suppression
 * without going through the whole feedFromTranscript pipeline. NOT wired into
 * server.js by this change; see glmps-97 follow-up.
 */
export function filterDispatchedWorktreeGaps(gaps, cwd) {
  const arr = Array.isArray(gaps) ? gaps : [];
  if (!isDispatchedWorktreeCwd(cwd)) return arr;
  return arr.filter(g => !SKILL_GATED_GAP_CODES.has(g?.code));
}

/**
 * feedFromTranscript({ events, lines, skillsUsed, project, sessionId, lastText, cwd })
 *
 * @param {object[]} events - Shared event shape objects from extractClaudeEvents
 * @param {string[]} lines - Raw JSONL transcript lines (for scanTranscriptForGaps,
 *                                 scanTranscriptForCorrections and the deferral-ticket orchestration-domination check)
 * @param {string[]} skillsUsed - Skills already recorded in the index for this session
 * @param {string}   project - Project name (cwd basename)
 * @param {string}   sessionId - Session identifier
 * @param {string}   lastText - Last assistant/user text block from the transcript
 * @param {string}   cwd - Session cwd (glmps-97: used to suppress skill-gated
 *                                 gap codes for dispatched Agent(isolation:"worktree")
 *                                 sessions - see block comment above)
 *
 * @returns {{ gaps: object[], ticket: ({source, title, prompt, state: 'held'}|null), codeChanged: boolean }}
 */
export function feedFromTranscript({
  events = [],
  lines = [],
  skillsUsed = [],
  project = '',
  sessionId = '',
  lastText = '',
  cwd = '',
} = {}) {
  const fromEvents = detectGaps(events, skillsUsed);
  const fromLines = scanTranscriptForGaps(lines, { project });
  const corrections = scanTranscriptForCorrections(lines);

  const seen = new Set();
  const mergedGaps = [];
  for (const g of [...fromEvents, ...fromLines, ...corrections]) {
    if (seen.has(g.code)) continue;
    seen.add(g.code);
    mergedGaps.push(g);
  }
  const gaps = filterDispatchedWorktreeGaps(mergedGaps, cwd);

  // ticket: conservative - harness-noise reject, then orchestration-domination
  //     suppression, then a genuine first-person deferral phrase (see block comment above) ---
  let ticket = null;
  if (typeof lastText === 'string' && lastText.length > 0 &&
      !isHarnessNoise(lastText) &&
      !RUNNER_WORKTREE_RE.test(String(cwd ?? '').replace(/\\/g, '/')) &&
      !CLOSING_REPORT_RE.test(lastText) &&
      !isOrchestrationDominated(lines) &&
      DEFERRAL_RE.test(lastText)) {
    // text a prompt-injected session can shape must never become an
    // unattended job. Filed held: an operator reads it and releases it.
    ticket = { source: 'deferred', title: extractDeferralTitle(lastText), prompt: lastText, state: 'held' };
  }

  const codeChanged = (Array.isArray(events) ? events : []).some(
    e => e.kind === 'file-edit' && e.op !== 'read' && CODE_EXT_RE.test(String(e.path ?? '')),
  );

  return { gaps, ticket, codeChanged };
}
