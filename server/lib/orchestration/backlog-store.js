import fs from 'node:fs';
import path from 'node:path';
import { scanTicket } from '../governance/poison-scan.js';
import { REOPENABLE_STATES } from '../scut/reopen.js';
import { readJsonStore, writeJsonStore, JsonStoreError } from '../json-store.js';
import { normalizeModelField, parseModelDirective, DEFAULT_VENDOR } from './vendor-agents.js';

const STATES = new Set(['queued', 'held', 'in_progress', 'in_review', 'idle', 'done', 'cancelled', 'archived']);
// The one shared "is this card closed" answer (fix round 1, D27 controller
// addItem's own dedup below, scutLaunch's mirror of that dedup
// (server.js), the /api/projects backlogOpen count, and
// unmerged-branches.js's OPEN_STATES_EXCLUDED all import this instead of
// keeping their own copy, the same class of drift that let nightly-exec.js's
// FINISHED set fall out of sync with queue-runner.js's. `idle` is
// deliberately NOT here: an idle card is reopenable, so it dedups as an open
// item, counts as open backlog, and an unmerged branch it references still
// counts as referenced (not flagged as abandoned).
export const CLOSED_STATES = new Set(['done', 'cancelled', 'archived']);
// Ids are <project-slug>-<n> (e.g. harbor-app-3); legacy glmps-## ids match too
// and stay valid forever - never rewrite stored ids.
export const TICKET_ID_RE = /^[a-z0-9][a-z0-9-]*-\d+$/;
export const DEFAULT_ID_PREFIX = 'glmps';
export const GATE_STATUSES = ['PASS', 'CONCERNS', 'FAIL', 'WAIVED'];
export const GATE_RISKS = ['P0', 'P1', 'P2', 'P3'];

// Normalizers: tolerate sloppy input, never throw.
function normAC(list) {
  if (!Array.isArray(list)) return [];
  return list.map(e => {
    if (typeof e === 'string') return { text: e, done: false };
    if (e && typeof e.text === 'string') return { text: e.text, done: !!e.done };
    return null;
  }).filter(Boolean);
}
function normIds(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(v => typeof v === 'string' && TICKET_ID_RE.test(v)))];
}
// Launch mode override (unattended reliability T5): unset means the runner
// decides from lineage (queue-runner.js launchMode).
const MODES = new Set(['interactive', 'headless']);
export function validMode(v) { return v === null || MODES.has(v); }
function normMode(v) { return MODES.has(v) ? v : null; }
function normParentId(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  return TICKET_ID_RE.test(t) ? t : null;
}
function normFiles(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))].slice(0, 15);
}

// TaskSpec intent contract (glmps-69): optional per-ticket goal/boundary
// metadata, rendered into the queue-runner seed header by queue-runner.js's
// renderSpec(). All fields optional; unknown keys and invalid enum values are
// dropped (never throw) so a sloppy PATCH degrades to "no extra guidance"
// instead of an error. Absent/empty -> null, so a ticket with no spec behaves
// byte-identically to one filed before this feature existed.
const SPEC_ACTS = new Set(['act', 'assess']);
const SPEC_RISK_TIERS = new Set(['low', 'medium', 'high']);
const SPEC_PROFILES = new Set(['worker', 'critic', 'verify']);

export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const out = {};
  if (SPEC_ACTS.has(spec.act)) out.act = spec.act;
  if (SPEC_RISK_TIERS.has(spec.riskTier)) out.riskTier = spec.riskTier;
  if (SPEC_PROFILES.has(spec.profile)) out.profile = spec.profile;
  if (typeof spec.escalation === 'string' && spec.escalation.trim()) out.escalation = spec.escalation.trim();
  if (typeof spec.deliverable === 'string' && spec.deliverable.trim()) out.deliverable = spec.deliverable.trim();
  return Object.keys(out).length ? out : null;
}

// `seq` is the legacy global counter - it now backs the glmps prefix only.
// `seqs` maps every other id prefix to its own counter (absent in stores
// written before project prefixes existed; treated as {}).
export function emptyState() { return { items: [], paused: false, seq: 0, seqs: {} }; }

function now() { return new Date().toISOString(); }

