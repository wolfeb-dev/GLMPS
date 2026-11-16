// server/lib/kernel/service-mode.js
// Restart semantics under the GLMPS Windows service (program K2). The wrapper
// sets GLMPS_SERVICE=1. In service mode a restart exits non-zero and lets
// WinSW's onfailure restart the process; it never spawns a detached copy, which
// would leave an unsupervised second server beside the supervised one.
export const SERVICE_RESTART_EXIT_CODE = 75;

// Fix round 1 (Opus review, Important): closeServer() has no deadline of its
// own. A stuck scut.stop() Slack round trip or an in-flight request could
// hang it forever, and WinSW only restarts this process once it actually
// exits -- a close that never finishes would leave a half-closed process
// nobody restarts. So the close is raced against this timeout instead of
// awaited unconditionally; whichever settles first wins, and exit(75) always
// follows.
export const SERVICE_RESTART_CLOSE_TIMEOUT_MS = 8000;

export function isServiceMode(env = process.env) { return env.GLMPS_SERVICE === '1'; }

export async function serviceRestart({
  closeServer, exit = process.exit, log = console.error,
  timeoutMs = SERVICE_RESTART_CLOSE_TIMEOUT_MS,
  // Card glmps-2-0-85: which close step is running, so an overrun says what
  // held it instead of only that something did.
  stage = () => null, onOverrun = () => {},
}) {
  let timedOut = false;
  await new Promise((resolve) => {
    let settled = false;
    // Deliberately NOT unref'd: exit(SERVICE_RESTART_EXIT_CODE) below must
    // always run, and it can only run after this promise resolves. An
    // unref'd timer does not count as event-loop work, so once closeServer()
    // has torn down every other handle (sockets, listeners) and nothing else
    // is keeping the loop alive, Node is free to exit the process on its own
    // the moment the loop looks empty -- with whatever exit code is implicit
    // at that point (0), never reaching exit(75) at all. Verified: with
    // unref'd, a never-settling closeServer() in a process with no other
    // handles exits 0 before this timer ever fires. Keeping the timer ref'd
    // guarantees the loop stays alive until this race settles one way or the
    // other, so exit(75) is always what WinSW actually sees.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      resolve();
    }, timeoutMs);
    Promise.resolve().then(() => closeServer()).then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log(`GLMPS: close before service restart failed: ${e?.message || e}`);
        resolve();
      },
    );
  });
  if (timedOut) {
    let where = null;
    try { where = stage(); } catch { /* the log line still goes out */ }
    log(`GLMPS: close before service restart timed out after ${timeoutMs}ms${where ? ` in ${where}` : ''}; exiting anyway`);
    try { onOverrun(where); } catch { /* exit(75) must still run */ }
  }
  exit(SERVICE_RESTART_EXIT_CODE);
}
