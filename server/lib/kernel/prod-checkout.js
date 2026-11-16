// server/lib/kernel/prod-checkout.js
// Promotion rule 2 (dev/prod T1, card glmps-2-0-runtime-48): the prod checkout
// is only ever fast-forwarded. A tracked change or a commit ahead of upstream
// stalls every later --ff-only deploy, so the deploy refuses to run on one.
// Fails closed: a checkout that cannot be read is not ok.
import { spawnSync } from 'node:child_process';

function lines(out) {
  return String(out ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
}

/** @returns {{ok: boolean, dirty: string[], ahead: string[], reason: string|null}} */
export function checkProdCheckout({ repoRoot, upstream = 'origin/main', spawnSyncFn = spawnSync } = {}) {
  const run = (args) => spawnSyncFn('git', ['-C', repoRoot, ...args], { encoding: 'utf8', windowsHide: true });
  const failed = (what, r) => ({
    ok: false, dirty: [], ahead: [],
    reason: `could not ${what} in ${repoRoot}: ${r.error?.message ?? (String(r.stderr || '').trim() || `exit ${r.status}`)}`,
  });

  const status = run(['status', '--porcelain', '--untracked-files=no']);
  if (status.error || status.status !== 0) return failed('read git status', status);
  const log = run(['log', '--oneline', `${upstream}..HEAD`]);
  if (log.error || log.status !== 0) return failed(`compare HEAD with ${upstream}`, log);

  const dirty = lines(status.stdout);
  const ahead = lines(log.stdout);
  if (!dirty.length && !ahead.length) return { ok: true, dirty, ahead, reason: null };
  const parts = [];
  if (dirty.length) parts.push(`tracked changes: ${dirty.join('; ')}`);
  if (ahead.length) parts.push(`commits ahead of ${upstream}: ${ahead.join('; ')}`);
  return { ok: false, dirty, ahead, reason: parts.join('. ') };
}
