// the pure geometry and classification behind the Loops and Alert pulses layers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orbitRadiusPx, orbitPoint, loopPhase, loopState, loopOrbits, loopLabel, pulsePlaces, pulseLabel, ORBIT_BASE_PX, ORBIT_STEP_PX } from '../../web/surface/orbits.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('ring radius steps out by index and opens with the square root of zoom', () => {
  assert.equal(orbitRadiusPx(0, 1), ORBIT_BASE_PX);
  assert.equal(orbitRadiusPx(3, 1), ORBIT_BASE_PX + 3 * ORBIT_STEP_PX);
  near(orbitRadiusPx(2, 4), 2 * orbitRadiusPx(2, 1));
  assert.ok(orbitRadiusPx(0, 1) > 30, 'outside the local platform ring');
});

test('a dot starts at twelve o clock and sweeps clockwise', () => {
  const [x0, y0] = orbitPoint(10, 0); near(x0, 0); near(y0, -10);
  const [x1, y1] = orbitPoint(10, 0.25); near(x1, 10); near(y1, 0);
  const [x2, y2] = orbitPoint(10, 0.5); near(x2, 0); near(y2, 10);
  const [x3] = orbitPoint(10, 5); near(x3, 0, 1e-5); // clamped to a full turn
});

test('a timed loop sweeps its interval, from nextRunTs when stated', () => {
  const now = 1_000_000;
  const loop = { trigger: { everyMs: 1000 }, nextRunTs: now + 250, lastRunTs: now - 9999 };
  near(loopPhase(loop, now), 0.75);
  near(loopPhase(loop, now + 250), 1);
  near(loopPhase(loop, now + 5000), 1, 1e-9); // overdue stays at due
  assert.ok(loopPhase(loop, now + 100) > loopPhase(loop, now), 'moves with time between feed refreshes');
});

test('a timed loop with no nextRunTs falls back to its last run', () => {
  const now = 50_000;
  near(loopPhase({ trigger: { everyMs: 10000 }, lastRunTs: now - 2500 }, now), 0.25);
});

test('an external or event loop reads its age against its SLA', () => {
  const now = 10_000_000;
  near(loopPhase({ trigger: { external: 'task' }, lastRunTs: now - 500, sla: { maxAgeMs: 1000 } }, now), 0.5);
  near(loopPhase({ trigger: { onEvent: 'x' }, ageS: 2, sla: { maxAgeMs: 4000 } }, now), 0.5);
  assert.equal(loopPhase({ trigger: { external: 'task' } }, now), 0, 'no interval and no SLA: at rest');
  assert.equal(loopPhase(null, now), 0);
});

test('loop state matches Now: failing red, critical at three, stale grey, else ok', () => {
  assert.deepEqual(loopState({ consecutiveFailures: 1 }), { severity: 'warn', word: 'failing 1 in a row' });
  assert.deepEqual(loopState({ consecutiveFailures: 3 }), { severity: 'critical', word: 'failing 3 in a row' });
  assert.deepEqual(loopState({ consecutiveFailures: 0, ageS: 10, sla: { maxAgeMs: 5000 } }), { severity: 'stale', word: 'stale' });
  assert.deepEqual(loopState({ consecutiveFailures: 0, ageS: 4, sla: { maxAgeMs: 5000 } }), { severity: 'ok', word: 'ok' });
  assert.equal(loopState({ consecutiveFailures: 2, ageS: 999, sla: { maxAgeMs: 1 } }).severity, 'warn', 'failing outranks stale');
  assert.equal(loopState({}).severity, 'ok', 'no SLA is never stale');
});

test('orbits are indexed by name so a ring keeps its place across refreshes', () => {
  const snap = { b: { consecutiveFailures: 0 }, a: { consecutiveFailures: 2 }, c: {} };
  const o = loopOrbits(snap, 0);
  assert.deepEqual(o.map((x) => [x.name, x.index]), [['a', 0], ['b', 1], ['c', 2]]);
  assert.equal(loopLabel(o[0]), 'Loop a: failing 2 in a row');
  assert.deepEqual(loopOrbits(null, 0), []);
});

test('alert pulses fold by place, ignore acknowledged, and take the worst severity and its title', () => {
  const alerts = [
    { id: '1', source: 'kernel-health', severity: 'warn', title: 'W' },
    { id: '2', source: 'poison', severity: 'critical', title: 'C' },
    { id: '3', source: 'injection', severity: 'critical', title: 'C2', acknowledged: true },
    { id: '4', source: 'capture-health', severity: 'warn', title: 'Slack silent' },
    { id: '5', source: 'egress', severity: 'warn', title: 'not placed' },
    { id: '6', source: 'integrity', severity: 'warn', title: 'acked locally' },
  ];
  const r = pulsePlaces(alerts, new Set(['6']));
  assert.deepEqual(r.places.get('local'), { place: 'local', count: 2, severity: 'critical', title: 'C' });
  assert.deepEqual(r.places.get('slack'), { place: 'slack', count: 1, severity: 'warn', title: 'Slack silent' });
  assert.equal(r.count, 3);
  assert.equal(r.unplaced, 1);
  assert.equal(pulseLabel(r.places.get('local'), 'the local store'), '2 active alerts at the local store, worst critical: C');
  assert.equal(pulsePlaces(undefined).count, 0);
});
