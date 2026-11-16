// server/lib/evaluation/learning-store.js
// Learning queue: pure model transforms + fs wrappers.
// Zero runtime dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recordShadow } from './shadow-arm.js';

// emptyState

// Guard proposer cutover: `config.autoApplyGaps` is
// retired. gap-pipeline.js's upsertGapAndApply never read it after Task 10
// deleted the auto-apply-with-template branch, so the switch had been inert
// since that commit; this removes the now-meaningless field from the shape
// itself rather than leaving a dead knob nobody can turn to any effect.
// `config` stays a plain extension point for a future setting.
export function emptyState() {
  return { items: [], config: {}, seq: 0 };
}

// sha1(str) - stable hex digest for dedup keys

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

// normalizeProject(p) -> canonical project key
//
// The three store writers spell `project` differently for the SAME repo:
//   live /api/state -> raw cwd            "D:\\proj"
//   Stop-hook feeder -> (now) raw cwd     "D:\\proj"
//   SessionStart synth -> projects slug   "D--glmps"
// Map all of them to the ~/.claude/projects dir-slug form so dedupKey collapses
// them to one row. The slug replaces every non-alphanumeric char with '-', which
// is exactly how Claude Code names its projects/ subdirectories, and is idempotent
// on an already-slugged value (D--glmps -> D--glmps).

export function normalizeProject(p) {
  return String(p ?? '').replace(/[^A-Za-z0-9]/g, '-');
}

// projectKey(p) -> canonical project key, with worktrees folded into their repo
//
// Card glmps-2-0-82: keying on the raw cwd gave every worktree its own row per
// gap code (174 of 196 keys were worktrees, 571 of 646 pending rows). A live
// linked worktree has a .git FILE pointing at <repo>/.git/worktrees/<name>, so
// walking up to it finds the parent repo for any worktree layout. A gone dir or
// an already-slugged value falls back to stripping the .claude/worktrees part.
//
// Card glmps-2-0-runtime-101 (scan F1): a path from a paired client names the
// client's disk, so with a clientId the key is a client-namespaced slug and no
// fs call runs; otherwise the stat would make GET /api/learning an existence
// oracle for server paths. A UNC or device path never reaches fs for anyone:
// a plain stat on Windows dials the share with the service's credentials and
// blocks the event loop. The cache is bounded since clients pick its keys.

export const PROJECT_KEY_CACHE_MAX = 512;
const projectKeyCache = new Map();
export const projectKeyCacheSize = () => projectKeyCache.size;

const UNC_OR_DEVICE_RE = /^[\\/]{2}/;

function stripWorktreePattern(s) {
  return s
    .replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/i, '')
    .replace(/--claude-worktrees-.*$/i, '');
}

