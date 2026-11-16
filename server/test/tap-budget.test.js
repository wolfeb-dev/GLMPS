// server/test/tap-budget.test.js
// The tap's budget collector (card glmps-2-0-runtime-38): derives the numbers
// locally and spools only the projection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBudgetCollector } from '../../taps/tap-budget.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapbudget-')); tmpDirs.push(d); return d; };

const value = (pct, now) => ({
  usage: { fiveHour: { usedPercent: pct, resetsAt: 9000 }, sevenDay: null, sevenDaySonnet: null, sevenDayOpus: null },
  meta: null, plan: { subscriptionType: 'max', rateLimitTier: 't', accessToken: 'LEAK' },
  flags: [{ code: 'x' }], available: true, source: 'oauth-usage', updatedTs: now,
});
function setup(over = {}) {
  const appended = [];
  const clock = { t: 1_000_000 };
  const calls = [];
  const spool = { append: (kind, payload) => { appended.push({ kind, payload }); return { seq: appended.length }; } };
  const pct = { v: 40 };
  const c = createBudgetCollector({
    claudeDir: '/claude', spool, now: () => clock.t, refreshMs: 600_000, log: () => {},
    readBudget: async (o) => { calls.push(o); return value(pct.v, clock.t); },
    ...over,
  });
  return { c, appended, clock, calls, pct };
}

test('tick spools one budget record carrying only the projection', async () => {
  const { c, appended } = setup();
  const r = await c.tick();
  assert.equal(r.appended, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].kind, 'budget');
  assert.equal(appended[0].payload.usage.fiveHour.usedPercent, 40);
  assert.equal('flags' in appended[0].payload, false);
  assert.equal(JSON.stringify(appended[0].payload).includes('LEAK'), false);
});

test('an unchanged budget is not re-appended until refreshMs has passed', async () => {
  const { c, appended, clock } = setup();
  await c.tick();
  clock.t += 120_000;
  assert.equal((await c.tick()).appended, false);
  clock.t += 600_000;
  assert.equal((await c.tick()).appended, true);
  assert.equal(appended.length, 2);
});

test('a changed budget is appended at once', async () => {
  const { c, appended, clock, pct } = setup();
  await c.tick();
  pct.v = 41; clock.t += 1000;
  assert.equal((await c.tick()).appended, true);
  assert.equal(appended.length, 2);
});

test('readBudget gets the claude dir files, a private cache, and the usage fetch only', async () => {
  const usageFetch = async () => ({});
  const { c, calls } = setup({ fetch: usageFetch });
  await c.tick(); await c.tick();
  assert.equal(calls[0].credentialsFile, path.join('/claude', '.credentials.json'));
  assert.equal(calls[0].statuslineFile, path.join('/claude', '.claude-manager', 'statusline.json'));
  assert.equal(calls[0].fetchImpl, usageFetch);
  assert.equal(calls[0].cache, calls[1].cache);
  assert.equal(typeof calls[0].cache, 'object');
});

test('claudeDir defaults to GLMPS_CLAUDE_DIR, then the home .claude', async () => {
  const a = setup({ claudeDir: undefined, env: { GLMPS_CLAUDE_DIR: '/from-env' } });
  await a.c.tick();
  assert.equal(a.calls[0].credentialsFile, path.join('/from-env', '.credentials.json'));
  const b = setup({ claudeDir: undefined, env: {}, homeDir: '/home/u' });
  await b.c.tick();
  assert.equal(b.calls[0].credentialsFile, path.join('/home/u', '.claude', '.credentials.json'));
});

test('tick never throws: a failing read or append returns {error} and logs', async () => {
  const logs = [];
  const a = setup({ readBudget: async () => { throw new Error('boom'); }, log: (m) => logs.push(m) });
  const r = await a.c.tick();
  assert.equal(r.error, 'boom');
  assert.equal(logs.length, 1);
  const b = setup({ spool: { append: () => { throw new Error('disk'); } } });
  assert.equal((await b.c.tick()).error, 'disk');
});

test('against a real planted claude dir the collector spools numbers and not the token', async () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: 'SENTINEL-R', subscriptionType: 'max' } }));
  const appended = [];
  const c = createBudgetCollector({ claudeDir: dir, spool: { append: (k, p) => { appended.push({ k, p }); return {}; } }, log: () => {} });
  const r = await c.tick();
  assert.equal(r.appended, true);
  assert.equal(appended[0].p.plan.subscriptionType, 'max');
  assert.equal(appended[0].p.available, false);
  assert.equal(JSON.stringify(appended).includes('SENTINEL'), false);
});
