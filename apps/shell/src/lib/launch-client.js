// apps/shell/src/lib/launch-client.js
// The shell's side of the authenticated launch protocol (see launch-auth.js for
// the exact scheme), shared by the launch runner and the agy runner so there is
// one copy of it. The raw token never leaves this process: every request proves
// knowledge of it with a fresh nonce and an HMAC over the method, target and
// body, and nothing in a response is trusted until the kernel's own proof over
// it verifies.
import { computeProof, proofsMatch, randomNonce, sha256Hex } from './launch-auth.js';

export function createLaunchClient({ kernelUrl, fetchImpl = fetch }) {
  // every request goes to the kernel URL's ORIGIN. The raw
  // string used to be concatenated (only a trailing slash stripped), so a
  // configured URL with a path, query or #fragment broke every poll.
  let base;
  try { base = new URL(String(kernelUrl)).origin; } catch { base = String(kernelUrl).replace(/\/+$/, ''); }

  // both proofs are bound to a direction ('req'/'res'),
  // the method and the request target (pathname + search of the URL
  // actually fetched, which is what the kernel sees as req.url), so a
  // captured proof fits no other route, id or direction.
  function authedRequest(token, p, { method = 'GET', body } = {}) {
    const rawBody = body !== undefined ? JSON.stringify(body) : '';
    const nonce = randomNonce();
    const url = `${base}${p}`;
    const u = new URL(url);
    const target = { method, path: u.pathname + u.search, nonce };
    const headers = { 'x-launch-nonce': nonce, 'x-launch-proof': computeProof(token, { direction: 'req', ...target, bodyHash: sha256Hex(rawBody) }) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const opts = { method, headers, ...(body !== undefined ? { body: rawBody } : {}) };
    return fetchImpl(url, opts).then((res) => ({ res, target }));
  }

  // Verifies the kernel's own outbound proof over the EXACT JSON this call
  // is about to trust, reusing the nonce THIS request sent - a missing or
  // wrong proof means the response is refused outright and nothing in its
  // body (a record, the allowlist) is ever read.
  async function verifiedJson(token, res, target) {
    const parsed = await res.json();
    const proof = typeof res.headers?.get === 'function' ? res.headers.get('x-launch-response-proof') : null;
    const expected = computeProof(token, { direction: 'res', ...target, bodyHash: sha256Hex(JSON.stringify(parsed)) });
    if (!proofsMatch(proof, expected)) return { ok: false, reason: 'the kernel response did not verify - refusing to trust it' };
    return { ok: true, body: parsed };
  }

  return { authedRequest, verifiedJson };
}
