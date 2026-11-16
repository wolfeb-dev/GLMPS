// A memo that answers from its last value at once and refreshes behind the
// answer once it is older than maxAgeMs. The Surface data ledger runs git
// ls-files over every residency checkout; making the panel wait on that each
// time the memo aged out is what left it reading "measuring" (glmps-2-0-63).
export function createSwrMemo(compute, { maxAgeMs, now = Date.now } = {}) {
  let memo = null;
  let pending = null;
  const refresh = () => {
    if (!pending) {
      pending = Promise.resolve().then(compute)
        .then((value) => { memo = { ts: now(), value }; return value; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
  return async () => {
    if (!memo) return refresh();
    if (now() - memo.ts >= maxAgeMs) refresh().catch(() => { /* keep serving the last value */ });
    return memo.value;
  };
}
