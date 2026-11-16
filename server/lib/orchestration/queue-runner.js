// server/lib/orchestration/queue-runner.js
// Pure decision core for the queue runner. No I/O; the server injects effects.

import path from 'node:path';
import crypto from 'node:crypto';
import { classifyTask } from '../evaluation/task-classify.js';
import { pickSkills, wakeSkills } from './skill-cues.js';
import { isUnderDir } from './worktrees.js';
import { zoneName, formatTime } from '../../../web/shared/time-format.js';

const RESOLVED = new Set(['done', 'archived']);

// Blockers still open. A dangling id (ticket deleted) does not block forever.
export function unresolvedBlockers(item, byId) {
  return (item.blockedBy ?? []).filter(id => { const t = byId.get(id); return t && !RESOLVED.has(t.state); });
}

/**
 * The next card to launch.
 *
 * `liveJobIds` (the runner ledger's keys) is a hard exclusion, not a nicety.
 * reconcileLedger REQUEUES an overrunning job, which sets its card back to
 * `queued` while deliberately KEEPING its ledger entry. Without this filter the
 * very next tick re-picks that card and launches a second session for it; since
 * worktreePlan is deterministic on the job id, `git worktree add` then fails on
 * the existing directory and launchJob falls back to the shared repo checkout,
 * putting two live agents on one working tree (glmps-53).
 */
export function pickNextJob(items = [], liveJobIds = [], { operatorOnly = false, preferOperator = false } = {}) {
  // Poison gate: a quarantined ticket (flagged at intake by poison-scan) is never
  // auto-launched. It stays queued and visible until an operator approves it.
  const live = new Set(liveJobIds);
  const byId = new Map(items.map(i => [i.id, i]));
  const queued = items.filter(i =>
    // D32 G3: two failed gates in a row wait for the operator's restated intent.
    i.state === 'queued' && !i.quarantined && !i.gate?.reintent && !i.needsIntent && !live.has(i.id)
    && unresolvedBlockers(i, byId).length === 0
    && (!operatorOnly || isOperatorCard(i)));
  if (!queued.length) return null;
  const rank = (i) => (preferOperator && isOperatorCard(i) ? 0 : 1);
  return queued.reduce((best, i) => (rank(i) < rank(best) || (rank(i) === rank(best) && i.order < best.order) ? i : best));
}

// Queued-but-blocked tickets: the runner demotes these to held so a human sees them.
export function blockedQueued(items = []) {
  const byId = new Map(items.map(i => [i.id, i]));
  return items
    .filter(i => i.state === 'queued' && ((i.blockedBy ?? []).length || i.gate?.reintent || i.needsIntent))
    .map(i => ({ id: i.id, blockers: [
      ...unresolvedBlockers(i, byId),
      ...(i.gate?.reintent ? ['a restated intent (two failed gates in a row)'] : []),
      // A blocker hold, so releasableHeld frees it once criteria clear the flag.
      ...(i.needsIntent ? ['acceptance criteria (filed without them)'] : []),
    ], forBlockers: !i.gate?.reintent }))
    .filter(b => b.blockers.length);
}

// Cards held before the flag existed (2026-10-25) carry only the runner's hold
// comment. Count one only while that comment is its last activity and nothing
// has updated the card since, so any later operator touch keeps it held.
const PRE_FLAG_TOUCH_MS = 1000;
function preFlagBlockerHold(i) {
  if ('autoHeldForBlockers' in i || !(i.blockedBy ?? []).length) return false;
  const last = (i.activity ?? []).at(-1);
  if (!/^runner: auto-held \S+ blocked by /.test(last?.text ?? '') || /restated intent/.test(last.text)) return false;
  const gap = Date.parse(i.updatedAt) - Date.parse(last.ts);
  return Number.isFinite(gap) && gap >= 0 && gap <= PRE_FLAG_TOUCH_MS;
}

// The inverse of blockedQueued: cards the runner itself held for blockers whose
// blockers are all resolved now. Only the store's autoHeldForBlockers flag
// qualifies, so an operator hold or any other hold is never undone here.
export function releasableHeld(items = []) {
  const byId = new Map(items.map(i => [i.id, i]));
  return items
    .filter(i => i.state === 'held' && (i.autoHeldForBlockers === true || preFlagBlockerHold(i)) && !i.gate?.reintent
      && !i.needsIntent && unresolvedBlockers(i, byId).length === 0)
    .map(i => ({ id: i.id, resolved: [...(i.blockedBy ?? [])] }));
}

// Runner slots in use: ledger entries for card sessions. Merge-queue
// reviewers are leased in the ledger too but never count against the cap.
export function slotsUsed(ledger, { except = null } = {}) {
  return Object.entries(ledger ?? {}).filter(([k, v]) => k !== except && v?.role !== 'reviewer').length;
}

// A primary card is one the operator started that no other card spawned. It
// decides only the reserved operator lane (slotUsage); the launch mode is
// launchMode's, by host lineage (glmps-2-0-163 replaced the 2026-10-23 rule
// that ran every non-primary card headless).
export const LAUNCH_MODES = new Set(['interactive', 'headless']);
const PRIMARY_SOURCES = new Set(['scut', 'operator', 'manual']);

export function isOperatorCard(card) {
  return PRIMARY_SOURCES.has(card?.source) && card?.provenance?.trust === 'operator' && !card?.parentId;
}

// A host is open until done, cancelled or archived; held and idle hosts can be
// resumed, so they still own their children. A parent id naming no card is no host.
const HOST_CLOSED = new Set(['done', 'cancelled', 'archived']);
export function hostOpen(card, items = []) {
  if (!card?.parentId) return false;
  const host = items.find((i) => i.id === card.parentId);
  return Boolean(host) && !HOST_CLOSED.has(host.state);
}

export function openChildren(id, items = []) {
  return items.filter((i) => i.parentId === id && !HOST_CLOSED.has(i.state));
}

// Card glmps-2-0-163 (operator, 2026-11-06): only a card spawned under an open
// host runs headless, because that host's session and channel manage it. Every
// other card opens interactively with its own channel, so no work runs where
// the operator cannot see it. Without the board (`items`) no host is known to
// be open, so the card opens interactively.
export function launchMode(card, items = []) {
  if (LAUNCH_MODES.has(card?.mode)) return card.mode;
  return hostOpen(card, items) ? 'headless' : 'interactive';
}

