// Exit when the process that started us is gone (card glmps-2-0-58). Windows
// never kills a child with its parent, so when the WinSW wrapper crashed the
// node server kept port 8123 and every service restart after it hit
// EADDRINUSE. Watching the parent closes that hole whatever kills the wrapper.

export function isPidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the pid exists but belongs to someone we may not signal.
    return e?.code === 'EPERM';
  }
}

/**
 * Calls onGone once, the first time `ppid` is no longer alive. Residual gap:
 * a pid the OS reuses within one interval reads as alive.
 * @returns {() => void} stop
 */
export function watchParent({ ppid = process.ppid, intervalMs = 2000, isAlive = isPidAlive, onGone }) {
  if (!(ppid > 0)) return () => {};
  const timer = setInterval(() => {
    if (isAlive(ppid)) return;
    clearInterval(timer);
    onGone(ppid);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
