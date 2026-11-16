// server/lib/scut/restart-all.js
// The Restart sequence (card glmps-2-0-170): quiesce, update, rebuild the app
// only if it is stale, restart only if the serving process predates the run,
// verify, release. It runs inside the server, so the kernel restart it causes
// kills it mid-run; every step is appended to the approvals ledger and a
// resumed run skips finished steps and waits on the one that was in flight.
// All effects are injected (no scheduler, service or state is touched here).
import { beginMaintenance, setMaintenancePhase, clearMaintenance, readMaintenance } from '../kernel/maintenance.js';
import { readLedgerText } from '../state-dir.js';

export const QUIESCE_WAIT_MS = 15 * 60_000;
const QUIESCE_POLL_MS = 5_000;
const DONE = new Set(['finished', 'skipped']);
const WORD = { finished: 'done', skipped: 'skipped', failed: 'failed', started: 'running' };

/** One line for the outcome post: the latest status of each step, in order. */
export function stepsText(steps = []) {
  const latest = new Map();
  for (const s of steps) latest.set(s.step, s);
  return [...latest.values()].map((s) => `${s.step} ${WORD[s.status] ?? s.status}${s.step === 'update' && s.status === 'skipped' && s.detail ? ` (${s.detail})` : ''}`).join(', ');
}

