// server/lib/orchestration/auto-deploy.js
//
// When a merge-queue merge should trigger a deploy (card glmps-2-0-66 F3,
// spec docs/specs/2026-10-20-glmps2-auto-deploy-after-merge.md). Pure: the
// answer comes from the backlog and the approvals log alone, so the process
// a deploy restarts into reaches the same answer, and a burst of merges
// collapses into one deploy (one run covers everything up to the base).
import { foldRequests, actionBusy } from '../scut/approvals.js';
import { formatTime } from '../../../web/shared/time-format.js';

export const LIVE_WINDOW_MS = 7 * 24 * 3600_000;

/** The deploy action configured for a merge request's repo and base, or null. */
export function deployActionFor(mr, autoDeploy) {
  const key = Object.keys(autoDeploy ?? {}).find((k) => {
    const at = k.lastIndexOf('@');
    return at > 0 && k.slice(0, at).toLowerCase() === String(mr?.repo).toLowerCase() && k.slice(at + 1) === mr?.base;
  });
  const action = key ? autoDeploy[key] : null;
  return typeof action === 'string' && action ? action : null;
}

function mergedAt(mr) {
  const h = (mr?.history ?? []).filter((x) => x?.to === 'merged').at(-1);
  const t = h ? Date.parse(h.ts) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Whether a queue merge is live: true when no deploy is configured for its
 * repo and base, else once a deploy run that started at or after the merge has
 * finished (glmps-2-0-107: a stranded card resumes only then, so its live
 * check sees the new code).
 * @param {{ mr: object, mergeTs: number, entries: object[], autoDeploy?: Record<string,string> }} p
 */
export function deployFinished({ mr, mergeTs, entries = [], autoDeploy }) {
  const action = deployActionFor(mr, autoDeploy);
  if (!action) return true;
  for (const r of foldRequests(entries).values()) {
    if (r.action === action && r.run && r.run.startedTs >= mergeTs && r.run.finishedTs != null) return true;
  }
  return false;
}

/**
 * `greens` is the newest green full run per integration key ({ sha, ts }), a
 * third source (card glmps-2-0-173): promotion only moves to a green commit, so
 * a merge deployed before main was certified would otherwise wait for the next
 * merge. `liveSha` is the running build's commit; a green that already runs is
 * not deployed again.
 * @param {{ items: object[], lessons?: object[], greens?: Record<string,{sha:string,ts:number}>, liveSha?: string|null, entries: object[], autoDeploy?: Record<string,string>, registry: object, now: number }} p
 * @returns {{ due: false, reason: string } | { due: true, action: string, source: 'merge'|'lesson'|'green', ticketId: string|null, lessonId?: string, mergeSha: string|null, mergeTs: number }}
 */
export function autoDeployDue({ items = [], lessons = [], greens = {}, liveSha = null, entries = [], autoDeploy, registry = {}, now }) {
  const pairs = Object.entries(autoDeploy ?? {}).filter(([k, v]) => typeof v === 'string' && v && k.includes('@'));
  if (!pairs.length) return { due: false, reason: 'off' };
  const requests = foldRequests(entries);
  let wait = null;
  for (const [key, action] of pairs) {
    const at = key.lastIndexOf('@');
    const repo = key.slice(0, at).toLowerCase();
    const base = key.slice(at + 1);
    let newest = null;
    for (const item of items) {
      const mr = item?.mergeRequest;
      // A PR merged by hand outside the queue is deployed by hand, as before.
      if (mr?.stage !== 'merged' || mr.mergedOutsideQueue || String(mr.repo).toLowerCase() !== repo || mr.base !== base) continue;
      const t = mergedAt(mr);
      if (t != null && (!newest || t > newest.mergeTs)) newest = { source: 'merge', ticketId: item.id, mergeSha: mr.mergeSha ?? null, mergeTs: t };
    }
    const newestMerge = newest;
    // An approved lesson pushed to this repo and branch counts like a queue merge (dev/prod T5).
    for (const l of lessons) {
      const p = l?.pushed;
      if (l?.status !== 'applied' || !p || String(p.repo).toLowerCase() !== repo || p.branch !== base) continue;
      if (Number.isFinite(p.ts) && (!newest || p.ts > newest.mergeTs)) newest = { source: 'lesson', lessonId: l.id, ticketId: null, mergeSha: p.sha ?? null, mergeTs: p.ts };
    }
    const green = greens?.[`${repo}@${base}`];
    const running = (sha) => !!liveSha && (sha.startsWith(liveSha) || liveSha.startsWith(sha));
    if (green?.sha && Number.isFinite(green.ts) && !running(green.sha) && (!newest || green.ts > newest.mergeTs)) {
      newest = { source: 'green', ticketId: newestMerge?.ticketId ?? null, mergeSha: green.sha, mergeTs: green.ts };
    }
    if (!newest) continue;
    const def = registry[action];
    if (!def) { wait ??= 'unknown-action'; continue; }
    let lastRun = null;
    for (const r of requests.values()) {
      if (r.action === action && r.run && (lastRun == null || r.run.startedTs > lastRun)) lastRun = r.run.startedTs;
    }
    if (lastRun != null && lastRun >= newest.mergeTs) continue;
    const busy = actionBusy(requests, def, now, registry);
    if (busy) { wait = busy; continue; }
    return { due: true, action, ...newest };
  }
  return { due: false, reason: wait ?? 'up to date' };
}

/** Cards whose queue merge into a deploy-configured branch is recent and not yet marked live (card glmps-2-0-173). */
export function liveCandidates({ items = [], autoDeploy, now, windowMs = LIVE_WINDOW_MS }) {
  return items.filter((item) => {
    const mr = item?.mergeRequest;
    if (mr?.stage !== 'merged' || mr.mergedOutsideQueue || mr.live || mr.liveUnknown || !mr.mergeSha || !deployActionFor(mr, autoDeploy)) return false;
    const t = mergedAt(mr);
    return t != null && now - t <= windowMs;
  });
}

/** Whether a merge's card may resume as live (glmps-2-0-107, card glmps-2-0-176). */
export function mergeIsLive(mr, { entries = [], autoDeploy } = {}) {
  if (!deployActionFor(mr, autoDeploy) || mr?.live) return true;
  if (!mr?.liveUnknown) return false;
  const t = mergedAt(mr);
  return t != null && deployFinished({ mr, mergeTs: t, entries, autoDeploy });
}

/**
 * One post per card when its merge is in the running build (`inBuild`, merge
 * commits the caller checked with git), and one when a deploy that started
 * after the merge finished without it. On the first run (`firstRun`, when the
 * notices begin) a merge already live is marked silently, so old channels
 * stay quiet; one still waiting is told, since that is the stranded case.
 * `kernelRepo` is the repo the live server runs: a merge into any other repo
 * is live once a deploy finished after it (card glmps-2-0-176). `unverifiable`
 * holds merge commits the live checkout cannot find even after a fetch.
 * @returns {{ id: string, mr: object, text: string|null }[]}
 */
export function liveNotices({ items = [], inBuild = new Set(), unverifiable = new Set(), kernelRepo = null, liveSha, entries = [], mainSuite = {}, autoDeploy, firstRun = false, now, tz } = {}) {
  const out = [];
  const short = (s) => String(s ?? '').slice(0, 7);
  for (const item of liveCandidates({ items, autoDeploy, now })) {
    const mr = item.mergeRequest;
    const t = mergedAt(mr);
    const what = `${mr.repo}#${mr.number ?? '?'} (merge ${short(mr.mergeSha)})`;
    const when = () => formatTime(now, { date: false, ...(tz ? { tz } : {}), now });
    if (kernelRepo && String(mr.repo).toLowerCase() !== String(kernelRepo).toLowerCase()) {
      if (!deployFinished({ mr, mergeTs: t, entries, autoDeploy })) continue;
      out.push({ id: item.id, mr: { ...mr, live: { sha: null, ts: now, via: 'deploy' } }, text: firstRun ? null : `Live: ${what} was deployed by a run that finished after the merge, as of ${when()}.` });
      continue;
    }
    if (inBuild.has(mr.mergeSha)) {
      out.push({ id: item.id, mr: { ...mr, live: { sha: liveSha, ts: now } }, text: firstRun ? null : `Live: ${what} is in the running build ${short(liveSha)} as of ${when()}.` });
      continue;
    }
    if (unverifiable.has(mr.mergeSha)) {
      out.push({ id: item.id, mr: { ...mr, liveUnknown: { ts: now, liveSha } }, text: `Cannot check live: ${what} is not in the live checkout, even after a fetch, so it is not checked again.` });
      continue;
    }
    if (mr.waitNotice || !deployFinished({ mr, mergeTs: t, entries, autoDeploy })) continue;
    const red = mainSuite?.[`${String(mr.repo).toLowerCase()}@${mr.base}`]?.red;
    const reason = red
      ? `main's full test run is red${red.cardId ? ` (card ${red.cardId})` : ''}, so the live server stays on the last green build until it is fixed`
      : "waiting for main's full test run to pass; it deploys on its own when it does";
    out.push({ id: item.id, mr: { ...mr, waitNotice: { ts: now, reason } }, text: `Merged but not live yet: ${what} is not in the running build ${short(liveSha)}: ${reason}.` });
  }
  return out;
}
