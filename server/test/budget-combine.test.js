// server/test/budget-combine.test.js
// Budget derived on the client (card glmps-2-0-runtime-38): the whitelist
// projection both sides run, and the merge of client budgets into /api/budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectBudget, combineBudget } from '../lib/observability/budget.js';

const NOW = 10_000_000;
const lim = (p, r = 5000) => ({ usedPercent: p, resetsAt: r });
const good = (over = {}) => ({
  usage: { fiveHour: lim(50), sevenDay: lim(10), sevenDaySonnet: null, sevenDayOpus: null },
  meta: { model: 'Opus', contextPercent: 12, costUsd: 1.5 },
  plan: { subscriptionType: 'max', rateLimitTier: 'tier' },
  available: true, source: 'oauth-usage', updatedTs: NOW - 1000, ...over,
});

test('projectBudget keeps only the whitelisted fields and drops everything else', () => {
  const dirty = good();
  dirty.accessToken = 'SECRET';
  dirty.usage.fiveHour.token = 'SECRET';
  dirty.plan.refreshToken = 'SECRET';
  dirty.meta.extra = 'SECRET';
  const p = projectBudget(dirty);
  assert.deepEqual(p, good());
  assert.equal(JSON.stringify(p).includes('SECRET'), false);
});

test('projectBudget normalizes bad values to null or safe defaults', () => {
  const p = projectBudget({
    usage: { fiveHour: lim(150, 1.5), sevenDay: { usedPercent: 'x', resetsAt: 1 }, sevenDaySonnet: 'no' },
    meta: { model: 'm'.repeat(200), contextPercent: 'x', costUsd: null },
    plan: { subscriptionType: 'x'.repeat(65), rateLimitTier: 7 },
    available: 'yes', source: 'weird', updatedTs: 'now',
  });
  assert.deepEqual(p.usage, { fiveHour: { usedPercent: 100, resetsAt: null }, sevenDay: null, sevenDaySonnet: null, sevenDayOpus: null });
  assert.deepEqual(p.meta, { model: null, contextPercent: null, costUsd: null });
  assert.deepEqual(p.plan, { subscriptionType: null, rateLimitTier: null });
  assert.equal(p.available, false);
  assert.equal(p.source, 'none');
  assert.equal(p.updatedTs, 0);
});

test('projectBudget of a non-object is null; absent usage/meta/plan stay null', () => {
  assert.equal(projectBudget(null), null);
  assert.equal(projectBudget('x'), null);
  const p = projectBudget({ available: false, source: 'none', updatedTs: 5 });
  assert.deepEqual(p, { usage: null, meta: null, plan: null, available: false, source: 'none', updatedTs: 5 });
});

const local = (over = {}) => ({ usage: null, meta: null, plan: null, flags: [], available: false, source: 'none', updatedTs: NOW, ...over });
const row = (clientId, payload, receivedTs = NOW - 500) => ({ clientId, seq: 1, kind: 'budget', ts: receivedTs, receivedTs, payload });
const names = { cli_a: 'laptop', cli_b: 'desktop' };
const clientName = (id) => names[id] ?? null;

test('combineBudget leaves an available local value on top and lists clients newest first', () => {
  const l = local({ usage: good().usage, available: true, source: 'oauth-usage', flags: [] });
  const out = combineBudget(l, [
    row('cli_a', good({ updatedTs: NOW - 5000 }), NOW - 4000),
    row('cli_b', good({ updatedTs: NOW - 100 }), NOW - 50),
  ], { clientName, now: NOW });
  assert.equal(out.source, 'oauth-usage');
  assert.equal(out.clientId, undefined);
  assert.deepEqual(out.clients.map((c) => c.clientId), ['cli_b', 'cli_a']);
  assert.equal(out.clients[0].name, 'desktop');
  assert.equal(out.clients[0].stale, false);
  assert.equal(out.clients[0].receivedTs, NOW - 50);
});

test('combineBudget recomputes flags and does not trust a shipped flags field', () => {
  const payload = good({ usage: { fiveHour: lim(96), sevenDay: null, sevenDaySonnet: null, sevenDayOpus: null } });
  payload.flags = [{ code: 'evil' }];
  const out = combineBudget(local(), [row('cli_a', payload)], { clientName, now: NOW });
  assert.deepEqual(out.clients[0].flags.map((f) => f.code), ['fiveHour-high']);
});

test('combineBudget fills the top level from the freshest non-stale available client when local is unavailable', () => {
  const out = combineBudget(local(), [
    row('cli_a', good({ updatedTs: NOW - 9000, meta: { model: 'old', contextPercent: null, costUsd: null } })),
    row('cli_b', good({ updatedTs: NOW - 100 })),
  ], { clientName, now: NOW });
  assert.equal(out.available, true);
  assert.equal(out.source, 'client');
  assert.equal(out.clientId, 'cli_b');
  assert.equal(out.usage.fiveHour.usedPercent, 50);
  assert.equal(out.meta.model, 'Opus');
  assert.equal(out.plan.subscriptionType, 'max');
  assert.equal(out.updatedTs, NOW - 100);
});

test('combineBudget does not promote a stale or unavailable client', () => {
  const stale = good({ updatedTs: NOW - 16 * 60_000 });
  const unavailable = good({ available: false, usage: null, source: 'none' });
  const out = combineBudget(local(), [row('cli_a', stale), row('cli_b', unavailable)], { clientName, now: NOW });
  assert.equal(out.available, false);
  assert.equal(out.source, 'none');
  assert.equal(out.clients.find((c) => c.clientId === 'cli_a').stale, true);
});

test('combineBudget leaves out unknown/revoked clients and unprojectable payloads', () => {
  const out = combineBudget(local(), [row('cli_gone', good()), row('cli_a', 'junk'), row('cli_b', good())], { clientName, now: NOW });
  assert.deepEqual(out.clients.map((c) => c.clientId), ['cli_b']);
});

test('combineBudget with no rows still returns an empty clients list', () => {
  const out = combineBudget(local(), [], { clientName, now: NOW });
  assert.deepEqual(out.clients, []);
  assert.equal(out.available, false);
});