/** Why the promotion this run started was refused, or null if it was not. Task Scheduler reports only an exit code. */
export function promotionRefusal(ledgerText, sinceTs) {
  let found = null;
  for (const line of String(ledgerText ?? '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (Date.parse(rec.ts) >= sinceTs) found = String(rec.outcome ?? '').startsWith('refused:') ? String(rec.reason ?? rec.outcome) : null;
  }
  return found;
}

/**
 * @param {{runId:string, startedTs:number, resume:boolean, steps:object[]}} run  steps: the ledger's entries for this run
 * @param {object} deps
 * @returns {Promise<{ok:boolean, exitCode:number|null, error?:string, health:object|null}>}
 */
export async function runRestartAll({ runId, startedTs, resume = false, steps = [] }, deps) {
  const { stateDir, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mergeBusy, appStale, bootTs, runStep, verify, recordStep = () => {} } = deps;
  const quiesceWaitMs = deps.quiesceWaitMs ?? QUIESCE_WAIT_MS;
  const latest = new Map();
  for (const s of steps) latest.set(s.step, s);
  const fail = (step, error, health = null) => ({ ok: false, exitCode: null, error: `${step}: ${error}`, health });

  // Runs one step unless the ledger says it finished. A step left `started`
  // is the in-flight one a restart interrupted: wait on it, with its own time.
  async function step(name, body) {
    const prev = latest.get(name);
    if (prev && DONE.has(prev.status)) return { ok: true, skipped: true };
    const resumed = prev?.status === 'started';
    const ts = resumed ? prev.ts : now();
    if (!resumed) recordStep({ step: name, status: 'started', ts });
    const outcome = await body({ ts, resumed });
    const status = outcome.skip ? 'skipped' : outcome.ok ? 'finished' : 'failed';
    recordStep({ step: name, status, ts: now(), ...(outcome.detail ? { detail: outcome.detail } : {}) });
    return outcome;
  }

  const runDef = async (name, ts, resumed) => {
    try {
      const r = await runStep(name, { startedTs: ts, ...(resumed ? { resume: true } : {}) });
      return r.ok ? { ok: true } : { ok: false, detail: r.error ?? `exit ${r.exitCode}` };
    } catch (e) { return { ok: false, detail: e?.message ?? String(e) }; }
  };

  try {
    const q = await step('quiesce', async () => {
      if (!readMaintenance(stateDir, now())) beginMaintenance(stateDir, { runId, now: now() });
      const t0 = now();
      while (mergeBusy()) {
        if (now() - t0 >= quiesceWaitMs) return { ok: false, detail: 'still busy: merge work did not finish in time, nothing was restarted' };
        await sleep(QUIESCE_POLL_MS);
      }
      return { ok: true };
    });
    if (!q.ok) return fail('quiesce', q.detail);

    const u = await step('update', async ({ ts, resumed }) => {
      setMaintenancePhase(stateDir, runId, 'restarting', { now: now() });
      const r = await runDef('deploy-glmps2', ts, resumed);
      setMaintenancePhase(stateDir, runId, 'quiescing', { now: now() });
      // A refusal left prod untouched (runner off, board paused, no tested
      // build), so the restart the operator asked for still goes ahead.
      const refused = r.ok ? null : deps.updateRefusal?.(ts);
      return refused ? { ok: true, skip: true, detail: refused } : r;
    });
    if (!u.ok) return fail('update', u.detail);

    const b = await step('rebuild', async ({ ts, resumed }) => {
      if (!resumed && !(await appStale())) return { ok: true, skip: true, detail: 'app unchanged' };
      return runDef('rebuild-app', ts, resumed);
    });
    if (!b.ok) return fail('rebuild', b.detail);

    const rs = await step('restart', async ({ ts, resumed }) => {
      if (!resumed && bootTs() >= startedTs) return { ok: true, skip: true, detail: 'already restarted during this run' };
      setMaintenancePhase(stateDir, runId, 'restarting', { now: now() });
      const r = await runDef('restart-glmps2', ts, resumed);
      setMaintenancePhase(stateDir, runId, 'quiescing', { now: now() });
      return r;
    });
    if (!rs.ok) return fail('restart', rs.detail);

    let health = null;
    const v = await step('verify', async () => {
      try {
        const r = await verify({ startedTs });
        health = r.health ?? null;
        return r.ok ? { ok: true } : { ok: false, detail: r.error ?? 'verification failed' };
      } catch (e) { return { ok: false, detail: e?.message ?? String(e) }; }
    });
    if (!v.ok) return fail('verify', v.detail, health);
    return { ok: true, exitCode: 0, health };
  } finally {
    clearMaintenance(stateDir, runId);
  }
}

/**
 * The runAction the approvals module calls for a composite def. `runApproval`
 * is runApprovalAction, so each step is the same scheduled-task run (with its
 * own strict health check) that the single actions use.
 */
export function makeRestartAllRunner({ stateDir, getRegistry, runApproval, mergeBusy, readTreeId, readHead, checkHealth, verifyHealthz, now = Date.now, sleep, quiesceWaitMs, appIsStale, healthUrl }) {
  return async function runComposite(def, { startedTs, resume, runId, steps = [], recordStep = () => {} }) {
    const seen = [...steps];
    const result = await runRestartAll({ runId, startedTs, resume, steps }, {
      stateDir, now, sleep, quiesceWaitMs, mergeBusy,
      updateRefusal: (since) => { try { return promotionRefusal(readLedgerText(stateDir, 'promotions.jsonl'), since); } catch { return null; } },
      appStale: async () => appIsStale(stateDir, await readTreeId()),
      bootTs: () => now() - process.uptime() * 1000,
      recordStep: (e) => { seen.push(e); recordStep(e); },
      runStep: (name, opts) => {
        const stepDef = getRegistry()[name];
        if (!stepDef) return { ok: false, error: `${name} is not registered` };
        return runApproval(stepDef, opts);
      },
      verify: async ({ startedTs: since }) => {
        const url = healthUrl ?? def.healthUrl;
        if (!url) return { ok: true };
        const head = await readHead(def.repoDir ?? getRegistry()['deploy-glmps2']?.repoDir);
        if (!head?.sha) return { ok: false, error: `could not read the deployed commit: ${head?.error ?? 'unknown'}` };
        const health = await checkHealth(url, { sleep, verify: (body) => verifyHealthz(body, { expectSha: head.sha, restartTs: since, now: now() }) });
        const healthy = health && !health.error && !health.mismatch && health.status >= 200 && health.status < 300;
        return healthy ? { ok: true, health } : { ok: false, health, error: health?.mismatch ?? health?.error ?? `/healthz answered ${health?.status}` };
      },
    });
    return { ...result, stepsLine: stepsText(seen) };
  };
}