function worktreeRepoRoot(dir) {
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch { /* keep walking */ }
    if (st?.isDirectory()) return null;
    if (st?.isFile()) {
      const m = fs.readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return null;
      const gitdir = path.resolve(cur, m[1]).replace(/\\/g, '/');
      const wt = gitdir.match(/^(.*)\/\.git\/worktrees\/[^/]+$/i);
      return wt ? path.normalize(wt[1]) : null;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export function projectKey(p, { clientId = null } = {}) {
  const raw = String(p ?? '');
  if (clientId) return normalizeProject(`client-${clientId}-${stripWorktreePattern(raw)}`);
  if (projectKeyCache.has(raw)) return projectKeyCache.get(raw);
  let resolved = raw;
  try {
    if (raw && !UNC_OR_DEVICE_RE.test(raw) && path.isAbsolute(raw) && fs.statSync(raw).isDirectory()) resolved = worktreeRepoRoot(raw) ?? raw;
  } catch { /* not a live dir: pattern fallback below */ }
  const key = normalizeProject(stripWorktreePattern(resolved));
  if (projectKeyCache.size >= PROJECT_KEY_CACHE_MAX) projectKeyCache.delete(projectKeyCache.keys().next().value);
  projectKeyCache.set(raw, key);
  return key;
}

// dedupKey(item) -> string

export function dedupKey(item) {
  if (item.source === 'gap') {
    return sha1(`${item.code}|${normalizeProject(item.project)}`);
  }
  return item.id;
}

// titleFromGap(gap) - derive a short human-readable label

function titleFromGap(gap) {
  if (gap.code) return gap.code.replace(/-/g, ' ');
  if (gap.message) return gap.message.slice(0, 60);
  return 'gap';
}

// Per-row history of distinct sessions, newest last. Bounded: the auto-approve
// windows (7 and 14 days) need far fewer than this per repo and gap code.
export const SIGHTINGS_MAX = 200;
function addSighting(list, sid, ts) {
  const next = [...(Array.isArray(list) ? list : []), { sid, ts }];
  return next.length > SIGHTINGS_MAX ? next.slice(next.length - SIGHTINGS_MAX) : next;
}

// ageOutPending(state, now, { days }) -> { state, aged }  PURE
//
// Card glmps-2-0-201: a pending gap or GEPA proposal nobody has seen for
// `days` is discarded with discardReason 'aged-out'. An operator idea is never
// aged out; it is the operator's own note, not a detection.
export const AGE_OUT_DAYS = 30;
export function ageOutPending(state, now = Date.now(), { days = AGE_OUT_DAYS } = {}) {
  const cutoff = now - days * 86400000;
  const aged = [];
  const items = state.items.map((i) => {
    if (i.status !== 'pending' || (i.source !== 'gap' && i.source !== 'gepa')) return i;
    const lastSeen = i.lastSeenTs ?? i.updatedTs ?? i.createdTs ?? now;
    if (lastSeen > cutoff) return i;
    const updated = { ...i, status: 'discarded', discardReason: 'aged-out', updatedTs: now };
    aged.push(updated);
    return updated;
  });
  return aged.length ? { state: { ...state, items }, aged } : { state, aged };
}

// upsertGapInto(state, gap, ctx) -> { state, item, isNew }
//
// gap = { code, severity, message }
// ctx = { project, sessionId, coveredCodes?, clientId? }
// Dedup by dedupKey; recurrence bumps count/updatedTs.
// A discarded item is never resurfaced.
// coveredCodes (guard-coverage.js) marks codes whose guard line already
// exists: those rows are 'covered', not 'pending', so they stay out of the
// approve/discard queue. Without coveredCodes, an existing status is kept.

export function upsertGapInto(state, gap, ctx = {}) {
  // Canonicalize the project so the same repo always keys to one row regardless
  // of which writer (and which spelling) produced it. The stored `project` field
  // is the canonical slug too, with a worktree folded into its parent repo.
  const project = projectKey(ctx.project ?? '', { clientId: ctx.clientId ?? null });
  const sessionId = ctx.sessionId ?? '';
  const key = sha1(`${gap.code}|${project}`);
  const existing = state.items.find((i) => i.source === 'gap' && i.id === key);
  const knowsCoverage = ctx.coveredCodes instanceof Set;
  const isCovered = knowsCoverage && ctx.coveredCodes.has(gap.code);

  if (existing) {
    const newSighting = Boolean(sessionId) && sessionId !== existing.lastSessionId;
    const now = Date.now();
    // An aged-out row was never judged by anyone, only forgotten, so a fresh
    // recurrence is new evidence and reopens it (card glmps-2-0-201).
    if (existing.status === 'discarded' && existing.discardReason === 'aged-out' && newSighting) {
      const { discardReason: _dropped, ...rest } = existing;
      const reopened = { ...rest, status: isCovered ? 'covered' : 'pending', count: 1, lastSessionId: sessionId,
        sightings: [{ sid: sessionId, ts: now }], lastSeenTs: now, updatedTs: now };
      const items = state.items.map((i) => (i.id === key ? reopened : i));
      return { state: { ...state, items }, item: reopened, isNew: false, changed: true };
    }
    // A manual discard never resurfaces. An applied row keeps its status but
    // still records sightings: the auto-approve probation measures them.
    if (existing.status === 'discarded') {
      return { state, item: existing, isNew: false, changed: false };
    }
    if (existing.status === 'applied') {
      if (!newSighting) return { state, item: existing, isNew: false, changed: false };
      const updated = { ...existing, lastSessionId: sessionId, sightings: addSighting(existing.sightings, sessionId, now), lastSeenTs: now };
      const items = state.items.map((i) => (i.id === key ? updated : i));
      return { state: { ...state, items }, item: updated, isNew: false, changed: true };
    }
    // A guard added or removed since the row was filed moves it between the
    // queue and 'covered'. Other live statuses (dispatched, failed) are left alone.
    let status = existing.status;
    if (knowsCoverage && (status === 'pending' || status === 'covered')) status = isCovered ? 'covered' : 'pending';
    // Count DISTINCT sessions, not polls: detectGaps re-emits standing gaps on
    // every /api/state poll, so only bump when a *different* session exhibits the
    // same gap. Same-session re-polls are no-ops, so the store is not rewritten
    // each tick (the recurrence badge then means "sessions", not "poll count").
    if (newSighting || status !== existing.status) {
      const updated = newSighting
        ? { ...existing, status, count: existing.count + 1, lastSessionId: sessionId,
          sightings: addSighting(existing.sightings, sessionId, now), lastSeenTs: now, updatedTs: now }
        : { ...existing, status, updatedTs: now };
      const items = state.items.map((i) => (i.id === key ? updated : i));
      return { state: { ...state, items }, item: updated, isNew: false, changed: true };
    }
    return { state, item: existing, isNew: false, changed: false };
  }

  const now = Date.now();
  const newItem = {
    id: key,
    source: 'gap',
    code: gap.code ?? null,
    severity: gap.severity ?? 'warn',
    title: titleFromGap(gap),
    body: gap.message ?? '',
    project,
    sessionId,
    lastSessionId: sessionId,
    lastFiredEpisodeId: null,
    status: isCovered ? 'covered' : 'pending',
    // Guard proposer cutover: no auto-populated template. Proposing
    // the rule text is now the GEPA plugin's job (upsertProposal below); an
    // operator can still set one by hand via applyAction's 'alternative'.
    proposedGuard: null,
    applyCommit: null,
    count: 1,
    sightings: sessionId ? [{ sid: sessionId, ts: now }] : [],
    lastSeenTs: now,
    error: null,
    createdTs: now,
    updatedTs: now,
  };

  return {
    state: { ...state, items: [...state.items, newItem] },
    item: newItem,
    isNew: true,
    changed: true,
  };
}

// upsertProposal(state, { source, title, body, rule, file, section,
//                          sourceItemIds, project, now }) -> { state, item, created }
//
// The GEPA plugin's landing point into the SAME queue upsertGapInto feeds
// (guard proposer cutover, Task 10). Deduped on sha1('gepa|' + rule) - a
// literal 'gepa' prefix, not the caller's `source`, since this dedup key
// exists to collapse repeated proposals of the SAME rule text regardless of
// which recurring failures produced it this time. Mirrors upsertGapInto's
// id scheme (the full sha1 hex digest as `id`, no truncation) so ids stay
// unique across sources: a gap item's id is sha1(code|project), an idea
// item's is `idea-<seq>`, and a gepa proposal's is sha1('gepa|'+rule) - three
// disjoint id shapes that cannot collide by construction.
//
// While pending, a re-proposal of the SAME rule bumps `count` and merges
// `derivedFrom` (the source gap items behind it) rather than creating a
// second row. A `failed` proposal (the approve route's gate refused it, or
// the write itself failed) REOPENS to `pending` on a fresh re-proposal - the
// failure was about a specific approval attempt, not a verdict on the rule
// itself, and GEPA proposing it again is new evidence the recurring failure
// is still live. Once decided `applied` or `discarded` the item is
// immutable, same invariant as upsertGapInto's "a discarded item never
// resurfaces".

// upsertGapInto re-sorts a row only when its own code|project key is
// re-detected, so a row keyed to a worktree that is gone keeps whatever status
// it was filed with (card glmps-2-0-192: 19 rows stuck 'pending' for weeks).
// This sweeps every live gap row against the current guard file instead.
export function reconcileCoverage(state, coveredCodes) {
  if (!(coveredCodes instanceof Set)) return { state, changed: false };
  let changed = false;
  const items = state.items.map((i) => {
    if (i.source !== 'gap' || (i.status !== 'pending' && i.status !== 'covered')) return i;
    const status = coveredCodes.has(i.code) ? 'covered' : 'pending';
    if (status === i.status) return i;
    changed = true;
    return { ...i, status, updatedTs: Date.now() };
  });
  return changed ? { state: { ...state, items }, changed } : { state, changed };
}

export function upsertProposal(state, {
  source = 'gepa', title, body, rule, file = 'CLAUDE.global.md', section = 'Learned guards',
  sourceItemIds = [], project = null, now = Date.now(),
}) {
  const key = sha1(`gepa|${rule}`);
  const existing = state.items.find((i) => i.dedupKey === key);
  if (existing) {
    const agedOut = existing.status === 'discarded' && existing.discardReason === 'aged-out';
    if (!agedOut && (existing.status === 'applied' || existing.status === 'discarded')) {
      return { state, item: existing, created: false };
    }
    const { discardReason: _dropped, ...base } = existing;
    const updated = {
      ...base,
      status: 'pending',
      error: null,
      count: (existing.count || 1) + 1,
      updatedTs: now,
      derivedFrom: [...new Set([...(existing.derivedFrom || []), ...sourceItemIds])],
    };
    const items = state.items.map((i) => (i.id === existing.id ? updated : i));
    return { state: { ...state, items }, item: updated, created: false };
  }
  const item = {
    id: key,
    dedupKey: key,
    source,
    code: 'gepa-proposal',
    severity: 'info',
    title,
    body,
    project,
    sessionId: null,
    status: 'pending',
    proposedGuard: { file, section, rule },
    derivedFrom: [...sourceItemIds],
    count: 1,
    error: null,
    createdTs: now,
    updatedTs: now,
  };
  return { state: { ...state, items: [...state.items, item] }, item, created: true };
}

// addIdea(state, text) -> { state, item }

export function addIdea(state, text) {
  const id = `idea-${state.seq + 1}`;
  const now = Date.now();
  const item = {
    id,
    source: 'idea',
    code: null,
    severity: 'idea',
    title: text.slice(0, 60),
    body: text,
    project: '',
    sessionId: '',
    status: 'pending',
    proposedGuard: null,
    applyCommit: null,
    count: 1,
    error: null,
    createdTs: now,
    updatedTs: now,
  };
  return {
    state: { ...state, seq: state.seq + 1, items: [...state.items, item] },
    item,
  };
}

// applyAction(state, id, action, payload) -> { state, item }  PURE
//
// action in 'approve' | 'discard' | 'alternative'
// approve: leaves status 'pending' - server orchestrates actual apply then
//          calls markApplied/markDispatched.
// discard: -> status 'discarded'
// alternative: sets proposedGuard.rule from payload.rule, keeps status 'pending'
// All transitions update updatedTs.

export function applyAction(state, id, action, payload = {}) {
  const existing = state.items.find((i) => i.id === id);
  if (!existing) throw new Error(`Item not found: ${id}`);

  const now = Date.now();
  let updated;

  switch (action) {
    case 'discard':
      updated = { ...existing, status: 'discarded', updatedTs: now };
      break;

    case 'alternative': {
      const guard = {
        ...(existing.proposedGuard ?? { file: 'CLAUDE.global.md', section: 'Learned guards' }),
        rule: payload.rule,
      };
      updated = { ...existing, proposedGuard: guard, updatedTs: now };
      break;
    }

    case 'approve':
      // Server orchestrates the actual apply; leave pending.
      updated = { ...existing, updatedTs: now };
      break;

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

// Helper setters (all return { state, item })

export function markApplied(state, id, commit, pushed) {
  const now = Date.now();
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  const updated = { ...item, status: 'applied', applyCommit: commit, ...(pushed ? { pushed } : {}), updatedTs: now };
  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

export function markDispatched(state, id) {
  const now = Date.now();
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  const updated = { ...item, status: 'dispatched', updatedTs: now };
  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

export function markFailed(state, id, error) {
  const now = Date.now();
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  const updated = { ...item, status: 'failed', error, updatedTs: now };
  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

// markSkipped: the headless "compose a guard line" hand recognized its own
// composed rule as a semantic duplicate of an existing guard and skipped the
// append (see buildIdeaApplyCommand's step 4). Distinct from 'applied' (it
// did nothing) and 'failed' (nothing went wrong) so the UI can tell the
// difference between "silently applied with no commit" and "correctly
// caught as a duplicate".
export function markSkipped(state, id, reason) {
  const now = Date.now();
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  const updated = { ...item, status: 'skipped', skipReason: reason ?? null, updatedTs: now };
  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

export function setConfig(state, patch) {
  return { ...state, config: { ...state.config, ...patch } };
}

// fs wrappers

function storePath(stateDir) {
  return path.join(stateDir, 'learning', 'store.json');
}

export function load(stateDir) {
  try {
    const raw = fs.readFileSync(storePath(stateDir), 'utf-8');
    const parsed = JSON.parse(raw);
    // Ensure seq exists (backward compat if old file was saved without it)
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

export function save(stateDir, state) {
  const file = storePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// Convenience load->mutate->save wrappers

// glmps-139 + 2026-07-29 correction: upsertGapInto's "leave alone" branch
// (see its doc comment above) is correct for the PROPOSAL state - an
// applied item must never churn or resurface - but on its own it means the
// store records NO shadow-arm observation at all for an applied guard whose
// gap keeps getting re-detected. The only existing fired:true writers are
// learning-apply.js's applyGuard (fires once, at auto-apply time only) and
// the alert-priming seen-set path in server.js; a MANUALLY-approved guard
// (POST /api/learning/item/:id/approve, the common path - it calls
// markApplied directly, never recordShadow) gets zero shadow history, ever.
// That silences guard-staleness (guard-retire.js's staleGuardCandidates /
// server.js's computeGuardStaleCandidates, both read lastFiredByClass) and
// the Loop view's guardHits metric (firedCountInWindow) for guards that are
// demonstrably still relevant.
//
// Decouple the MEASUREMENT from the proposal STATE: re-detecting the gap
// means the guard's trigger condition recurred, so record a shadow
// fired:true observation for its taskClass (= gap.code), WITHOUT touching
// the (already-returned, unmutated) item or state from upsertGapInto.
//
// glmps-139's ORIGINAL comment here claimed this call site is "invoked once
// per session end" and therefore fires "at most one entry per (session,
// code), never once per poll tick". That was WRONG, measured 2026-07-29: the
// Stop hook (hooks/capability-feed.js, this function's sole caller) fires
// once per agent TURN, not once per conversation. A single 7-day session
// produced 143 fired:true records for one gap code, at 143 distinct
// timestamps (median gap ~508s - turn cadence, not a poll loop and not a
// burst). Every turn re-detects the same already-applied gap and this call
// site wrote an unconditional shadow record every time.
//
// Fix: gate the write on a TRANSITION, not a call. `lastFiredEpisodeId` on
// the persisted item tracks the last (episodeId ?? sessionId) that produced
// a fired:true write for it; the write only fires again when that identity
// changes. No caller passes episodeId yet (episode-id.js's resolver exists
// but is not wired into hooks/capability-feed.js), so `ctx.episodeId` falls
// back to `ctx.sessionId` - which is already constant across every turn of
// one Claude Code session, so the fallback alone collapses the 143-write
// case to 1 without requiring richer episode resolution. Contrast
// gap-pipeline.js's upsertGapAndApply, which server.js's frequently-polled
// /api/state handler calls repeatedly per session and which deliberately
// gates its OWN shadow write on up.isNew for a different flooding reason -
// that function and its poll-loop call site are untouched by this change.
export function upsertGap(stateDir, gap, ctx) {
  const state = load(stateDir);
  const result = upsertGapInto(state, gap, ctx);

  const episodeId = (typeof ctx?.episodeId === 'string' && ctx.episodeId) ? ctx.episodeId
    : (typeof ctx?.sessionId === 'string' && ctx.sessionId) ? ctx.sessionId : null;
  // A 'covered' row's guard exists in the guard file, so its recurrence is the
  // same "guard's trigger recurred" signal as an applied one, even on the
  // first detection (a new row can be covered; it can never be applied).
  const isRecurringApplied = gap?.code && (result.item?.status === 'applied' || result.item?.status === 'covered');
  const isNewTransition = episodeId && episodeId !== result.item?.lastFiredEpisodeId;

  let finalState = result.state;
  if (isRecurringApplied && isNewTransition) {
    try {
      recordShadow(stateDir, { taskClass: gap.code, fired: true, sid: ctx?.sessionId ?? null, episodeId });
      finalState = {
        ...finalState,
        items: finalState.items.map((i) => (i.id === result.item.id ? { ...i, lastFiredEpisodeId: episodeId } : i)),
      };
    } catch { /* fail-open: measurement must never break the upsert */ }
  }
  save(stateDir, finalState);
  return result;
}

export function addIdeaTo(stateDir, text) {
  const state = load(stateDir);
  const result = addIdea(state, text);
  save(stateDir, result.state);
  return result;
}

export function setConfigIn(stateDir, patch) {
  const state = load(stateDir);
  const updated = setConfig(state, patch);
  save(stateDir, updated);
  return updated;
}
