// Where the kernel is, where its logs are, and which service to start.
// GLMPS 2.0 identity: the GLMPS2 service on port 8123 with its state in
// ~/.glmps2, or ~/.glmps until the cutover renames it (card
// glmps-2-0-144; the server's own rule is server/lib/state-dir.js, which the
// shell must not import). Env overrides (GLMPS_KERNEL_URL, GLMPS_SERVICE_NAME,
// GLMPS_STATE_DIR) are unchanged.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_KERNEL_URL = 'http://127.0.0.1:8123';
export const STATE_DIR_NAME = '.glmps2';
export const LEGACY_STATE_DIR_NAME = '.glmps';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function resolveKernelUrl({ env = process.env, settings = {} } = {}) {
  const source = env.GLMPS_KERNEL_URL ? 'env' : settings.kernelUrl ? 'settings' : 'default';
  const raw = env.GLMPS_KERNEL_URL || settings.kernelUrl || DEFAULT_KERNEL_URL;
  let u = null;
  try { u = new URL(raw); } catch { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    const d = new URL(DEFAULT_KERNEL_URL);
    return { url: d.href, origin: d.origin, isLoopback: true, source: 'default',
      warning: `ignored invalid kernel URL from ${source}: ${String(raw).slice(0, 200)}` };
  }
  // credentials in the kernel URL were shown in plain text and
  // broke fetch. Invalid; the warning names the host, never the secret.
  if (u.username || u.password) {
    const d = new URL(DEFAULT_KERNEL_URL);
    return { url: d.href, origin: d.origin, isLoopback: true, source: 'default',
      warning: `ignored kernel URL from ${source}: it carries credentials (user/password) for ${u.host}` };
  }
  return { url: u.href, origin: u.origin, isLoopback: LOOPBACK.has(u.hostname), source, warning: null };
}

// the same formula resolveLogsDir already builds on,
// pulled out so the launch runner can resolve the one directory its own
// runner-origin path check (validateLaunch) needs - the state dir a
// runner-queued prompt file must actually live inside.
export function resolveStateDir({ env = process.env, settings = {}, homedir, exists = fs.existsSync }) {
  if (env.GLMPS_STATE_DIR || settings.stateDir) return env.GLMPS_STATE_DIR || settings.stateDir;
  const next = path.join(homedir, STATE_DIR_NAME);
  let present = false;
  try { present = exists(next) === true; } catch { present = false; }
  return present ? next : path.join(homedir, LEGACY_STATE_DIR_NAME);
}

// The shell's own source for the worktrees root the gitops allowlist pins every
// path to, built the same way the kernel builds it (GLMPS_WORKTREES_DIR, else
// <stateDir>/runner/worktrees); settings.worktreesDir is for a service whose
// environment sets GLMPS_WORKTREES_DIR where the shell cannot see it.
export function resolveWorktreesDir({ env = process.env, settings = {}, homedir, exists }) {
  return env.GLMPS_WORKTREES_DIR || settings.worktreesDir || path.join(resolveStateDir({ env, settings, homedir, exists }), 'runner', 'worktrees');
}

export function resolveLogsDir({ env = process.env, settings = {}, homedir, exists }) {
  return path.join(resolveStateDir({ env, settings, homedir, exists }), 'logs');
}

export function resolveServiceName({ env = process.env, isPackaged }) {
  return !isPackaged && env.GLMPS_SERVICE_NAME ? env.GLMPS_SERVICE_NAME : 'GLMPS2';
}

// the launch runner executes whatever the kernel hands
// it, in the operator's own session - the session-0 problem this whole
// feature exists for is local-only. A non-loopback kernelUrl means a LAN
// host or a MITM between here and there could serve a launch that then
// runs on THIS machine regardless of the kernel's own up/degraded state,
// so the runner must not even be created against one.
export function shouldRunLaunches({ isLoopback }) {
  return isLoopback === true;
}