// `maintenance` is a Restart run quiescing the box (card glmps-2-0-170): no new launch.
export function shouldClaim({ enabled, paused, runningCount, maxConcurrent, maintenance = false } = {}) {
  return !!enabled && !paused && !maintenance && runningCount < maxConcurrent;
}

// Reserved operator lane (glmps-2-0-111): `maxConcurrent` is the automation
// pool and `operatorSlots` more slots only operator cards may use. Operator
// sessions fill their lane first and spill into the automation pool past it,
// so the lane is never consumed by automation. A live id with no card
// (another store, a deleted card) counts as automation.
export function slotUsage({ ledger, launching = [], items = [], except = null } = {}) {
  const byId = new Map(items.map(i => [i.id, i]));
  const ids = new Set([
    ...Object.entries(ledger ?? {}).filter(([, v]) => v?.role !== 'reviewer').map(([k]) => k),
    ...launching,
  ]);
  ids.delete(except);
  let operator = 0;
  for (const id of ids) if (isOperatorCard(byId.get(id))) operator++;
  return { auto: ids.size - operator, operator };
}

export function hasCapacity({ usage, maxConcurrent, operatorSlots = 0, forOperator = false } = {}) {
  const reserved = Math.max(0, Number(operatorSlots) || 0);
  if (forOperator) return usage.auto + usage.operator < maxConcurrent + reserved;
  return usage.auto + Math.max(0, usage.operator - reserved) < maxConcurrent;
}

// TaskSpec intent contract (glmps-69): the durable piece of prompt engineering
// is the intent contract, not phrasing. `spec` is optional per-ticket
// goal/boundary metadata (see backlog-store.js normalizeSpec for the shape and
// validation); renderSpec renders it into exactly TWO static profiles so the
// prompt itself never needs per-model tuning. Absent/empty spec -> [] so a
// ticket with no spec produces byte-identical output to before this existed.
const SPEC_RISK_SENTENCES = {
  low: 'small blast radius \u2014 safe to proceed independently.',
  medium: 'moderate blast radius \u2014 verify assumptions before making wide changes.',
  high: 'high blast radius \u2014 go carefully, checkpoint often, prefer small reversible steps.',
};

export function renderSpec(spec) {
  if (!spec || typeof spec !== 'object') return [];
  const profile = spec.profile === 'critic' ? 'critic' : spec.profile === 'verify' ? 'verify' : 'worker';
  const riskLine = (spec.riskTier && SPEC_RISK_SENTENCES[spec.riskTier])
    ? `Risk tier: ${spec.riskTier} \u2014 ${SPEC_RISK_SENTENCES[spec.riskTier]}`
    : null;
  const escalationLine = spec.escalation ? `Escalate (stop and ask on the card) when: ${spec.escalation}` : null;

  if (profile === 'critic') {
    // Rubric-constrained review contract: no file edits, a structured verdict,
    // same risk/escalation lines as the worker profile. Selecting the critic
    // profile is itself meaningful, so this renders even with no other fields.
    const lines = [
      'You are the CRITIC on this card: do not modify files.',
      'Produce a structured verdict: a findings list (each tagged with a severity), then a single verdict line.',
    ];
    if (riskLine) lines.push(riskLine);
    if (escalationLine) lines.push(escalationLine);
    return lines;
  }

  if (profile === 'verify') {
    // Layered verification (glmps-81 Phase 3): execution checks first, an
    // independent critic second. Mirrors verify.js's own precedence rule in
    // prompt form -- a failed declared execution check (tests / acceptance
    // criteria) is a hard veto reported via /gate BEFORE any critic review is
    // requested; the critic can only downgrade a passing execution result,
    // never overturn a failing one. Selecting this profile is itself
    // meaningful, so it renders even with no other fields (same convention as
    // the critic profile above).
    const lines = [
      'This card runs LAYERED VERIFICATION: execution checks first, an independent critic second.',
      "Run the ticket's declared execution checks (its acceptance criteria / test command) FIRST, before anything else.",
      'A failing execution check is a hard veto: report it via /gate with lens "exec" and STOP \u2014 do not request or wait for critic review.',
      'Only once every declared execution check passes (or none are declared) should an independent cross-model critic review the result.',
    ];
    if (riskLine) lines.push(riskLine);
    if (escalationLine) lines.push(escalationLine);
    return lines;
  }

  // Goal-first agentic profile (default). Only present fields render, so a
  // partial spec (e.g. just an escalation condition) stays terse.
  const lines = [];
  if (spec.deliverable) lines.push(`Deliverable: ${spec.deliverable}`);
  if (spec.act === 'assess') lines.push('Mode: assess only \u2014 report, do not change code.');
  if (riskLine) lines.push(riskLine);
  if (escalationLine) lines.push(escalationLine);
  if (lines.length) lines.push('Before reporting done, audit your claims against actual command/test output.');
  return lines;
}

// Build the seed header prepended to a launched job's prompt. Pure + testable.
// Chat handoff guard (glmps-21): when a ticket carries a chat origin, the
// launched session is told it OWNS the single reply to that thread, so a
// message handed off to the backlog is not ALSO answered inline by the session
// that filed it. The filing session sets the origin and stays silent; this
// session is the one point of reply. Discord was the original channel for this
// and was retired 2026-08-29 (docs/discord-ticket-handoff.md), so Slack is now
// the only origin that branches here.
// Default mirrors server.js's `parkHoldMs` (SCUT_PARK_HOLD_MS ?? 540_000) at
// the time of writing, used only when a caller does not pass the real value.
// The server call site always passes its own computed parkHoldMs so the two
// can never drift apart; see glmps-40.
const DEFAULT_PARK_HOLD_MS = 540_000;

// glmps-78. A chat reply is read on a phone, at a glance, with none
// of the terminal's surrounding context, so it gets a tighter budget and a
// slower cadence than the CLI does. The SHAPE itself (lead, then a `Details:`
// fold) is stated once in the working agreement and in the machine-wide
// CLAUDE.md; only the chat-specific numbers live here. Slack is the only chat
// branch since Discord was retired, but this stays a shared constant so a
// future channel cannot drift from it.
const CHAT_ALTITUDE_LINE =
  'REPORTING ALTITUDE (this thread): the operator is an engineering manager reading on a phone, at a glance, ' +
  'out of context. Keep each post under ~1,200 characters before its `Details:` fold, and post once per ' +
  'meaningful state change rather than once per action. Your global CLAUDE.md carries the full contract.';