// Slug a project name for use as an id prefix: lowercase, runs of
// non-alphanumerics collapse to '-', outer dashes trimmed.
export function projectSlug(project) {
  return String(project ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The id prefix for a project: its slug, or the legacy 'glmps' prefix for
// default/blank/unknown projects (keeps old numbering behavior intact).
export function idPrefixFor(project) {
  const slug = projectSlug(project);
  return (!slug || slug === 'default') ? DEFAULT_ID_PREFIX : slug;
}

// A run quota: how many completed nightly runs must exist before a held ticket
// becomes workable. Only a positive integer counts. Zero is deliberately null
// rather than "release now" - a quota of zero is just not holding the ticket,
// and letting it through here would make an obvious typo silently arm a card.
function normRunQuota(v) {
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
}

/**
 * releaseOnQuota(items, completedRuns) -> ids to release
 *
 * Which HELD tickets have had their run quota met. Pure; the caller does the
 * state change.
 *
 * glmps-60 (two nights per bake-off candidate) and -61 (three
 * consecutive nights) cannot be finished until nights have actually elapsed,
 * but leaving them `queued` with the runner live means a session picks one up
 * and finds nothing to observe. Holding them and releasing on a real count is
 * the honest version of "schedule this for after the quota is met".
 *
 * Only `held` is eligible, on purpose: a ticket somebody has already queued,
 * cancelled or finished must never be dragged back by a quota it still carries.
 */
export function releaseOnQuota(items, completedRuns) {
  if (!Number.isFinite(completedRuns)) return [];
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && i.state === 'held'
      && Number.isFinite(i.releaseAfterRuns) && i.releaseAfterRuns >= 1
      && completedRuns >= i.releaseAfterRuns)
    .map((i) => i.id);
}

function hasIntent(acceptanceCriteria) {
  return normAC(acceptanceCriteria).some(c => c.text.trim());
}

// Gap 18 (card glmps-2-0-runtime-79): a card filed by hand or by script with no
// acceptance criteria is flagged at filing, not only nudged at launch. Slack-born
// cards are exempt because the launch header grills the operator for their
// criteria in-thread; loop-diagnosis cards are filed by the kernel.
export function needsIntentAtFiling({ acceptanceCriteria, source, origin } = {}) {
  if (hasIntent(acceptanceCriteria)) return false;
  if (origin?.via === 'slack' || source === 'scut') return false;
  if (source === 'loop-diagnosis' || origin?.via === 'loop-diagnosis') return false;
  return true;
}

/**
 * @param opts.requireIntent - flag the card needsIntent when needsIntentAtFiling
 *   says so. Only the HTTP intake route opts in; internal filers are unchanged.
 * @param opts.requireFollowUpApproval - refuse a deferred card that names a
 *   parentId unless input.operatorApproved === true and input.outOfScope says
 *   why it is not part of the parent. Only the HTTP route opts in. The refusal
 *   is {state, item:null, status, error, hint?}; nothing is filed.
 * @param opts.resolveProject - optional (project) -> project, the canonical-project
 *   table (orchestration/canonical-project.js). Server intake paths pass it so an
 *   old 2.0 project name files into the canonical one; tests and other callers
 *   omit it and keep the name they gave.
 * @param opts.trust - optional 'operator'|'external' override for the poison
 *   scan's trust classification. A SEPARATE argument on purpose: it must be
 *   unreachable from the ticket body, which arrives over HTTP. Only an intake
 *   path that ran its own authorization gate may pass it (today: scutLaunch,
 *   backed by the fail-closed Slack allowlist in lib/scut/guard.js). It
 *   relaxes warn-level content only; critical always quarantines.
 */
export function addItem(state, { project, title, prompt, state: itemState, source, priority, origin,
  description, acceptanceCriteria, relevantFiles, deferredRefs, assignee, dueDate, blockedBy, spec,
  actor, requiredRole, sessionId, releaseAfterRuns, parentId, mode, operatorApproved, outOfScope, model } = {},
{ trust, requireIntent = false, requireFollowUpApproval = false, resolveProject = null } = {}) {
  const parent = normParentId(parentId);
  const reason = typeof outOfScope === 'string' ? outOfScope.trim() : '';
  if (requireFollowUpApproval && source === 'deferred' && parent) {
    if (operatorApproved !== true) {
      return { state, item: null, isNew: false, status: 409, error: 'ask-first',
        hint: `Do not file follow-ups yourself. Post the item in the parent card's thread as a numbered list with why it is not part of ${parent}, and file it only after the operator approves, with operatorApproved:true and outOfScope:<reason>.` };
    }
    if (!reason) return { state, item: null, isNew: false, status: 400, error: `say why this is not part of ${parent}` };
  }
  const named = (typeof project === 'string' && project.trim()) ? project.trim() : 'default';
  const proj = typeof resolveProject === 'function' ? (resolveProject(named) || named) : named;
  const ttl  = title ?? '';
  const src  = source ?? 'manual';

  // Dedup: if an open item with the same (project, title, source) exists, return it.
  const existing = state.items.find(
    i => i.project === proj && i.title === ttl && i.source === src && !CLOSED_STATES.has(i.state)
  );
  if (existing) return { state, item: existing, isNew: false };

  // Id allocation: glmps keeps the legacy monotonic `seq`; every other prefix
  // gets its own counter in `seqs`, guarded against ids already in the store
  // (covers hand-edits and re-homed tickets whose counter entry lags).
  const prefix = idPrefixFor(proj);
  let seq = state.seq;
  const seqs = { ...(state.seqs ?? {}) };
  let id;
  if (prefix === DEFAULT_ID_PREFIX) {
    seq = state.seq + 1;
    id = `${DEFAULT_ID_PREFIX}-${seq}`;
  } else {
    let n = (seqs[prefix] ?? 0) + 1;
    while (state.items.some(i => i.id === `${prefix}-${n}`)) n++;
    seqs[prefix] = n;
    id = `${prefix}-${n}`;
  }
  const ts = now();
  const order = state.items.reduce((m, i) => Math.max(m, i.order), 0) + 1;
  const promptText = (prompt ?? title ?? '').trim();
  const descText = typeof description === 'string' ? description : '';
  const acNorm = normAC(acceptanceCriteria);
  // Poisoning gate: scan the ticket at intake, attach provenance, and quarantine
  // anything the scanner flags as block-worthy - including description and
  // acceptanceCriteria, which buildSeedDoc also interpolates into agent seed
  // docs, so they must be covered too. Quarantined queued items are skipped by
  // the autonomous runner (pickNextJob) until an operator approves.
  const provenance = scanTicket({ title: ttl, prompt: promptText, description: descText, acceptanceCriteria: acNorm, source: src }, { trust });
  const itemState_resolved = STATES.has(itemState) ? itemState : 'queued';
  const item = {
    id,
    project: proj,
    title: ttl,
    prompt: promptText,
    state: itemState_resolved,
    source: src,
    groupId: null, order,
    priority: priority !== undefined ? priority : null,
    // Attribution to the session that filed this ticket (glmps: follow-up
    // attribution for the stage board). Set at creation; 'unknown' -> null.
    sessionId: (typeof sessionId === 'string' && sessionId.trim() && sessionId.trim() !== 'unknown') ? sessionId.trim() : null,
    branch: null, prUrl: null,
    origin: origin ?? null,   // optional handoff context, e.g. { via:'slack', channel, thread_ts, user }
    // Attribution (glmps-72 Workstream B): who/what filed this ticket. Set once
    // at creation like origin/provenance - never patchable, so it can't be
    // silently rewritten. A diagnostics covariate only; nothing here enforces
    // or branches dispatch on it.
    actor: typeof actor === 'string' && actor.trim() ? actor.trim() : null,
    // Authorization (glmps-72 B3): when set, the runner may only claim/launch
    // this ticket for an actor holding this role (no-op while cfg.actors is
    // empty - see lib/governance/actors.js gateCheck). Planner-set metadata,
    // so it IS patchable (unlike actor/provenance).
    requiredRole: typeof requiredRole === 'string' && requiredRole.trim() ? requiredRole.trim() : null,
    // The card whose agent filed this one. Set at intake only, like actor:
    // it is what makes the card secondary, so a PATCH must not clear it.
    parentId: parent,
    ...(reason && parent && source === 'deferred' ? { outOfScope: reason } : {}),
    mode: normMode(mode),
    model: intakeModel(model, ttl, promptText),
    provenance,
    quarantined: provenance.quarantined,
    activity: [], createdAt: ts, updatedAt: ts,
    description: descText,
    acceptanceCriteria: acNorm,
    // Not patchable: only criteria clear it (updateItem), so the runner can trust it.
    needsIntent: !!requireIntent && needsIntentAtFiling({ acceptanceCriteria: acNorm, source: src, origin }),
    relevantFiles: normFiles(relevantFiles),
    deferredRefs: normIds(deferredRefs),
    assignee: typeof assignee === 'string' && assignee.trim() ? assignee.trim() : null,
    dueDate: typeof dueDate === 'string' && dueDate.trim() ? dueDate.trim() : null,
    blockedBy: normIds(blockedBy),
    releaseAfterRuns: normRunQuota(releaseAfterRuns),
    spec: normalizeSpec(spec),
    devLog: [],
    gate: null,
    doneAt: itemState_resolved === 'done' ? ts : null,
    // A card born directly in 'idle' (bypassing updateItem/releaseToIdle, e.g.
    // POST /api/backlog {state:'idle'}) must stamp idleSince the same way a
    // card born 'done' stamps doneAt above - otherwise an idle-TTL check
    // reading idleSince would never fire for it.
    idleSince: itemState_resolved === 'idle' ? ts : null,
    // same reasoning, uniformly for every
    // REOPENABLE_STATES member - a card born directly in 'cancelled' or
    // 'archived' has no other stamp at all, so this is the only way
    // reopenBranch's reference time exists for it.
    stateEnteredAt: REOPENABLE_STATES.has(itemState_resolved) ? ts : null,
  };
  return { state: { ...state, items: [...state.items, item], seq, seqs }, item, isNew: true };
}

const PATCHABLE = new Set(['title', 'prompt', 'state', 'groupId', 'order', 'priority', 'sessionId', 'branch', 'prUrl',
  'description', 'acceptanceCriteria', 'relevantFiles', 'deferredRefs', 'assignee', 'dueDate', 'blockedBy', 'spec',
  'requiredRole', 'releaseAfterRuns', 'mode', 'model']);

// Card glmps-2-0-162: which vendor runs the card. A model the caller names wins;
// otherwise "use <model>" in the text is read once, here, so the operator sees
// and can edit what the runner will use. null means Claude.
function intakeModel(model, title, prompt) {
  if (model != null) { const r = normalizeModelField(model); return r.ok ? r.value : null; }
  const v = parseModelDirective(`${title}\n${prompt}`);
  return v && v !== DEFAULT_VENDOR ? v : null;
}

// Transition bookkeeping shared by every path that can change state.
// doneAt: when a card closed. idleSince: when a card was paused (D27: a
// released ticket is idle and reopenable, and a PASS-gated card idle past the
// TTL is the one automatic close, so the pause start must be recorded).
function stampDone(prev, next) {
  const ts = now();
  if (next.state === 'done' && prev.state !== 'done') next.doneAt = ts;
  if (next.state !== 'done' && prev.state === 'done') next.doneAt = null;
  if (next.state === 'idle' && prev.state !== 'idle') next.idleSince = ts;
  if (next.state !== 'idle' && prev.state === 'idle') next.idleSince = null;
  // a uniform entry stamp for EVERY reopenable
  // state (idle, done, cancelled, archived), not just idle/done -
  // reopen.js's reopenBranch needs a reference time for cancelled/archived
  // too, and reading one field is simpler for that caller than branching per
  // state. Set fresh on any transition INTO a reopenable state - even a
  // DIRECT one between two of them (idle -> cancelled), so it is never left
  // stale from the PRIOR reopenable episode - and cleared on exit. This is
  // what actually closes I4: unlike the old item.release.ts, it can never
  // carry a value left over from a previous episode.
  // Any exit from held ends a runner auto-hold, so a later operator hold is never mistaken for one.
  if (next.state !== 'held' && next.autoHeldForBlockers) next.autoHeldForBlockers = false;
  if (REOPENABLE_STATES.has(next.state)) {
    if (next.state !== prev.state) next.stateEnteredAt = ts;
  } else if (REOPENABLE_STATES.has(prev.state)) {
    next.stateEnteredAt = null;
  }
  return next;
}

export function updateItem(state, id, patch = {}) {
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i };
    for (const [k, v] of Object.entries(patch)) if (PATCHABLE.has(k)) next[k] = v;
    if ('acceptanceCriteria' in patch) {
      next.acceptanceCriteria = normAC(patch.acceptanceCriteria);
      // D32 G3: rewritten criteria are a restated intent, so the failure count restarts.
      if (i.gate) next.gate = { ...i.gate, failStreak: 0, reintent: false };
      if (next.needsIntent && hasIntent(next.acceptanceCriteria)) next.needsIntent = false;
    }
    if ('relevantFiles' in patch) next.relevantFiles = normFiles(patch.relevantFiles);
    if ('deferredRefs' in patch) next.deferredRefs = normIds(patch.deferredRefs);
    if ('blockedBy' in patch) next.blockedBy = normIds(patch.blockedBy);
    if ('releaseAfterRuns' in patch) next.releaseAfterRuns = normRunQuota(patch.releaseAfterRuns);
    if ('spec' in patch) next.spec = normalizeSpec(patch.spec);
    if ('mode' in patch) next.mode = normMode(patch.mode);
    if ('model' in patch) { const r = normalizeModelField(patch.model); next.model = r.ok ? r.value : (i.model ?? null); }
    // Moving a card between boards keeps its id (ids are unique board-wide;
    // only new ids take the project prefix). A blank value is ignored rather
    // than clearing the column, since a card always belongs to one.
    if (typeof patch.project === 'string' && patch.project.trim()) next.project = patch.project.trim();
    stampDone(i, next);
    next.updatedAt = now();
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// glmps-2-0-163: a spawned card whose host closed is promoted so the operator
// can manage it: it opens interactively, and the Slack channel the server just
// opened for it becomes its origin. Origin stays outside PATCHABLE (a PATCH
// skips the intake scan), so only this server-side path rewrites it.
export function promoteItem(state, id, { from = null, origin = null, requeue = false } = {}) {
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i, mode: 'interactive', promoted: { from, at: now() } };
    if (origin?.via === 'slack' && origin.channel && origin.thread_ts) next.origin = { ...origin };
    if (requeue) next.state = 'queued';
    stampDone(i, next);
    next.updatedAt = now();
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// The channel the server opened for a card at an interactive launch becomes
// its origin, so the launch header gives the session the park loop.
export function setChannelOrigin(state, id, origin) {
  if (!(origin?.via === 'slack' && origin.channel && origin.thread_ts)) return { state, item: null };
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    item = { ...i, origin: { ...origin }, updatedAt: now() };
    return item;
  });
  return { state: { ...state, items }, item };
}

