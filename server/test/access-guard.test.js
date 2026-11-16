// Routes under test: server/lib/routes/guards-routes.js
// Routes under test: server/lib/routes/surface-routes.js
// Routes under test: server/lib/routes/tap-routes.js
// Routes under test: server/lib/routes/workspace-routes.js
// server/test/access-guard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoopback, isLoopbackHost, isGuardedRoute, tokenMatches, presentedTokenFrom, checkAccess, SIDE_EFFECT_GET_ROUTES, isCanonicalPathname, mintWikiTicket, verifyWikiTicket, wikiTicketScope, localSessionValue, LOCAL_SESSION_ROUTES,
} from '../lib/governance/access-guard.js';

test('isLoopback: loopback addresses true, LAN/undefined false', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']) assert.equal(isLoopback(a), true, a);
  for (const a of ['192.168.1.5', '10.0.0.2', '0.0.0.0', '', undefined, null]) assert.equal(isLoopback(a), false, String(a));
});

test('isLoopbackHost: bind host classification', () => {
  for (const h of [undefined, '127.0.0.1', '::1', 'localhost']) assert.equal(isLoopbackHost(h), true, String(h));
  for (const h of ['0.0.0.0', '192.168.1.5']) assert.equal(isLoopbackHost(h), false, h);
});

test('isGuardedRoute (remote token rule): every API read and any mutating method is guarded; health, icons and dashboard assets are not', () => {
  for (const [m, p] of [
    ['POST', '/api/file'], ['PUT', '/api/file'], ['PATCH', '/api/backlog/glmps-1'], ['DELETE', '/api/backlog/glmps-1'],
    ['POST', '/api/runner/run/glmps-1'], ['GET', '/api/budget'], ['GET', '/api/memory/lookup'],
    ['GET', '/api/judge/verdicts'], ['GET', '/api/judge/summary'], ['GET', '/api/launches'],
    // the old "open lens" reads now need the token too
    ['GET', '/api/state'], ['GET', '/api/backlog'], ['GET', '/api/events'], ['GET', '/api/search'],
    ['GET', '/api/file'], ['GET', '/api/config'], ['GET', '/api/surface/file-diff'],
    // any method on a sensitive route, not only GET
    ['OPTIONS', '/api/budget'], ['PROPFIND', '/api/budget'], ['HEAD', '/api/state'],
    // F3/F4: a mutating method on ANY path, and the OTLP alias
    ['POST', '/v1/traces'], ['POST', '/sessions/x'], ['POST', '//api/workspace/x/steer'],
    // repo content served outside /api
    ['GET', '/wiki-ext/repo/page.html'], ['GET', '/wiki/server.html'],
    // the wiki handler decodes the raw URL, so a percent-encoded extension is still an asset
    ['GET', '/wiki/server%2ehtml'], ['GET', '/wiki/server.ht%6dl'], ['GET', '/wiki/server%2Ejson'],
  ]) assert.equal(isGuardedRoute(m, p), true, `${m} ${p}`);
  for (const [m, p] of [
    ['GET', '/api/health'], ['GET', '/healthz'], ['GET', '/api/icon/claude'],
    ['GET', '/index.html'], ['GET', '/'], ['GET', '/wiki'], ['GET', '/wiki/server'],
  ]) assert.equal(isGuardedRoute(m, p), false, `${m} ${p}`);
});

test('tokenMatches: constant-time equality, rejects empty / mismatched / length-diff', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc123', 'abc124'), false);
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches('abc', ''), false);
  assert.equal(tokenMatches('abc', null), false);
});

test('presentedTokenFrom: Bearer header, X-GLMPS-Token header, none', () => {
  assert.equal(presentedTokenFrom({ authorization: 'Bearer tok-123' }), 'tok-123');
  assert.equal(presentedTokenFrom({ authorization: 'bearer tok-123' }), 'tok-123');
  assert.equal(presentedTokenFrom({ 'x-glmps-token': 'tok-xyz' }), 'tok-xyz');
  assert.equal(presentedTokenFrom({}), '');
});

