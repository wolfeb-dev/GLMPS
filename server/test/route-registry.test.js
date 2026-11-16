// Routes under test: server/lib/routes/workspace-routes.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRoute, matchRoute, listRoutes, clearRoutes, createRouteRegistry } from '../lib/observability/route-registry.js';

test.beforeEach(() => clearRoutes());

test('registers and matches an exact route', () => {
  registerRoute({ method: 'GET', pattern: '/api/workspace', handle: () => 'list' });
  const m = matchRoute('GET', '/api/workspace');
  assert.ok(m);
  assert.equal(m.route.handle(), 'list');
  assert.deepEqual(m.params, {});
});

test('matches a :param route and decodes the segment', () => {
  registerRoute({ method: 'GET', pattern: '/api/workspace/:id', handle: () => 'one' });
  const m = matchRoute('GET', '/api/workspace/sess%2F1');
  assert.ok(m);
  assert.equal(m.params.id, 'sess/1');
});

test('exact route is not shadowed by a same-method param route', () => {
  registerRoute({ method: 'GET', pattern: '/api/workspace/:id', handle: () => 'one' });
  registerRoute({ method: 'GET', pattern: '/api/workspace', handle: () => 'list' });
  const m = matchRoute('GET', '/api/workspace');
  assert.equal(m.route.pattern, '/api/workspace');
});

test('no match -> null', () => {
  assert.equal(matchRoute('GET', '/api/nope'), null);
});

test('method mismatch -> null', () => {
  registerRoute({ method: 'GET', pattern: '/api/x', handle: () => 1 });
  assert.equal(matchRoute('POST', '/api/x'), null);
});

test('re-registering the same method+pattern replaces the handler', () => {
  registerRoute({ method: 'GET', pattern: '/api/x', handle: () => 'old' });
  registerRoute({ method: 'GET', pattern: '/api/x', handle: () => 'new' });
  const m = matchRoute('GET', '/api/x');
  assert.equal(m.route.handle(), 'new');
});

test('listRoutes returns method/pattern only', () => {
  registerRoute({ method: 'GET', pattern: '/api/x', handle: () => 1 });
  assert.deepEqual(listRoutes(), [{ method: 'GET', pattern: '/api/x' }]);
});

test('registerRoute validates its inputs', () => {
  assert.throws(() => registerRoute({ method: 'GET', pattern: '/api/x' }));
  assert.throws(() => registerRoute({ pattern: '/api/x', handle: () => 1 }));
});

test('F3: matchRoute never matches a path with an empty segment (no filter(Boolean) normalisation)', () => {
  registerRoute({ method: 'POST', pattern: '/api/workspace/:sid/steer', handle: () => 'steer' });
  assert.ok(matchRoute('POST', '/api/workspace/s1/steer'));
  for (const p of ['//api/workspace/s1/steer', '/api//workspace/s1/steer', '/api/workspace/s1/steer/', 'api/workspace/s1/steer']) {
    assert.equal(matchRoute('POST', p), null, p);
  }
});

test('createRouteRegistry: each table is private, and the module-level table is untouched', () => {
  const a = createRouteRegistry();
  const b = createRouteRegistry();
  a.registerRoute({ method: 'GET', pattern: '/api/x', handle: () => 'a' });
  b.registerRoute({ method: 'GET', pattern: '/api/x', handle: () => 'b' });
  assert.equal(a.matchRoute('GET', '/api/x').route.handle(), 'a');
  assert.equal(b.matchRoute('GET', '/api/x').route.handle(), 'b');
  assert.equal(matchRoute('GET', '/api/x'), null);
});

// Card glmps-2-0-224: a malformed %-escape in a :param segment used to throw a
// URIError out of matchRoute, which the client-ownership preamble calls before
// the request handler's try, so it became an unhandled rejection.
test('matchRoute treats a segment that does not decode as no match', () => {
  const t = createRouteRegistry();
  t.registerRoute({ method: 'POST', pattern: '/api/backlog/:id/devlog', handle: () => {} });
  assert.equal(t.matchRoute('POST', '/api/backlog/%ZZ/devlog'), null);
  assert.equal(t.matchRoute('POST', '/api/backlog/%E0%A4%A/devlog'), null);
  assert.equal(t.matchRoute('POST', '/api/backlog/a%2Fb/devlog').params.id, 'a/b');
});