// The runner's hold for open blockers. The flag is deliberately outside
// PATCHABLE: it licenses the runner to release the card later, so only the
// runner may set it.
export function holdForBlockers(state, id) {
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = stampDone(i, { ...i, state: 'held', autoHeldForBlockers: true });
    next.updatedAt = now();
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// glmps-2-0-171: make `hostId` the host of existing cards (a card that re-cuts
// or files cards owns them). parentId is outside PATCHABLE, so this is the only
// way an existing card changes parent. Refused per id with a reason.
export function adoptItem(state, hostId, ids = []) {
  const host = state.items.find(i => i.id === hostId);
  if (!host) return { state, adopted: [], refused: [], error: 'host not found' };
  const byId = new Map(state.items.map(i => [i.id, i]));
  const refused = [];
  const adopted = [];
  if (CLOSED_STATES.has(host.state)) {
    return { state, adopted, refused: ids.map(id => ({ id, reason: 'host is closed' })) };
  }
  const ancestors = new Set();
  for (let p = host.parentId; p && !ancestors.has(p); p = byId.get(p)?.parentId) ancestors.add(p);
  for (const id of ids) {
    const child = byId.get(id);
    let reason = null;
    if (!child) reason = 'card not found';
    else if (id === hostId) reason = 'a card cannot host itself';
    else if (CLOSED_STATES.has(child.state)) reason = 'card is closed';
    else if (ancestors.has(id)) reason = 'card is an ancestor of the host';
    else if (child.parentId === hostId) reason = 'already hosted by this card';
    else if (child.parentId && byId.has(child.parentId) && !CLOSED_STATES.has(byId.get(child.parentId).state)) {
      reason = `hosted by ${child.parentId}, which is open`;
    }
    if (reason) refused.push({ id, reason }); else adopted.push(id);
  }
  if (!adopted.length) return { state, adopted, refused };
  const at = now();
  const items = state.items.map(i => {
    if (i.id === hostId) {
      return { ...i, devLog: [...(i.devLog ?? []), { ts: at, by: 'adopt', text: `adopted ${adopted.join(', ')}` }], updatedAt: at };
    }
    if (adopted.includes(i.id)) {
      return { ...i, parentId: hostId, devLog: [...(i.devLog ?? []), { ts: at, by: 'adopt', text: `adopted by ${hostId}${i.parentId ? ` (was ${i.parentId})` : ''}` }], updatedAt: at };
    }
    return i;
  });
  return { state: { ...state, items }, adopted, refused };
}

// The operator's approval for test edits on a debug card. Outside PATCHABLE:
// it unlocks the test-file guard, so only the operator-gated route writes it.
export function setTestEditsApproval(state, id, approval) {
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i, testEditsApproved: approval || null, updatedAt: now() };
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// The agent's own stated reason for editing existing tests on a debug card.
// Any caller may set it (the route validates); it does not unlock the token case.
export function setTestEditsDeclaration(state, id, declaration) {
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i, testEditsDeclared: declaration || null, updatedAt: now() };
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// AO sends label-only deltas; interpret them into our state + activity.
export function applyLabelDelta(state, id, { labels = [], removeLabels = [], comment } = {}) {
  let derived = null;
  if (labels.includes('agent:backlog')) derived = 'queued';
  if (labels.includes('agent:in-progress')) derived = 'in_progress';
  if (labels.includes('merged-unverified') || labels.includes('agent:done')) derived = 'done';
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i };
    if (derived) next.state = derived;
    if (comment) next.activity = [...i.activity, { ts: now(), text: comment }];
    stampDone(i, next);
    next.updatedAt = now();
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// Operator-only release of a poison-quarantined ticket. Deliberately NOT part of
// updateItem's PATCHABLE set, so a generic PATCH cannot silently clear the gate;
// releasing a held ticket is an explicit, logged human action.
export function approveItem(state, id) {
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i, quarantined: false, updatedAt: now() };
    next.activity = [...(i.activity || []), { ts: now(), text: 'poison-quarantine approved by operator' }];
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// D27: every stale, TTL, eviction or stop release parks the card as idle,
// never done. Not in PATCHABLE: the release record is written only by the
// release path, so a generic PATCH cannot forge why a card was paused.
export function releaseToIdle(state, id, { kind, why } = {}) {
  let item = null;
  const items = state.items.map((i) => {
    if (i.id !== id) return i;
    const ts = now();
    const next = { ...i, state: 'idle', release: { kind: String(kind ?? 'unknown'), why: String(why ?? ''), ts }, updatedAt: ts };
    stampDone(i, next);
    next.activity = [...(i.activity ?? []), { ts, text: `scut:released (${next.release.kind}): ${next.release.why}` }];
    item = next;
    return next;
  });
  return { state: item ? { ...state, items } : state, item };
}

// glmps-15: a ticket moved to 'done' whose gate was never recorded
// PASS or WAIVED is a "gate-less close" - work marked complete without a recorded
// passing (or explicitly waived) verification, exactly what the queue-runner seed
// doc asks the launched session to avoid. Surfaced, NOT blocked: the agent:done
// transition stays permissive (manual/operator closes must still work); this only
// lets the board flag closes that skipped the gate.
export function isGatelessDone(item) {
  if (!item || item.state !== 'done') return false;
  const status = item.gate && item.gate.status;
  return status !== 'PASS' && status !== 'WAIVED';
}

export function gatelessDoneIds(items = []) {
  return (Array.isArray(items) ? items : []).filter(isGatelessDone).map((i) => i.id);
}

// glmps-2-0-191: a card closed (done, cancelled, archived) while its PR is still
// open is work marked finished that never landed (card 158 closed with PR #121
// unmerged). A card's PR is its prUrl or its merge request's PR. PR state needs
// GitHub, so the caller supplies `prStates` (prUrl -> 'OPEN' | 'MERGED' | ...);
// a url the map does not know is not flagged (fail open).
export function cardPrUrls(item) {
  const urls = [item?.prUrl, item?.mergeRequest?.prUrl].filter((u) => typeof u === 'string' && u.trim());
  return [...new Set(urls)];
}

const prKey = (url) => String(url ?? '').trim().toLowerCase();

export function closedWithOpenPrIds(items = [], prStates = null) {
  if (!Array.isArray(items) || !(prStates instanceof Map) || !prStates.size) return [];
  const open = new Set([...prStates].filter(([, s]) => String(s).toUpperCase() === 'OPEN').map(([u]) => prKey(u)));
  return items
    .filter((i) => i && CLOSED_STATES.has(i.state) && cardPrUrls(i).some((u) => open.has(prKey(u))))
    .map((i) => i.id);
}

export function setPaused(state, paused) { return { ...state, paused: !!paused }; }

export function listItems(state, { project, status } = {}) {
  if (status === 'queued' && state.paused) return [];
  return state.items.filter(i =>
    (project == null || i.project === project) &&
    (status == null || i.state === status));
}

// Storage (card glmps-2-0-runtime-68). store.json is a snapshot and the changes
// since it are an append-only log, so a write costs O(change) instead of
// rewriting a multi-megabyte board. Log records are whole values
// ({t:'put',item} | {t:'del',id} | {t:'meta',meta}), so replaying one twice is
// harmless. The snapshot names its log generation (logGen) and only
// store.<logGen>.log is replayed: a restored backup can never pick up a log
// that was written on top of a different snapshot.
function dirOf(stateDir) { return path.join(stateDir, 'backlog'); }
function file(stateDir) { return path.join(dirOf(stateDir), 'store.json'); }
function logFile(stateDir, gen) { return path.join(dirOf(stateDir), `store.${gen}.log`); }
const LOG_RE = /^store\.(.+)\.log$/;
const DEFAULT_COMPACT_BYTES = 8 * 1024 * 1024;
function compactBytes() {
  const n = Number(process.env.GLMPS_BACKLOG_COMPACT_BYTES);
  return n > 0 ? n : DEFAULT_COMPACT_BYTES;
}
function newGen() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

// Versions restart at 1 with the process, so a client compares epochs first.
export const BOARD_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// One parsed board per process, shared by load() and the dashboard read path.
// Cards are deep-frozen because load() hands out the cached objects: a caller
// that edits one in place throws instead of silently diverging from disk.
const caches = new Map();
function cacheFor(stateDir) {
  let c = caches.get(stateDir);
  if (!c) {
    c = { snapKey: null, gen: null, offset: 0, seen: 0, partial: false, meta: metaOf(emptyState()), items: [], index: new Map(),
      loadError: null, version: 1, view: null, memo: new Map(), pending: new Set(), lastTaken: 1 };
    caches.set(stateDir, c);
  }
  return c;
}
export function dropCache(stateDir) { caches.delete(stateDir); }

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}
function metaOf(state) {
  const { items, loadError, logGen, ...meta } = state ?? {};
  return meta;
}
function indexOf(items) { return new Map(items.map((it, k) => [it.id, k])); }
// Every snapshot is a rename of a fresh temp file, so the file id moves on each
// one even when a coarse clock leaves mtime equal and a same-length logGen
// leaves size equal (card glmps-2-0-222). Bigint keeps a 64-bit NTFS id exact.
function statKey(f) {
  try { const s = fs.statSync(f, { bigint: true }); return `${s.ino}:${s.mtimeNs}:${s.size}`; } catch { return 'missing'; }
}

