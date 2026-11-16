// Module under test: web/surface/director.js (pure; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DWELL_MS, DWELL_REDUCED_MS, FRESH_GIT_MS, tierOf, directorStep, initialDirector } from '../../web/surface/director.js';

const NOW = 1_800_000_000_000;
const s = (id, o = {}) => ({ id, waiting: false, failing: false, lastGitTs: null, cpm: 0, idle: false, ...o });

test('priority is waiting on you, then failing, then a fresh commit or push, then the busiest', () => {
  assert.ok(tierOf(s('a', { waiting: true }), NOW) > tierOf(s('a', { failing: true }), NOW));
  assert.ok(tierOf(s('a', { failing: true }), NOW) > tierOf(s('a', { lastGitTs: NOW - 1000 }), NOW));
  assert.ok(tierOf(s('a', { lastGitTs: NOW - 1000 }), NOW) > tierOf(s('a', { cpm: 9 }), NOW));
  assert.ok(tierOf(s('a', { cpm: 1 }), NOW) > tierOf(s('a'), NOW));
  assert.equal(tierOf(s('a', { lastGitTs: NOW - FRESH_GIT_MS - 1 }), NOW), tierOf(s('a'), NOW), 'a git event older than 6 s no longer counts');
  assert.equal(tierOf(s('a', { cpm: 9, idle: true }), NOW), tierOf(s('a'), NOW), 'an idle session is never busy');
});

test('the first step picks the highest tier; the busiest breaks a tie', () => {
  const list = [s('quiet'), s('busy', { cpm: 8 }), s('busier', { cpm: 20 }), s('waits', { waiting: true })];
  assert.equal(directorStep(initialDirector(), list, { now: NOW }).id, 'waits');
  assert.equal(directorStep(initialDirector(), list.slice(0, 3), { now: NOW }).id, 'busier');
});

test('a pick holds for the dwell, then moves on to the least recently visited peer', () => {
  const list = [s('a', { cpm: 5 }), s('b', { cpm: 4 }), s('c', { cpm: 3 })];
  let st = directorStep(initialDirector(), list, { now: NOW });
  assert.equal(st.id, 'a');
  st = directorStep(st, list, { now: NOW + DWELL_MS - 1 });
  assert.equal(st.id, 'a');
  assert.equal(st.changed, false);
  st = directorStep(st, list, { now: NOW + DWELL_MS });
  assert.equal(st.id, 'b');
  assert.equal(st.changed, true);
  st = directorStep(st, list, { now: NOW + 2 * DWELL_MS });
  assert.equal(st.id, 'c');
  st = directorStep(st, list, { now: NOW + 3 * DWELL_MS });
  assert.equal(st.id, 'a', 'the tour comes round again');
});

test('a session waiting on you keeps the camera when nothing outranks it', () => {
  const list = [s('waits', { waiting: true }), s('busy', { cpm: 30 })];
  let st = directorStep(initialDirector(), list, { now: NOW });
  st = directorStep(st, list, { now: NOW + DWELL_MS });
  assert.equal(st.id, 'waits');
  assert.equal(st.changed, false);
});

test('two sessions waiting alternate', () => {
  const list = [s('w1', { waiting: true }), s('w2', { waiting: true })];
  let st = directorStep(initialDirector(), list, { now: NOW });
  const first = st.id;
  st = directorStep(st, list, { now: NOW + DWELL_MS });
  assert.notEqual(st.id, first);
});

test('a locked session holds the camera whatever outranks it, and releasing it resumes the tour', () => {
  const list = [s('waits', { waiting: true }), s('picked')];
  let st = directorStep(initialDirector(), list, { now: NOW, lockId: 'picked' });
  assert.equal(st.id, 'picked');
  st = directorStep(st, list, { now: NOW + 5 * DWELL_MS, lockId: 'picked' });
  assert.equal(st.id, 'picked');
  st = directorStep(st, list, { now: NOW + 5 * DWELL_MS + 1 });
  assert.equal(st.id, 'waits', 'unlocked, the next step re-picks by priority');
});

test('a lock on a session that left the ring is ignored', () => {
  const st = directorStep(initialDirector(), [s('a')], { now: NOW, lockId: 'gone' });
  assert.equal(st.id, 'a');
});

test('the focused session leaving the ring moves the camera at once', () => {
  let st = directorStep(initialDirector(), [s('a', { cpm: 9 }), s('b')], { now: NOW });
  assert.equal(st.id, 'a');
  st = directorStep(st, [s('b')], { now: NOW + 1000 });
  assert.equal(st.id, 'b');
  st = directorStep(st, [], { now: NOW + 2000 });
  assert.equal(st.id, null);
});

test('reduced motion tours every 20 s', () => {
  const list = [s('a', { cpm: 5 }), s('b', { cpm: 4 })];
  let st = directorStep(initialDirector(), list, { now: NOW, reduced: true });
  st = directorStep(st, list, { now: NOW + DWELL_MS + 1, reduced: true });
  assert.equal(st.id, 'a');
  st = directorStep(st, list, { now: NOW + DWELL_REDUCED_MS, reduced: true });
  assert.equal(st.id, 'b');
});

test('a single session stays put and the step does not mutate its input', () => {
  const st0 = initialDirector();
  const st1 = directorStep(st0, [s('only')], { now: NOW });
  assert.deepEqual(st0, initialDirector());
  const st2 = directorStep(st1, [s('only')], { now: NOW + 3 * DWELL_MS });
  assert.equal(st2.id, 'only');
  assert.equal(st2.changed, false);
});
