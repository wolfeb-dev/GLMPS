// A watch on the requests folder dies silently when the folder is deleted or
// replaced (the 2026-11-06 state-folder move left card glmps-2-0-155 unopened
// for 49 minutes), so the drain also runs on a timer and the watch is re-armed
// whenever it is gone. Kept free of vscode so node:test can drive it.
type Closable = { close(): void; on(event: string, fn: (...args: unknown[]) => void): unknown };

export interface WatchRequestsOptions {
  dir: string;
  drain: () => void;
  watch: (dir: string, cb: (...args: unknown[]) => void) => Closable;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  pollMs?: number;
}

export function watchRequests(opts: WatchRequestsOptions): { dispose(): void } {
  const { dir, drain, watch, setTimer, clearTimer, pollMs = 30_000 } = opts;
  let watcher: Closable | null = null;
  let disposed = false;

  const arm = (): void => {
    if (watcher || disposed) return;
    let w: Closable;
    try { w = watch(dir, () => drain()); } catch { return; }
    const lost = (): void => {
      if (watcher !== w) return;
      watcher = null;
      try { w.close(); } catch { /* already closed */ }
    };
    w.on('error', lost);
    w.on('close', lost);
    watcher = w;
  };

  drain();
  arm();
  const timer = setTimer(() => { arm(); drain(); }, pollMs);

  return {
    dispose(): void {
      disposed = true;
      clearTimer(timer);
      const w = watcher;
      watcher = null;
      if (w) { try { w.close(); } catch { /* already closed */ } }
    },
  };
}