// A read that fails for any reason other than ENOENT serves an empty board
// TAGGED with `loadError`, so dashboard readers keep working while every
// writer (all of which load -> mutate -> save) is stopped by save() instead of
// persisting the empty board over the real one. The tag is an own enumerable
// property on purpose: the mutators return `{ ...state, items }`, and a
// non-enumerable or symbol tag would not survive that spread.
function fullLoad(stateDir, c) {
  c.snapKey = statKey(file(stateDir));
  c.offset = 0; c.seen = 0; c.partial = false;
  try {
    const base = { ...emptyState(), ...readJsonStore(file(stateDir), { fallback: {} }) };
    c.gen = typeof base.logGen === 'string' ? base.logGen : null;
    c.items = (Array.isArray(base.items) ? base.items : []).map(deepFreeze);
    c.index = indexOf(c.items);
    c.meta = deepFreeze(metaOf(base));
    c.loadError = null;
    if (c.gen) readTail(stateDir, c);
  } catch (e) {
    console.error(`[backlog-store] load failed, serving an empty read-only board: ${e.message}`);
    c.gen = null; c.items = []; c.index = new Map(); c.meta = metaOf(emptyState());
    c.loadError = { code: e.code ?? null, message: e.message };
  }
}

// Applies the complete lines past c.offset. Returns what changed, or null when
// the log shrank under us (rewritten by someone else: reload in full). A line
// that does not parse is a torn append from a crash; it is skipped, and the
// next append starts on a fresh line so it cannot be glued onto it.
function readTail(stateDir, c) {
  const f = logFile(stateDir, c.gen);
  let buf;
  let fd;
  try { fd = fs.openSync(f, 'r'); } catch (e) {
    if (e?.code === 'ENOENT') { c.seen = 0; return c.offset === 0 ? { ids: [], pausedMoved: false } : null; }
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < c.offset) return null;
    c.seen = size;
    buf = Buffer.alloc(size - c.offset);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, c.offset);
  } finally { fs.closeSync(fd); }
  const end = buf.lastIndexOf(0x0a);
  c.partial = end !== buf.length - 1;
  if (end < 0) return { ids: [], pausedMoved: false };
  c.offset += end + 1;
  const records = [];
  let torn = 0;
  for (const line of buf.toString('utf8', 0, end).split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { torn += 1; }
  }
  if (torn) console.error(`[backlog-store] skipped ${torn} torn line(s) in ${path.basename(f)}`);
  return applyRecords(c, records);
}

