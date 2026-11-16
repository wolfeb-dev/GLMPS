import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadActors, actorForToken, actorHasRole, gateCheck } from '../lib/governance/actors.js';

test('loadActors returns [] when cfg.actors is absent or not an array', () => {
  assert.deepEqual(loadActors({}), []);
  assert.deepEqual(loadActors({ actors: null }), []);
  assert.deepEqual(loadActors({ actors: 'nope' }), []);
});

test('loadActors drops malformed entries (missing/blank id, non-object) but keeps valid ones', () => {
  const actors = loadActors({
    actors: [
      { id: 'alice', roles: ['promote'] },
      { id: '   ' },           // blank id -> dropped
      { name: 'no id' },       // missing id -> dropped
      null,                    // not an object -> dropped
      'bob',                   // not an object -> dropped
      { id: 42 },              // id not a string -> dropped
      { id: 'carol', roles: 'not-an-array' }, // roles coerced to []
    ],
  });
  assert.deepEqual(actors.map(a => a.id), ['alice', 'carol']);
  assert.deepEqual(actors[1].roles, []);
});

test('loadActors normalizes roles (trims, dedups, drops non-strings)', () => {
  const [a] = loadActors({ actors: [{ id: 'alice', roles: [' promote ', 'promote', '', 42, 'research'] }] });
  assert.deepEqual(a.roles, ['promote', 'research']);
});

test('loadActors normalizes optional fields to null when absent/blank', () => {
  const [a] = loadActors({ actors: [{ id: 'alice' }] });
  assert.equal(a.name, null);
  assert.equal(a.token, null);
  assert.equal(a.notify, null);
  assert.deepEqual(a.roles, []);
});

test('loadActors accepts name/token strings and an object notify profile, and drops unknown fields', () => {
  const [a] = loadActors({
    actors: [{ id: 'alice', name: 'Alice', token: 'sekret', discordUser: 'alice#1234', notify: { method: 'slack', target: 'C1' } }],
  });
  assert.equal(a.name, 'Alice');
  assert.equal(a.token, 'sekret');
  assert.deepEqual(a.notify, { method: 'slack', target: 'C1' });
  // Discord retired 2026-08-29: the field is no longer part of the actor shape,
  // and an old config that still carries it is silently ignored rather than
  // rejected, so a stale config.json does not break the server.
  assert.ok(!('discordUser' in a));
});

test('actorForToken matches by token, returns null for no match/empty/absent token', () => {
  const actors = loadActors({ actors: [{ id: 'alice', token: 'alice-secret' }, { id: 'bob', token: 'bob-secret' }] });
  assert.equal(actorForToken(actors, 'alice-secret').id, 'alice');
  assert.equal(actorForToken(actors, 'bob-secret').id, 'bob');
  assert.equal(actorForToken(actors, 'wrong'), null);
  assert.equal(actorForToken(actors, ''), null);
  assert.equal(actorForToken(actors, undefined), null);
  assert.equal(actorForToken([], 'alice-secret'), null);
});

test('actorForToken never matches an actor with no configured token', () => {
  const actors = loadActors({ actors: [{ id: 'alice' }] });
  assert.equal(actorForToken(actors, ''), null);
  assert.equal(actorForToken(actors, 'alice'), null); // id is not a token
});

test('actorHasRole: true/false by membership; true when role is falsy (no role required)', () => {
  const actors = loadActors({ actors: [{ id: 'alice', roles: ['promote'] }] });
  assert.equal(actorHasRole(actors, 'alice', 'promote'), true);
  assert.equal(actorHasRole(actors, 'alice', 'capital'), false);
  assert.equal(actorHasRole(actors, 'unknown', 'promote'), false);
  assert.equal(actorHasRole(actors, 'alice', undefined), true);
  assert.equal(actorHasRole(actors, 'alice', ''), true);
});

test('gateCheck is ALWAYS a no-op when actors is empty (solo mode) regardless of actorId/role', () => {
  assert.equal(gateCheck({ actors: [], actorId: 'anyone', role: 'promote' }).allowed, true);
  assert.equal(gateCheck({ actors: [], actorId: null, role: 'capital' }).allowed, true);
  assert.equal(gateCheck({}).allowed, true);
});

test('gateCheck allows when no role is required, even with actors configured', () => {
  const actors = loadActors({ actors: [{ id: 'alice', roles: [] }] });
  assert.equal(gateCheck({ actors, actorId: 'alice', role: undefined }).allowed, true);
  assert.equal(gateCheck({ actors, actorId: 'ghost', role: null }).allowed, true);
});

test('gateCheck denies an unknown actor when a role is required, with a reason', () => {
  const actors = loadActors({ actors: [{ id: 'alice', roles: ['promote'] }] });
  const r = gateCheck({ actors, actorId: 'ghost', role: 'promote' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /unknown actor/);
});

test('gateCheck denies a known actor lacking the role, allows one holding it', () => {
  const actors = loadActors({ actors: [{ id: 'alice', roles: ['promote'] }, { id: 'bob', roles: ['research'] }] });
  const denied = gateCheck({ actors, actorId: 'bob', role: 'promote' });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /lacks role/);
  assert.equal(gateCheck({ actors, actorId: 'alice', role: 'promote' }).allowed, true);
});

// Future seam (glmps-72 B3 point 3): promotion "apply" (glmps-33 advisory->apply,
// not yet built) will gate on role 'promote' at whatever endpoint eventually lands,
// exactly like this. No route exists yet; this just reserves + proves the mechanism.
test('gateCheck seam reserved for a future promotion-apply endpoint (glmps-33): promote-role check', () => {
  const actors = loadActors({ actors: [{ id: 'alice', roles: ['promote'] }, { id: 'bob', roles: ['research'] }] });
  assert.equal(gateCheck({ actors, actorId: 'alice', role: 'promote' }).allowed, true);
  assert.equal(gateCheck({ actors, actorId: 'bob', role: 'promote' }).allowed, false);
});
