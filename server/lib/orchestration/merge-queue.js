// server/lib/orchestration/merge-queue.js
//
// Pure state machine for GLMPS 2.0 merge requests (spec:
// docs/specs/2026-10-17-glmps2-merge-queue.md). Agents file a request; the
// server walks it requested -> testing -> merging -> merged, with exits
// bounced (back to the author) and held (waiting for the operator). Testing
// runs the PR's affected tests (glmps-2-0-runtime-125); there is no per-PR
// reviewer, so `reviewing` is reached only by records written before
// B-Lean (glmps-2-0-runtime-114) and keeps its edges so those can still leave.
//
// No I/O and no clock reads: callers pass `now`, the queue (backlog items) and
// do the git/gh work themselves, in the style of queue-runner.js. The tick
// calls nextAction() then transition(); the test stage and the merger call
// transition() with their results.

export const STAGES = ['requested', 'testing', 'reviewing', 'merging', 'merged', 'bounced', 'held', 'closed'];
export const ACTIVE_STAGES = new Set(['testing', 'reviewing', 'merging']);
export const TERMINAL_STAGES = new Set(['merged', 'bounced', 'closed']);
export const MAX_ROUNDS = 3;
export const MAX_RESTARTS = 3;
export const MAX_REPAIRS = 3;

// held -> requested is the operator releasing a hold, testing -> requested a
// timeout held for load (glmps-2-0-runtime-98) or a red-base hold
// (glmps-2-0-runtime-125). merging -> testing is a PR head or base that moved
// after testing, so it needs new tests.
const EDGES = {
  // merged/bounced straight from requested: a PR merged or closed outside the
  // queue is settled before it takes the test slot (glmps-2-0-76).
  requested: ['testing', 'held', 'merged', 'bounced'],
  testing: ['merging', 'bounced', 'held', 'requested'],
  reviewing: ['merging', 'testing', 'bounced', 'held'],
  // merging -> requested: the base went red before this request merged (glmps-2-0-runtime-125).
  merging: ['merged', 'testing', 'bounced', 'held', 'requested'],
  // held and bounced requests are re-read from GitHub (glmps runtime-9-a): a
  // PR merged or closed outside the queue settles them.
  held: ['requested', 'merged', 'closed'],
  merged: [],
  bounced: ['merged', 'closed'],
  closed: [],
};

const PUBLIC_REPOS = new Set(['wolfeb-dev/glmps']);

export function parsePrUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)$/.exec(url.trim());
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

export function isPublicRepo(repo) {
  return PUBLIC_REPOS.has(String(repo ?? '').toLowerCase());
}

export function prViewRecipe({ repo, number }) {
  return {
    file: 'gh',
    args: ['pr', 'view', String(number), '-R', repo, '--json', 'baseRefName,headRefName,headRefOid,state,isCrossRepository,title'],
  };
}

