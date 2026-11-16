// server/lib/kernel/cert-expiry.js
// Card glmps-2-0-152: the private listener's certificate and each paired
// client's certificate, checked by the cert-expiry loop, so nothing stops
// working on a date nobody saw coming.
export const CERT_WARN_DAYS = 30;
const DAY = 86400000;

/** Certificates inside the warning window or past expiry, server first. */
export function certExpiryFindings({ serverNotAfter = null, serverHost = null, serverHostCovered = null, clients = [], now = Date.now(), warnDays = CERT_WARN_DAYS } = {}) {
  const horizon = now + warnDays * DAY;
  const out = [];
  if (serverHostCovered === false) out.push({ kind: 'server-host', host: serverHost });
  if (Number.isFinite(serverNotAfter) && serverNotAfter <= horizon) out.push({ kind: 'server', notAfter: serverNotAfter, expired: serverNotAfter <= now });
  for (const c of Array.isArray(clients) ? clients : []) {
    if (!c?.paired || !Number.isFinite(c.certNotAfter) || c.certNotAfter > horizon) continue;
    out.push({ kind: 'client', clientId: c.id, name: c.name ?? null, notAfter: c.certNotAfter, expired: c.certNotAfter <= now });
  }
  return out;
}