// glmps-2-0-211: a thread that ends on "6/6 - plan complete" and then goes quiet
// while the gate, PR and merge queue run reads as finished, or as dead.
const WAITING_STATE_LINE =
  'WAITING STATE (this thread): before any wait (the park loop, the merge queue, CI, the operator, a child card, ' +
  'a long-running command), post what you are waiting on and who or what acts next, the next step once it ' +
  'arrives, and an expected time with your confidence in it ("merge queue, about 10 min, medium"). When the ' +
  'remaining step is the final one, add a line "Last step before close: <step>". If the wait outlasts your ' +
  'estimate, post the new estimate and why. A progress count alone ("6/6") is not a status.';

// D32 G1: only 2.9% of cards carried acceptance criteria when this landed, so
// gates checked "tests passed", not "did what was meant". Classes where a wrong
// guess at the goal is expensive get one grilling round (the Matt Pocock
// grilling format) answered by the operator; everything else, or a card with no
// chat thread to answer in, records its own intent so the gate has ACs to check.
const GRILL_CLASSES = new Set(['feature', 'research', 'ui']);

export function intentFirstLines(job = {}, { port, headless = false } = {}) {
  if ((job.acceptanceCriteria ?? []).length) return [];
  const o = job.origin;
  const chat = !!(o && o.via === 'slack' && o.channel && o.thread_ts);
  let taskClass = 'other';
  try { taskClass = classifyTask({ firstPrompt: job.prompt ?? job.title ?? '' }).taskClass; } catch { /* one-liner */ }
  const patch = `PATCH http://127.0.0.1:${port}/api/backlog/${job.id} {"acceptanceCriteria":["..."]}`;
  if (chat && GRILL_CLASSES.has(taskClass)) {
    return [
      `INTENT FIRST: this card has no acceptance criteria. Before any other work, read what you need, then post ONE ` +
      `grilling round (use the \`grilling\` skill for its format) as a devlog: at most 5 numbered questions, fewer is ` +
      `better, and only about decisions that are the operator's (intent, scope, priority, what done means, money or ` +
      `quota, irreversible or prod actions, a real business tradeoff). Method, deliverable form, PR shape, test ` +
      `choice and non-goals that follow from the ask are yours: list them in the same post as "I will ..." lines, ` +
      `not as questions. Look facts up yourself, never ask them. Each question is followed by your recommended ` +
      `answer, so they can reply "1 yes, 2 b". ` +
      `${headless ? 'Then end as described above.' : 'Then park as described above.'} When the reply arrives, record the agreed done-when as numbered criteria with ` +
      `${patch} (non-goals go in the same list as "Does not ..."), then do the work. If no question is the ` +
      `operator's, ask none: post your one-line plan and the criteria, record them, and proceed without parking. ` +
      `If parking is unavailable, record your recommended answers as the criteria, say so in a devlog, and proceed.`,
    ];
  }
  return [
    `INTENT FIRST: this card has no acceptance criteria. Your first devlog states, in one line, the outcome and ` +
    `how you will know it is done. Then record 1 to 3 checkable criteria with ${patch} before you start.`,
  ];
}

// A headless card (unattended reliability T6) is a print-mode session that ends
// when its turn ends, so it is never parked: it waits on the operator by
// exiting with a gate, and a reply resumes the same session.
const HEADLESS_LINE =
  'HEADLESS RUN: you run in print mode with nobody at the terminal, and this session ends when you stop. There is ' +
  'no park loop: never POST /api/scut/park. If you need the operator\'s decision, post the question as a devlog, ' +
  'record a gate (CONCERNS, naming what you are waiting on), then end. When the work is done, record the gate ' +
  'verdict, close the card as above, then end. A reply from the operator resumes this same session with the reply ' +
  'as your next instruction. Ending without recording a gate is reported as a failed run.';

// One zone for every time the operator reads (card glmps-2-0-runtime-66): agents
// wrote Z, UTC and local times interchangeably.
// A fixed instant keeps the header byte-stable: 4:22 PM in Pacific.
const EXAMPLE_TS = Date.UTC(2026, 0, 15, 0, 22);
export function timeZoneLine(timeZone) {
  if (!timeZone) return null;
  return `OPERATOR TIMEZONE: ${timeZone} (${zoneName(timeZone)}). Write times for the operator in ${timeZone}, with the ` +
    `zone named (for example "${formatTime(EXAMPLE_TS, { tz: timeZone, date: false })}"); never Z or UTC in prose. ` +
    'Machine fields (JSON ts, logs) stay ISO UTC.';
}

// The reopen note to read for skill cues, or null. The merge reviewer and the
// merge queue reopen cards with their own findings, which are not the
// operator's wording; the Slack reopen loop passes no source.
export function operatorReply(reopen) {
  if (!reopen?.note) return null;
  return reopen.source == null || reopen.source === 'operator' ? reopen.note : null;
}

// Which Pocock skill(s) a launch should name. The class comes from the route
// when one was made, else from the classifier, so a card too thin to route
// still gets a class suggestion. A reopen is driven by the operator's reply, so
// the reply's cues outrank the original card text. Fails open to "none".
export function resolveSkills({ job, route = null, vocab, reply = null } = {}) {
  try {
    const cued = reply ? wakeSkills(reply, vocab) : [];
    if (cued.length) return { skills: cued, via: 'cue' };
    const text = job?.prompt ?? job?.title ?? '';
    let taskClass = route?.taskClass;
    if (!taskClass) {
      try { taskClass = classifyTask({ firstPrompt: text }).taskClass; } catch { taskClass = 'other'; }
    }
    return pickSkills(text, vocab, { taskClass, operator: job?.origin?.via === 'slack' });
  } catch { return { skills: [], via: 'none' }; }
}

function skillsLine(skills) {
  const list = skills?.skills ?? [];
  if (!list.length) return null;
  const names = list.map((s) => `\`${s}\``).join(', ');
  const plural = list.length > 1;
  const lead = skills.via === 'cue'
    ? `The operator's wording cues the ${names} skill${plural ? 's' : ''}: invoking ${plural ? 'them' : 'it'} is mandatory for this card.`
    : `This card's class suggests the ${names} skill: invoke it unless the card's wording points elsewhere. ` +
      `It is for the work itself, so an intent-first round does not replace it: run it after that round.`;
  return `SKILLS: ${lead} Invoke a skill with the Skill tool (it may be listed as \`mattpocock-skills:X\`); ` +
    `tell any subagent you dispatch to invoke it too; name the skill you ran in your devlog posts (for example 'ran to-spec').`;
}

