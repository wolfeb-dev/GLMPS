// A stand-in desktop shell for server tests: claims every gitops record the
// kernel queued and answers with handler(op) merged over an empty success
// result. The server must not import the shell, so the allowlist itself is
// checked from the other side (apps/shell/test/gitops-e2e.test.js).
export function fakeShell(launchBroker, handler) {
  const seen = [];
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    for (const r of launchBroker.pending()) {
      if (r.origin !== 'gitops') continue;
      if (!launchBroker.claim(r.id, 'desktop-shell')) continue;
      seen.push(r.op);
      launchBroker.complete(r.id, { result: { status: 0, stdout: '', stderr: '', timedOut: false, ...(handler(r.op) ?? {}) } });
    }
    setTimeout(loop, 5);
  };
  setTimeout(loop, 5);
  return { seen, stop() { stopped = true; } };
}