test('checkAccess: loopback always allowed, even guarded route with no token', () => {
  const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/runner/run/x', presentedToken: '', token: 'secret' });
  assert.deepEqual(r, { allow: true });
});

// A browser on this machine is a loopback client; a lured page can hit the
// server via a rebound Host (DNS rebinding) or a cross-origin fetch/form
// (CSRF). Mutating routes must reject foreign Origin/Host with 403; GET reads
// and legit localhost mutations stay open.

test('rebind: loopback mutating request with foreign Host -> 403', () => {
  const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'PATCH', pathname: '/api/backlog/x',
    host: 'evil.example.com:8123', presentedToken: '', token: '' });
  assert.deepEqual(r, { allow: false, status: 403 });
});

test('csrf: loopback mutating request with foreign Origin -> 403', () => {
  const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/backlog',
    host: '127.0.0.1:8123', origin: 'https://evil.example.com', presentedToken: '', token: '' });
  assert.deepEqual(r, { allow: false, status: 403 });
});

test('csrf: Origin "null" (sandboxed/opaque) is foreign for mutations -> 403', () => {
  const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/backlog',
    host: 'localhost:8123', origin: 'null', presentedToken: '', token: '' });
  assert.deepEqual(r, { allow: false, status: 403 });
});

test('same-origin localhost mutations allowed: 127.0.0.1, localhost, [::1], with/without port', () => {
  for (const [host, origin] of [
    ['127.0.0.1:8123', 'http://127.0.0.1:8123'],
    ['localhost:8123', 'http://localhost:8123'],
    ['[::1]:8123', 'http://[::1]:8123'],
    ['127.0.0.1', undefined],           // curl / executor: no Origin header
    ['localhost:8123', undefined],
  ]) {
    const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/backlog',
      host, origin, presentedToken: '', token: '' });
    assert.deepEqual(r, { allow: true }, `host=${host} origin=${origin}`);
  }
});

// Task 15 residual 2: this used to read "reads stay open regardless of
// Origin/Host". That is now true only of the legacy pure-call shape (no
// localPort), which the server never uses: server.js always passes the bound
// port, and then a foreign Host is refused (K-2). Both halves are pinned.
test('legacy call shape (no localPort): a loopback read is not Host-checked; server.js always passes localPort', () => {
  const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
    host: 'evil.example.com', origin: 'https://evil.example.com', presentedToken: '', token: '' });
  assert.equal(r.allow, true);
});

test('the same loopback read with the bound port passed (what server.js does) is refused 403', () => {
  const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
    host: 'evil.example.com', origin: 'https://evil.example.com', presentedToken: '', token: '', localPort: 8124 });
  assert.deepEqual(r, { allow: false, status: 403, reason: 'host-not-allowed' });
});

test('remote client with valid token keeps working (LAN Host is not "foreign" on the token path)', () => {
  const r = checkAccess({ remoteAddress: '192.168.1.9', method: 'POST', pathname: '/api/backlog',
    host: '192.168.1.5:8123', origin: 'http://192.168.1.5:8123', presentedToken: 'secret', token: 'secret' });
  assert.equal(r.allow, true);
});

test('F2: a remote read of an API route needs the token; dashboard assets stay open', () => {
  const remote = { remoteAddress: '192.168.1.9', token: 'secret' };
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/api/state', presentedToken: '' }), { allow: false, status: 401 });
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/api/file', presentedToken: '' }), { allow: false, status: 401 });
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/api/config', presentedToken: '' }), { allow: false, status: 401 });
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/api/state', presentedToken: 'secret' }), { allow: true });
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/index.html', presentedToken: '' }), { allow: true });
});

test('checkAccess: remote + guarded + no/wrong token => 401', () => {
  const none = checkAccess({ remoteAddress: '192.168.1.9', method: 'POST', pathname: '/api/file', presentedToken: '', token: 'secret' });
  assert.deepEqual(none, { allow: false, status: 401 });
  const wrong = checkAccess({ remoteAddress: '192.168.1.9', method: 'PUT', pathname: '/api/file', presentedToken: 'nope', token: 'secret' });
  assert.deepEqual(wrong, { allow: false, status: 401 });
  const budget = checkAccess({ remoteAddress: '192.168.1.9', method: 'GET', pathname: '/api/budget', presentedToken: '', token: 'secret' });
  assert.deepEqual(budget, { allow: false, status: 401 });
});

