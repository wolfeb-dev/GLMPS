import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopAlerts } from '../lib/loops/loop-health.js';
import { collectAlerts } from '../lib/observability/alert-sources.js';

const snap = (over) => ({ wiki: { lastOutcome: 'failed:timeout', consecutiveFailures: 1, lastReason: 'timeout', lastRunTs: 5, ...over } });

test('one failure is a warn, three is critical, zero is silent', () => {
  assert.equal(loopAlerts(snap())[0].severity, 'warn');
  assert.equal(loopAlerts(snap({ consecutiveFailures: 3 }))[0].severity, 'critical');
  assert.deepEqual(loopAlerts(snap({ consecutiveFailures: 0, lastOutcome: 'done' })), []);
});

test('the alert names the loop, the reason and the count, and targets the loops view', () => {
  const [a] = loopAlerts(snap({ consecutiveFailures: 2 }));
  assert.equal(a.source, 'loop');
  assert.equal(a.title, 'Loop failing: wiki');
  assert.equal(a.detail, 'timeout (2 consecutive)');
  assert.deepEqual(a.target, { view: 'loops', loop: 'wiki' });
  assert.equal(a.ts, 5);
});

test('collectAlerts renders loopHealth', () => {
  const alerts = collectAlerts({ loopHealth: snap({ consecutiveFailures: 3 }) });
  assert.equal(alerts.filter((x) => x.source === 'loop').length, 1);
  assert.equal(collectAlerts({}).filter((x) => x.source === 'loop').length, 0);
});

test('a wiki loop that the checker rejected once is a warn titled "Loop failing: wiki"', () => {
  const [a] = loopAlerts(snap({ lastOutcome: 'failed:checker:style', lastReason: 'checker:style' }));
  assert.equal(a.severity, 'warn');
  assert.equal(a.title, 'Loop failing: wiki');
  assert.equal(a.detail, 'checker:style (1 consecutive)');
});
