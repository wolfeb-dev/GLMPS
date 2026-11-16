// Did the deploy's restart actually put the new build on the port? (card
// glmps-2-0-58). A 200 from /healthz is not enough: on 2026-10-18 an orphaned
// server from the previous build answered it. The answer must name the commit
// just fast-forwarded and come from a process that started after the restart.
import { execFile } from 'node:child_process';

// Clock reads in two processes, and uptime_s is floored to the second.
const CLOCK_SLACK_MS = 5000;

/** @returns {{ok: boolean, reason?: string}} */
export function verifyDeployedHealthz(body, { expectSha, restartTs, now = Date.now() }) {
  const want = String(expectSha ?? '').trim().slice(0, 7);
  if (!/^[0-9a-f]{7}$/.test(want)) return { ok: false, reason: `no expected commit to check against (${expectSha ?? 'none'})` };
  const version = typeof body?.version === 'string' ? body.version : null;
  if (!version) return { ok: false, reason: '/healthz reported no version' };
  if (!version.endsWith(`+${want}`)) return { ok: false, reason: `/healthz reports ${version}, expected +${want}: the old build is still serving` };
  const up = Number(body?.uptime_s);
  if (!Number.isFinite(up)) return { ok: false, reason: '/healthz reported no uptime' };
  const bootTs = now - up * 1000;
  if (bootTs < restartTs - CLOCK_SLACK_MS) {
    return { ok: false, reason: `/healthz uptime ${up} s predates the restart ${Math.round((now - restartTs) / 1000)} s ago: a process from before the restart is serving` };
  }
  return { ok: true };
}

/** `git rev-parse <rev>` (HEAD by default) in repoDir, or null with the reason logged by the caller. */
export function readRepoHead(repoDir, { execFileImpl = execFile, rev = 'HEAD' } = {}) {
  return new Promise((resolve) => {
    execFileImpl('git', ['rev-parse', rev], { cwd: repoDir, windowsHide: true, timeout: 10_000 }, (err, out) => {
      const sha = String(out ?? '').trim();
      resolve(!err && /^[0-9a-f]{7,}$/.test(sha) ? { sha } : { sha: null, error: (err?.message || `unexpected output: ${sha.slice(0, 80)}`).trim() });
    });
  });
}