test('checkAccess: remote + guarded + correct token => allowed', () => {
  const r = checkAccess({ remoteAddress: '192.168.1.9', method: 'POST', pathname: '/api/file', presentedToken: 'secret', token: 'secret' });
  assert.equal(r.allow, true);
});

test('checkAccess: remote + guarded + server has no token => fail closed (401)', () => {
  const r = checkAccess({ remoteAddress: '192.168.1.9', method: 'POST', pathname: '/api/file', presentedToken: 'anything', token: '' });
  assert.deepEqual(r, { allow: false, status: 401 });
});

// Reads outside SENSITIVE_GET_ROUTES had no Host check at all, so a
// DNS-rebound page (Host: evil.example.com:<port>, connecting to 127.0.0.1)
// could read state and config. When the server passes its bound port, EVERY
// request from a loopback client must name 127.0.0.1, localhost or [::1] at
// that port (plus the configured bind host when it is non-local); otherwise
// 403. A request with no Host header (a raw non-browser client) is unchanged.
// Called without localPort (the legacy pure-call shape every test above
// uses), checkAccess behaves exactly as before.
test('K-2: a loopback read with a rebound Host is refused once the bound port is known', () => {
  const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
    host: 'evil.example.com:8124', localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' });
  assert.deepEqual(r, { allow: false, status: 403, reason: 'host-not-allowed' });
  const asset = checkAccess({ remoteAddress: '::1', method: 'GET', pathname: '/index.html',
    host: 'rebind.attacker.test:8124', localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' });
  assert.deepEqual(asset, { allow: false, status: 403, reason: 'host-not-allowed' }, 'static assets too: every request');
});

test('K-2: 127.0.0.1, localhost and [::1] at the bound port are allowed, any case', () => {
  for (const host of ['127.0.0.1:8124', 'localhost:8124', 'LOCALHOST:8124', '[::1]:8124']) {
    const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
      host, localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' });
    assert.deepEqual(r, { allow: true }, host);
  }
});

test('K-2: a local hostname at the wrong port, a missing port off 80, or a malformed Host is refused', () => {
  for (const host of ['127.0.0.1:9999', '127.0.0.1', 'localhost', '127.0.0.1:8124:1', '127.0.0.1:abc', 'localhost.:8124', '[::1:8124']) {
    const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
      host, localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' });
    assert.deepEqual(r, { allow: false, status: 403, reason: 'host-not-allowed' }, host);
  }
  const port80 = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
    host: 'localhost', localPort: 80, bindHost: '127.0.0.1', presentedToken: '', token: '' });
  assert.deepEqual(port80, { allow: true }, 'no port in Host means 80');
});

test('K-2: no Host header at all (a raw non-browser client) stays allowed', () => {
  for (const host of [undefined, '']) {
    const r = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
      host, localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' });
    assert.deepEqual(r, { allow: true });
  }
});

test('K-2: with remote access enabled, the configured bind host is also allowed for a loopback client; a wildcard bind adds nothing', () => {
  const lan = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
    host: '192.168.1.5:8124', localPort: 8124, bindHost: '192.168.1.5', presentedToken: '', token: 'secret' });
  assert.deepEqual(lan, { allow: true });
  const wildcard = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
    host: '0.0.0.0:8124', localPort: 8124, bindHost: '0.0.0.0', presentedToken: '', token: 'secret' });
  assert.deepEqual(wildcard, { allow: false, status: 403, reason: 'host-not-allowed' });
  const rebound = checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/api/state',
    host: 'evil.example.com:8124', localPort: 8124, bindHost: '192.168.1.5', presentedToken: '', token: 'secret' });
  assert.deepEqual(rebound, { allow: false, status: 403, reason: 'host-not-allowed' });
});

