// server/lib/scut/connect-retry.js
// Retries the one-shot step that precedes the Socket Mode client (auth.test).
// socket-mode.js already retries its own connect forever; before this, a
// single auth.test timeout rejected the startup and inbound Slack stayed dead
// until a restart. Same jittered, capped exponential delay as socket-mode, as
// an awaited loop (no timers of its own). Resolves with the attempt's value,
// or with STOPPED when isStopped() turns true so a stop is not a failure.

export const STOPPED = Symbol('scut-connect-stopped');

export async function retryUntilConnected({
  attempt,
  isStopped,
  sleep,
  random = Math.random,
  baseDelayMs = 1000,
  maxDelayMs = 60000,
  onFailure = () => {},
}) {
  let failures = 0;
  for (;;) {
    if (isStopped()) return STOPPED;
    try {
      return await attempt();
    } catch (error) {
      failures += 1;
      onFailure({ attempt: failures, error });
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (failures - 1));
      await sleep(backoff * (0.5 + random()));
    }
  }
}