function applyRecords(c, records) {
  const items = c.items.slice();
  const index = c.index;
  const ids = [];
  let removed = false;
  let pausedMoved = false;
  for (const r of records) {
    if (r?.t === 'put' && r.item && r.item.id != null) {
      const it = deepFreeze(r.item);
      const k = index.get(it.id);
      if (k === undefined) { index.set(it.id, items.length); items.push(it); } else items[k] = it;
      ids.push(it.id);
    } else if (r?.t === 'del') {
      const k = index.get(r.id);
      if (k !== undefined) { items[k] = undefined; index.delete(r.id); removed = true; }
      ids.push(r.id);
    } else if (r?.t === 'meta' && r.meta) {
      if (!!r.meta.paused !== !!c.meta.paused) pausedMoved = true;
      c.meta = deepFreeze(r.meta);
    }
  }
  c.items = removed ? items.filter((it) => it !== undefined) : items;
  if (removed) c.index = indexOf(c.items);
  return { ids, pausedMoved };
}

function changed(c, r) {
  if (r && !r.ids.length && !r.pausedMoved) return;
  c.version += 1;
  c.view = null;
  c.memo = new Map();
  if (!r || r.pausedMoved || c.pending === null) c.pending = null;
  else for (const id of r.ids) c.pending.add(id);
}

