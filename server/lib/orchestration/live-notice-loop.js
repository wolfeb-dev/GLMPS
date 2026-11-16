// server/lib/orchestration/live-notice-loop.js
//
// The live check under the loop contract (card glmps-2-0-176; the notices are
// card glmps-2-0-173's). Maker: for each queue merge not yet live, ask git
// whether its merge commit is in the running build, then post and mark what
// liveNotices decides. A "not in the build" answer is remembered until the
// running build changes, so git runs after a deploy, not on every run. A merge
// commit the live checkout cannot find gets one fetch, then is marked
// unverifiable. Checker: re-reads the backlog and proves each mark landed on
// the same merge commit. All I/O is injected.
import { liveCandidates, liveNotices } from './auto-deploy.js';

export const LIVE_NOTICE_LOOP = Object.freeze({
  name: 'merge-queue-live-notice',
  trigger: { everyMs: 60_000 },
  ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 5 * 60_000 },
  sla: { maxAgeMs: 30 * 60_000 },
});

// The stderr a failed git call reports. A child killed at its time limit has no
// stderr and only Node's "Command failed: <argv>", which hides that it hung.
export function gitFailureText(err, stderr, timeoutMs) {
  if (stderr) return stderr;
  if (!err) return '';
  const msg = String(err.message ?? err);
  return err.killed ? `timed out after ${Math.round(timeoutMs / 1000)} s (killed): ${msg}` : msg;
}

const FETCH_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 10_000;

// The loop's git. Ancestry and object reads are local and run in-process. The
// fetch needs GitHub credentials, which a service kernel does not hold (D33):
// run in-process it waits on a sign-in prompt nobody can answer until the time
// limit kills it (card glmps-2-0-181), so in service mode it goes through the
// desktop app like the rest of the merge queue's network git.
export function createLiveNoticeGit({ viaShell, shellGit, runLocal, repoRoot, refuseFetch = false }) {
  return (args) => {
    if (args[0] === 'fetch') {
      if (refuseFetch) return Promise.resolve({ status: 1, stdout: '', stderr: 'git fetch refused in a test process' });
      if (viaShell) return shellGit(args, { cwd: repoRoot }, { extraRepos: [repoRoot] });
      return runLocal('git', ['-C', repoRoot, ...args], { timeout: FETCH_TIMEOUT_MS });
    }
    return runLocal('git', ['-C', repoRoot, ...args], { timeout: LOCAL_TIMEOUT_MS });
  };
}

const fieldOf = (mr) => (mr.live ? 'live' : mr.liveUnknown ? 'liveUnknown' : 'waitNotice');

export function createLiveNoticeLoop({
  enabled = () => true, loadItems, liveSha, kernelRepo, autoDeploy, git, entries, mainSuite,
  markerExists, writeMarker, save, now = Date.now, tz,
}) {
  // merge sha -> the running commit it was last found missing from.
  const notInBuild = new Map();
  const fetched = new Set();

  async function inBuild(sha, live) {
    const r = await git(['merge-base', '--is-ancestor', sha, live]);
    if (r.status === 0) return 'yes';
    if (r.status === 1) return 'no';
    const has = await git(['cat-file', '-e', `${sha}^{commit}`]);
    if (has.status === 0) throw new Error(`git merge-base failed for ${sha}: ${String(r.stderr ?? '').trim().slice(0, 200)}`);
    if (fetched.has(sha)) return 'missing';
    const f = await git(['fetch', '-q', 'origin']);
    if (f.status !== 0) throw new Error(`git fetch failed: ${String(f.stderr ?? '').trim().slice(0, 200)}`);
    fetched.add(sha);
    return inBuild(sha, live);
  }

  async function maker(ctx) {
    const cfg = autoDeploy();
    const live = liveSha();
    if (!enabled() || !cfg || !Object.keys(cfg).length || !live) return { outcome: 'nothing-to-do' };
    const firstRun = !markerExists();
    const repo = (await kernelRepo())?.toLowerCase() ?? null;
    const t = now();
    const candidates = liveCandidates({ items: loadItems(), autoDeploy: cfg, now: t });
    const found = new Set();
    const unverifiable = new Set();
    const open = new Set();
    for (const c of candidates) {
      if (ctx?.signal?.aborted) break;
      const sha = c.mergeRequest.mergeSha;
      if (repo && String(c.mergeRequest.repo).toLowerCase() !== repo) continue;
      open.add(sha);
      if (notInBuild.get(sha) === live) continue;
      const answer = await inBuild(sha, live);
      if (answer === 'yes') found.add(sha);
      else if (answer === 'no') notInBuild.set(sha, live);
      else unverifiable.add(sha);
    }
    for (const sha of notInBuild.keys()) if (!open.has(sha)) notInBuild.delete(sha);
    const notices = liveNotices({
      items: loadItems(), inBuild: found, unverifiable, kernelRepo: repo, liveSha: live,
      entries: entries(), mainSuite: mainSuite(), autoDeploy: cfg, firstRun, now: t, tz,
    });
    for (const n of notices) save(n);
    if (firstRun) writeMarker();
    if (!notices.length) return { outcome: 'nothing-to-do' };
    return { outcome: 'done', result: { firstRun, marked: notices.map((n) => ({ id: n.id, mergeSha: n.mr.mergeSha, field: fieldOf(n.mr) })) } };
  }

  async function checker({ firstRun, marked }) {
    const byId = new Map(loadItems().map((i) => [i.id, i]));
    const lost = marked.filter((m) => {
      const mr = byId.get(m.id)?.mergeRequest;
      return !mr || mr.mergeSha !== m.mergeSha || !mr[m.field];
    });
    if (lost.length) return { ok: false, reason: lost.map((m) => `${m.id}: ${m.field} not recorded for ${m.mergeSha}`).join('; ') };
    if (firstRun && !markerExists()) return { ok: false, reason: 'the first-run marker was not written' };
    return { ok: true, verifierRef: `live-notice@${marked.map((m) => `${m.id}:${m.field}`).join(',')}` };
  }

  return { maker, checker };
}
