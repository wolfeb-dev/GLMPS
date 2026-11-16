import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBootTrace } from '../lib/kernel/boot-trace.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('the first span runs from process start (time 0) to the first mark', () => {
  const c = clock(1500);
  const trace = createBootTrace({ now: c.now });
  trace.mark('import');
  assert.deepEqual(trace.spans(), [{ name: 'import', ms: 1500, endMs: 1500, waited: false }]);
});

test('each mark times the stretch since the previous mark', () => {
  const c = clock(100);
  const trace = createBootTrace({ now: c.now });
  trace.mark('import');
  c.advance(250); trace.mark('setup');
  c.advance(40); trace.mark('poll');
  assert.deepEqual(trace.spans().map((s) => [s.name, s.ms, s.endMs]), [['import', 100, 100], ['setup', 250, 350], ['poll', 40, 390]]);
});

test('a waited span is recorded but never reported as a block', () => {
  const c = clock(0);
  const trace = createBootTrace({ now: c.now });
  trace.mark('import');
  c.advance(900); trace.waited('plugin load');
  c.advance(300); trace.mark('routes and loops');
  assert.equal(trace.spans()[1].waited, true);
  assert.deepEqual(trace.blocks().map((s) => s.name), ['routes and loops']);
});

test('blocks() keeps spans at or over the threshold (200 ms by default)', () => {
  const c = clock(0);
  const trace = createBootTrace({ now: c.now });
  c.advance(199); trace.mark('a');
  c.advance(200); trace.mark('b');
  c.advance(50); trace.mark('c');
  assert.deepEqual(trace.blocks().map((s) => s.name), ['b']);
  assert.deepEqual(trace.blocks({ thresholdMs: 40 }).map((s) => s.name), ['a', 'b', 'c']);
});

test('line() names the ready time and every block with its duration', () => {
  const c = clock(2915);
  const trace = createBootTrace({ now: c.now });
  trace.mark('import');
  c.advance(1212); trace.mark('routes and loops');
  c.advance(30); trace.mark('measurables');
  assert.equal(trace.line(), 'boot trace: ready 4,157 ms after process start; blocks of 200 ms or more: import 2,915 ms, routes and loops 1,212 ms');
});

test('line() says so when no block reaches the threshold', () => {
  const c = clock(10);
  const trace = createBootTrace({ now: c.now });
  trace.mark('import');
  assert.equal(trace.line(), 'boot trace: ready 10 ms after process start; no block of 200 ms or more');
});

test('spans() returns a copy', () => {
  const trace = createBootTrace({ now: () => 5 });
  trace.mark('a');
  trace.spans().pop();
  assert.equal(trace.spans().length, 1);
});
