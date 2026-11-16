// server/lib/orchestration/gitops-broker.js
// git, gh, test and headless review runs for a kernel that cannot make them. As a Windows
// service the kernel sits in session 0 with no GitHub sign-in, and no service
// may hold the operator's credentials (D33). So each call is queued on the
// launch broker as a 'gitops' record; the desktop shell, in the operator's own
// session, claims it through the authenticated launch protocol, checks it
// against its own allowlist, runs it and reports { status, stdout, stderr }.
// run() resolves a non-zero exit as a result (callers read `status`) and
// rejects only when the call could not be made: code NO_SHELL (nobody claimed
// it), REFUSED (the shell's allowlist said no), GITOPS_TIMEOUT or GITOPS_FAILED.
const KINDS = new Set(['git', 'gh', 'test', 'review', 'card', 'vendor-card', 'release']);
const INFRA_CODES = new Set(['NO_SHELL', 'REFUSED', 'GITOPS_TIMEOUT', 'GITOPS_FAILED']);
// The call could not be made (no shell, refused, lost): a caller holds its work
// for the operator on this, instead of treating it as a failed git or test run.
export const isGitopsInfraError = (e) => INFRA_CODES.has(e?.code);
const DEFAULT_TIMEOUT_MS = { git: 120000, gh: 60000, test: 30 * 60 * 1000, review: 60 * 60 * 1000, card: 30 * 60 * 1000, 'vendor-card': 60 * 60 * 1000, release: 11 * 60 * 1000 };
const TAILED = new Set(['test', 'review', 'card']);
// A test run's, a review's or a card run's outcome is at the end of its output; a diff or JSON read is cut at its end.
const capOf = (s, n, kind) => { const t = typeof s === 'string' ? s : ''; return t.length <= n ? t : (TAILED.has(kind) ? t.slice(-n) : t.slice(0, n)); };

// Card glmps-2-0-85: 10 s was missed on a loaded workstation (a full test run
// plus kernel stalls of a few seconds), and each miss held the merge queue for
// a manual release. A shell that is really gone still holds, a minute later.
export const DEFAULT_CLAIM_WAIT_MS = 60000;

export function createGitopsBroker({
  launchBroker, roots = () => ({ repos: [], worktrees: '' }),
  claimWaitMs = DEFAULT_CLAIM_WAIT_MS, pollMs = 100, graceMs = 15000, maxOutput = 200 * 1024,
  // Told once per call how long the desktop app took to claim it, from the
  // record's own claim time, so a claim and finish inside one poll still count.
  onPickup = null,
}) {
  // A call can name extra checkout roots for itself (the tap-git clones dir) without widening every other call's.
  const withRepos = (r, extra) => (Array.isArray(extra) && extra.length ? { ...r, repos: [...new Set([...(r.repos ?? []), ...extra])] } : r);
  async function run({ kind, cwd = null, args = [], command = null, settings = null, promptFile = null, model = null, sessionId = null, resume = false, vendor = null, branch = null, base = null, cardId = null, title = null, repo = null, number = null, bump = null, summary = null, finishOnly = false, agentText = null, timeoutMs, onEnqueued = null, extraRepos = [], maxOutput: cap = maxOutput, claimWaitMs: wait = claimWaitMs } = {}) {
    if (!KINDS.has(kind)) throw new TypeError(`gitops kind must be one of ${[...KINDS].join(', ')}: ${kind}`);
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS[kind];
    const op = { kind, cwd, args, ...(command != null ? { command } : {}), timeoutMs: limit, roots: withRepos(roots(), extraRepos), maxOutput: cap };
    if (kind === 'test') delete op.args;
    if (kind === 'review') { delete op.args; Object.assign(op, { model, settings, promptFile }); }
    if (kind === 'card') { delete op.args; Object.assign(op, { model, settings, promptFile, sessionId, resume: resume === true }); }
    // Card glmps-2-0-162: a non-Claude agent run plus the shell's fixed finish (tests, commit, push, PR).
    if (kind === 'vendor-card') { delete op.args; Object.assign(op, { vendor, model, promptFile, branch, base, cardId, title, ...(finishOnly === true ? { finishOnly: true, agentText: String(agentText ?? '') } : {}) }); }
    // Card glmps-2-0-216: the release after a merge, run by the shell's fixed sequence.
    if (kind === 'release') { delete op.args; Object.assign(op, { repo, base, number, cardId, bump, summary }); }
    const { id } = launchBroker.enqueue({ origin: 'gitops', command: `gitops ${kind}`, cwd: cwd ?? 'gitops', op });
    try { onEnqueued?.(id); } catch { /* a bad callback must not lose the call */ }
    const t0 = Date.now();
    let claimedAt = null;
    let pickedUp = false;
    const notePickup = (rec) => {
      if (pickedUp || !Number.isFinite(rec.claimedTs)) return;
      pickedUp = true;
      try { onPickup?.({ kind, ms: Math.max(0, rec.claimedTs - t0) }); } catch { /* a bad callback must not lose the call */ }
    };
    return new Promise((resolve, reject) => {
      const end = (fn) => { try { launchBroker.scrub(id); } catch { /* the record is only cosmetic now */ } fn(); };
      const giveUp = (error) => {
        // fail() leaves a record the shell already finished alone
        launchBroker.fail(id, error.message);
        end(() => reject(error));
      };
      const poll = () => {
        const rec = launchBroker.get(id);
        const now = Date.now();
        if (!rec) return reject(new Error('gitops broker: the call record disappeared'));
        notePickup(rec);
        if (rec.state === 'done') {
          const r = rec.result ?? {};
          return end(() => resolve({
            status: Number.isInteger(r.status) ? r.status : 1,
            stdout: capOf(r.stdout, cap, kind), stderr: capOf(r.stderr, cap, kind), timedOut: r.timedOut === true,
            ...(r.cancelled === true ? { cancelled: true } : {}),
          }));
        }
        if (rec.state === 'failed') {
          const msg = rec.error || 'gitops call failed';
          const code = /^refused by shell/.test(msg) ? 'REFUSED' : 'GITOPS_FAILED';
          return end(() => reject(Object.assign(new Error(msg), { code })));
        }
        if (rec.state === 'pending' && now - t0 >= wait) {
          return giveUp(Object.assign(new Error(`gitops broker: the desktop app did not pick this up within ${wait} ms (is the GLMPS 2.0 desktop app running?)`), { code: 'NO_SHELL' }));
        }
        if (rec.state === 'claimed') {
          claimedAt ??= now;
          if (now - claimedAt >= limit + graceMs) {
            return giveUp(Object.assign(new Error(`gitops broker: the desktop app returned no result for ${kind} within ${limit + graceMs} ms (timed out)`), { code: 'GITOPS_TIMEOUT' }));
          }
        }
        setTimeout(poll, pollMs);
      };
      setTimeout(poll, pollMs);
    });
  }
  // Ask the shell to stop a run; the run still resolves, as cancelled.
  const cancel = (id) => launchBroker.requestCancel(id);
  return { run, cancel };
}

