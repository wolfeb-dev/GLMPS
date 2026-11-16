// server/lib/governance/access-guard.js
// Pure, zero-dep access decision for the non-local bind + shared-token feature
// (and, since scan 2026-10-15 F2, the loopback local-session rule below).
// The token is enforced PER-REQUEST by remote-vs-loopback: localhost (the host-native
// executor - queue runner, companion, tap, local dev) keeps full access with no token;
// only real LAN/remote clients need a token, and only on mutating/secret routes.
// See docs/superpowers/specs/2026-06-30-non-local-bind-shared-token-design.md.
import crypto from 'node:crypto';
import net from 'node:net';
// the wiki handler decides "is this a wiki asset" on the RAW url and
// decodes it, so the guard must use the very same predicate (a parsed-path
// regex let '/wiki/server%2ehtml' through untokened).
import { isWikiAssetRequest } from '../observability/wiki-serve.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

/** Is the request's client address a loopback (same-host) address? */
export function isLoopback(addr) {
  return !!addr && LOOPBACK.has(addr);
}

/** Is the server's configured bind host a loopback (localhost-only) host? */
export function isLoopbackHost(host) {
  return !host || host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// sensitive reads guarded the same way
// as the secret GET /api/budget - a remote LAN client would otherwise read
// them token-free, and a same-host DNS-rebound browser page would read them
// with no Host/Origin check at all. /api/memory/lookup can return Mem0-
// admitted facts scoped to any project on the box; /api/judge/verdicts and
// /api/judge/summary expose the judge's independent pass/fail ledger over
// every session.
// Fix round 1, m1: the launch queue carries a command/cwd about to run in
// the operator's own session - a remote LAN client (or a same-host
// DNS-rebound page) reading it unguarded is the same shape of leak the
// other three routes here were already closed for.
const SENSITIVE_GET_ROUTES = new Set(['/api/budget', '/api/memory/lookup', '/api/judge/verdicts', '/api/judge/summary', '/api/launches']);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Scan 2026-10-15 F2: a loopback address alone is not the operator. Another
// local account, a low-privilege local service or a same-host proxy reaches
// 127.0.0.1 too, and can send any Origin or Sec-Fetch-* header it likes. The
// routes that read or write files or run code therefore need, from loopback
// as well, proof of a per-install key that only the operator account can
// read (<stateDir>/local-session-key): the desktop shell adds it as a header,
// a browser holds it after the dashboard-link step. The client presents
// HMAC(key) rather than the key itself. The remote token is accepted too.
export const LOCAL_SESSION_ROUTES = new Set(['/api/file', '/api/file/undo', '/api/terminal', '/api/resume', '/api/open-in-editor', '/api/restart', '/api/actions/rebuild-app', '/api/actions/restart-all']);
// The same proof for a write whose path is also an ordinary read: creating a
// project edits the harness permission list and trust file (glmps-2-0-runtime-75).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const scopeRe = (p) => new RegExp(`^${p.split(':id').map(escapeRe).join('[^/]+')}$`);
// Minting a pairing code and rotating or revoking a client hand out or kill a
// credential (scan F9, glmps-2-0-runtime-109). ':id' matches one path segment.
export const LOCAL_SESSION_WRITES = Object.freeze([
  ['POST', '/api/projects'],
  ['POST', '/api/tap/pair-code'],
  ['POST', '/api/clients/:id/rotate'],
  ['POST', '/api/clients/:id/revoke'],
].map(([method, p]) => Object.freeze({ method, path: p, re: scopeRe(p) })));
function needsLocalSession(method, pathname) {
  return LOCAL_SESSION_ROUTES.has(pathname) || LOCAL_SESSION_WRITES.some((w) => w.method === method && w.re.test(pathname));
}
export const LOCAL_SESSION_KEY_FILE = 'local-session-key';
export const LOCAL_SESSION_HEADER = 'x-glmps-local-session';
export function localSessionValue(key) {
  return crypto.createHmac('sha256', String(key)).update('glmps-local-session-v1').digest('hex');
}

// Security hardening 2026-10-13 (F2, F3, F4, F21): the REMOTE token rule.
// A remote client needs the token for any mutating method on ANY path (so a
// '//api/...' or '/v1/traces' spelling can never slip past a prefix test),
// and for every read of server data: /api/*, the OTLP /v1/* alias, other
// repos' wiki pages, and wiki assets. Only liveness, icons and the dashboard's
// own static assets stay open, so the page still loads and can ask for the
// token. Supersedes section 2.4 of the 2026-06-30 non-local spec.
const OPEN_REMOTE_PATHS = new Set(['/api/health', '/healthz']);
export function isGuardedRoute(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  if (MUTATING_METHODS.has(m)) return true;
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return true;
  if (OPEN_REMOTE_PATHS.has(pathname) || pathname.startsWith('/api/icon/')) return false;
  if (pathname.startsWith('/api/') || pathname.startsWith('/v1/') || pathname.startsWith('/wiki-ext/')) return true;
  if (isWikiAssetRequest(pathname)) return true;
  return false;
}

// Server-and-client-tap task 3: a paired client tap's token (kernel/clients.js)
// is a second remote credential, scoped. It reaches tap ingest, the routes the
// client's hooks and agents call through the relay, and the dashboard's reads,
// and nothing else. Writes are an allowlist, so a route added later is refused
// until it is listed here. Reads are open on /api/* minus CLIENT_DENIED_READS:
// the server's own disk, secrets, config and client management.
export const TAP_PAIR_ROUTE = '/api/tap/pair';
export const CLIENT_WRITE_SCOPE = Object.freeze([
  ['POST', '/api/tap/ingest'],
  ['POST', '/api/tap/heartbeat'],
  ['POST', '/api/tap/mirror/append'],
  ['POST', '/api/tap/mirror/snapshot'],
  ['POST', '/api/tap/git'],
  ['POST', '/api/backlog'],
  ['PATCH', '/api/backlog/:id'],
  ['POST', '/api/backlog/:id/devlog'],
  ['POST', '/api/backlog/:id/gate'],
  ['POST', '/api/backlog/:id/progress'],
  ['POST', '/api/backlog/:id/merge-request'],
  ['POST', '/api/control/gate'],
  ['POST', '/api/launches/:id/claim'],
  ['POST', '/api/launches/:id/result'],
  ['POST', '/api/guards/refusal'],
  ['POST', '/api/outcomes/finalize'],
  ['POST', '/api/ingest/learning-gaps'],
  ['POST', '/api/ingest/backlog-ticket'],
  ['POST', '/api/ingest/decision-log'],
  ['POST', '/api/ingest/qa-trends'],
  ['POST', '/api/otel'],
  ['POST', '/v1/traces'],
].map(([method, p]) => Object.freeze({ method, path: p, re: scopeRe(p) })));
export const CLIENT_DENIED_READS = Object.freeze([
  '/api/file', '/api/surface/tree', '/api/surface/file-diff',
  '/api/budget', '/api/config', '/api/runner/config', '/api/wiki/ticket',
  '/api/clients', '/api/clients/*', '/api/tap/*',
]);
// Card glmps-2-0-runtime-67: the tap fetches its own update archive with its
// own token. The archive is signed and checked against the tap's pinned signer,
// so reading it grants nothing; the installer and release document stay dashboard-only.
// Task 10 adds the client's own mirror manifest: the server answers it for the
// token's client only, so it reads nothing of anyone else's.
export const TAP_UPDATE_PATH = '/api/tap/download/update';
export const CLIENT_ALLOWED_TAP_READS = Object.freeze([TAP_UPDATE_PATH, '/api/tap/mirror']);
function deniedRead(pathname) {
  if (CLIENT_ALLOWED_TAP_READS.includes(pathname)) return false;
  if (LOCAL_SESSION_ROUTES.has(pathname)) return true;
  return CLIENT_DENIED_READS.some((d) => (d.endsWith('/*') ? pathname.startsWith(d.slice(0, -1)) : pathname === d));
}
/** May a paired client's token reach this method + path? */
export function clientScopeAllows(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  if (typeof pathname !== 'string') return false;
  if (m === 'GET' || m === 'HEAD') return pathname.startsWith('/api/') && !deniedRead(pathname);
  return CLIENT_WRITE_SCOPE.some((s) => s.method === m && s.re.test(pathname));
}

// the wiki iframe shows UNTRUSTED HTML whose script can read its own
// location.href, so it must never carry the master token. It gets a wiki
// ticket instead: an HMAC (per-process random key) over a scope and an
// expiry, valid 10 minutes, accepted only for GET/HEAD under /wiki/ and
// /wiki-ext/ - never for /api, /v1 or a mutation.
// Scan 2026-10-15 F4/F5: the MAC also covers the wiki the ticket was minted
// for, 'kernel' (/wiki) or 'ext:<project key>' (/wiki-ext/<key>), and the
// guard derives the scope from the request path, so a ticket handed to one
// repo's untrusted page opens no other wiki.
export const WIKI_TICKET_TTL_MS = 10 * 60 * 1000;
function wikiTicketMac(key, exp, scope) {
  return crypto.createHmac('sha256', String(key)).update(`wiki-read:${scope}:${exp}`).digest('base64url');
}
/** The ticket scope of a wiki base ('/wiki', '/wiki-ext/<key>') or of a path under one; null otherwise. */
export function wikiTicketScope(p) {
  const s = String(p ?? '');
  if (s === '/wiki' || s.startsWith('/wiki/')) return 'kernel';
  const m = /^\/wiki-ext\/([^/]+)(?:\/|$)/.exec(s);
  if (!m) return null;
  try { return `ext:${decodeURIComponent(m[1])}`; } catch { return null; }
}
export function mintWikiTicket({ key, scope = 'kernel', now = Date.now(), ttlMs = WIKI_TICKET_TTL_MS } = {}) {
  if (!key) throw new Error('mintWikiTicket: no key');
  if (!scope) throw new Error('mintWikiTicket: no scope');
  const exp = now + ttlMs;
  return { ticket: `${exp}.${wikiTicketMac(key, exp, scope)}`, expiresAt: exp };
}
export function verifyWikiTicket(ticket, { key, scope = 'kernel', now = Date.now() } = {}) {
  if (!key || !scope || typeof ticket !== 'string') return false;
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > now) || exp > now + WIKI_TICKET_TTL_MS) return false;
  const want = Buffer.from(wikiTicketMac(key, exp, scope));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** one canonical spelling. An empty segment ('//', or a trailing '/' on the
 *  API surface) is refused, never normalised. A single trailing '/' stays legal
 *  on a dashboard page path: the wiki lens's own URL is '/wiki/', and no API,
 *  OTLP or wiki-ext dispatch ever sees such a path. */
