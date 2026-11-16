// server/lib/orchestration/worktree-outcome.js
// The one rule for "may this card's worktree go": record what it held on the
// card first, then remove it only when nothing in it would be lost (clean tree,
// head pushed or merged). Shared by the runner's departure reclaim, the
// worktree sweeper and the backfill script so they cannot disagree.
//
// House split: pure decision + record here; `gatherWorktreeFacts` takes an
// injected synchronous `git(args, cwd) -> { status, stdout }`. The card writes
// (`writeOutcome`, `flagKept`, `markRemoved`) go through backlog-store and are
// shared by the server and the backfill script.
import * as backlogStore from './backlog-store.js';

/** @param facts { branch, head, pushed, merged, dirty } (null where unreadable) */
export function outcomeRecord(facts, card) {
  const mr = card?.mergeRequest;
  return {
    branch: facts?.branch ?? null,
    head: facts?.head ?? null,
    pushed: facts?.pushed ?? null,
    merged: facts?.merged ?? null,
    dirty: facts?.dirty ?? null,
    prUrl: mr?.prUrl ?? null,
    mergeStage: mr?.stage ?? null,
    gate: card?.gate?.status ?? null,
  };
}

const FIELDS = ['branch', 'head', 'pushed', 'merged', 'dirty', 'prUrl', 'mergeStage', 'gate'];
export function sameOutcome(a, b) {
  if (!a || !b) return false;
  return FIELDS.every((k) => (a[k] ?? null) === (b[k] ?? null));
}

/** Is there a stored outcome record for this card's worktree at `dir`? */
export function outcomeRecordedFor(card, dir) {
  const o = card?.runSession?.outcome;
  return !!(o && o.branch && dir && o.dir === dir && card.runSession.worktree?.dir === dir);
}

/**
 * @param written the outcome record for this card+worktree is on the card now
 * Anything unreadable keeps the worktree: removal needs positive evidence.
 */
export function removalVerdict({ facts, written } = {}) {
  if (!written) return { remove: false, reason: 'no-record' };
  if (!facts || !facts.head || facts.dirty == null) return { remove: false, reason: 'unreadable' };
  if (facts.dirty > 0) return { remove: false, reason: 'dirty' };
  if (facts.pushed) return { remove: true, reason: 'clean-pushed' };
  if (facts.merged) return { remove: true, reason: 'clean-merged' };
  return { remove: false, reason: 'unpushed' };
}

const KEEP_TEXT = {
  'no-record': 'the outcome record could not be written',
  unreadable: 'git could not read the worktree',
  dirty: 'it has uncommitted changes',
  unpushed: 'its head commit is neither pushed nor merged',
};
export function keepReasonText(reason) { return KEEP_TEXT[reason] ?? reason; }

/** Human line for the card devlog. */
export function outcomeText(record, dir) {
  const r = record;
  const parts = [
    `branch ${r.branch ?? '?'}`,
    `head ${String(r.head ?? '?').slice(0, 10)}`,
    `pushed ${r.pushed ?? '?'}`,
    `merged ${r.merged ?? '?'}`,
    `${r.dirty ?? '?'} uncommitted file(s)`,
  ];
  if (r.prUrl) parts.push(`PR ${r.prUrl}${r.mergeStage ? ` (${r.mergeStage})` : ''}`);
  if (r.gate) parts.push(`gate ${r.gate}`);
  return `worktree outcome: ${parts.join(', ')}${dir ? ` [${dir}]` : ''}`;
}

// Where "merged into the integration branch" is checked: the repo checkout's
// upstream first (glmps2/main for the runtime repo), then the usual names.
// Remote refs only: a local main that was merged but never pushed is not integrated.
export function integrationRefsFor({ git, repo }) {
  return whenSettled(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repo), (up) => {
    const refs = [];
    const upstream = up.status === 0 ? up.stdout.trim() : '';
    if (/^origin\//.test(upstream)) refs.push(upstream);
    for (const r of ['origin/main', 'origin/master']) if (!refs.includes(r)) refs.push(r);
    return refs;
  });
}

// Writes the record to the card (runSession.outcome plus a devlog line) unless
// the same record is already there. Returns true when the card holds it after
// the call, false when the write failed.
export function writeOutcome({ stateDir, card, worktree, record }) {
  if (outcomeRecordedFor(card, worktree.dir) && sameOutcome(card.runSession.outcome, record)) return true;
  try {
    backlogStore.setRunSessionIn(stateDir, card.id, {
      worktree: card.runSession?.worktree ?? { dir: worktree.dir, branch: record.branch, repo: worktree.repo },
      outcome: { ...record, ts: Date.now() },
    });
    backlogStore.appendDevLogIn(stateDir, card.id, { by: 'runner', text: outcomeText(record, worktree.dir) });
    return true;
  } catch { return false; }
}

// Flag once: the same reason is not written to the devlog again.
export function flagKept({ stateDir, id, reason }) {
  const card = backlogStore.load(stateDir).items.find((i) => i.id === id);
  if (card?.runSession?.keptReason === reason) return false;
  backlogStore.setRunSessionIn(stateDir, id, { keptReason: reason });
  backlogStore.appendDevLogIn(stateDir, id, { by: 'runner', text: `worktree kept: ${keepReasonText(reason)}` });
  return true;
}

export function markRemoved({ stateDir, id }) {
  backlogStore.setRunSessionIn(stateDir, id, { purgedTs: Date.now(), keptReason: null });
}

// `git` may be synchronous (direct git) or return a promise (the desktop shell's
// git seam in service mode). The result is a plain value in the first case and a
// promise in the second, so the synchronous callers stay synchronous.
export function whenSettled(v, fn) {
  return v && typeof v.then === 'function' ? v.then(fn) : fn(v);
}

export function gatherWorktreeFacts({ dir, branch, git, integrationRefs = [] }) {
  let why = null;
  const note = (r) => { if (r.status !== 0 && !why) why = String(r.stderr || r.stdout || `git exit ${r.status}`).trim().split('\n')[0].slice(0, 200); return r; };
  return whenSettled(git(['rev-parse', 'HEAD'], dir), (headR) => {
    note(headR);
    const head = headR.status === 0 && headR.stdout.trim() ? headR.stdout.trim() : null;
    return whenSettled(git(['status', '--porcelain'], dir), (st) => {
      note(st);
      const dirty = st.status === 0 ? st.stdout.split('\n').filter((l) => l.trim()).length : null;
      const done = (pushed, merged) => ({ branch: branch ?? null, head, pushed, merged, dirty, ...(why && (!head || dirty == null) ? { why } : {}) });
      if (!head) return done(false, false);
      const pushedV = branch
        ? whenSettled(git(['for-each-ref', '--contains', head, '--format=%(refname)', `refs/remotes/origin/${branch}`], dir), (r) => r.status === 0 && r.stdout.trim().length > 0)
        : false;
      return whenSettled(pushedV, (pushed) => {
        const tryRef = (i) => i >= integrationRefs.length ? false
          : whenSettled(git(['merge-base', '--is-ancestor', head, integrationRefs[i]], dir), (r) => (r.status === 0 ? true : tryRef(i + 1)));
        return whenSettled(tryRef(0), (merged) => done(pushed, merged));
      });
    });
  });
}
