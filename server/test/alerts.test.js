// server/test/alerts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEVERITY, normalizeAlert, rankAlerts, summarizeAlerts, dedupAlerts } from '../lib/observability/alerts.js';

test('normalizeAlert: defaults + severity validation + derived id', () => {
  const a = normalizeAlert({ source: 'capture', severity: 'warn', title: 'Gemini model gap', target: { view: 'analytics' } });
  assert.equal(a.source, 'capture');
  assert.equal(a.severity, 'warn');
  assert.equal(a.title, 'Gemini model gap');
  assert.equal(a.detail, '');
  assert.deepEqual(a.target, { view: 'analytics' });
  assert.equal(a.acknowledged, false);
  assert.ok(a.id, 'derives a stable id when none given');

  // invalid/missing severity -> info
  assert.equal(normalizeAlert({ source: 's', title: 't', severity: 'boom' }).severity, SEVERITY.INFO);
  assert.equal(normalizeAlert({ source: 's', title: 't' }).severity, SEVERITY.INFO);
});

test('rankAlerts: severity desc, then recency desc', () => {
  const ranked = rankAlerts([
    { source: 'a', title: 'i', severity: 'info', ts: 20 },
    { source: 'b', title: 'c', severity: 'critical', ts: 10 },
    { source: 'c', title: 'w', severity: 'warn', ts: 30 },
    { source: 'd', title: 'c2', severity: 'critical', ts: 40 },
  ].map(normalizeAlert));
  assert.deepEqual(ranked.map(a => a.title), ['c2', 'c', 'w', 'i']);
});

test('summarizeAlerts: counts, topSeverity, unacknowledged', () => {
  const s = summarizeAlerts([
    { source: 'a', title: '1', severity: 'warn' },
    { source: 'b', title: '2', severity: 'critical', acknowledged: true },
    { source: 'c', title: '3', severity: 'info' },
    { source: 'd', title: '4', severity: 'warn' },
  ].map(normalizeAlert));
  assert.equal(s.total, 4);
  assert.equal(s.critical, 1);
  assert.equal(s.warn, 2);
  assert.equal(s.info, 1);
  assert.equal(s.unacknowledged, 3); // the acknowledged critical excluded
  assert.equal(s.topSeverity, 'critical');
});

test('summarizeAlerts: empty -> zeros, topSeverity null', () => {
  const s = summarizeAlerts([]);
  assert.equal(s.total, 0);
  assert.equal(s.topSeverity, null);
});

test('dedupAlerts: same id collapses, newest ts wins', () => {
  const a1 = normalizeAlert({ id: 'x', source: 's', title: 't', severity: 'warn', ts: 10 });
  const a2 = normalizeAlert({ id: 'x', source: 's', title: 't', severity: 'critical', ts: 20 });
  const out = dedupAlerts([a1, a2]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ts, 20);
  assert.equal(out[0].severity, 'critical');
});
