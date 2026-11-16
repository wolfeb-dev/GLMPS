// server/lib/observability/route-registry.js
//
// Registry seam for server.js's flat if-chain. A feature registers its routes
// here instead of adding another inline `if (u.pathname === ...)` block.
// server.js still owns dispatch: matchRoute() just looks up which registered
// handler (if any) applies to a request. Exact-literal patterns are tried
// before ':param' patterns so an exact route is never shadowed by a
// same-method placeholder route.
//
// Pure in-memory Map; no fs, no server coupling. clearRoutes() exists only
// for test isolation (server.js never calls it in production).
//
// Handlers close over one startServer call's state, so each server dispatches
// from its own createRouteRegistry() table: with one shared table, a second
// server in the same process answered the first server's requests from the
// second's state (card glmps-2-0-151). The module-level functions are one more
// table, which tests read to inspect what the latest server registered.

function segmentsOf(pattern) {
  return pattern.split('/').filter(Boolean).map(seg => ({
    name: seg.startsWith(':') ? seg.slice(1) : null,
    literal: seg.startsWith(':') ? null : seg,
  }));
}

function keyOf(method, pattern) { return `${method} ${pattern}`; }

function matchesSegments(segments, pathParts) {
  if (segments.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.literal !== null) {
      if (seg.literal !== pathParts[i]) return null;
    } else {
      // An undecodable %-escape is no match, never a throw: the request
      // preamble calls matchRoute outside the handler's try (card glmps-2-0-224).
      try { params[seg.name] = decodeURIComponent(pathParts[i]); } catch { return null; }
    }
  }
  return params;
}

export function createRouteRegistry() {
  const routes = new Map(); // key: `${method} ${pattern}` -> { method, pattern, handle, segments }

  /**
   * @param {{method:string, pattern:string, handle:Function}} route
   */
  function registerRoute({ method, pattern, handle, clientOwnsCard = false } = {}) {
    if (!method || !pattern || typeof handle !== 'function') {
      throw new TypeError('registerRoute requires method, pattern, and a handle function');
    }
    // clientOwnsCard: a paired client may call this route only on a card it
    // filed; the request preamble reads the flag and checks the `:id` card.
    routes.set(keyOf(method, pattern), { method, pattern, handle, clientOwnsCard: clientOwnsCard === true, segments: segmentsOf(pattern) });
  }

  /**
   * strict. The path must start with '/' and have no empty segment ('//',
   * a trailing '/'); such a path matches nothing, so the router can never
   * dispatch a spelling the access guard did not authorise.
   * @returns {{ route: object, params: object } | null}
   */
  function matchRoute(method, pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
    const pathParts = pathname.slice(1).split('/');
    if (pathParts.some((p) => p === '')) return null;
    const candidates = [...routes.values()].filter(r => r.method === method);
    const exact = candidates.filter(r => r.segments.every(s => s.literal !== null));
    const withParams = candidates.filter(r => r.segments.some(s => s.literal === null));
    for (const r of [...exact, ...withParams]) {
      const params = matchesSegments(r.segments, pathParts);
      if (params) return { route: r, params };
    }
    return null;
  }

  function listRoutes() {
    return [...routes.values()].map(({ method, pattern, clientOwnsCard }) => ({ method, pattern, ...(clientOwnsCard ? { clientOwnsCard } : {}) }));
  }

  function clearRoutes() { routes.clear(); }

  return { registerRoute, matchRoute, listRoutes, clearRoutes };
}

export const { registerRoute, matchRoute, listRoutes, clearRoutes } = createRouteRegistry();