export function launchHeader({ job = {}, port, route = null, skills = null, parkHoldMs = DEFAULT_PARK_HOLD_MS, headless = false, timeZone = null } = {}) {
  const lines = [
    `Backlog card ${job.id} (project: ${job.project}). You were launched by the GLMPS queue runner.`,
    `When done, close the card: PATCH http://127.0.0.1:${port}/api/backlog/${job.id} with {"labels":["agent:done"]} (use "agent:backlog" to requeue).`,
  ];
  const o = job.origin;
  if (o && o.via === 'slack' && o.channel && o.thread_ts) {
    // There is NO Slack tool in the session.
    // Point the agent at the devlog/gate endpoints it already uses: SCUT relays
    // both into the originating thread. Naming a mechanism the agent does not
    // have (as this used to) produces either a silent thread or an agent that
    // goes hunting for the bot token on disk.
    lines.push(
      `This ticket came from Slack (channel ${o.channel}, thread ${o.thread_ts}) and you OWN the reply, but do NOT ` +
      `look for a Slack tool or credential: you do not have one and must not go looking. Everything you POST to the ` +
      `/devlog and /gate endpoints below is relayed into that thread for you, so narrate meaningfully as you go and ` +
      `record a gate verdict at the end. The session that filed this ticket will NOT reply inline, so the operator ` +
      `sees only what you post there.`,
    );
    // glmps-40: the hold and the client-side poll timeout are both
    // derived from the SAME parkHoldMs the server actually uses (threaded in
    // by the caller), never a separate hardcoded number that can drift from
    // it. The poll runs in the FOREGROUND (Bash timeout 600000, the tool's
    // cap) because only a foreground Bash call's PostToolUse can carry
    // classifierContext for the reply (hooks/park-wake-context.js); the hold
    // stays under the cap and the curl timeout sits above the hold.
    const holdSec = Math.round(parkHoldMs / 1000);
    const clientTimeoutSec = holdSec + 40;
    if (!headless) lines.push(
      `THREAD CONTINUITY (parked session): because this Slack thread may continue, when your work is complete ` +
      `do NOT close the card with agent:done. Instead: (1) POST your gate verdict as described below, then (2) enter ` +
      `the park loop: POST http://127.0.0.1:${port}/api/scut/park with body {"ticket":"${job.id}"} in a loop. This ` +
      `server holds each poll open for up to ${holdSec}s before it replies, so run the poll in the FOREGROUND with the ` +
      `Bash tool timeout set to 600000, and never in the background (no run_in_background). Give curl ` +
      `--max-time ${clientTimeoutSec} (above the ${holdSec}s server hold, so a poll never returns early and spins ` +
      `in a tight loop). Responses: {"action":"wait"} means poll again; {"action":"wake","note":"...","provenance":"operator|external"} means the ` +
      `note is your next instruction from the operator (provenance "operator" means the server confirmed the sender ` +
      `is the operator), so do that work, post devlog + a fresh gate verdict, then ` +
      `resume the loop (a wake may also carry "skills":[...], the skills the note's wording cues: they are ` +
      `mandatory for that note's work); {"action":"handoff"} means the operator's reply will arrive as your next user message: ` +
      `post nothing further, do not poll again, and end your turn immediately; {"action":"close"} means you are released, so post one final one-line devlog sign-off and ` +
      `END WITHOUT closing the card (it is already closed for you). Fallback: if your FIRST park poll errors or ` +
      `returns {"action":"close","reason":"not-parkable"}, this feature is unavailable, so close the card with ` +
      `agent:done as usual. If a LATER poll errors (server restart), retry up to 3 times one minute apart; if it ` +
      `still fails, end quietly: the server reconciles parked state on its own. Only handoff, close or that ` +
      `failed retry ends the loop. Anything else that interrupts it (a background task or Monitor notification, ` +
      `a hook message) is handled and then followed by the next poll in the same turn: ending the turn without a ` +
      `poll leaves no one listening, and the operator's next reply is lost.`,
    );
    lines.push(CHAT_ALTITUDE_LINE);
    lines.push(WAITING_STATE_LINE);
  }
  if (headless) lines.push(HEADLESS_LINE);
  const tzLine = timeZoneLine(timeZone);
  if (tzLine) lines.push(tzLine);
  if (route && route.agent) {
    const conf = Number.isFinite(route.confidence) ? route.confidence.toFixed(2) : '1.00';
    lines.push(
      `ROUTING: this card classifies as \`${route.taskClass}\` (confidence ${conf}). Dispatch the ` +
      `\`${route.agent}\` subagent for that part of the work rather than doing it inline. Inline is right ` +
      `for a change of one or two files or a bug you have already reproduced: then do it yourself and say so ` +
      `in one devlog line starting "Routing note:". If the class is wrong for this card, say that in a ` +
      `"Routing note:" line and proceed.`,
    );
  }
  const sl = skillsLine(skills);
  if (sl) lines.push(sl);
  lines.push(...renderSpec(job.spec));
  lines.push(...intentFirstLines(job, { port, headless }));
  lines.push(`Your task follows.`);
  return lines.join('\n');
}