test('K-2: the existing checks are not loosened: a good Host does not excuse a foreign Origin on a mutation, and remote clients still need the token', () => {
  const csrf = checkAccess({ remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/backlog',
    host: '127.0.0.1:8124', origin: 'https://evil.example.com', localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' });
  assert.deepEqual(csrf, { allow: false, status: 403 });
  const remote = checkAccess({ remoteAddress: '192.168.1.9', method: 'POST', pathname: '/api/file',
    host: '192.168.1.5:8124', localPort: 8124, bindHost: '0.0.0.0', presentedToken: '', token: 'secret' });
  assert.deepEqual(remote, { allow: false, status: 401 });
});

// The desktop shell routes a Slack link to the kernel into the dashboard pane
// as a top-level GET (Sec-Fetch-Mode: navigate, Sec-Fetch-Site: none, since the
// shell itself calls loadURL), and any browser page can fire a cross-site
// <img>/<script> GET. The GET-route audit found these
// eight write state. They stay GET (the dashboard polls them with same-origin
// fetch), but a browser request to them must be a same-origin, non-navigation
// fetch. A client sending no Sec-Fetch-* headers (curl, hooks, the runner,
// Node's fetch) is not a browser context and is unchanged.
test('K-1: the audited state-changing GET routes are exactly these eight', () => {
  assert.deepEqual([...SIDE_EFFECT_GET_ROUTES].sort(), [
    '/api/alerts', '/api/backlog', '/api/guards/retire-candidates', '/api/learning',
    '/api/memory/scan', '/api/qa-trends', '/api/skills/lifecycle', '/api/state',
  ]);
});

test('K-1: a top-level navigation or a non-same-origin browser fetch to a state-changing GET is refused 403', () => {
  const base = { remoteAddress: '127.0.0.1', method: 'GET', host: '127.0.0.1:8124', localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' };
  // Residual 1: /api/state (and other flat-chain routes) answer ANY method,
  // so HEAD and a CORS preflight OPTIONS reach the same write path as GET.
  const NAV = 'navigation-to-state-changing-get';
  const XS = 'cross-site-state-changing-get';
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'head']) {
    for (const [secFetchSite, secFetchMode, reason] of [['none', 'navigate', NAV], ['same-origin', 'navigate', NAV], ['cross-site', 'no-cors', XS], ['same-site', 'cors', XS], ['cross-site', 'cors', XS], [undefined, 'navigate', NAV]]) {
      for (const pathname of SIDE_EFFECT_GET_ROUTES) {
        assert.deepEqual(checkAccess({ ...base, method, pathname, secFetchSite, secFetchMode }), { allow: false, status: 403, reason }, `${method} ${pathname} ${secFetchSite}/${secFetchMode}`);
      }
    }
  }
  // Remote clients too: this is about the browser context, not the address.
  assert.deepEqual(checkAccess({ ...base, remoteAddress: '192.168.1.9', host: '192.168.1.5:8124', pathname: '/api/backlog', secFetchSite: 'cross-site', secFetchMode: 'no-cors' }), { allow: false, status: 403, reason: XS });
  assert.deepEqual(checkAccess({ ...base, method: 'HEAD', remoteAddress: '192.168.1.9', host: '192.168.1.5:8124', pathname: '/api/state', secFetchSite: 'cross-site', secFetchMode: 'no-cors' }), { allow: false, status: 403, reason: XS });
});

test('K-1: the dashboard\'s same-origin fetch, a non-browser client and other GETs are unaffected', () => {
  const base = { remoteAddress: '127.0.0.1', method: 'GET', host: '127.0.0.1:8124', localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' };
  for (const pathname of SIDE_EFFECT_GET_ROUTES) {
    for (const method of ['HEAD', 'OPTIONS']) {
      assert.deepEqual(checkAccess({ ...base, method, pathname, secFetchSite: 'same-origin', secFetchMode: 'cors' }), { allow: true }, `${method} ${pathname} same-origin`);
      assert.deepEqual(checkAccess({ ...base, method, pathname }), { allow: true }, `${method} ${pathname} non-browser`);
    }
    assert.deepEqual(checkAccess({ ...base, pathname, secFetchSite: 'same-origin', secFetchMode: 'cors' }), { allow: true }, `${pathname} dashboard fetch`);
    assert.deepEqual(checkAccess({ ...base, pathname }), { allow: true }, `${pathname} curl/hook`);
    assert.deepEqual(checkAccess({ ...base, pathname, secFetchMode: 'cors' }), { allow: true }, `${pathname} node fetch`);
  }
  assert.deepEqual(checkAccess({ ...base, pathname: '/api/config', secFetchSite: 'none', secFetchMode: 'navigate' }), { allow: true }, 'a read-only GET may still be opened directly');
  assert.deepEqual(checkAccess({ ...base, pathname: '/', secFetchSite: 'none', secFetchMode: 'navigate' }), { allow: true }, 'the dashboard page itself');
  assert.deepEqual(checkAccess({ ...base, method: 'POST', pathname: '/api/memory/scan', origin: 'http://127.0.0.1:8124', secFetchSite: 'same-origin', secFetchMode: 'cors' }), { allow: true }, 'the POST form of a route is governed by the mutation rules');
});

test('F3: a pathname with an empty segment is refused 400 for every client, before any other rule', () => {
  for (const remoteAddress of ['127.0.0.1', '192.168.1.9']) {
    for (const pathname of ['//api/workspace/s1/steer', '/api//backlog', '/api/backlog//', undefined, '', 'api/x']) {
      const r = checkAccess({ remoteAddress, method: 'POST', pathname, presentedToken: 'secret', token: 'secret' });
      assert.deepEqual(r, { allow: false, status: 400, reason: 'non-canonical-path' }, `${remoteAddress} ${pathname}`);
    }
  }
  assert.equal(isCanonicalPathname('/api/backlog'), true);
  assert.equal(isCanonicalPathname('/'), true);
  assert.equal(isCanonicalPathname('//api/x'), false);
});

test('F3: a single trailing slash is refused on the API surface but stays legal on a dashboard page path (the wiki lens is /wiki/)', () => {
  for (const p of ['/api/backlog/', '/api/', '/v1/traces/', '/wiki-ext/repo/', '/wiki//', '//']) assert.equal(isCanonicalPathname(p), false, p);
  for (const p of ['/wiki/', '/wiki', '/sessions/x/']) assert.equal(isCanonicalPathname(p), true, p);
  assert.deepEqual(checkAccess({ remoteAddress: '127.0.0.1', method: 'GET', pathname: '/wiki/' }), { allow: true });
  assert.deepEqual(checkAccess({ remoteAddress: '192.168.1.9', method: 'GET', pathname: '/wiki/', presentedToken: '', token: 'secret' }), { allow: true });
});

test('F4: a POST to /v1/traces is guarded like /api/otel (foreign Origin on loopback, token on remote)', () => {
  const loop = checkAccess({ remoteAddress: '127.0.0.1', method: 'POST', pathname: '/v1/traces',
    host: '127.0.0.1:8124', origin: 'https://evil.example.com', presentedToken: '', token: '' });
  assert.deepEqual(loop, { allow: false, status: 403 });
  const remote = checkAccess({ remoteAddress: '192.168.1.9', method: 'POST', pathname: '/v1/traces', presentedToken: '', token: 'secret' });
  assert.deepEqual(remote, { allow: false, status: 401 });
});

test('Review focus 1: a query-string token unlocks remote READS (EventSource, wiki iframe) but never a mutation', () => {
  const remote = { remoteAddress: '192.168.1.9', presentedToken: '', queryToken: 'secret', token: 'secret' };
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/api/events' }), { allow: true });
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/wiki-ext/repo/core.html' }), { allow: true });
  assert.deepEqual(checkAccess({ ...remote, method: 'POST', pathname: '/api/backlog' }), { allow: false, status: 401 });
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/api/events', queryToken: 'wrong' }), { allow: false, status: 401 });
  // D30 says GET and HEAD only; any other non-mutating method gets no query token
  assert.deepEqual(checkAccess({ ...remote, method: 'HEAD', pathname: '/api/events' }), { allow: true });
  assert.deepEqual(checkAccess({ ...remote, method: 'OPTIONS', pathname: '/api/events' }), { allow: false, status: 401 });
  assert.deepEqual(checkAccess({ ...remote, method: 'PROPFIND', pathname: '/api/events' }), { allow: false, status: 401 });
});

test('C1: a wiki ticket is a short-lived read-only key for /wiki/ and /wiki-ext/ GET/HEAD only', () => {
  const key = 'k'.repeat(32);
  const now = 1_700_000_000_000;
  const { ticket, expiresAt } = mintWikiTicket({ key, scope: 'ext:repo', now });
  const kernelTicket = mintWikiTicket({ key, now }).ticket;
  assert.equal(expiresAt, now + 10 * 60 * 1000);
  assert.doesNotMatch(ticket, /secret/);
  const remote = { remoteAddress: '192.168.1.9', presentedToken: '', token: 'secret', ticketKey: key, now: now + 1000 };
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/wiki-ext/repo/core.html', wikiTicket: ticket }), { allow: true });
  assert.deepEqual(checkAccess({ ...remote, method: 'HEAD', pathname: '/wiki/server.html', wikiTicket: kernelTicket }), { allow: true });
  // never on the API, the OTLP alias, or any other method
  for (const pathname of ['/api/state', '/api/file', '/v1/traces']) {
    assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname, wikiTicket: ticket }), { allow: false, status: 401 }, pathname);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.deepEqual(checkAccess({ ...remote, method, pathname: '/wiki-ext/repo/core.html', wikiTicket: ticket }), { allow: false, status: 401 }, method);
  }
  // expired, tampered, wrong key, malformed
  assert.deepEqual(checkAccess({ ...remote, now: expiresAt + 1, method: 'GET', pathname: '/wiki-ext/repo/core.html', wikiTicket: ticket }), { allow: false, status: 401 });
  const [exp, mac] = ticket.split('.');
  const tampered = [`${Number(exp) + 60_000}.${mac}`, `${exp}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, 'garbage', '', `${exp}.`];
  for (const t of tampered) {
    assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/wiki-ext/repo/core.html', wikiTicket: t }), { allow: false, status: 401 }, t);
  }
  assert.deepEqual(checkAccess({ ...remote, ticketKey: 'x'.repeat(32), method: 'GET', pathname: '/wiki-ext/repo/core.html', wikiTicket: ticket }), { allow: false, status: 401 });
  assert.equal(verifyWikiTicket(ticket, { key, scope: 'ext:repo', now: now + 1 }), true);
  assert.equal(verifyWikiTicket(ticket, { key: '', now: now + 1 }), false);
  // a ticket never stands in for the token as a query token either
  assert.deepEqual(checkAccess({ ...remote, method: 'GET', pathname: '/api/events', queryToken: ticket }), { allow: false, status: 401 });
});

// Scan 2026-10-15 F4: a ticket opens only the wiki it was minted for.
test('F4: a wiki ticket is scoped to one wiki: kernel or one project', () => {
  const key = 'k'.repeat(32);
  const now = 1_700_000_000_000;
  const remote = { remoteAddress: '192.168.1.9', presentedToken: '', token: 'secret', ticketKey: key, now: now + 1000, method: 'GET' };
  const repoX = mintWikiTicket({ key, scope: wikiTicketScope('/wiki-ext/repo-x'), now }).ticket;
  const kernel = mintWikiTicket({ key, now }).ticket;
  assert.deepEqual(checkAccess({ ...remote, pathname: '/wiki-ext/repo-x/core.html', wikiTicket: repoX }), { allow: true });
  assert.deepEqual(checkAccess({ ...remote, pathname: '/wiki-ext/repo%2Dx/core.html', wikiTicket: repoX }), { allow: true }, 'same key, encoded');
  for (const pathname of ['/wiki-ext/repo-y/core.html', '/wiki-ext/repo-x2/core.html', '/wiki/server.html', '/wiki/manifest.json']) {
    assert.deepEqual(checkAccess({ ...remote, pathname, wikiTicket: repoX }), { allow: false, status: 401 }, pathname);
  }
  assert.deepEqual(checkAccess({ ...remote, pathname: '/wiki/manifest.json', wikiTicket: kernel }), { allow: true });
  assert.deepEqual(checkAccess({ ...remote, pathname: '/wiki-ext/repo-x/core.html', wikiTicket: kernel }), { allow: false, status: 401 });
  assert.equal(wikiTicketScope('/wiki'), 'kernel');
  assert.equal(wikiTicketScope('/wiki-ext/a%20b'), 'ext:a b');
  for (const bad of ['/api/state', '/wiki-ext/', '/wiki-ext/%E0', '/wikis/x']) assert.equal(wikiTicketScope(bad), null, bad);
});

test('F6: with the bound port known, a localhost Origin on another port is foreign for a mutation', () => {
  const base = { remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/backlog', host: '127.0.0.1:8124',
    localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' };
  assert.deepEqual(checkAccess({ ...base, origin: 'http://localhost:3000' }), { allow: false, status: 403 });
  assert.deepEqual(checkAccess({ ...base, origin: 'http://127.0.0.1:8123' }), { allow: false, status: 403 });
  assert.deepEqual(checkAccess({ ...base, origin: 'http://127.0.0.1' }), { allow: false, status: 403 }, 'no port in Origin means 80');
  assert.deepEqual(checkAccess({ ...base, origin: 'http://127.0.0.1:8124' }), { allow: true });
  assert.deepEqual(checkAccess({ ...base, host: '[::1]:8124', origin: 'http://[::1]:8124' }), { allow: true });
});

test('F6: a mutation whose Sec-Fetch-Site is present and not same-origin is refused, even with no Origin', () => {
  const base = { remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/runner/config', host: '127.0.0.1:8124',
    localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' };
  for (const s of ['same-site', 'cross-site', 'none']) {
    assert.deepEqual(checkAccess({ ...base, secFetchSite: s }), { allow: false, status: 403, reason: 'cross-site-mutation' }, s);
  }
  assert.deepEqual(checkAccess({ ...base, secFetchSite: 'same-origin', origin: 'http://127.0.0.1:8124' }), { allow: true });
  assert.deepEqual(checkAccess({ ...base }), { allow: true }, 'no Sec-Fetch-Site: a non-browser client (runner, hooks, curl)');
});

test('F6: Origin "null" on a mutation is refused, never treated as no Origin', () => {
  const base = { remoteAddress: '127.0.0.1', method: 'POST', pathname: '/api/backlog', host: '127.0.0.1:8124',
    localPort: 8124, bindHost: '127.0.0.1', presentedToken: '', token: '' };
  assert.deepEqual(checkAccess({ ...base, origin: 'null' }), { allow: false, status: 403 });
});

// Scan 2026-10-15 F2: loopback alone does not open file, terminal or restart routes.
test('F2: loopback clients need the local session (or the token) on the file, terminal, resume, editor and restart routes', () => {
  const expected = localSessionValue('a'.repeat(64));
  const base = { remoteAddress: '127.0.0.1', token: 'tok', localSessionExpected: expected };
  const routes = [['GET', '/api/file'], ['PUT', '/api/file'], ['POST', '/api/file/undo'], ['POST', '/api/terminal'], ['POST', '/api/resume'], ['POST', '/api/open-in-editor'], ['POST', '/api/restart']];
  for (const [method, pathname] of routes) {
    const refused = { allow: false, status: 401, reason: 'local-session-required' };
    assert.deepEqual(checkAccess({ ...base, method, pathname }), refused, `${method} ${pathname} bare`);
    assert.deepEqual(checkAccess({ ...base, method, pathname, origin: 'http://127.0.0.1:8124', secFetchSite: 'same-origin', host: '127.0.0.1:8124' }), refused, 'browser headers are not proof');
    assert.deepEqual(checkAccess({ ...base, method, pathname, localSession: expected.slice(0, -1) + (expected.endsWith('0') ? '1' : '0') }), refused, 'wrong value');
    assert.deepEqual(checkAccess({ ...base, method, pathname, localSession: 'a'.repeat(64) }), refused, 'the raw key is not the session');
    assert.deepEqual(checkAccess({ ...base, method, pathname, localSession: expected }), { allow: true }, `${method} ${pathname} with session`);
    assert.deepEqual(checkAccess({ ...base, method, pathname, presentedToken: 'tok' }), { allow: true }, 'the remote token also works (same-host proxy)');
    assert.deepEqual(checkAccess({ ...base, localSessionExpected: null, method, pathname, localSession: '' }), refused, 'fails closed with no key');
  }
  assert.deepEqual(checkAccess({ ...base, method: 'GET', pathname: '/api/state' }), { allow: true }, 'other loopback reads unchanged');
  assert.deepEqual(checkAccess({ ...base, method: 'POST', pathname: '/api/backlog' }), { allow: true }, 'other loopback mutations unchanged');
  assert.ok(LOCAL_SESSION_ROUTES.has('/api/file'));
  assert.match(localSessionValue('k'), /^[0-9a-f]{64}$/);
  assert.notEqual(localSessionValue('k'), localSessionValue('j'));
});

// Creating a project edits the harness permission list and trust file, so the
// write needs the local session; the project list itself stays an ordinary read.
test('F2: POST /api/projects needs the local session, GET /api/projects does not', () => {
  const expected = localSessionValue('a'.repeat(64));
  const base = { remoteAddress: '127.0.0.1', token: 'tok', localSessionExpected: expected, pathname: '/api/projects' };
  assert.deepEqual(checkAccess({ ...base, method: 'POST' }), { allow: false, status: 401, reason: 'local-session-required' });
  assert.deepEqual(checkAccess({ ...base, method: 'POST', localSession: expected }), { allow: true });
  assert.deepEqual(checkAccess({ ...base, method: 'GET' }), { allow: true });
});

// Scan F9 (card glmps-2-0-runtime-109): minting a pairing code, rotating or
// revoking a client hands out or kills a credential, so a bare loopback caller
// must prove it is the operator.
test('F9: pair-code, client rotate and client revoke need the local session (or the token) from loopback', () => {
  const expected = localSessionValue('a'.repeat(64));
  const base = { remoteAddress: '127.0.0.1', token: 'tok', localSessionExpected: expected, method: 'POST' };
  const refused = { allow: false, status: 401, reason: 'local-session-required' };
  for (const pathname of ['/api/tap/pair-code', '/api/clients/cli_x/rotate', '/api/clients/cli_x/revoke', '/api/clients/cli_abc-123/rotate']) {
    assert.deepEqual(checkAccess({ ...base, pathname }), refused, `${pathname} bare`);
    assert.deepEqual(checkAccess({ ...base, pathname, presentedToken: 'nope' }), refused, `${pathname} wrong token`);
    assert.deepEqual(checkAccess({ ...base, pathname, localSession: 'b'.repeat(64) }), refused, `${pathname} wrong session`);
    assert.deepEqual(checkAccess({ ...base, pathname, localSession: expected }), { allow: true }, `${pathname} with session`);
    assert.deepEqual(checkAccess({ ...base, pathname, presentedToken: 'tok' }), { allow: true }, `${pathname} with token`);
    assert.deepEqual(checkAccess({ ...base, localSessionExpected: null, pathname }), refused, `${pathname} fails closed with no key`);
  }
  assert.deepEqual(checkAccess({ ...base, pathname: '/api/tap/pair' }), { allow: true }, 'the pairing exchange itself stays open (the code is its credential)');
  assert.deepEqual(checkAccess({ ...base, method: 'GET', pathname: '/api/clients' }), { allow: true }, 'the client list read is unchanged');
  assert.deepEqual(checkAccess({ ...base, pathname: '/api/clients/a/b/rotate' }), { allow: true }, ':id matches one segment only');
});