// The desktop app's job pickups as /healthz shows them, and an alert for one
// that used more than half the wait: a slow pickup is the warning before a
// NO_SHELL miss holds the merge queue (card glmps-2-0-85).
export const PICKUP_SAMPLES = 20;
export function pickupSummary(samples, { claimWaitMs = DEFAULT_CLAIM_WAIT_MS, now = Date.now() } = {}) {
  const recent = samples.slice(-PICKUP_SAMPLES);
  const sorted = recent.map((s) => s.ms).sort((a, b) => a - b);
  const stats = recent.length
    ? { last_ms: recent.at(-1).ms, median_ms: sorted[Math.floor((sorted.length - 1) / 2)], max_ms: sorted.at(-1), n: recent.length }
    : { last_ms: null, median_ms: null, max_ms: null, n: 0 };
  const slow = recent.filter((s) => s.ms > claimWaitMs / 2 && now - s.at <= 24 * 3600 * 1000);
  const alerts = slow.length ? [{
    source: 'shell-pickup', severity: 'warn',
    title: `The desktop app took ${Math.round(slow.at(-1).ms / 1000)} s to pick up a ${slow.at(-1).kind} job (limit ${Math.round(claimWaitMs / 1000)} s)`,
    detail: `${slow.length} of the last ${recent.length} pickups used more than half the wait. Past the limit the merge queue holds for a manual release.`,
    target: null, ts: slow.at(-1).at,
  }] : [];
  return { stats, alerts };
}

const TEST_TAIL_CHARS = 8000;

// The shapes the existing merge-queue code already takes as injected seams
// (merge-tests git and runTest, merge-exec and the intake route's gh), backed
// by the shell. A failed call rejects with its code intact.
export function createShellSeams(broker) {
  return {
    git: (args, { cwd } = {}, extra = {}) => broker.run({ kind: 'git', cwd, args, ...extra }).then(({ status, stdout, stderr }) => ({ status, stdout, stderr })),
    gh: (file, args) => broker.run({ kind: 'gh', args }).then(({ status, stdout, stderr }) => ({ status, stdout, stderr })),
    async runTest({ command, cwd, timeoutMs }) {
      const t0 = Date.now();
      const r = await broker.run({ kind: 'test', cwd, command, timeoutMs });
      return {
        exitCode: r.timedOut ? null : r.status, timedOut: r.timedOut,
        tail: `${r.stdout}${r.stderr}`.slice(-TEST_TAIL_CHARS), durationMs: Date.now() - t0,
      };
    },
  };
}