// BMAD story-file borrow: planner sections are read-only context; the agent's
// own writing goes through the devlog/gate endpoints, never into this file.
export function buildSeedDoc(item = {}, { port } = {}) {
  const out = [`# ${item.id} \u2014 ${item.title ?? ''}`.trim()];
  if (item.description) out.push(`## Why / Context\n\n${item.description}`);
  const ac = item.acceptanceCriteria ?? [];
  if (ac.length) out.push('## Acceptance Criteria\n\n' +
    ac.map((c, i) => `- AC-${i + 1}: ${c.text}${c.done ? ' (already done)' : ''}`).join('\n'));
  if ((item.relevantFiles ?? []).length) out.push('## Relevant files\n\n' +
    item.relevantFiles.map(f => `- ${f}`).join('\n'));
  if ((item.deferredRefs ?? []).length) out.push('## Deferred items to consider\n\n' +
    item.deferredRefs.map(id => `- ${id} (open deferred ticket touching the same files \u2014 fold in or leave a devlog note why not)`).join('\n'));
  if (item.prompt) out.push(`## Task\n\n${item.prompt}`);
  out.push([
    '## Working agreement',
    '',
    '- The sections above are planner-authored and read-only; do not edit this file.',
    `- Log progress (cite ACs by number, e.g. "AC-2 done"): POST http://127.0.0.1:${port}/api/backlog/${item.id}/devlog {"by":"agent","text":"..."}`,
    // glmps-78. Naming the endpoint was never the hard part; what the
    // operator kept getting was the mechanism first. Measured on the live board
    // when this landed, 36% of agent devlogs named two or more internal
    // identifiers in their FIRST line. So the agreement states the SHAPE, and
    // states the guard against the obvious failure of following it: an update
    // that reads clean because the bad news was summarized out of it.
    '- Write those for an engineering manager, not for the engineer on this ticket. Lead with the outcome and the decision you need from them (or say plainly that there is none); put the mechanism - file names, symbols, commands, output - below a literal `Details:` line rather than in the lead, and keep internal identifiers out of the first line entirely. Numbers, not adjectives.',
    // glmps-2-0-185: 40% of the questions agents put to the operator (81 of
    // 204) were calls an engineer should own, and at least 4 re-asked
    // something he had already answered.
    '- Ask the operator only what is the operator\'s to decide: intent and objective, scope, priority, what done means, spending money or quota, irreversible or prod actions, policy, a choice with a real business tradeoff, or approving a follow-up card. Everything else is yours: approach, naming, layout, which tests, PR shape, proceeding with work already asked for, routine reversible steps, and any fact you can look up. State those as "I will X unless you say otherwise" and carry on. Never ask the operator to edit a file: put the proposed text or choices in your devlog with a link to the affected file, take the reply, make the edit yourself, and link the file you changed. Every question you do ask carries your recommended answer. Before asking anything, read this card\'s devlog (and its parent card\'s) for an earlier answer; if the operator already answered, act on it and cite it instead of asking again.',
    '- Altitude is never licence to hide a problem. Risk, blockers, unverified assumptions and irreversible actions (prod writes, force pushes, deletions, credential access) must survive at every altitude, especially when the rest of the news is good. "Done" is not a status: say what you verified and how.',
    // glmps-2-0-runtime-98 F3: concurrent agent full-suite runs pushed the
    // merge queue past its 30-minute ceiling; the hook denies them too.
    '- Run only the tests your change touches: node scripts/affected-tests.mjs (or node --test with the files named). Never run the full suite (npm test, or node --test with no files): the merge queue runs it batched on the base, and a runner session is denied it.',
    `- On completion, run verification (tests/build) and record the verdict: POST http://127.0.0.1:${port}/api/backlog/${item.id}/gate {"status":"PASS|CONCERNS|FAIL|WAIVED","evidence":["actual command output summary"],"risk":"P0|P1|P2|P3","summary":"two or three plain sentences: what was delivered and what is still open or risky"}. The summary is what the operator reads in the main channel when the card closes and its own channel is hidden, so write it for someone who saw none of the thread, and include one sentence starting "Risk:" (the risk, or "none" with why) and one starting "Verified:" (what was checked and how).`,
    '- In the gate evidence, cite every acceptance criterion by number (AC-1, AC-2, ...) with what showed it met: a PASS that leaves one uncited is recorded as CONCERNS. If the gate response carries "reintent":true, the card has failed twice in a row: do not retry, ask the operator in a devlog to restate what done means, and wait for the answer.',
    // glmps-2-0-66: without this line agents ended on "merge PR #N" and the
    // merge queue merged 1 of the 24 PRs in its first 2 days.
    `- If your work is a pull request into a private wolfeb-dev repo, land it through the merge queue once your gate is PASS. Ship this card's whole change as ONE pull request per repo: one change, one PR. Use interim, covers or several PRs only when the operator asked for it or must answer before the next step is possible. POST http://127.0.0.1:${port}/api/backlog/${item.id}/merge-request {"prUrl":"https://github.com/wolfeb-dev/<repo>/pull/<n>"}. The server runs the tests your PR affects (plus any failing files of a red base) on the PR merged with its base, then merges it and closes this card; there is no per-PR reviewer, so run your affected tests before you file. A test failure or a merge conflict bounces the PR: the card comes back to you with the reason and the test output, so fix it, push, and file the merge request again. A timeout is requeued as load and costs you nothing. While the base's last full suite is red the queue merges only a PR whose tests show those failing files green; any other PR waits, with no round spent, until the base is green again. Never run \`gh pr merge\` and never ask the operator to merge. If the PR is one step and the card continues after it (for example a spec you will build on once the operator answers), add "interim":true to that request: the merge then leaves this card open and your park loop running, and you file the next PR as a new merge request. If the card has several acceptance criteria and this PR delivers only some of them, add "covers":[1,2] (the AC numbers it delivers): the merge then closes this card only when every acceptance criterion has been covered by some merged PR. Add "final":true to the request that finishes the card whatever is covered. A request with neither field closes the card when it merges.`,
    `- Do not file follow-up cards on your own. If you find work outside this card's acceptance criteria that you cannot finish here, add it to one numbered list in your next devlog ("Found while working: 1. ... 2. ..."), each with one line on why it is not part of this card and your recommendation ("Recommend: file" or "Recommend: skip", with the reason), and ask which to file. File only the items the operator names: POST http://127.0.0.1:${port}/api/backlog with "parentId":"${item.id}", "operatorApproved":true and "outOfScope":"<why>" (the server refuses anything else). If you will work that card yourself, also include "state":"in_progress". Work that this card's acceptance criteria need is done here, never filed. A queue run, triage or review card delivers that list as its result.`,
    `- When this card spawns one or more runtime tickets ("parentId":"${item.id}"), those child cards run as stateless headless sessions with no Slack channel of their own: when a child finishes a turn, asks a question, or stops with a CONCERNS or FAIL gate, its process exits to idle or held and nothing reaches Slack on its own. This host card and its session must stay open until every spawned runtime card is done or cancelled: (1) add an acceptance criterion on this card for managing its spawned runtime cards to completion, and pass "interim":true on any merge request for this card's own PRs (such as a spec or red-base fix) while any child card is still open; (2) never put "${item.id}" in a child card's "blockedBy" while this host card stays open (the runner auto-holds any queued card blocked by an open card; queue the child after this card's spec PR merges, or clear the blocker on merge, and use "blockedBy" only between sibling child cards); (3) check GET http://127.0.0.1:${port}/api/backlog/<child-id> on every park cycle and post a devlog on THIS card at each meaningful child transition (launched, phase/PR merged, bounced, or stopped in idle/held), and whenever a child stops in idle or held with a question or CONCERNS gate, relay the child's question and recommendation to this card's devlog, wait for the operator's reply in the park loop, post the decision to the child's /devlog, and requeue the child with {"labels":["agent:backlog"]}.`,
    `- If this card asked a question and your answer recommends a change you could make, end the answer with: "Reply 'build it' and I will do it on this card." Do not file a card for it. File the answer's PR (if any) with "interim":true so this card stays open and your park loop keeps running.`,
    '- A ticket closed done without a PASS/WAIVED gate is surfaced on the board as a gate-less close (GET /api/backlog `gatelessDone`) AND fed to the capability learning loop as a recurring gap, so record the gate above.',
    `- If you write a spec (to-spec) or a plan, commit it and declare it ONCE: POST http://127.0.0.1:${port}/api/backlog/${item.id}/progress {"plan":"docs/specs/<file>.md"}. The server then posts a progress check-in on each task boundary so the operator can see where the work is without asking. It counts TICKED checkboxes, so give the document a checkbox per task and tick them as you finish - an unticked one under-reports and makes you look stuck.`,
  ].join('\n'));
  return out.join('\n\n');
}