// Brings the cache up to date with disk: nothing to do when neither file
// moved, the log tail when only the log grew (an append by this or another
// process), a full reload when the snapshot changed.
function sync(stateDir) {
  const c = cacheFor(stateDir);
  const first = c.snapKey === null;
  if (first || statKey(file(stateDir)) !== c.snapKey) {
    fullLoad(stateDir, c);
    if (!first) changed(c, null);
    return c;
  }
  if (!c.gen) return c;
  let size;
  try { size = fs.statSync(logFile(stateDir, c.gen)).size; } catch { size = 0; }
  if (size === c.seen) return c;
  let r;
  try { r = readTail(stateDir, c); } catch (e) {
    console.error(`[backlog-store] log read failed, serving the last good board: ${e.message}`);
    return c;
  }
  if (r === null) { fullLoad(stateDir, c); changed(c, null); } else changed(c, r);
  return c;
}

export function load(stateDir) {
  const c = sync(stateDir);
  if (c.loadError) return { ...emptyState(), loadError: { ...c.loadError } };
  return { ...c.meta, items: c.items.slice() };
}

// Writes `state` as a new snapshot with a fresh log generation. The previous
// snapshot becomes store.json.bak and its log is kept beside it, so restoring
// the backup restores a consistent board. Used for migration (a legacy store
// has no generation), a reordered items array, and size-triggered compaction.
function writeSnapshot(stateDir, c, state) {
  const prevGen = c.gen;
  const prevOffset = c.offset;
  const gen = newGen();
  const items = state.items ?? [];
  const meta = metaOf(state);
  // Every generation has its log file from the start, empty until the next write.
  fs.mkdirSync(dirOf(stateDir), { recursive: true });
  fs.writeFileSync(logFile(stateDir, gen), '', { flag: 'a' });
  // A store that failed to read is never copied over the last good backup.
  writeJsonStore(file(stateDir), { items, ...meta, logGen: gen }, { space: 2, backup: !c.loadError });
  const ids = [];
  const seen = new Set();
  const next = items.map((it) => {
    seen.add(it.id);
    const k = c.index.get(it.id);
    if (k !== undefined && c.items[k] === it) return it;
    ids.push(it.id);
    return deepFreeze(JSON.parse(JSON.stringify(it)));
  });
  for (const it of c.items) if (!seen.has(it.id)) ids.push(it.id);
  const pausedMoved = !!meta.paused !== !!c.meta.paused || !!c.loadError;
  c.items = next; c.index = indexOf(next); c.meta = deepFreeze(JSON.parse(JSON.stringify(meta)));
  c.gen = gen; c.offset = 0; c.seen = 0; c.partial = false; c.loadError = null;
  c.snapKey = statKey(file(stateDir));
  // Another process may have appended to the old log after this one last read
  // it; carry those lines into the new generation rather than drop them.
  if (prevGen) {
    try {
      const old = fs.readFileSync(logFile(stateDir, prevGen));
      const end = old.lastIndexOf(0x0a);
      if (end + 1 > prevOffset) fs.appendFileSync(logFile(stateDir, gen), old.subarray(prevOffset, end + 1), { flush: true });
    } catch { /* no old log: nothing to carry */ }
  }
  for (const f of fs.readdirSync(dirOf(stateDir))) {
    const m = LOG_RE.exec(f);
    if (m && m[1] !== gen && m[1] !== prevGen) { try { fs.unlinkSync(path.join(dirOf(stateDir), f)); } catch { /* busy: the next compaction retries */ } }
  }
  const r = readTail(stateDir, c);
  changed(c, { ids: [...ids, ...(r?.ids ?? [])], pausedMoved: pausedMoved || !!r?.pausedMoved });
}

export function compact(stateDir) {
  const c = sync(stateDir);
  if (c.loadError) {
    throw new JsonStoreError(`refusing to compact a backlog that failed to load: ${c.loadError.message}`, {
      file: file(stateDir), code: c.loadError.code ?? 'ELOADFAILED',
    });
  }
  writeSnapshot(stateDir, c, { ...c.meta, items: c.items });
}

export function save(stateDir, state) {
  if (state?.loadError) {
    throw new JsonStoreError(`refusing to save a backlog that failed to load: ${state.loadError.message}`, {
      file: file(stateDir), code: state.loadError.code ?? 'ELOADFAILED',
    });
  }
  const c = sync(stateDir);
  if (c.loadError || !c.gen) return writeSnapshot(stateDir, c, state);
  // Diff by identity: the mutators copy only the cards they change, so a card
  // that is still the cached object is unchanged and costs one compare.
  const lines = [];
  const seen = new Set();
  let lastK = -1;
  let sawNew = false;
  let reordered = false;
  for (const it of state.items ?? []) {
    if (seen.has(it.id)) { reordered = true; break; }
    seen.add(it.id);
    const k = c.index.get(it.id);
    if (k === undefined) { sawNew = true; lines.push(`{"t":"put","item":${JSON.stringify(it)}}`); continue; }
    if (sawNew || k < lastK) { reordered = true; break; }
    lastK = k;
    if (c.items[k] !== it) lines.push(`{"t":"put","item":${JSON.stringify(it)}}`);
  }
  if (reordered) return writeSnapshot(stateDir, c, state);
  for (const it of c.items) if (!seen.has(it.id)) lines.push(JSON.stringify({ t: 'del', id: it.id }));
  const meta = metaOf(state);
  if (JSON.stringify(meta) !== JSON.stringify(c.meta)) lines.push(JSON.stringify({ t: 'meta', meta }));
  if (!lines.length) return;
  fs.appendFileSync(logFile(stateDir, c.gen), `${c.partial ? '\n' : ''}${lines.join('\n')}\n`, { flush: true });
  // Another process may have compacted between our sync and our append; it
  // renames the new snapshot in before copying the old log, so a moved snapshot
  // here means the lines may sit in a log nothing replays. Records are whole
  // values, so writing them again into the live generation is safe.
  for (let tries = 0; statKey(file(stateDir)) !== c.snapKey && tries < 5; tries += 1) {
    fullLoad(stateDir, c); changed(c, null);
    if (c.loadError || !c.gen) break;
    fs.appendFileSync(logFile(stateDir, c.gen), `${c.partial ? '\n' : ''}${lines.join('\n')}\n`, { flush: true });
  }
  // Read back what was written (plus anything another process appended in
  // between), so the cache holds exactly what is on disk.
  const r = readTail(stateDir, c);
  if (r === null) { fullLoad(stateDir, c); changed(c, null); } else changed(c, r);
  if (c.offset > compactBytes()) writeSnapshot(stateDir, c, { ...c.meta, items: c.items });
}