// Fail closed: anything that is not the exact shape we asked gh for is null.
export function parsePrView(stdout) {
  let j;
  try { j = JSON.parse(String(stdout ?? '')); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const { baseRefName, headRefName, headRefOid, state } = j;
  if (![baseRefName, headRefName, headRefOid, state].every((v) => typeof v === 'string' && v)) return null;
  return { base: baseRefName, head: headRefName, headSha: headRefOid, state, crossRepo: j.isCrossRepository === true, title: typeof j.title === 'string' ? j.title : '' };
}

// A merge request is filed by the card's own work, and requests carry no
// session identity, so the evidence is the card id in the PR's head branch or
// title. The id must stand alone: glmps-1 is not in glmps-10.
export function prNamesCard({ id, head, title } = {}) {
  const want = String(id ?? '').toLowerCase();
  if (!want) return false;
  const at = (text) => {
    const hay = String(text ?? '').toLowerCase();
    for (let i = hay.indexOf(want); i !== -1; i = hay.indexOf(want, i + 1)) {
      if (!/[a-z0-9]/.test(hay[i - 1] ?? '') && !/[a-z0-9]/.test(hay[i + want.length] ?? '')) return true;
    }
    return false;
  };
  return at(head) || at(title);
}

export function integrationKey(mr) {
  return `${String(mr.repo).toLowerCase()}@${mr.base}`;
}

export function isActive(mr) { return !!mr && ACTIVE_STAGES.has(mr.stage); }
export function isTerminal(mr) { return !!mr && TERMINAL_STAGES.has(mr.stage); }

const capReason = (reason) => `round cap (${MAX_ROUNDS}) reached${reason ? `: ${reason}` : ''}`;

/**
 * A new request, or a re-file after a bounce when `prev` is given: history is
 * carried and the round advances. A re-file past the cap lands held.
 */
// interim (glmps-2-0-75): the card continues after this PR merges, so the
// merge must not close it. A request filed after a MERGED one is a new PR,
// not a retry, so it starts the round count again.
// covers (runtime-9-a): the AC numbers this PR claims, or null for "judge it
// against every criterion". final: the author says this PR finishes the card.
export function createMergeRequest({ prUrl, repo, number, base, head, headSha, filedBy, interim, covers, final } = {}, { now, prev = null } = {}) {
  const by = filedBy || 'agent';
  const round = prev && prev.stage !== 'merged' ? (prev.round ?? 1) + 1 : 1;
  const history = [...(prev?.history ?? []), { ts: now, from: prev?.stage ?? null, to: 'requested', reason: `filed by ${by}` }];
  const out = {
    prUrl, repo, number, base, head, headSha, interim: interim === true,
    covers: Array.isArray(covers) ? [...new Set(covers)].sort((a, b) => a - b) : null, final: final === true,
    stage: 'requested', round, filedBy: by, filedAt: now, history,
    tests: null, review: null, mergeSha: null,
  };
  if (round > MAX_ROUNDS) {
    out.stage = 'held';
    out.history = [...history, { ts: now, from: 'requested', to: 'held', reason: capReason('') }];
  }
  return out;
}

/**
 * Intake check for the coverage fields (runtime-9-a). Returns { covers, final }
 * or { error }. No fields at all is { covers: null, final: false }.
 */
export function parseScope(body, acceptanceCriteria) {
  const total = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.length : 0;
  const final = body?.final;
  if (final != null && typeof final !== 'boolean') return { error: 'final must be true or false' };
  if (final === true && body?.interim === true) return { error: 'a request cannot be both final and interim' };
  const raw = body?.covers;
  if (raw == null) return { covers: null, final: final === true };
  if (!Array.isArray(raw) || !raw.length) return { error: 'covers must be a non-empty list of acceptance criterion numbers' };
  const bad = raw.filter((n) => !Number.isInteger(n) || n < 1 || n > total);
  if (bad.length) {
    return { error: total ? `covers has unknown acceptance criteria: ${bad.join(', ')} (the card has ${total})` : 'covers given but the card has no acceptance criteria' };
  }
  return { covers: [...new Set(raw)].sort((x, y) => x - y), final: final === true };
}

function others(queue, mr, id) {
  const key = integrationKey(mr);
  return (Array.isArray(queue) ? queue : []).filter((c) => {
    const o = c?.mergeRequest;
    if (!o || (id != null && c.id === id) || o === mr) return false;
    return integrationKey(o) === key;
  });
}

/**
 * Move `mr` to stage `to`. Returns { mergeRequest } or { error }. Entering
 * `testing` takes the branch's single active slot, so it needs the queue (and
 * the card `id`, to not count itself). A bounce in the last allowed round
 * becomes a hold.
 */
export function transition(mr, to, { now, reason, queue, id, repair = false } = {}) {
  if (!STAGES.includes(to)) return { error: `unknown stage: ${to}` };
  if (!(EDGES[mr.stage] ?? []).includes(to)) return { error: `illegal transition: ${mr.stage} -> ${to}` };
  if (to === 'testing') {
    const busy = others(queue, mr, id).find((c) => isActive(c.mergeRequest));
    if (busy) return { error: `branch busy: ${busy.id} is ${busy.mergeRequest.stage}` };
  }
  let stage = to;
  let why = reason ?? '';
  let restarts = mr.restarts ?? 0;
  if (to === 'bounced' && mr.round >= MAX_ROUNDS) { stage = 'held'; why = capReason(why); }
  // A moved head or base sends the request back to testing without using a
  // round, so it is counted separately or a moving head could loop forever.
  // A repaired conflict is the reviewer's own work and is not a restart.
  if (to === 'testing' && (mr.stage === 'merging' || (mr.stage === 'reviewing' && !repair))) {
    restarts += 1;
    if (restarts > MAX_RESTARTS) { stage = 'held'; why = `restart cap (${MAX_RESTARTS}) reached${why ? `: ${why}` : ''}`; }
  }
  // A base that keeps moving can conflict again after every repair, so repairs
  // get their own cap; each cycle costs a reviewer session.
  let repairs = mr.repairs ?? 0;
  if (to === 'testing' && mr.stage === 'reviewing' && repair) {
    repairs += 1;
    if (repairs > MAX_REPAIRS) { stage = 'held'; why = `repair cap (${MAX_REPAIRS}) reached${why ? `: ${why}` : ''}`; }
  }
  if (to === 'requested' && mr.stage === 'held') { restarts = 0; repairs = 0; }
  return {
    mergeRequest: {
      ...mr, stage,
      ...(restarts === (mr.restarts ?? 0) ? {} : { restarts }),
      ...(repairs === (mr.repairs ?? 0) ? {} : { repairs }),
      history: [...mr.history, { ts: now, from: mr.stage, to: stage, reason: why }],
    },
  };
}

/** Why merging into a red branch is paused, for devlogs, the lane and the board. */
export function redPauseReason(base, red) {
  return `the full suite is red on ${base} at ${String(red?.sha ?? '').slice(0, 7)}`;
}

// A request held for this red waits until a fix lands or the red changes.
const redHeld = (mr, red) => !!red && !!mr?.redHold && mr.redHold === red.sha;

/**
 * What the next tick should do for one request: 'start-testing', 'hold',
 * 'wait' (blocked, or an executor owns it) or 'none'. Requested requests start
 * oldest first within a branch. `red` is the branch's red full-suite record,
 * if any (glmps-2-0-runtime-125).
 */
export function nextAction(mr, queue, { id, red = null } = {}) {
  if (!mr) return { action: 'none', reason: 'no merge request' };
  if (isActive(mr)) return { action: 'wait', reason: `${mr.stage} in progress` };
  if (mr.stage !== 'requested') return { action: 'none', reason: mr.stage };
  if (mr.round > MAX_ROUNDS) return { action: 'hold', reason: capReason('') };
  if (redHeld(mr, red)) return { action: 'wait', reason: `paused: ${redPauseReason(mr.base, red)}; waiting for a fix to land` };
  const peers = others(queue, mr, id).filter((c) => !redHeld(c.mergeRequest, red));
  const busy = peers.find((c) => isActive(c.mergeRequest));
  if (busy) return { action: 'wait', reason: `branch busy: ${busy.id} is ${busy.mergeRequest.stage}` };
  const ahead = peers
    .filter((c) => c.mergeRequest.stage === 'requested')
    .find((c) => compareFiled({ id: c.id, mr: c.mergeRequest }, { id, mr }) < 0);
  if (ahead) return { action: 'wait', reason: `queued behind ${ahead.id}` };
  return { action: 'start-testing', reason: 'branch free' };
}

// A load hold puts the request at the back of the queue without re-filing it.
const queuedAt = (mr) => mr.queuedAt ?? mr.filedAt;

function compareFiled(a, b) {
  const x = queuedAt(a.mr); const y = queuedAt(b.mr);
  if (x !== y) return x < y ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/** The queue per integration branch for GET /api/merge-queue; `reds` maps a branch key to its red full-suite record. */
export function groupQueue(items, { reds = {} } = {}) {
  const lanes = new Map();
  for (const c of Array.isArray(items) ? items : []) {
    const m = c?.mergeRequest;
    if (!m || isTerminal(m)) continue;
    const branch = integrationKey(m);
    if (!lanes.has(branch)) lanes.set(branch, { branch, repo: m.repo, base: m.base, rows: [] });
    lanes.get(branch).rows.push({ id: c.id, m, title: c.title });
  }
  return [...lanes.values()]
    .sort((a, b) => (a.branch < b.branch ? -1 : 1))
    .map(({ branch, repo, base, rows }) => ({
      branch, repo, base,
      paused: reds?.[branch] ? { reason: redPauseReason(base, reds[branch]), sha: reds[branch].sha, since: reds[branch].ts ?? null, files: reds[branch].files ?? [] } : null,
      requests: rows
        .sort((a, b) => compareFiled({ id: a.id, mr: a.m }, { id: b.id, mr: b.m }))
        .map((r) => ({ id: r.id, title: r.title, stage: r.m.stage, round: r.m.round, prUrl: r.m.prUrl })),
    }));
}

// glmps-2-0-runtime-63: a headless author is released to idle when its run
// ends, so a bounce reaches it only by putting the card back in the queue.
// done is not here: a done card whose request bounced shows done for work that
// never landed, so it is reopened (glmps-2-0-runtime-91).
const CLOSED_CARD_STATES = new Set(['cancelled', 'archived']);
const BOUNCE_TAIL_CHARS = 1500;

/** Bounces since the request history last reached merged. */
export function bounceStreak(mr) {
  let n = 0;
  for (const h of mr?.history ?? []) {
    if (h.to === 'merged') n = 0;
    else if (h.to === 'bounced') n += 1;
  }
  return n;
}

/**
 * What happens to the card after its request bounced: 'requeue' (idle or
 * queued), 'reopen' (done, so requeued after leaving done), 'live' (a session
 * holds it and reads the devlog), 'hold' (the round cap, maxRetries bounces in
 * a row, or a tests error) or 'skip' (the operator holds it, it waits for a
 * restated intent, or it is cancelled or archived).
 */
export function bounceDisposition({ card, mr, maxRetries }) {
  const last = mr?.history?.at(-1)?.reason ?? '';
  if (card?.state === 'held') return { action: 'skip', reason: 'the operator holds the card' };
  if (card?.gate?.reintent) return { action: 'skip', reason: 'the card waits for a restated intent (two failed gates in a row)' };
  if (CLOSED_CARD_STATES.has(card?.state)) return { action: 'skip', reason: `the card is ${card.state}` };
  if (mr?.stage === 'held') return { action: 'hold', reason: `merge request held: ${last}` };
  // An infra error is the queue's to fix; relaunching the author only burns retries.
  if (/^tests error:/.test(last)) return { action: 'hold', reason: `the merge queue could not run the tests, which the author cannot fix: ${last}` };
  const streak = bounceStreak(mr);
  if (streak > maxRetries) return { action: 'hold', streak, reason: `${streak} bounces in a row (retry cap ${maxRetries}), last: ${last}` };
  if (card?.state === 'done') return { action: 'reopen', streak };
  if (card?.state === 'idle' || card?.state === 'queued') return { action: 'requeue', streak };
  return { action: 'live', streak };
}

/** The instructions the requeued author launches with. */
export function bounceNote(mr) {
  const reason = mr?.history?.at(-1)?.reason ?? 'unknown';
  const t = mr?.tests;
  const tail = /^tests /.test(reason) && t?.status !== 'pass' && t?.tail ? String(t.tail).slice(-BOUNCE_TAIL_CHARS) : '';
  return `The merge queue bounced your pull request ${mr?.repo}#${mr?.number}: ${reason}. Fix it, push, then file the merge request again.`
    + (tail ? `\n\nTest output (tail):\n${tail}` : '');
}

/** True when the request's last move was a bounce, including one the round cap turned into a hold. */
export function isBounceExit(mr) {
  const h = mr?.history?.at(-1);
  return !!h && (h.to === 'bounced' || (h.to === 'held' && h.from !== 'requested' && /^round cap/.test(h.reason ?? '')));
}
