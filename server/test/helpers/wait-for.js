// Wait on the condition a test is about to assert, not on a fixed clock: a CI
// runner running 4 test files at once can stall a process far past any
// margin that holds on a dev box. The timeout is a backstop for a real
// regression, so keep it generous; a passing run never pays for it.
export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 10, message = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: timed out after ${timeoutMs} ms waiting for ${message}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