const STRICT_TRAILING_PREFIXES = ['/api/', '/v1/', '/wiki-ext/'];
export function isCanonicalPathname(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  if (pathname === '/') return true;
  const parts = pathname.slice(1).split('/');
  const strict = STRICT_TRAILING_PREFIXES.some((p) => pathname.startsWith(p));
  const body = !strict && parts.length > 1 && parts[parts.length - 1] === '' ? parts.slice(0, -1) : parts;
  return !body.some((s) => s === '');
}

// Task 15, K-1: the GET routes the kernel GET-route audit found writing state
// : learning-store priming and
// saves, measurable persistence, the memory-integrity baseline, the backlog
// archive sweep, a gh-backed QA sample. They stay GET because the dashboard
// polls them with same-origin fetch, but the desktop shell opens a Slack link
// to the kernel as a top-level navigation, and any web page can fire a
// cross-site <img>/<script> GET at a loopback port. A route that starts
// writing on GET must be added here (and to the audit table).
export const SIDE_EFFECT_GET_ROUTES = new Set([
  '/api/alerts',                    // primeAlertsIntoLearning: learning store, alert seen-set, shadow log
  '/api/state',                     // ?session=: upsertGapAndApply + learningStore.save
  '/api/learning',                  // ingestResults (deletes result files) + learningStore.save
  '/api/guards/retire-candidates',  // persistGuardRetireCandidates (query-tunable minObservations)
  '/api/skills/lifecycle',          // persistSkillArchiveCandidates
  '/api/memory/scan',               // writes memory-baseline.json when none exists
  '/api/backlog',                   // sweepArchiveIn: moves closed cards to the archive
  '/api/qa-trends',                 // ?refresh=: runs gh, appends to the QA trends store
]);