// Read-side view for the dashboard's hot path: every reader shares one parsed
// board per version. Callers must not mutate the returned state.
export function readView(stateDir) {
  const c = sync(stateDir);
  if (!c.view) c.view = c.loadError ? { ...emptyState(), loadError: { ...c.loadError } } : { ...c.meta, items: c.items };
  return c.view;
}

export function memoView(stateDir, name, make) {
  const c = sync(stateDir);
  if (!c.memo.has(name)) c.memo.set(name, make());
  return c.memo.get(name);
}

export function boardVersion(stateDir) { return sync(stateDir).version; }

export function countsByState(stateDir) {
  return memoView(stateDir, 'counts', () => {
    const counts = {};
    for (const i of readView(stateDir).items) counts[i.state] = (counts[i.state] ?? 0) + 1;
    return counts;
  });
}

// Drains the card ids saved since the last call. ids is null when the change
// cannot be named (the snapshot was replaced, or the board-level fields moved);
// the reader then refetches the whole board.
export function takeChanges(stateDir) {
  const c = sync(stateDir);
  const ids = c.pending === null ? null : [...c.pending];
  const out = { epoch: BOARD_EPOCH, version: c.version, prev: c.lastTaken, ids };
  c.pending = new Set();
  c.lastTaken = c.version;
  return out;
}

export function itemsByIds(stateDir, ids) {
  const c = sync(stateDir);
  const items = []; const removed = [];
  for (const id of ids) { const k = c.index.get(id); if (k !== undefined) items.push(c.items[k]); else removed.push(id); }
  return { items, removed };
}

export function reorderItems(state, { ids = [], status, project } = {}) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  const setStatus = STATES.has(status) ? status : null;
  const touched = [];
  const items = state.items.map(i => {
    if (!pos.has(i.id)) return i;
    const next = { ...i, order: pos.get(i.id), updatedAt: now() };
    if (setStatus) next.state = setStatus;
    stampDone(i, next);
    touched.push(next);
    return next;
  });
  touched.sort((a, b) => a.order - b.order);
  return { state: { ...state, items }, items: touched };
}

export function removeItem(state, id) {
  const items = state.items.filter(i => i.id !== id);
  return { state: { ...state, items }, removed: items.length !== state.items.length };
}

// Agent-authored, append-only. Deliberately NOT in PATCHABLE (like approveItem):
// a generic PATCH must never forge or rewrite the log.
export function appendDevLog(state, id, { by, text } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return { state, item: null, error: 'empty text' };
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const entry = { ts: now(), by: typeof by === 'string' && by.trim() ? by.trim() : null, text: t };
    item = { ...i, devLog: [...(i.devLog ?? []), entry], updatedAt: now() };
    return item;
  });
  return { state: { ...state, items }, item };
}

// D32 G2: a card's acceptance criteria are its intent, so a PASS whose evidence
// never names one of them has not shown the intent was met. Matched by number
// (AC-2, ac 2, AC2) because that is how the working agreement asks agents to
// cite them; the lookahead keeps AC-10 from counting as AC-1.
export function uncitedAC(acceptanceCriteria, evidence) {
  const text = (Array.isArray(evidence) ? evidence : []).join('\n');
  const missing = [];
  (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).forEach((_, i) => {
    if (!new RegExp(`\\bAC[-\\s]?${i + 1}(?!\\d)`, 'i').test(text)) missing.push(`AC-${i + 1}`);
  });
  return missing;
}

// D32 G3: two failed gates in a row means retrying is not converging, and the
// likelier fault is the intent, which only the operator can restate.
const REINTENT_AFTER = 2;

// The agent's close summary (card glmps-2-0-104), carried into the closing
// post in the operator's main channel; capped so one card cannot flood it.
export const GATE_SUMMARY_MAX = 600;

export function setGate(state, id, { status, evidence, risk, by, summary } = {}) {
  if (!GATE_STATUSES.includes(status)) return { state, item: null, error: `status must be one of ${GATE_STATUSES.join('|')}` };
  if (risk != null && !GATE_RISKS.includes(risk)) return { state, item: null, error: `risk must be one of ${GATE_RISKS.join('|')}` };
  const ev = Array.isArray(evidence) ? evidence.filter(e => typeof e === 'string' && e.trim()).map(e => e.trim()) : [];
  const sum = typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, GATE_SUMMARY_MAX) : null;
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const missingAC = status === 'PASS' ? uncitedAC(i.acceptanceCriteria, ev) : [];
    const recorded = missingAC.length ? 'CONCERNS' : status;
    const failStreak = recorded === 'FAIL' || recorded === 'CONCERNS' ? (i.gate?.failStreak ?? 0) + 1 : 0;
    const g = { status: recorded, evidence: ev, risk: risk ?? null, by: typeof by === 'string' && by.trim() ? by.trim() : null, ts: now(),
      failStreak, reintent: failStreak >= REINTENT_AFTER };
    if (sum) g.summary = sum;
    if (missingAC.length) Object.assign(g, { requested: status, missingAC });
    item = { ...i, gate: g, updatedAt: now() };
    return item;
  });
  return { state: { ...state, items }, item };
}

// The one-line verdict relayed to the card's chat thread.
export function gateRelayText(gate = {}, risk) {
  let t = `gate ${gate.status}`;
  if (risk) t += ` (risk ${risk})`;
  if (gate.requested && gate.requested !== gate.status) {
    t += ` (${gate.requested} recorded as ${gate.status}: ${(gate.missingAC ?? []).join(', ')} not cited in the evidence)`;
  }
  if (gate.reintent) {
    t += `. ${gate.failStreak} failed gates in a row: retries stop until you restate what done means. ` +
      'Reply with the corrected goal or acceptance criteria.';
  }
  return t;
}

// The session a runner job actually ran in (C2). Written by the runner when it
// first sees the job's session, read by reopen-by-reply. Not in PATCHABLE and
// separate from `sessionId` (the session that FILED the card). A relaunch
// replaces sessionId, so the ids it replaced move to previousSessionIds: the
// session-to-card join still has to name the card for the earlier runs
// (glmps-190).
export function setRunSession(state, id, patch = {}) {
  let item = null;
  const items = state.items.map((i) => {
    if (i.id !== id) return i;
    const prev = i.runSession ?? {};
    const next = { ...prev, ...patch };
    const sid = patch.sessionId;
    if (sid && prev.sessionId && sid !== prev.sessionId) {
      next.previousSessionIds = [...(prev.previousSessionIds ?? []), prev.sessionId].filter((s, k, a) => s !== sid && a.indexOf(s) === k);
    } else if (prev.previousSessionIds) {
      next.previousSessionIds = prev.previousSessionIds;
    }
    item = { ...i, runSession: next, updatedAt: now() };
    return item;
  });
  return { state: item ? { ...state, items } : state, item };
}
export function setRunSessionIn(stateDir, id, patch) { const r = setRunSession(load(stateDir), id, patch); if (r.item) save(stateDir, r.state); return r; }