// The section a reopened ticket's prompt file carries (D27 C2, Task 7).
// Branch b is the same session resumed; branch c is a fresh session that must
// say, in its first devlog, why the old one could not be resumed.
export function reopenSeedSection({ note, branch, reason = null, source = 'operator', headless = false } = {}) {
  // the note is untrusted Slack input landing in a markdown
  // prompt file the launched agent reads as instructions. Quoting every line
  // (`> `) fences it off as the reply it is, so a line that happens to look
  // like a heading (e.g. "## Task") can never be read as a NEW, forged
  // section of the seed doc.
  const trimmed = String(note ?? '').trim();
  const said = trimmed ? trimmed.split('\n').map((l) => `> ${l}`).join('\n') : '(no message: they rejoined the channel. Post a one-line status and park.)';
  // The merge queue reopens a card with its reviewer's findings (glmps-2-0-44).
  // glmps-2-0-runtime-63: a test bounce requeues the card with the failure.
  const lines = source === 'merge-reviewer'
    ? ['## Reopened by the merge reviewer', '', 'The merge reviewer asked for changes on your pull request:', '', said, '']
    : source === 'merge-queue'
      ? ['## Reopened by the merge queue', '', 'The merge queue bounced your pull request:', '', said, '']
      : ['## Reopened by the operator', '', "The operator replied in this ticket's Slack channel:", '', said, ''];
  if (branch === 'b' && headless) lines.push('This is the same session, resumed headless. Act on the reply, post a devlog, record a gate, then end.');
  else if (branch === 'b') lines.push('This is the same session, resumed. Act on the reply, post a devlog, then park again as the header says.');
  else lines.push(`The previous session could not be resumed: ${reason ?? 'unknown'}. Your FIRST devlog must say so, in one line, with that reason. Then act on the reply.`);
  return lines.join('\n');
}

// Attribution (glmps-72 Workstream B): a chat-originated ticket's launched
// session is attributed to the chat user (already captured on the ticket's
// origin), not the local operator identity; everything else falls back to the
// configured/default local actor. Diagnostics only - dispatch never branches
// on this. Slack is the only chat origin since Discord was retired 2026-08-29.
export function actorForJob({ job = {}, cfgActor } = {}) {
  const o = job.origin;
  if (o && o.via === 'slack' && o.user) return o.user;
  return cfgActor ?? 'operator';
}

// Two agents launched for the SAME project would otherwise share one checkout
// (`cwd: repoFor(project)`) and clobber each other's files. The pure helpers
// live in worktrees.js (shared with interactive-session isolation, glmps-71);
// re-exported here so existing consumers keep their import path.
export {
  shouldIsolate, worktreePlan, worktreeAddRecipe, worktreeRemoveRecipe,
  worktreePruneRecipe, worktreeFetchRecipe, upstreamRefRecipe, isUnderDir,
} from './worktrees.js';

/**
 * Should a departed job's worktree checkout be removed, and why?
 *
 * glmps-53: a job leaving the ledger is NOT evidence its agent
 * stopped. Every editor/companion launch has `pid: null` (launchSession cannot
 * return one), so its only liveness input is the wall clock, and a session that
 * simply works longer than maxRuntimeMs is requeued twice, then held, then has
 * its checkout deleted underneath it. It happened to glmps-33, -36,
 * -51 and -59.
 *
 * The old safety argument was that the caller's non-forcing `git worktree
 * remove` refuses on a dirty tree. That is backwards: it spares the agent that
 * committed nothing and destroys the checkout of the agent that committed as it
 * went, which is exactly what happened to glmps-59.
 *
 * `liveDirs` is the real signal and the worktree sweeper has used it all along
 * (planSweep's occupancy check): the cwds of sessions that have not ended. A
 * checkout somebody is sitting in is never removed here. Declining is safe, not
 * a leak: the sweeper still owns that directory (it is under the managed
 * worktrees dir and holds no ledger lease once the job departs) and reclaims it
 * on the next scan after the session ends.
 *
 * A missing or malformed `liveDirs` is not an empty one: it is no answer at
 * all, and returns `occupancy-unknown` without reclaiming.
 */
