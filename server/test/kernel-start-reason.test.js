// Tests for classifying each kernel start (server/lib/kernel/start-reason.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  requesterOf, recordStop, noteStopOverrun, classifyStart, recordStart, readStarts, startsSummary, kernelStartAlerts,
  STARTS_KEPT,
} from '../lib/kernel/start-reason.js';

const tmpState = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-start-reason-'));
const T0 = Date.parse('2026-10-24T17:00:00Z');
const MIN = 60_000;

test('classifyStart: first, unclean, requested, deploy, stop', () => {
  const previous = { at: T0, version: 'v1' };
  assert.equal(classifyStart({ stop: null, previous: null, version: 'v1' }), 'first recorded start');
  assert.equal(classifyStart({ stop: null, previous, version: 'v1' }), 'unclean exit');
  assert.equal(classifyStart({ stop: null, previous, version: 'v2' }), 'unclean exit', 'a crash is a crash even across versions');
  assert.equal(classifyStart({ stop: { at: T0 - 1, kind: 'stop' }, previous, version: 'v1' }), 'unclean exit', 'a stop older than the last start is stale');
  assert.equal(classifyStart({ stop: { at: T0 + 1, kind: 'restart-requested' }, previous, version: 'v1' }), 'requested restart');
  assert.equal(classifyStart({ stop: { at: T0 + 1, kind: 'restart-requested' }, previous, version: 'v2' }), 'deploy', 'the documented deploy is a pull plus Restart server');
  assert.equal(classifyStart({ stop: { at: T0 + 1, kind: 'stop' }, previous, version: 'v2' }), 'deploy');
  assert.equal(classifyStart({ stop: { at: T0 + 1, kind: 'stop' }, previous, version: 'v1' }), 'stop');
});

test('a deploy through Restart server keeps who asked, and does not count toward the restart alert', () => {
  const dir = tmpState();
  recordStart(dir, { version: 'v1', now: T0 });
  recordStop(dir, { kind: 'restart-requested', by: { via: 'browser', page: '/settings' }, version: 'v1', now: T0 + MIN });
  const e = recordStart(dir, { version: 'v2', now: T0 + 2 * MIN });
  assert.equal(e.reason, 'deploy');
  assert.deepEqual(e.by, { via: 'browser', page: '/settings' });
  for (let n = 3; n < 8; n++) {
    recordStop(dir, { kind: 'restart-requested', version: `v${n - 1}`, now: T0 + n * MIN });
    recordStart(dir, { version: `v${n}`, now: T0 + n * MIN + 1 });
  }
  assert.deepEqual(kernelStartAlerts(readStarts(dir), { now: T0 + 10 * MIN }), []);
});

test('requesterOf names the desktop app, a browser or a script', () => {
  assert.equal(requesterOf({ 'user-agent': 'Mozilla/5.0 ... Electron/38.0 GLMPS/2.0' }).via, 'desktop app');
  const b = requesterOf({ 'user-agent': 'Mozilla/5.0 Chrome/155', referer: 'http://127.0.0.1:8123/settings?x=1' }, '127.0.0.1');
  assert.deepEqual([b.via, b.page, b.remote], ['browser', '/settings', '127.0.0.1']);
  assert.equal(requesterOf({ 'user-agent': 'curl/8.4' }).via, 'script');
  assert.equal(requesterOf({}).via, 'unknown client');
  assert.equal(requesterOf({ referer: 'not a url' }).page, null);
});

test('a requested restart after a wake, with an overrun, is recorded on the next start', () => {
  const dir = tmpState();
  recordStart(dir, { version: 'v1', now: T0 });
  recordStop(dir, { kind: 'restart-requested', by: { via: 'browser', page: '/settings' }, version: 'v1', lastWakeTs: T0 + 10 * MIN, now: T0 + 14 * MIN });
  noteStopOverrun(dir, 'Slack stop');
  const e = recordStart(dir, { version: 'v1', now: T0 + 15 * MIN });
  assert.equal(e.reason, 'requested restart');
  assert.deepEqual(e.by, { via: 'browser', page: '/settings' });
  assert.equal(e.minutesAfterWake, 4);
  assert.equal(e.overranIn, 'Slack stop');
  assert.equal(fs.existsSync(path.join(dir, 'kernel', 'last-stop.json')), false, 'the stop record is consumed');
  assert.equal(recordStart(dir, { version: 'v1', now: T0 + 30 * MIN }).reason, 'unclean exit');
});

test('noteStopOverrun without a stop record writes nothing', () => {
  const dir = tmpState();
  noteStopOverrun(dir, 'HTTP close');
  assert.equal(fs.existsSync(path.join(dir, 'kernel', 'last-stop.json')), false);
});

test('the ring keeps the last starts only', () => {
  const dir = tmpState();
  for (let n = 0; n < STARTS_KEPT + 5; n++) recordStart(dir, { version: 'v1', now: T0 + n });
  const ring = readStarts(dir);
  assert.equal(ring.length, STARTS_KEPT);
  assert.equal(ring.at(-1).at, T0 + STARTS_KEPT + 4);
});

test('startsSummary reports the last start and a 24 hour count by reason', () => {
  const ring = [{ at: T0 - 2 * 24 * 60 * MIN, reason: 'deploy' }, { at: T0 - 60 * MIN, reason: 'deploy' }, { at: T0, reason: 'requested restart' }];
  assert.deepEqual(startsSummary(ring, { now: T0 }), { last_start: { reason: 'requested restart', at: new Date(T0).toISOString() }, starts_24h: { deploy: 1, 'requested restart': 1 } });
  assert.deepEqual(startsSummary([], { now: T0 }), { last_start: null, starts_24h: {} });
});

test('alerts: an unclean exit within 7 days, and 4 non-deploy restarts in 24 hours', () => {
  const now = T0;
  const old = { at: now - 8 * 24 * 60 * MIN, reason: 'unclean exit' };
  const fresh = { at: now - MIN, reason: 'unclean exit' };
  assert.deepEqual(kernelStartAlerts([old], { now }), []);
  assert.equal(kernelStartAlerts([fresh], { now }).length, 1);
  const req = (m) => ({ at: now - m * MIN, reason: 'requested restart', by: { via: 'browser', page: '/settings' }, minutesAfterWake: 3, overranIn: null });
  const three = [req(50), req(40), { at: now - 30 * MIN, reason: 'deploy' }, req(20)];
  assert.deepEqual(kernelStartAlerts(three, { now }), []);
  const four = [...three, { at: now - 10 * MIN, reason: 'stop' }];
  const a = kernelStartAlerts(four, { now });
  assert.equal(a.length, 1);
  assert.match(a[0].title, /restarted 4 times in 24 hours, not counting deploys/);
  assert.match(a[0].detail, /requested restart \(asked by the browser \(\/settings\); 3 min after a wake from standby\)/);
});
