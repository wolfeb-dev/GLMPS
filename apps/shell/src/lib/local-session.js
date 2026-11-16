// apps/shell/src/lib/local-session.js
// Scan 2026-10-15 F2: the kernel's file, terminal, resume, open-in-editor and
// restart routes need proof of the per-install key in <stateDir>/
// local-session-key from loopback clients too. The shell, running as the
// operator, reads the key and adds HMAC(key) as a request header for the
// dashboard partition's requests to a loopback kernel only; page script
// never sees it. Mirrors server/lib/governance/access-guard.js
// localSessionValue (pinned by local-session-parity.test.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_SESSION_KEY_FILE = 'local-session-key';
export const LOCAL_SESSION_HEADER = 'X-GLMPS-Local-Session';
const RETRY_MS = 5000;

export function localSessionValue(key) {
  return crypto.createHmac('sha256', String(key)).update('glmps-local-session-v1').digest('hex');
}

export function readLocalSession(stateDir, { readFile = fs.readFileSync } = {}) {
  const file = path.join(stateDir, LOCAL_SESSION_KEY_FILE);
  let key;
  try { key = String(readFile(file, 'utf8')).trim(); }
  catch (e) { return { value: null, reason: e?.code === 'ENOENT' ? `no local session key yet: ${file}` : `local session key could not be read (${e?.code || e?.message || e}): ${file}` }; }
  if (!/^[0-9a-f]{64}$/.test(key)) return { value: null, reason: `local session key is malformed: ${file}` };
  return { value: localSessionValue(key), reason: null };
}

/**
 * The kernel creates the key at its first boot, which may be after the shell
 * starts, so a missing key is re-read at most every 5 s rather than once.
 */
export function createLocalSession({ stateDir, readFile, now = Date.now, log = () => {} }) {
  let value = null; let lastTry = -Infinity; let lastReason = null;
  return {
    get() {
      if (value) return value;
      if (now() - lastTry < RETRY_MS) return null;
      lastTry = now();
      const r = readLocalSession(stateDir, { readFile });
      value = r.value;
      if (!value && r.reason !== lastReason) { lastReason = r.reason; log(r.reason); }
      return value;
    },
  };
}

/** The webRequest filter: every request to the kernel's own origin, nothing else. */
export function kernelRequestFilter(kernelUrl) {
  return { urls: [`${new URL(kernelUrl).origin}/*`] };
}

export function withLocalSession(requestHeaders, value) {
  return value ? { ...requestHeaders, [LOCAL_SESSION_HEADER]: value } : requestHeaders;
}

// The dashboard calls these routes with fetch, which Electron reports as
// 'xhr'. Navigations, scripts, images and anything a wiki page (untrusted
// HTML in a sandboxed iframe) starts never get the header.
export function wantsLocalSession(details) {
  if (details?.resourceType !== 'xhr') return false;
  let ref = '';
  try { ref = new URL(details.referrer || '').pathname; } catch { return true; }
  return !(ref.startsWith('/wiki/') || ref.startsWith('/wiki-ext/'));
}

/** Installs the header on one Electron session; only ever called for a loopback kernel. */
export function installLocalSession({ ses, kernelUrl, localSession }) {
  ses.webRequest.onBeforeSendHeaders(kernelRequestFilter(kernelUrl), (details, callback) => {
    const headers = wantsLocalSession(details) ? withLocalSession(details.requestHeaders, localSession.get()) : details.requestHeaders;
    callback({ requestHeaders: headers });
  });
}