// Lifecycle: done items age out to archived after `days` (0/negative disables).
export function sweepArchive(state, { days = 7, now: nowMs = Date.now() } = {}) {
  if (!(days > 0)) return { state, moved: [] };
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const moved = [];
  const items = state.items.map(i => {
    if (i.state !== 'done' || !i.doneAt) return i;
    if (Date.parse(i.doneAt) > cutoff) return i;
    moved.push(i.id);
    // route the done -> archived move through stampDone so
    // stateEnteredAt is the archive time and doneAt is cleared, exactly as an
    // updateItem to archived would (reopenBranch reads stateEnteredAt).
    return stampDone(i, {
      ...i, state: 'archived', updatedAt: now(),
      activity: [...(i.activity ?? []), { ts: now(), text: `auto-archived after ${days} day(s) in done` }],
    });
  });
  return moved.length ? { state: { ...state, items }, moved } : { state, moved };
}

// The merge request is server-written (merge-queue.js decides every stage), so
// like gate and devLog it is deliberately not in PATCHABLE.
export function setMergeRequest(state, id, mergeRequest) {
  let item = null;
  const items = state.items.map((i) => {
    if (i.id !== id) return i;
    item = { ...i, mergeRequest, updatedAt: now() };
    return item;
  });
  return { state: item ? { ...state, items } : state, item };
}

// Which merged PR covered each acceptance criterion (runtime-9-a). Server-written
// like the merge request, so not in PATCHABLE; keyed by AC number.
export function recordCoverage(state, id, { covers = [], prUrl, mergeSha = null, at } = {}) {
  let item = null;
  const items = state.items.map((i) => {
    if (i.id !== id) return i;
    const coverage = { ...(i.coverage ?? {}) };
    for (const n of covers) coverage[n] = { prUrl, mergeSha, at };
    item = { ...i, coverage, updatedAt: now() };
    return item;
  });
  return { state: item ? { ...state, items } : state, item };
}

// One record per card run, for comparing models across cards (card
// glmps-2-0-162). Runner-written, so not in PATCHABLE; the newest RUNS_MAX kept.
const RUNS_MAX = 50;
export function appendRun(state, id, run) {
  let item = null;
  const items = state.items.map((i) => {
    if (i.id !== id) return i;
    item = { ...i, runs: [...(i.runs ?? []), run].slice(-RUNS_MAX), updatedAt: now() };
    return item;
  });
  return { state: item ? { ...state, items } : state, item };
}

// Findings waiting for the author's next launch (server-written, so not in PATCHABLE).
export function setPendingReopen(state, id, pending) {
  let item = null;
  const items = state.items.map((i) => {
    if (i.id !== id) return i;
    item = { ...i, pendingReopen: pending ?? null, updatedAt: now() };
    return item;
  });
  return { state: item ? { ...state, items } : state, item };
}

export function appendRunIn(stateDir, id, run) { const r = appendRun(load(stateDir), id, run); if (r.item) save(stateDir, r.state); return r; }
export function setPendingReopenIn(stateDir, id, pending) { const r = setPendingReopen(load(stateDir), id, pending); if (r.item) save(stateDir, r.state); return r; }
export function recordCoverageIn(stateDir, id, cov) { const r = recordCoverage(load(stateDir), id, cov); if (r.item) save(stateDir, r.state); return r; }
export function setMergeRequestIn(stateDir, id, mergeRequest) { const r = setMergeRequest(load(stateDir), id, mergeRequest); if (r.item) save(stateDir, r.state); return r; }
export function approveItemIn(stateDir, id) { const r = approveItem(load(stateDir), id); save(stateDir, r.state); return r; }
export function releaseToIdleIn(stateDir, id, rel) { const r = releaseToIdle(load(stateDir), id, rel); if (r.item) save(stateDir, r.state); return r; }
export function addItemTo(stateDir, input, opts) { const r = addItem(load(stateDir), input, opts); save(stateDir, r.state); return r; }
export function promoteItemIn(stateDir, id, opts) { const r = promoteItem(load(stateDir), id, opts); if (r.item) save(stateDir, r.state); return r; }
export function adoptItemIn(stateDir, hostId, ids) { const r = adoptItem(load(stateDir), hostId, ids); if (r.adopted.length) save(stateDir, r.state); return r; }
export function setChannelOriginIn(stateDir, id, origin) { const r = setChannelOrigin(load(stateDir), id, origin); if (r.item) save(stateDir, r.state); return r; }
export function holdForBlockersIn(stateDir, id) { const r = holdForBlockers(load(stateDir), id); if (r.item) save(stateDir, r.state); return r; }
export function setTestEditsApprovalIn(stateDir, id, approval) { const r = setTestEditsApproval(load(stateDir), id, approval); if (r.item) save(stateDir, r.state); return r; }
export function setTestEditsDeclarationIn(stateDir, id, declaration) { const r = setTestEditsDeclaration(load(stateDir), id, declaration); if (r.item) save(stateDir, r.state); return r; }
export function updateItemIn(stateDir, id, patch) { const r = updateItem(load(stateDir), id, patch); save(stateDir, r.state); return r; }
export function applyLabelDeltaIn(stateDir, id, delta) { const r = applyLabelDelta(load(stateDir), id, delta); save(stateDir, r.state); return r; }
export function setPausedIn(stateDir, paused) { const s = setPaused(load(stateDir), paused); save(stateDir, s); return s; }
export function listFrom(stateDir, filters) { return listItems(load(stateDir), filters); }
export function reorderItemsIn(stateDir, payload) { const r = reorderItems(load(stateDir), payload); save(stateDir, r.state); return { items: r.items }; }
export function removeItemIn(stateDir, id) { const r = removeItem(load(stateDir), id); save(stateDir, r.state); return { removed: r.removed }; }
export function appendDevLogIn(stateDir, id, entry) { const r = appendDevLog(load(stateDir), id, entry); if (r.item) save(stateDir, r.state); return r; }
export function setGateIn(stateDir, id, gate) { const r = setGate(load(stateDir), id, gate); if (r.item) save(stateDir, r.state); return r; }
export function sweepArchiveIn(stateDir, opts) { const r = sweepArchive(load(stateDir), opts); if (r.moved.length) save(stateDir, r.state); return r; }
