/**
 * outcome-metrics.js
 * Pure session-metrics computation + summary aggregation.
 * Zero dependencies, Node 18+ ESM.
 */
import { tagValue } from './evidence.js';

// Edit-family tool names (shared by editApplyFailures + churn pairing).
const EDIT_TOOL_RE = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

// A "tool event" for pairing purposes is anything carrying a `tool` name:
// extract-claude.js stamps `tool` onto every classified tool_use event
// regardless of kind (Edit/Write/NotebookEdit come through as kind:'file-edit',
// not kind:'tool'), so pairing must key off `tool`, not `kind`. The synthetic
// prompt event (kind:'tool', tool:'user') also carries a `tool` name, but a
// human turn is never a tool call, so it is excluded here too via
// isPromptEvent (declared below; safe to reference before its line runs,
// since hasToolField is only ever called from computeMetrics after the
// whole module has finished evaluating).
function hasToolField(e) {
  return typeof e.tool === 'string' && e.tool.length > 0 && !isPromptEvent(e);
}

// Edit-type event: an Edit/Write/NotebookEdit tool call with a path, or (for
// adapters that label edits directly) a kind:'edit' event with a path.
function isEditEvent(e) {
  if (!e.path) return false;
  if (typeof e.tool === 'string' && EDIT_TOOL_RE.test(e.tool)) return true;
  return e.kind === 'edit';
}

function isReadEvent(e) {
  return e.tool === 'Read' || e.tool === 'Grep' || e.tool === 'Glob';
}

// A real user turn. Both arms are kept so the fix does not depend on which
// adapter produced the event: extract-claude.js stamps a synthetic user
// prompt as kind:'tool', tool:'user' (there is no kind:'prompt' in the real
// event stream today), but a future/other adapter may legitimately emit
// kind:'prompt' directly, keep recognizing both.
export const isPromptEvent = (e) =>
  e.kind === 'prompt' || (e.kind === 'tool' && e.tool === 'user');

// A real tool-call event: kind:'tool' but not the synthetic prompt event.
// Both extract-antigravity.js and extract-claude.js stamp a human turn as
// kind:'tool', tool:'user' (the same kind real tool_use events carry), so
// every kind==='tool' filter below reuses isPromptEvent to exclude it. A
// human turn must never count as a tool call.
function isToolCallEvent(e) {
  return e.kind === 'tool' && !isPromptEvent(e);
}

/**
 * @param {{ events?: Array<{kind:string,ts:number|string,[k:string]:any}>, usage?: {input?:number,output?:number,ctxUsedPct?:number}|null }} opts
 * @returns {object} Partial<OutcomeRow>
 */
export function computeMetrics({ events = [], usage = null } = {}) {
  // extract-claude.js stamps ts as the transcript's ISO-8601 string; string
  // subtraction is NaN, so every timing below needs epoch ms.
  const sorted = events
    .map(e => (typeof e.ts === 'string' ? { ...e, ts: Date.parse(e.ts) } : e))
    .sort((a, b) => a.ts - b.ts);

  // turns: count prompt events
  const turns = sorted.filter(isPromptEvent).length;

  // wallClockMs.total
  let total = null;
  if (sorted.length >= 2) {
    total = sorted[sorted.length - 1].ts - sorted[0].ts;
  }

  // wallClockMs.toolWait: for each real tool-call event, find the NEXT
  // tool_result after it. Prompt events are excluded (isToolCallEvent), so a
  // tool_result that happens to follow a human turn is never credited as
  // wait time on that turn.
  const toolEvents = sorted.reduce((acc, e, i) => {
    if (isToolCallEvent(e)) acc.push(i);
    return acc;
  }, []);

  let toolWait = null;
  if (toolEvents.length > 0) {
    let sum = 0;
    for (const toolIdx of toolEvents) {
      const toolTs = sorted[toolIdx].ts;
      // find first tool_result after this index
      const resultEvent = sorted.slice(toolIdx + 1).find(e => e.kind === 'tool_result');
      if (resultEvent != null) {
        sum += resultEvent.ts - toolTs;
      }
    }
    toolWait = sum;
  }

  // toolCalls + toolErrors. toolCalls excludes prompt events (isToolCallEvent):
  // a human turn is never a tool call.
  const toolCalls = sorted.filter(isToolCallEvent).length;
  const toolErrors = sorted.filter(e => e.kind === 'tool_result' && e.error === true).length;

  // editApplyFailures: pair each tool_result with the closest preceding
  // unmatched tool event (mirrors toolWait's forward pairing, reversed).
  // Null only when there are zero tool events at all; 0 when edits exist
  // but none of their results errored.
  const anyToolEvents = sorted.some(hasToolField);
  let editApplyFailures = null;
  if (anyToolEvents) {
    let failures = 0;
    let pendingTool = null;
    for (const e of sorted) {
      if (e.kind === 'tool_result') {
        if (pendingTool != null) {
          if (e.error === true && EDIT_TOOL_RE.test(pendingTool.tool)) failures++;
          pendingTool = null;
        }
      } else if (hasToolField(e)) {
        pendingTool = e;
      }
    }
    editApplyFailures = failures;
  }

  // churn: re-edits of a path already touched earlier in the session.
  // extra.readEditRatio: read-type tool calls per edit-type event.
  const editEvents = sorted.filter(isEditEvent);
  let churn = null;
  let readEditRatio = null;
  if (editEvents.length > 0) {
    const seenPaths = new Set();
    let rework = 0;
    for (const e of editEvents) {
      if (seenPaths.has(e.path)) rework++;
      else seenPaths.add(e.path);
    }
    churn = rework;

    const readCount = sorted.filter(isReadEvent).length;
    readEditRatio = Math.round((readCount / editEvents.length) * 100) / 100;
  }

  // tokens
  const tokensIn = usage?.input ?? null;
  const tokensOut = usage?.output ?? null;

  // contextUsageRatio
  const contextUsageRatio = (typeof usage?.ctxUsedPct === 'number') ? usage.ctxUsedPct / 100 : null;

  // firstTry
  const firstTry = (turns != null) ? (turns <= 1) : null;

  return {
    turns,
    wallClockMs: {
      total,
      modelThink: null,
      toolWait,
      rework: null,
    },
    tokens: {
      in: tokensIn,
      out: tokensOut,
    },
    toolCalls,
    toolErrors,
    editApplyFailures,
    churn,
    contextUsageRatio,
    firstTry,
    extra: { readEditRatio },
  };
}