export function reclaimVerdict({ entry, isAlive = () => false, liveDirs } = {}) {
  const wt = entry?.worktree;
  if (!wt?.repo || !wt?.dir) return { reclaim: false, reason: 'no-worktree' };
  if (entry.pid && isAlive(entry.pid)) return { reclaim: false, reason: 'pid-alive' };
  // An explicit array, including an EMPTY one, is a real answer: the caller
  // looked, and this is who is live. Anything else is the ABSENCE of an answer.
  // The old signature defaulted `liveDirs` to [], which made "I did not look"
  // indistinguishable from "I looked and nobody is there" and quietly reverted
  // this function to the pre-mc-53 rule the moment a caller forgot to pass it.
  if (Array.isArray(liveDirs)) {
    if (liveDirs.some(d => isUnderDir(d, wt.dir))) return { reclaim: false, reason: 'occupied' };
    return { reclaim: true, reason: 'reclaimable' };
  }
  // No occupancy answer. A real pid that is provably dead is still conclusive
  // on its own: that agent is gone, whoever else is around. A null pid is not
  // conclusive about anything - it is every editor/companion launch - so with
  // the occupancy signal missing there is no evidence at all, and the mc-53
  // constraint is that absence of evidence never authorizes a removal.
  if (entry.pid) return { reclaim: true, reason: 'reclaimable' };
  return { reclaim: false, reason: 'occupancy-unknown' };
}

export function shouldReclaimWorktree(args) { return reclaimVerdict(args).reclaim; }

// idle (D27): a released ticket's session is gone or told to close; its ledger
// entry departs like any finished job. Its worktree is kept by the retention
// rule (server/lib/scut/ticket-retention.js), not by the ledger.
// Exported (not just module-local) because reconcileLedger's ledger-departure
// rule and nightly-exec.js's poll-until-terminal rule are the same question --
// "has this card's session ended" -- asked from two call sites. A second,
// duplicated Set drifted the moment 'idle' was added here without also being
// added there (nightly-exec.js kept polling an idle card to its timeout
// instead of reporting the real outcome); importing this one avoids a repeat.
export const FINISHED = new Set(['done', 'in_review', 'idle', 'cancelled', 'archived']);

/**
 * @param gateWaitMs (jobId) -> ms this job has spent BLOCKED on an approval gate
 *        (glmps-29). Subtracted from wall clock before the overrun
 *        check: a job waiting on a human is not a runaway job, and once gates
 *        can wait hours EVERY gated job would otherwise trip maxRuntimeMs and be
 *        requeued while its agent is alive and still waiting. Optional and
 *        fail-soft, so a missing or throwing implementation degrades to zero
 *        credit (the previous behaviour), never to a broken runner tick.
 */
// A headless card run (unattended reliability T6) lives exactly as long as its
// broker call: `headlessLive(id, entry)` answers that. The shell kills it at
// the runtime cap, so the cap plus `headlessSlackMs` is only a backstop, and an
// overrun is held, never requeued beside a process that may still be running.
// Once it has exited the card says how it went: a gate recorded during this
// run means it finished (released to idle, reopenable by reply), no gate means
// it stopped short and is held for the operator.
function headlessVerdict(entry, item, { live, now, maxRuntimeMs, slackMs }) {
  if (live) return now - entry.startedAt > maxRuntimeMs + slackMs ? { action: 'hold', reason: 'timeout' } : null;
  const gateMs = Date.parse(item.gate?.ts ?? '');
  return Number.isFinite(gateMs) && gateMs >= entry.startedAt
    ? { action: 'release', reason: 'headless run ended with a gate' }
    : { action: 'hold', reason: 'headless run exited without a gate' };
}

// Card glmps-2-0-runtime-69: liveness for a pid-less (editor-hosted) entry from
// the process-list snapshot the session guard reads ({ ts, sessions:
// [{ ticketId, sessionId }] }, session-closer.js). A claude.exe lives for the
// whole interactive session, waiting at its prompt included, so absence is
// evidence. Ended needs a sighting and then two later snapshots without it: a
// session never seen may simply not have started (a late companion pickup), and
// freeing that slot could put a second launch beside it. Both comparisons are
// strict, so a reused or stale snapshot never advances the state. The sighting
// is keyed by sessionId so a relaunch that copies the old entry starts clean.
export function pidlessLiveness(id, entry, snapshot) {
  const unchanged = { entry, ended: false };
  const sid = entry?.sessionId ? String(entry.sessionId).toLowerCase() : null;
  const ts = Number(snapshot?.ts);
  if (!sid || !Number.isFinite(ts) || !Array.isArray(snapshot.sessions) || ts < entry.startedAt) return unchanged;
  const prior = entry.liveness?.sessionId && String(entry.liveness.sessionId).toLowerCase() === sid ? entry.liveness : null;
  const present = snapshot.sessions.some((s) => s?.ticketId === id && s.sessionId && String(s.sessionId).toLowerCase() === sid);
  if (present) return { entry: { ...entry, liveness: { sessionId: entry.sessionId, seenAt: ts, missedAt: null } }, ended: false };
  if (!prior || !(ts > prior.seenAt)) return unchanged;
  if (prior.missedAt == null) return { entry: { ...entry, liveness: { ...prior, missedAt: ts } }, ended: false };
  return ts > prior.missedAt ? { entry, ended: true } : unchanged;
}

