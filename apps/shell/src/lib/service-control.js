// The supervision loop's maker, and the only shell file allowed to start a
// process. It asks the Service Control Manager to start the kernel service
// (K2); the SCM, not Electron, becomes the kernel's parent. Never stop,
// never install, never spawn node.
//
// SERVICE_NAME below is a plain literal, not derived from process.env: this
// module must stay a pure, deterministic default. A caller that needs the
// env-aware, packaging-aware name (dev/smoke overrides via GLMPS_SERVICE_NAME)
// calls endpoints.js resolveServiceName itself and passes the result in as
// `name`.
import { execFile } from 'node:child_process';

export const SERVICE_NAME = 'GLMPS2';
// Win32 codes from `sc.exe start`, general to any service name (1060 for a
// missing service, 5 for a service without start rights).
const KNOWN = {
  0: [true, 'start-requested'],
  1056: [true, 'already-running'],
  1060: [false, 'not-installed'],
  5: [false, 'access-denied'],
  1058: [false, 'disabled'],
};

export function interpretScStart({ code, stdout = '' }) {
  const m = /FAILED (\d+):/.exec(String(stdout));
  if (m) {
    const win32 = Number(m[1]);
    const k = KNOWN[win32];
    return k ? { ok: k[0], code: win32, reason: k[1] } : { ok: false, code: win32, reason: `sc-error-${win32}` };
  }
  // No FAILED text: only a genuine, present exit code counts. `code == null` covers both a signal-killed process (Node
  // reports code: null on a signal kill) and a caller that omitted it
  // entirely; `Number(null)` is 0, which would otherwise be misread as
  // success, so it is checked for explicitly rather than coerced.
  if (code == null) return { ok: false, code: null, reason: 'sc-killed' };
  const win32 = Number(code);
  if (!Number.isInteger(win32)) return { ok: false, code, reason: 'sc-error-unknown' };
  const k = KNOWN[win32];
  return k ? { ok: k[0], code: win32, reason: k[1] } : { ok: false, code: win32, reason: `sc-error-${win32}` };
}

export function startService({ name = SERVICE_NAME, execFileImpl = execFile, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFileImpl('sc.exe', ['start', name], { windowsHide: true, timeout: timeoutMs }, (err, stdout = '') => {
      if (err && err.code === 'ENOENT') return resolve({ ok: false, code: null, reason: 'sc-missing' });
      if (err && err.killed) return resolve({ ok: false, code: null, reason: 'sc-timeout' });
      return resolve(interpretScStart({ code: err ? err.code : 0, stdout }));
    });
  });
}
