// server/test/source-guard.test.js
// glmps-47: per-source failure isolation for the capture watch loop.
// A throwing read on one source must never propagate; repeated failures back
// off exponentially (skip-and-continue); warnings are debounced per source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceGuard } from '../lib/observability/source-guard.js';

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('guard: throwing fn is caught, returns ok:false, does not propagate', () => {
  const g = createSourceGuard({ log: () => {} });
  const r = g.run('a', () => { throw new Error('EPERM: locked'); });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /EPERM/);
});

test('guard: one failing source does not affect another', () => {
  const g = createSourceGuard({ log: () => {} });
  g.run('bad', () => { throw new Error('EBUSY'); });
  const r = g.run('good', () => 42);
  assert.equal(r.ok, true);
  assert.equal(r.value, 42);
});

test('guard: failed source is skipped until its backoff expires, then retried', () => {
  const clock = makeClock(1000);
  const g = createSourceGuard({ log: () => {}, now: clock.now, baseBackoffMs: 100 });
  let calls = 0;
  const fn = () => { calls++; throw new Error('EPERM'); };
  g.run('s', fn);                       // fails -> backoff 100ms
  assert.equal(calls, 1);
  const r = g.run('s', fn);             // within backoff -> skipped, fn not called
  assert.equal(calls, 1);
  assert.equal(r.skipped, true);
  clock.advance(101);
  g.run('s', fn);                       // backoff expired -> retried
  assert.equal(calls, 2);
});

test('guard: backoff grows exponentially and is capped', () => {
  const clock = makeClock(0);
  const g = createSourceGuard({ log: () => {}, now: clock.now, baseBackoffMs: 100, maxBackoffMs: 400 });
  const fail = () => { throw new Error('x'); };
  g.run('s', fail);                     // backoff 100
  clock.advance(101); g.run('s', fail); // backoff 200
  clock.advance(201); g.run('s', fail); // backoff 400
  clock.advance(401); g.run('s', fail); // backoff capped at 400
  clock.advance(399);
  assert.equal(g.run('s', fail).skipped, true, 'still inside capped backoff');
  clock.advance(2);
  assert.equal(g.run('s', fail).skipped, undefined, 'retried after capped backoff');
});

test('guard: success clears the failure state', () => {
  const clock = makeClock(0);
  const g = createSourceGuard({ log: () => {}, now: clock.now, baseBackoffMs: 100 });
  let fail = true;
  const fn = () => { if (fail) throw new Error('x'); return 'ok'; };
  g.run('s', fn);
  clock.advance(101);
  fail = false;
  assert.equal(g.run('s', fn).value, 'ok');
  fail = true;
  clock.advance(1);
  g.run('s', fn);                       // fresh failure -> base backoff again
  clock.advance(101);
  let calls = 0;
  g.run('s', () => { calls++; throw new Error('x'); });
  assert.equal(calls, 1, 'backoff restarted from base after success');
});

test('guard: warnings are debounced per source', () => {
  const clock = makeClock(0);
  const warnings = [];
  const g = createSourceGuard({ log: (m) => warnings.push(m), now: clock.now, baseBackoffMs: 1, warnEveryMs: 1000 });
  const fail = () => { throw new Error('EPERM: locked db'); };
  for (let i = 0; i < 5; i++) { g.run('s', fail); clock.advance(2); }
  assert.equal(warnings.length, 1, 'repeated failures within the window warn once');
  assert.match(warnings[0], /s.*EPERM/s);
  clock.advance(1000);
  g.run('s', fail);
  assert.equal(warnings.length, 2, 'warns again after the debounce window');
});

test('guard: warn() emits a debounced standalone warning per key', () => {
  const clock = makeClock(0);
  const warnings = [];
  const g = createSourceGuard({ log: (m) => warnings.push(m), now: clock.now, warnEveryMs: 500 });
  g.warn('k', 'extract failed on one line');
  g.warn('k', 'extract failed on one line');
  assert.equal(warnings.length, 1);
  clock.advance(501);
  g.warn('k', 'extract failed on one line');
  assert.equal(warnings.length, 2);
  g.warn('other', 'different key not debounced by k');
  assert.equal(warnings.length, 3);
});
