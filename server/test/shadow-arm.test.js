import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordShadow, shadowRates, shadowFile, lastFiredByClass, firedCountInWindow } from '../lib/evaluation/shadow-arm.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shadow-')); }

test('counterfactual rate is independent of actual fires', () => {
  const d = tmp();
  // would have fired 3/4 times, but only actually fired 1/4 (shadow slice)
  recordShadow(d, { taskClass: 'feature', wouldFire: true, fired: true });
  recordShadow(d, { taskClass: 'feature', wouldFire: true, fired: false });
  recordShadow(d, { taskClass: 'feature', wouldFire: true, fired: false });
  recordShadow(d, { taskClass: 'feature', wouldFire: false, fired: false });
  const r = shadowRates(d);
  assert.equal(r.byClass.feature.n, 4);
  assert.equal(r.byClass.feature.counterfactualRate, 0.75);
  assert.equal(r.byClass.feature.fireRate, 0.25);
});

test('missing file -> empty', () => {
  assert.deepEqual(shadowRates(tmp()), { byClass: {} });
});


test('recordShadow omits wouldFire from the persisted record when the caller does not pass it', () => {
  const d = tmp();
  recordShadow(d, { taskClass: 'done-without-verification', fired: true, sid: 's1' });
  const raw = fs.readFileSync(shadowFile(d), 'utf8').trim();
  const entry = JSON.parse(raw);
  assert.equal('wouldFire' in entry, false);
  assert.equal(entry.fired, true);
});

test('recordShadow still persists an explicit wouldFire (skill-trial real counterfactual)', () => {
  const d = tmp();
  recordShadow(d, { taskClass: 'my-gap', wouldFire: true, fired: false, sid: 's1' });
  const entry = JSON.parse(fs.readFileSync(shadowFile(d), 'utf8').trim());
  assert.equal(entry.wouldFire, true);
});