export function reconcileLedger({ ledger = {}, items = [], isAlive, now, maxRuntimeMs, maxRetries, gateWaitMs, headlessLive, headlessSlackMs = 5 * 60_000, pidlessSnapshot = null } = {}) {
  const waitFor = (id) => {
    if (typeof gateWaitMs !== 'function') return 0;
    try { const ms = Number(gateWaitMs(id)); return Number.isFinite(ms) && ms > 0 ? ms : 0; }
    catch { return 0; }
  };
  const byId = new Map(items.map(i => [i.id, i]));
  const next = {};
  const actions = [];
  for (const [id, entry] of Object.entries(ledger)) {
    const item = byId.get(id);
    // glmps-42: "no card" is NOT evidence that the job finished.
    // `backlogStore.load` fail-opens to zero items on a parse error, and a torn
    // read is reachable in normal operation (every devlog POST rewrites
    // backlog.json while this tick reads it). Dropping the entry here is not
    // cosmetic: the caller reclaims the worktree of anything that left the
    // ledger, so one unlucky read deletes a LIVE agent's checkout. Keep the
    // lease and let the runtime budget below be the only thing that ends a job
    // without an explicit finished state - that decision always has an action
    // explaining it.
    if (!item) {
      const overdue = (now - entry.startedAt - waitFor(id)) > maxRuntimeMs;
      if (!overdue) { next[id] = entry; continue; }
      if (entry.retries < maxRetries) {
        actions.push({ id, action: 'requeue', reason: 'timeout' });
        next[id] = { ...entry, retries: entry.retries + 1 };
      } else {
        actions.push({ id, action: 'hold', reason: 'timeout' });
      }
      continue;
    }
    if (FINISHED.has(item.state)) continue;
    if (entry.headless) {
      let live = true;
      try { if (typeof headlessLive === 'function') live = !!headlessLive(id, entry); } catch { live = true; }
      const v = headlessVerdict(entry, item, { live, now, maxRuntimeMs, slackMs: headlessSlackMs });
      if (!v) next[id] = entry;
      else actions.push({ id, ...v });
      continue;
    }
    // A null pid means the session is editor/companion-owned (launchSession could
    // not return a real pid); its liveness is governed by the card state and the
    // runtime timeout only, never a pid probe. Probing it would read every such
    // still-running job as "exited" and requeue it on the next tick. The
    // process-list snapshot (pidlessLiveness) is the one signal that can end it.
    let cur = entry;
    let exited = false;
    let sessionEnded = false;
    if (entry.pid != null) exited = !isAlive(entry.pid);
    else ({ entry: cur, ended: sessionEnded } = pidlessLiveness(id, entry, pidlessSnapshot));
    const overran = (now - entry.startedAt - waitFor(id)) > maxRuntimeMs;
    if (!exited && !sessionEnded && !overran) { next[id] = cur; continue; }
    const reason = overran ? 'timeout' : exited ? 'process exited' : 'session ended';
    if (entry.retries < maxRetries) {
      actions.push({ id, action: 'requeue', reason });
      // An ended session stays ended: without dropping its sighting every later
      // snapshot would requeue it again until it was held.
      const { liveness: _l, ...rest } = cur;
      next[id] = { ...(sessionEnded ? rest : cur), retries: entry.retries + 1 };
    } else {
      actions.push({ id, action: 'hold', reason });
    }
  }
  return { ledger: next, actions };
}

// The persisted ledger (runner-store.js `loadLedger`/`saveLedger`) IS the
// checkpoint at each superstep boundary; reconcileLedger IS the resume-decision
// function. Nothing about that logic changes here (see reconcileLedger above,
// unmodified). What was missing was a way to *prove* two independent loads of
// the same persisted state, reconciled against the same observed liveness,
// land on the byte-identical next action -- not just "the runner didn't crash."
//
// stableStringify sorts object keys (both outer job ids and inner entry
// fields) recursively so insertion order never perturbs the checksum --
// a fresh `loadLedger()` after a real process restart reads back a plain JS
// object from JSON.parse, whose key order is not a guaranteed decision input.
// No Date.now()/Math.random() anywhere in this path: the checksum is a pure
// function of the ledger value alone.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Pure. Deterministic checksum of a ledger's decision-relevant state (the
// same `ledger` shape reconcileLedger reads/returns). Used by the resume test
// to assert two independently-reconciled ledgers are not just deepEqual but
// hash-identical.
export function ledgerChecksum(ledger = {}) {
  return crypto.createHash('sha256').update(stableStringify(ledger), 'utf8').digest('hex');
}

// Measured across 688 real dispatches, 80% went to the generalist
// (general-purpose) while purpose-built specialists sat unused, because
// nothing in the launch path ever decided WHICH specialist a claimed card
// should name. resolveRoute is that decision, made once, so the runner owns
// it instead of hoping the launched session remembers to pick one.
export const DEFAULT_ROUTE_MIN_CONFIDENCE = 0.5;
// Was 2 until 2026-08-12. The 2 was correct when only `research` and `ui` were
// mapped: a thin-evidence match then sent a card to one of two agents that had
// no business touching it. With all eight classes mapped to agents chosen for
// them, and the launch header's devlog escape hatch for a misroute, the cost of
// a marginal wrong directive is far below the cost this gate was actually
// imposing: it discarded 27 of 79 real cards for the crime of having a
// one-line title. Measured coverage went from 15.2% to 55.7% of the corpus.
// Note this only loosens EVIDENCE, not ambiguity: minConfidence stays 0.5, and
// a cross-class tie still resolves to `other` and routes nowhere.
export const DEFAULT_ROUTE_MIN_SCORE = 1;

const NO_ROUTE = { agent: null, taskClass: null, confidence: 0, via: null };

/**
 * Decide which specialist a claimed card should name at launch.
 *
 * Every uncertainty resolves to NO_ROUTE, which reproduces the pre-routing
 * behavior exactly: a generic session with no directive. This is deliberate,
 * not a shortcut -- absent config, an unmapped class, ambiguous
 * classification, thin evidence, or a throw inside the classifier all fail
 * the same way, matching the house pattern where gates fail open.
 *
 * Two independent gates guard the classified path, and neither is sufficient
 * alone: `confidence` (maxScore / sum) rejects AMBIGUITY -- how dominant the
 * winning class is against the others -- while `score` (the winning class's
 * raw score) rejects THIN EVIDENCE. A prompt matching exactly one weak
 * keyword and nothing else scores confidence = 1/1 = 1.0, maximally
 * "confident" while resting on a single word; minScore is what catches that.
 *
 * A fresh object is returned on every path (never the shared NO_ROUTE
 * reference) so a caller mutating its result can never corrupt a later call.
 */
export function resolveRoute({ job = {}, routes = {}, minConfidence = DEFAULT_ROUTE_MIN_CONFIDENCE, minScore = DEFAULT_ROUTE_MIN_SCORE } = {}) {
  if (!routes || typeof routes !== 'object') return { ...NO_ROUTE };
  if (job.role && routes[job.role]) {
    return { agent: routes[job.role], taskClass: job.role, confidence: 1, via: 'explicit' };
  }
  let res;
  try {
    res = classifyTask({
      firstPrompt: job.prompt ?? job.title ?? '',
      filesTouched: Array.isArray(job.relevantFiles) ? job.relevantFiles : [],
    });
  } catch { return { ...NO_ROUTE }; }
  const { taskClass, confidence, score } = res ?? {};
  if (!taskClass || taskClass === 'other') return { ...NO_ROUTE };
  if (!(confidence >= minConfidence)) return { ...NO_ROUTE };
  if (!(score >= minScore)) return { ...NO_ROUTE };
  const agent = routes[taskClass];
  if (!agent) return { ...NO_ROUTE };
  return { agent, taskClass, confidence, via: 'classified' };
}
