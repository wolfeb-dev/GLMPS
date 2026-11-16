// taps/tap-tls.js
// The tap's side of local-only mutual TLS (card glmps-2-0-runtime-147, spec
// docs/specs/2026-11-10-glmps-2-0-171-local-only-mtls.md). The tap trusts only
// the CA it pinned at pairing by fingerprint, never the Windows store, and
// presents its own client certificate on every request to an https server.
// Global fetch cannot take a CA or a client certificate without the undici
// package, so an https request with `init.tls` goes through node:https here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { Readable } from 'node:stream';

export const CA_FILE = 'server-ca.pem';
export const CERT_FILE = 'client-cert.pem';
export const caFile = (home) => path.join(home, CA_FILE);
export const certFile = (home) => path.join(home, CERT_FILE);

/** The tap's client key pair: P-256, made on this machine; only the public half is ever sent. */
export function tapKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** 64 lowercase hex, from any spelling the dashboard or an operator gives (colons, spaces, groups, case). */
export function normalizeFingerprint(input) {
  const f = String(input ?? '').toLowerCase().replace(/[\s:-]+/g, '');
  return /^[0-9a-f]{64}$/.test(f) ? f : null;
}

const fingerprintOf = (pem) => new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

/** Shown in four-character groups so it can be compared by eye with the dashboard. */
export const groupFingerprint = (f) => String(f ?? '').replace(/(.{4})(?=.)/g, '$1 ');

/**
 * The trust anchor to pin: the certificate in the server's presented chain whose
 * SHA-256 is the fingerprint the dashboard showed. Anything else is refused.
 */
export function pinFromChain(chainPems, fingerprint) {
  const want = normalizeFingerprint(fingerprint);
  if (!want) return { ok: false, reason: 'the fingerprint is not a SHA-256 fingerprint (64 hex characters)' };
  if (!Array.isArray(chainPems) || !chainPems.length) return { ok: false, reason: 'the server presented no certificate' };
  for (const pem of chainPems) if (fingerprintOf(pem) === want) return { ok: true, caPem: pem };
  const root = fingerprintOf(chainPems[chainPems.length - 1]);
  return { ok: false, reason: `the server's certificate authority has fingerprint ${groupFingerprint(root)}, not the ${groupFingerprint(want)} the dashboard showed; this may not be your GLMPS server, so nothing was sent` };
}

const derToPem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n')}-----END CERTIFICATE-----\n`;

/**
 * Read the chain an https server presents, without trusting it yet and without
 * sending anything. connect: { host, localAddress } overrides the address dialled
 * (tests; CI has no private interface), never the name the certificate is checked for.
 */
export function probeServerChain(serverUrl, { connect = null, timeoutMs = 10_000 } = {}) {
  const u = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: connect?.host ?? u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 443),
      ...(connect?.localAddress ? { localAddress: connect.localAddress } : {}),
      ...(net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? {} : { servername: u.hostname }),
      // Read-only look at the chain: it is matched against the pinned fingerprint before anything is sent.
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' })); }, timeoutMs);
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const out = [];
      const seen = new Set();
      for (let c = sock.getPeerCertificate(true); c && c.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
        seen.add(c.fingerprint256);
        out.push(derToPem(c.raw));
      }
      sock.end();
      resolve(out);
    });
  });
}

/** {state:'ok', notAfter} | {state:'missing'|'expired', reason, notAfter}: what the status page reports before any request. */
export function certificateState({ certPem, keyPresent, caPem, now = Date.now() }) {
  if (!caPem) return { state: 'missing', notAfter: null, reason: `the pinned server certificate authority (${CA_FILE}) is missing; pair this client again` };
  if (!certPem || !keyPresent) return { state: 'missing', notAfter: null, reason: 'this client has no client certificate; pair it again with a new code' };
  let notAfter;
  try { notAfter = Date.parse(new crypto.X509Certificate(certPem).validTo); } catch { return { state: 'missing', notAfter: null, reason: `${CERT_FILE} is not a certificate; pair this client again` }; }
  if (notAfter <= now) return { state: 'expired', notAfter, reason: `the client certificate expired on ${new Date(notAfter).toISOString().slice(0, 10)}; pair this client again from the dashboard (Pair again)` };
  return { state: 'ok', notAfter, reason: null };
}

const readOrNull = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export const readCa = (home) => readOrNull(caFile(home));
export const readCert = (home) => readOrNull(certFile(home));

export function writePem(file, pem) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, pem, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const NULL_BODY = new Set([101, 204, 205, 304]);

function httpsFetch(url, init, connect) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const { ca, cert, key } = init.tls;
  return new Promise((resolve, reject) => {
    const fail = (e) => reject(Object.assign(new TypeError('fetch failed'), { cause: e }));
    const headers = { ...(init.headers || {}) };
    const body = init.body == null ? null : (typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body));
    if (body) headers['content-length'] = String(body.length);
    const req = https.request({
      host: connect?.host ?? host, port: Number(u.port || 443), path: u.pathname + u.search,
      method: init.method || 'GET', headers, agent: false,
      ...(connect?.localAddress ? { localAddress: connect.localAddress } : {}),
      ...(net.isIP(host) ? {} : { servername: host }),
      // ca replaces the system store: the pinned CA is the only anchor.
      ca, ...(cert && key ? { cert, key } : {}),
      checkServerIdentity: (_h, c) => tls.checkServerIdentity(host, c),
    }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const one of [].concat(v)) h.append(k, one);
      const nullBody = NULL_BODY.has(res.statusCode) || (init.method || 'GET').toUpperCase() === 'HEAD';
      if (nullBody) res.resume();
      resolve(new Response(nullBody ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers: h }));
    });
    const onAbort = () => req.destroy(init.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init.signal) {
      if (init.signal.aborted) { onAbort(); }
      else { init.signal.addEventListener('abort', onAbort, { once: true }); req.once('close', () => init.signal.removeEventListener('abort', onAbort)); }
    }
    req.on('error', fail);
    req.end(body ?? undefined);
  });
}

/**
 * A fetch that sends a request carrying `init.tls` ({ ca, cert, key }) over
 * node:https with that trust and identity, and every other request through `base`.
 */
export function createTapFetch({ base = globalThis.fetch, connect = null } = {}) {
  return (url, init = {}) => (init.tls ? httpsFetch(url, init, connect) : base(url, init));
}