/**
 * K-1: may this request reach a state-changing GET? A browser request must be
 * a same-origin, non-navigation fetch (the dashboard's own poll). A client
 * that sends no Sec-Fetch-Site (curl, hooks, the runner, Node's fetch) is not
 * a browser context and is allowed; Sec-Fetch-* cannot be set by page script.
 */
export function sideEffectGetOk({ secFetchSite, secFetchMode } = {}) {
  return sideEffectGetRefusal({ secFetchSite, secFetchMode }) === null;
}

/** K-1 residual 3: the named reason a state-changing GET is refused, or null when allowed. */
export function sideEffectGetRefusal({ secFetchSite, secFetchMode } = {}) {
  // A browser that sends no Sec-Fetch-* headers falls back to the previous
  // posture (allowed, fail-open by design), the same as a non-browser client.
  if (secFetchMode === 'navigate') return 'navigation-to-state-changing-get';
  if (secFetchSite != null && secFetchSite !== '' && secFetchSite !== 'same-origin') return 'cross-site-state-changing-get';
  return null;
}

/** Constant-time token equality. Empty/mismatched/length-diff => false. */
export function tokenMatches(presented, token) {
  if (!presented || !token) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Extract the presented token from request headers (Authorization: Bearer, or X-GLMPS-Token). */
export function presentedTokenFrom(headers = {}) {
  const auth = headers['authorization'] || headers['Authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = headers['x-glmps-token'] || headers['X-GLMPS-Token'];
  return x ? String(x).trim() : '';
}

/** Hostnames that legitimately reach a localhost-bound server from this machine. */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Strip a :port suffix from a Host header value ([::1]:8123 and 127.0.0.1:8123 forms). */
function hostnameOf(hostHeader) {
  const h = String(hostHeader).trim().toLowerCase();
  const m = h.startsWith('[') ? h.match(/^(\[[^\]]*\])(?::\d+)?$/) : h.match(/^([^:]+)(?::\d+)?$/);
  return m ? m[1] : h;
}

/**
 * CSRF / DNS-rebinding check for loopback clients on mutating routes (glmps-48).
 * - Host header must name a localhost host: a browser lured to a DNS-rebound
 *   domain connects to 127.0.0.1 but sends the foreign Host.
 * - Origin header, when present, must be a localhost origin: a cross-origin
 *   fetch/form post always carries the attacker page's Origin ('null' for
 *   sandboxed/opaque origins counts as foreign). Absent Origin = non-browser
 *   client (curl, the executor, taps) - allowed.
 */
export function originHostOk({ host, origin, localPort } = {}) {
  if (host != null && host !== '' && !LOCAL_HOSTNAMES.has(hostnameOf(host))) return false;
  if (origin != null && origin !== '') {
    if (origin === 'null') return false;
    let o;
    try { o = new URL(origin); } catch { return false; }
    const hostname = o.hostname.toLowerCase();
    if (!LOCAL_HOSTNAMES.has(hostname) && !LOCAL_HOSTNAMES.has(`[${hostname}]`)) return false;
    // with the bound port known, the Origin must be AT that port (no port
    // means 80, or 443 for https), so a page on another localhost port is foreign.
    if (Number.isInteger(localPort)) {
      const port = o.port ? Number(o.port) : (o.protocol === 'https:' ? 443 : 80);
      if (port !== localPort) return false;
    }
  }
  return true;
}

/** Split a Host header into { hostname, port } (port null when absent); null when malformed. */
function parseHostHeader(hostHeader) {
  const h = String(hostHeader).trim().toLowerCase();
  const m = h.startsWith('[') ? h.match(/^(\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/) : h.match(/^([^:[\]]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  return { hostname: m[1], port: m[2] === undefined ? null : Number(m[2]) };
}

const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Task 15, K-2: DNS-rebinding check for EVERY loopback request (reads and
 * static assets included, not just the guarded routes). A browser lured to a
 * rebound name connects to 127.0.0.1 but sends the foreign name in Host. The
 * Host must name 127.0.0.1, localhost or [::1] - or the configured bind host
 * when remote access is enabled (a non-local, non-wildcard bind) - at the
 * port this server is actually bound to (no port in Host means 80). No Host
 * header at all is a raw non-browser client and stays allowed, the same
 * posture originHostOk takes.
 */
export function hostAllowed({ host, localPort, bindHost } = {}) {
  if (host == null || host === '') return true;
  const parsed = parseHostHeader(host);
  if (!parsed) return false;
  const names = new Set(LOCAL_HOSTNAMES);
  const b = bindHost ? String(bindHost).trim().toLowerCase() : '';
  if (b && !isLoopbackHost(b) && !WILDCARD_BINDS.has(b)) names.add(b.includes(':') && !b.startsWith('[') ? `[${b}]` : b);
  if (!names.has(parsed.hostname)) return false;
  return (parsed.port ?? 80) === Number(localPort);
}

// The client store is read on every request, so a revoked client fails at the
// token lookup and a rotated one at the fingerprint, with no revocation list.
function clientCertRefusal(client, cert) {
  if (!client.certSha256) return 'client-must-re-pair';
  if (!cert || !cert.fingerprint256) return 'client-certificate-required';
  if (cert.authorized !== true) return 'client-certificate-untrusted';
  if (!tokenMatches(cert.fingerprint256, client.certSha256)) return 'client-certificate-mismatch';
  return null;
}

/**
 * Pure access decision.
 * localPort/bindHost: the server passes the socket's bound
 * port and its configured bind host, which turns on the Host allowlist for
 * every loopback request. Omitted (the legacy pure-call shape), the decision
 * is exactly what it was before.
 * authenticateClient: token -> paired client row or null (clients store);
 * a remote request it recognises is allowed only inside the client scope and
 * carries its clientId, so later ingest stamps the client from the token.
 * clientCert: the TLS peer certificate as { fingerprint256 (lowercase hex),
 * authorized (chains to the client CA, in validity) }, or null. A remote client
 * token is accepted only beside the certificate on file for that same client.
 * @returns {{allow:true, clientId?:string}} or {{allow:false, status:401|403}}
 */
export function checkAccess({ remoteAddress, method, pathname, presentedToken, queryToken, wikiTicket, ticketKey, now = Date.now(), token, host, origin, localPort, bindHost, secFetchSite, secFetchMode, localSession, localSessionExpected, authenticateClient, clientCert = null }) {
  // authorise and dispatch on ONE canonical path. Checked first, for every
  // client, so no later rule ever sees a spelling the router would rewrite.
  if (!isCanonicalPathname(pathname)) return { allow: false, status: 400, reason: 'non-canonical-path' };
  // K-1: for every client, loopback or remote - this is about the browser
  // context the request came from, not the address. Residual 1: every method
  // the mutation rules do not already govern (GET, HEAD, OPTIONS, ...) - the
  // flat-chain /api/state answers any method, so a HEAD or a CORS preflight
  // reached the same write path a GET was refused for.
  const m = String(method || 'GET').toUpperCase();
  if (!MUTATING_METHODS.has(m) && SIDE_EFFECT_GET_ROUTES.has(pathname)) {
    const refusal = sideEffectGetRefusal({ secFetchSite, secFetchMode });
    if (refusal) return { allow: false, status: 403, reason: refusal };
  }
  if (isLoopback(remoteAddress)) {
    if (Number.isInteger(localPort) && !hostAllowed({ host, localPort, bindHost })) {
      return { allow: false, status: 403, reason: 'host-not-allowed' };
    }
    // Same-host: full trust for the executor + local dev, EXCEPT that the
    // user's browser is also a loopback client, so a mutation on ANY path
    // /v1/traces too) and the sensitive reads must reject a foreign
    // Origin/Host (CSRF / DNS rebinding). Ordinary reads stay open.
    if ((MUTATING_METHODS.has(m) || SENSITIVE_GET_ROUTES.has(pathname)) && !originHostOk({ host, origin, localPort })) {
      return { allow: false, status: 403 };
    }
    // Sec-Fetch-Site cannot be set by page script. A browser mutation that
    // is not same-origin (another port is 'same-site') is refused; a client
    // that sends none (runner, hooks, curl, the shell's Node fetch) is unchanged.
    if (MUTATING_METHODS.has(m) && secFetchSite != null && secFetchSite !== '' && secFetchSite !== 'same-origin') {
      return { allow: false, status: 403, reason: 'cross-site-mutation' };
    }
    // fails closed when the server has no expected value (key not created).
    if (needsLocalSession(m, pathname) && !tokenMatches(localSession, localSessionExpected) && !tokenMatches(presentedToken, token)) {
      return { allow: false, status: 401, reason: 'local-session-required' };
    }
    return { allow: true };
  }
  if (!isGuardedRoute(m, pathname)) return { allow: true };  // remote: liveness, icons, dashboard assets
  // only GET and HEAD are reads for the URL-borne credentials below.
  const isRead = m === 'GET' || m === 'HEAD';
  // a valid, unexpired wiki ticket opens wiki reads and nothing else.
  const wikiScope = isRead ? wikiTicketScope(pathname) : null;
  if (wikiScope && verifyWikiTicket(wikiTicket, { key: ticketKey, scope: wikiScope, now })) return { allow: true };
  // Review focus 1: EventSource cannot send a header, so a ?access_token=
  // value is accepted for GET/HEAD only, never for a mutation.
  const presented = presentedToken || (isRead ? (queryToken || '') : '');
  if (tokenMatches(presented, token)) return { allow: true };
  // A client token is header-only (the relay sends headers), so it never sits in a URL or a log line.
  const client = presentedToken && typeof authenticateClient === 'function' ? authenticateClient(presentedToken) : null;
  if (client && client.id) {
    const certRefusal = clientCertRefusal(client, clientCert);
    if (certRefusal) return { allow: false, status: 401, reason: certRefusal };
    if (!clientScopeAllows(m, pathname)) return { allow: false, status: 403, reason: 'client-token-out-of-scope' };
    return { allow: true, clientId: client.id };
  }
  // The pairing code in the body is this route's credential, so it is the one place a remote caller with no token gets through.
  if (m === 'POST' && pathname === TAP_PAIR_ROUTE) return { allow: true };
  return { allow: false, status: 401 };                       // remote + guarded + bad/no token (fail closed)
}

const v4Octets = (h) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
};
const stripBrackets = (host) => String(host ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
// The first 16 bits of an IPv6 literal, or null; '::' and '::ffff:a.b.c.d' start with 0.
const v6Head = (h) => (net.isIPv6(h) ? (h.startsWith(':') ? 0 : parseInt(h.split(':')[0], 16)) : null);

/** The class of a bind host: loopback, private, wildcard, hostname, link-local, shared or public. */
function addressClass(host) {
  const h = stripBrackets(host);
  if (isLoopbackHost(h)) return 'loopback';
  if (WILDCARD_BINDS.has(h)) return 'wildcard';
  const o = v4Octets(h);
  if (o) {
    if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)) return 'private';
    if (o[0] === 169 && o[1] === 254) return 'link-local';
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'shared';
    if (o[0] === 127) return 'loopback-alias';
    return 'public';
  }
  const head = v6Head(h);
  if (head == null) return 'hostname';
  if ((head & 0xfe00) === 0xfc00) return 'private';
  if ((head & 0xffc0) === 0xfe80) return 'link-local';
  return 'public';
}

/** Is this an RFC1918 IPv4 or fc00::/7 IPv6 address literal? */
export function isPrivateAddress(host) {
  return addressClass(host) === 'private';
}

const BIND_REFUSALS = {
  wildcard: 'a wildcard bind listens on every interface, including any public one',
  hostname: 'a hostname can resolve to an interface nobody named; bind to the address literal',
  'link-local': 'a link-local address is not a stable home or office network address',
  shared: 'the 100.64.0.0/10 shared range is carrier-grade NAT or an overlay, not this network',
  public: 'a public address would put GLMPS on the internet',
  'loopback-alias': 'only 127.0.0.1 is the loopback bind; another 127.x address is neither loopback-only nor reachable from the network',
};

/**
 * Spec 2026-11-10-glmps-2-0-171: a non-loopback bind must be a private address
 * literal with TLS configured, so GLMPS is never internet-facing and no token
 * crosses the network in cleartext. Every other bind is refused with a named reason.
 */
export function remoteBindPolicy({ bindHost, tls = false } = {}) {
  const cls = addressClass(bindHost);
  if (cls === 'loopback') return { allow: true, private: false };
  if (cls !== 'private') {
    return { allow: false, reason: `non-local bind refused: host ${bindHost} is not a private address literal (${cls}: ${BIND_REFUSALS[cls]}). GLMPS binds only to 127.0.0.1 or to this machine's private address (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or fc00::/7) with TLS.` };
  }
  if (tls !== true) {
    return { allow: false, reason: `non-local bind refused: host ${bindHost} has no TLS configuration, so the access token would cross the network in cleartext. Set "tls": { "source": "home" } (run node scripts/provision-server-box.mjs --apply) or { "source": "provided", ... } in config.json, or bind to 127.0.0.1.` };
  }
  return { allow: true, private: true };
}

// Every common same-host proxy adds at least one of these. Node lowercases names.
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via'];
export const PROXIED_PEER = 'proxied-loopback';

/**
 * Security review point 2: the address the access decision should see. A
 * loopback socket carrying a forwarding header is a same-host proxy relaying
 * someone else, so it is reported as PROXIED_PEER (not loopback) and the
 * remote token rules apply. Any other address passes through unchanged.
 */
export function peerAddress(socketAddress, headers = {}) {
  if (!isLoopback(socketAddress)) return socketAddress;
  return FORWARDING_HEADERS.some((h) => headers[h] != null) ? PROXIED_PEER : socketAddress;
}