/**
 * @param {Array<object>} rows
 * @returns {{ byClass: { [taskClass: string]: { n: number, medianTurns: object, verifierPassRate: object, firstTryRate: object, medianContextUsage: object, medianChurn: object } } }}
 * Each of the five metrics is an evidence-tagged envelope from evidence.js's
 * tagValue(): { value, evidence: 'measured'|'constant'|'absent', n, reason? }.
 */
export function summarizeOutcomes(rows = []) {
  const groups = {};

  for (const row of rows) {
    const cls = row.taskClass ?? '__unknown__';
    if (!groups[cls]) groups[cls] = [];
    groups[cls].push(row);
  }

  const byClass = {};
  for (const [cls, groupRows] of Object.entries(groups)) {
    const n = groupRows.length;

    const turnValues = groupRows.map(r => r.turns).filter(v => v != null);
    const medianTurns = tagValue(median(turnValues), turnValues);

    const verifierRows = groupRows.filter(r => r.verifier?.exitOk != null);
    const verifierSamples = verifierRows.map(r => r.verifier.exitOk === true);
    const verifierPassRate = tagValue(
      verifierSamples.length ? verifierSamples.filter(Boolean).length / verifierSamples.length : null,
      verifierSamples,
    );

    const firstTryRows = groupRows.filter(r => r.firstTry != null);
    const firstTrySamples = firstTryRows.map(r => r.firstTry === true);
    const firstTryRate = tagValue(
      firstTrySamples.length ? firstTrySamples.filter(Boolean).length / firstTrySamples.length : null,
      firstTrySamples,
    );

    const ctxValues = groupRows.map(r => r.contextUsageRatio).filter(v => v != null);
    const medianContextUsage = tagValue(median(ctxValues), ctxValues);

    const churnValues = groupRows.map(r => r.churn).filter(v => v != null);
    const medianChurn = tagValue(median(churnValues), churnValues);

    byClass[cls] = { n, medianTurns, verifierPassRate, firstTryRate, medianContextUsage, medianChurn };
  }

  return { byClass };
}

// Gap 14 target (operator, 10-28): the classification 'other' share is judged
// over the last `window` judged rows, a count rather than days, so a slow week
// cannot shrink the sample. At p ~10% a window of 200 has a standard error of
// about 2 points, enough to tell 15% from under 10%. Lifetime share is not the
// measure: pre-judge rows default to 'other' and are never re-judged.
export const OTHER_SHARE = Object.freeze({ window: 200, target: 0.15 });

export function otherShare(rows = [], { window = OTHER_SHARE.window, target = OTHER_SHARE.target } = {}) {
  const recent = rows
    .filter((r) => r?.extra?.judge && !r.extra.judge.skipped && r.taskClass && r.taskClass !== 'pending')
    .sort((a, b) => (Number(a.extra.judge.ts) || 0) - (Number(b.extra.judge.ts) || 0))
    .slice(-window);
  const n = recent.length;
  const other = recent.filter((r) => r.taskClass === 'other').length;
  const share = n ? other / n : null;
  return { window, n, other, share, target, meetsTarget: share == null ? null : share < target };
}

/**
 * Diagnostic-only grouping (glmps-72 Workstream B): the SAME summarizeOutcomes
 * shape, computed once per actor. Global (ungrouped) summarizeOutcomes stays
 * the default everywhere; this exists so a guard's false-positive rate can be
 * checked per actor BEFORE promotion, without adding per-actor learning
 * stores or branching dispatch on actor.
 * @param {Array<object>} rows
 * @returns {{ byActor: { [actor: string]: ReturnType<typeof summarizeOutcomes> } }}
 */
export function summarizeByActor(rows = []) {
  const groups = {};
  for (const row of rows) {
    const key = row.actor ?? '__unknown__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  const byActor = {};
  for (const [actorId, groupRows] of Object.entries(groups)) {
    byActor[actorId] = summarizeOutcomes(groupRows);
  }
  return { byActor };
}

/**
 * Compute median of a numeric array. Returns null for empty arrays.
 * @param {number[]} arr
 * @returns {number|null}
 */
function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
