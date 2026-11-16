// server/lib/kernel/pairing.js
// Pairing codes (server-and-client-tap build task 4): the one-time credential an
// operator mints and a client tap redeems for a client id and token. Single use,
// 10 minute expiry, 8 characters, and a per-source cap on wrong attempts. Codes
// live in memory only, so a server restart voids every outstanding code.
import crypto from 'node:crypto';
import { validTapVersion } from './clients.js';
import { validTapPublicKey } from './x509-lite.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LEN = 8;
const NAME_MAX = 100;

const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const normalize = (code) => String(code ?? '').toUpperCase().replace(/[\s-]+/g, '');

/** A refusal carries the HTTP status and a stable reason the route answers with. */
export class PairingRefusal extends Error {
  constructor(status, reason) {
    super(reason);
    this.name = 'PairingRefusal';
    this.status = status;
    this.reason = reason;
  }
}

function validBody({ name, tapVersion, dataRoots, publicKey }) {
  const n = typeof name === 'string' ? name.trim() : '';
  return !!n && n.length <= NAME_MAX
    && validTapPublicKey(publicKey)
    && validTapVersion(tapVersion)
    && (dataRoots === undefined || (Array.isArray(dataRoots) && dataRoots.every((r) => typeof r === 'string' && r)));
}

// issueCert({ clientId, publicKeyPem }) -> { certPem, notAfter, fingerprint256 }:
// the client-issuing CA signs the key the tap generated (card glmps-2-0-152).
export function createPairing({ clientStore, issueCert, now = Date.now, ttlMs = 10 * 60 * 1000, maxFailures = 5, failureWindowMs = 60 * 1000, maxLiveCodes = 10 }) {
  if (typeof issueCert !== 'function') throw new TypeError('createPairing needs issueCert');
  const codes = new Map();     // sha256(code) -> { expiresAt, actor, clientId }
  const failures = new Map();  // source -> [timestamps inside the window]

  const prune = () => {
    const t = now();
    for (const [k, v] of codes) if (v.expiresAt <= t) codes.delete(k);
    for (const [s, list] of failures) {
      const live = list.filter((ts) => t - ts < failureWindowMs);
      if (live.length) failures.set(s, live); else failures.delete(s);
    }
  };
  const refuse = (source, status, reason) => {
    clientStore.recordRefusedPair({ source, reason });
    return new PairingRefusal(status, reason);
  };

  function mint({ actor, clientId = null }) {
    if (!actor) throw new TypeError('an actor is required to mint a pairing code');
    prune();
    if (clientId && !clientStore.get(clientId)) throw new Error(`no client ${clientId}`);
    if (codes.size >= maxLiveCodes) throw new PairingRefusal(429, 'too-many-live-codes');
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const expiresAt = now() + ttlMs;
    codes.set(hashCode(code), { expiresAt, actor: String(actor), clientId });
    return { code, expiresAt, clientId };
  }

  function redeem({ code, name, tapVersion = null, dataRoots = [], publicKey, source = null }) {
    prune();
    const src = source ?? 'unknown';
    if ((failures.get(src)?.length ?? 0) >= maxFailures) throw refuse(source, 429, 'rate-limited');
    const key = hashCode(normalize(code));
    const entry = codes.get(key);
    if (!entry) {
      failures.set(src, [...(failures.get(src) ?? []), now()]);
      throw refuse(source, 401, 'invalid-code');
    }
    // A typo in the body must not burn the code, so validate before consuming it.
    if (!validBody({ name, tapVersion, dataRoots, publicKey })) throw refuse(source, 400, 'invalid-body');
    codes.delete(key);
    const out = clientStore.pair({
      clientId: entry.clientId, name, tapVersion, dataRoots, actor: `pair-code:${entry.actor}`, source,
      issueCert: (clientId) => issueCert({ clientId, publicKeyPem: publicKey }),
    });
    return { clientId: out.clientId, token: out.token, certificate: out.certificate.certPem, certificateExpiresAt: out.certificate.notAfter, repaired: entry.clientId != null };
  }

  // Test seam: lets a test prove codes are held only as hashes.
  return { mint, redeem, _debugKeys: () => [...codes.keys()] };
}
