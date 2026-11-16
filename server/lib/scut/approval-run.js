// server/lib/scut/approval-run.js
// Runs one registered approval action and reports its outcome. The action's
// executable and args come only from the registry, and execFile never goes
// through a shell. deploy-glmps2 starts a scheduled task (the LocalSystem
// service has no git credentials), so the exit status is the task's last
// result, read once the task stops running.
import { execFile } from 'node:child_process';
import { verifyDeployedHealthz, readRepoHead } from '../kernel/deploy-verify.js';

// The task name rides in an environment variable so nothing from config is
// ever spliced into PowerShell source.
const TASK_QUERY = [
  '$p = $env:GLMPS_APPROVAL_TASK; $i = $p.LastIndexOf([char]92);',
  '$t = Get-ScheduledTask -TaskPath $p.Substring(0, $i + 1) -TaskName $p.Substring($i + 1) -ErrorAction Stop;',
  '$n = $t | Get-ScheduledTaskInfo;',
  '@{ state = [string]$t.State; lastResult = $n.LastTaskResult; lastRunTime = $n.LastRunTime.ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress',
].join(' ');

function run(execFileImpl, file, args, opts) {
  return new Promise((resolve) => {
    execFileImpl(file, args, { windowsHide: true, timeout: 60_000, ...opts }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export async function queryTask(task, { execFileImpl = execFile, env = process.env } = {}) {
  const r = await run(execFileImpl, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TASK_QUERY],
    { env: { ...env, GLMPS_APPROVAL_TASK: task }, timeout: 30_000 });
  if (r.code !== 0) throw new Error(`task query failed: ${(r.stderr || r.err?.message || '').trim().slice(0, 200)}`);
  const j = JSON.parse(r.stdout.trim());
  return { state: String(j.state), lastResult: Number(j.lastResult), lastRunTs: Date.parse(j.lastRunTime) };
}

// Task Scheduler stamps LastRunTime when the run starts; allow for the gap
// between our clock read and its own.
const START_SLACK_MS = 60_000;

export async function waitForTask(task, { startedTs, timeoutMs, pollMs = 5000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), query }) {
  const deadline = now() + timeoutMs;
  let lastErr = null;
  while (now() < deadline) {
    await sleep(pollMs);
    try {
      const s = await query(task);
      lastErr = null;
      if (s.state !== 'Running' && s.lastRunTs >= startedTs - START_SLACK_MS) return { done: true, exitCode: s.lastResult };
    } catch (e) { lastErr = e; }
  }
  return { done: false, error: lastErr ? lastErr.message : `task still running after ${Math.round(timeoutMs / 60_000)} min` };
}

// verify(body) -> {ok, reason}: a 200 whose body fails it is retried, then
// reported as `mismatch` (glmps-2-0-58: an orphaned old build answered 200).
export async function checkHealth(url, { fetchImpl = fetch, attempts = 6, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryMs = 5000, verify = null } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(retryMs);
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      let body = null;
      try { body = await res.json(); } catch { /* not JSON: the status still counts */ }
      const summary = body ? [body.status, body.version].filter(Boolean).join(', ') : '';
      if (res.ok) {
        const v = verify ? verify(body) : { ok: true };
        if (v.ok) return { status: res.status, summary };
        last = { status: res.status, summary, mismatch: v.reason };
        continue;
      }
      last = { status: res.status, summary };
    } catch (e) { last = { error: e?.message ?? String(e) }; }
  }
  return last;
}

/**
 * Run (or, with resume, keep waiting on) one action.
 * @returns {Promise<{ok:boolean, exitCode:number|null, error?:string, health:object|null}>}
 */
export async function runApprovalAction(def, { startedTs, resume = false, execFileImpl = execFile, fetchImpl = fetch, now = Date.now, sleep, pollMs, query, readHead } = {}) {
  let exitCode = null;
  const readHeadAt = readHead ?? ((dir) => readRepoHead(dir, { execFileImpl }));
  // An update that finds nothing new exits 0 without restarting, so the old
  // process correctly serves the right commit. Only a run that moved HEAD must
  // have been restarted; a resume proves a restart, so it stays strict.
  const headBefore = def.restartOnlyIfHeadMoved && !resume && def.repoDir ? (await readHeadAt(def.repoDir)).sha ?? null : null;
  if (!resume) {
    const launch = await run(execFileImpl, def.file, def.args, {});
    if (launch.code !== 0) {
      return { ok: false, exitCode: launch.code, error: `could not start: ${(launch.stderr || launch.err?.message || '').trim().slice(0, 200)}`, health: null };
    }
    exitCode = 0;
  }
  if (def.scheduledTask) {
    const q = query ?? ((task) => queryTask(task, { execFileImpl }));
    const w = await waitForTask(def.scheduledTask, { startedTs, timeoutMs: def.timeoutMs, now, sleep, pollMs, query: q });
    if (!w.done) return { ok: false, exitCode: null, error: w.error, health: null };
    exitCode = w.exitCode;
  } else if (resume) {
    return { ok: false, exitCode: null, error: 'the server restarted before the action finished', health: null };
  }
  // With a repoDir the health answer must come from the deployed commit and
  // from a process started after this run did.
  let verify = null;
  if (def.healthUrl && def.repoDir) {
    const head = await readHeadAt(def.repoDir);
    if (!head.sha) return { ok: false, exitCode, error: `could not read the deployed commit in ${def.repoDir}: ${head.error}`, health: null };
    const unchanged = headBefore != null && headBefore === head.sha;
    verify = (body) => verifyDeployedHealthz(body, { expectSha: head.sha, restartTs: unchanged ? 0 : startedTs, now: now() });
  }
  const health = def.healthUrl ? await checkHealth(def.healthUrl, { fetchImpl, sleep, verify }) : null;
  const healthy = !health || (!health.error && !health.mismatch && health.status >= 200 && health.status < 300);
  const result = { ok: exitCode === 0 && healthy, exitCode, health };
  if (health?.mismatch) result.error = health.mismatch;
  return result;
}
