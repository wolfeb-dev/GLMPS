// server/lib/governance/launch-nonces.js
// the kernel's half of replay protection for the launch
// routes (see launch-auth.js for the protocol). A request nonce is accepted
// at most once, and only if it was minted within windowMs of now. Because a
// nonce outside the window is refused on its age alone, an entry can be
// forgotten once its window has passed, which is what keeps the seen-set
// bounded without ever forgetting a nonce that could still be replayed.
// Only ever called AFTER the request's proof has verified, so only a holder
// of the launch token can add entries.
import { nonceTime } from './launch-auth.js';

// Post-breaker residual T1: the past keeps the full window; the future
// gets only futureMs, since the shell and kernel share one machine clock.
export function createNonceGuard({ windowMs = 120_000, futureMs = 5_000, max = 10_000, now = Date.now } = {}) {
  const seen = new Map(); // nonce -> expiry (ms)

  function prune(t) {
    for (const [n, expiry] of seen) if (expiry < t) seen.delete(n);
  }

  function accept(nonce) {
    const minted = nonceTime(nonce);
    if (minted === null) return { ok: false, reason: 'malformed nonce' };
    const t = now();
    if (t - minted > windowMs) return { ok: false, reason: 'stale nonce (older than the freshness window)' };
    if (minted - t > futureMs) return { ok: false, reason: 'stale nonce (minted in the future)' };
    if (seen.has(nonce)) return { ok: false, reason: 'replayed nonce' };
    if (seen.size >= max) prune(t);
    // Refuse rather than evict a still-live entry: evicting one would make
    // it replayable for the rest of its window.
    if (seen.size >= max) return { ok: false, reason: 'nonce cache full' };
    seen.set(nonce, minted + windowMs);
    return { ok: true };
  }

  return { accept, size: () => seen.size };
}