function writeRaw(dir, entries) {
  const file = shadowFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

test('shadowRates: sinceTs excludes entries recorded strictly before it', () => {
  const d = tmp();
  writeRaw(d, [
    { taskClass: 'gap-x', wouldFire: true, fired: false, ts: '2026-01-01T00:00:00.000Z' },  // before window
    { taskClass: 'gap-x', wouldFire: false, fired: false, ts: '2026-02-01T00:00:00.000Z' }, // in window
    { taskClass: 'gap-x', wouldFire: false, fired: false, ts: '2026-03-01T00:00:00.000Z' }, // in window
  ]);
  const sinceTs = Date.parse('2026-01-15T00:00:00.000Z');
  const r = shadowRates(d, { sinceTs });
  assert.equal(r.byClass['gap-x'].n, 2);
  assert.equal(r.byClass['gap-x'].counterfactualRate, 0);
});

test('shadowRates: omitting sinceTs (existing call shape) is fully unaffected', () => {
  const d = tmp();
  writeRaw(d, [
    { taskClass: 'gap-x', wouldFire: true, fired: false, ts: '2026-01-01T00:00:00.000Z' },
    { taskClass: 'gap-x', wouldFire: false, fired: false, ts: '2026-03-01T00:00:00.000Z' },
  ]);
  const r = shadowRates(d);
  assert.equal(r.byClass['gap-x'].n, 2);
});

test('shadowRates: an entry with an unparseable ts is kept (fail-open) even when sinceTs is set', () => {
  const d = tmp();
  writeRaw(d, [
    { taskClass: 'gap-x', wouldFire: false, fired: false, ts: 'not-a-date' },
    { taskClass: 'gap-x', wouldFire: false, fired: false, ts: '2026-06-01T00:00:00.000Z' },
  ]);
  const r = shadowRates(d, { sinceTs: Date.parse('2026-05-01T00:00:00.000Z') });
  assert.equal(r.byClass['gap-x'].n, 2);
});

test('shadowRates: recordShadow-written entries (real ts) are still included with no sinceTs', () => {
  const d = tmp();
  recordShadow(d, { taskClass: 'gap-y', wouldFire: true, fired: true });
  const r = shadowRates(d, {});
  assert.equal(r.byClass['gap-y'].n, 1);
});


test('shadowRates: counterfactualRate is null when no entry in the class carries wouldFire', () => {
  const d = tmp();
  recordShadow(d, { taskClass: 'g', fired: true, sid: 's1' });
  recordShadow(d, { taskClass: 'g', fired: true, sid: 's2' });
  const r = shadowRates(d);
  assert.equal(r.byClass.g.counterfactualRate, null);
  assert.equal(r.byClass.g.fireCount, 2);
  assert.equal(r.byClass.g.n, 2);
});

test('shadowRates: counterfactualRate is computed only over entries that carry wouldFire, mixed with wouldFire-less entries', () => {
  const d = tmp();
  recordShadow(d, { taskClass: 'g', wouldFire: true, fired: true, sid: 's1' });
  recordShadow(d, { taskClass: 'g', wouldFire: false, fired: false, sid: 's2' });
  recordShadow(d, { taskClass: 'g', fired: true, sid: 's3' }); // no wouldFire
  const r = shadowRates(d);
  assert.equal(r.byClass.g.n, 3);
  assert.equal(r.byClass.g.fireCount, 2);
  assert.equal(r.byClass.g.counterfactualRate, 0.5); // 1 of 2 wouldFire-carrying entries true
});

test('shadowRates: episodeCount counts distinct episodeIds among fired:true entries, null when none carry one', () => {
  const d = tmp();
  recordShadow(d, { taskClass: 'g', fired: true, sid: 's1' }); // no episodeId
  const r1 = shadowRates(d);
  assert.equal(r1.byClass.g.episodeCount, null);

  recordShadow(d, { taskClass: 'g', fired: true, sid: 's2', episodeId: 'ep-1' });
  recordShadow(d, { taskClass: 'g', fired: true, sid: 's3', episodeId: 'ep-1' }); // same episode again
  recordShadow(d, { taskClass: 'g', fired: true, sid: 's4', episodeId: 'ep-2' });
  const r2 = shadowRates(d);
  assert.equal(r2.byClass.g.episodeCount, 2); // ep-1, ep-2
});


test('lastFiredByClass: missing file -> empty object', () => {
  assert.deepEqual(lastFiredByClass(tmp()), {});
});

test('lastFiredByClass: only fired:true entries count; the latest one wins', () => {
  const d = tmp();
  writeRaw(d, [
    { taskClass: 'sleep-poll', wouldFire: true, fired: false, ts: '2026-06-01T00:00:00.000Z' }, // observed, not fired
    { taskClass: 'sleep-poll', wouldFire: true, fired: true, ts: '2026-06-10T00:00:00.000Z' },
    { taskClass: 'sleep-poll', wouldFire: true, fired: true, ts: '2026-06-05T00:00:00.000Z' }, // earlier fire, ignored
  ]);
  const out = lastFiredByClass(d);
  assert.equal(out['sleep-poll'], Date.parse('2026-06-10T00:00:00.000Z'));
});

test('lastFiredByClass: a class observed but never fired is absent from the map (fail-open)', () => {
  const d = tmp();
  writeRaw(d, [
    { taskClass: 'reread-loop', wouldFire: true, fired: false, ts: '2026-06-01T00:00:00.000Z' },
    { taskClass: 'reread-loop', wouldFire: false, fired: false, ts: '2026-06-05T00:00:00.000Z' },
  ]);
  assert.deepEqual(lastFiredByClass(d), {});
});

test('lastFiredByClass: an unparseable ts on a fired entry is skipped, never invented', () => {
  const d = tmp();
  writeRaw(d, [{ taskClass: 'x', wouldFire: true, fired: true, ts: 'not-a-date' }]);
  assert.deepEqual(lastFiredByClass(d), {});
});

test('lastFiredByClass: independent per class', () => {
  const d = tmp();
  writeRaw(d, [
    { taskClass: 'a', wouldFire: true, fired: true, ts: '2026-06-01T00:00:00.000Z' },
    { taskClass: 'b', wouldFire: true, fired: true, ts: '2026-06-02T00:00:00.000Z' },
  ]);
  const out = lastFiredByClass(d);
  assert.equal(out.a, Date.parse('2026-06-01T00:00:00.000Z'));
  assert.equal(out.b, Date.parse('2026-06-02T00:00:00.000Z'));
});


test('firedCountInWindow: missing file -> 0', () => {
  assert.equal(firedCountInWindow(tmp(), { windowStart: 0, now: Date.now() }), 0);
});

test('firedCountInWindow: counts only fired:true entries inside [windowStart, now], across all classes', () => {
  const d = tmp();
  writeRaw(d, [
    { taskClass: 'a', wouldFire: true, fired: true, ts: '2026-06-10T00:00:00.000Z' },  // in window
    { taskClass: 'b', wouldFire: true, fired: true, ts: '2026-06-11T00:00:00.000Z' },  // in window
    { taskClass: 'a', wouldFire: true, fired: false, ts: '2026-06-10T00:00:00.000Z' }, // observed, not fired
    { taskClass: 'a', wouldFire: true, fired: true, ts: '2026-01-01T00:00:00.000Z' },  // before window
  ]);
  const count = firedCountInWindow(d, {
    windowStart: Date.parse('2026-06-01T00:00:00.000Z'),
    now: Date.parse('2026-06-30T00:00:00.000Z'),
  });
  assert.equal(count, 2);
});

test('firedCountInWindow: an unparseable ts on a fired entry is skipped, never invented', () => {
  const d = tmp();
  writeRaw(d, [{ taskClass: 'x', wouldFire: true, fired: true, ts: 'not-a-date' }]);
  assert.equal(firedCountInWindow(d, { windowStart: 0, now: Date.now() }), 0);
});
