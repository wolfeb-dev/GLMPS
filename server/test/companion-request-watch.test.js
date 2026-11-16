import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
// The module is TypeScript; Node strips types by default only from 22.18, below
// the engines floor of 22.5, so skip rather than fail to load (card glmps-2-0-161).
const skip = process.features.typescript ? false : 'needs Node type stripping (22.18+)';
const { watchRequests } = skip ? {} : await import('../../companion/src/request-watch.ts');

function harness({ failArm = 0 } = {}) {
  const watchers = [];
  const timers = [];
  let drains = 0;
  let armFailures = failArm;
  const watch = (dir, cb) => {
    if (armFailures > 0) { armFailures--; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
    const w = new EventEmitter();
    w.dir = dir; w.cb = cb; w.closed = false;
    w.close = () => { if (!w.closed) { w.closed = true; w.emit('close'); } };
    watchers.push(w);
    return w;
  };
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimer = (t) => { t.cleared = true; };
  const tick = () => { for (const t of timers) if (!t.cleared) t.fn(); };
  const handle = watchRequests({ dir: '/home/u/.glmps/requests', drain: () => { drains++; }, watch, setTimer, clearTimer, pollMs: 30_000 });
  return { handle, watchers, timers, tick, drains: () => drains, live: () => watchers.filter((w) => !w.closed) };
}

test('it drains at start, on a change and on every poll tick', { skip }, () => {
  const h = harness();
  assert.equal(h.drains(), 1);
  h.watchers[0].cb('rename', 'resume.jsonl');
  assert.equal(h.drains(), 2);
  assert.equal(h.timers[0].ms, 30_000);
  h.tick();
  assert.equal(h.drains(), 3);
});

test('a watch that errors is re-armed on the next tick and keeps draining', { skip }, () => {
  const h = harness();
  h.watchers[0].emit('error', new Error('EPERM'));
  assert.equal(h.live().length, 0);
  h.tick();
  assert.equal(h.live().length, 1, 'one live watch after the re-arm');
  h.live()[0].cb('change', 'resume.jsonl');
  assert.equal(h.drains(), 3);
});

test('a watch whose folder vanished (closed) is re-armed', { skip }, () => {
  const h = harness();
  h.watchers[0].close();
  h.tick();
  assert.equal(h.live().length, 1);
  assert.equal(h.watchers.length, 2);
});

test('a folder missing at start still polls, and the watch arms once it can', { skip }, () => {
  const h = harness({ failArm: 2 });
  assert.equal(h.watchers.length, 0);
  h.tick();
  assert.equal(h.watchers.length, 0, 'second arm attempt also failed');
  h.tick();
  assert.equal(h.live().length, 1);
  assert.equal(h.drains(), 3);
});

test('a healthy watch is not re-armed on a tick', { skip }, () => {
  const h = harness();
  h.tick(); h.tick();
  assert.equal(h.watchers.length, 1);
});

test('dispose stops the timer and closes the watch without re-arming', { skip }, () => {
  const h = harness();
  h.handle.dispose();
  assert.equal(h.timers[0].cleared, true);
  assert.equal(h.live().length, 0);
  assert.equal(h.watchers.length, 1);
});
