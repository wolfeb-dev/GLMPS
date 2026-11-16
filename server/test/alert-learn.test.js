// server/test/alert-learn.test.js
// alertsToGaps() maps the LEARNABLE subset of dashboard alerts (server/lib/
// observability/alerts.js canonical shape) into gap-shape items the existing
// learning pipeline already knows how to consume. Pure unit tests over fixture
// alert objects - no fs, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertsToGaps, ALERT_CODE_MAP, isLearnableAlertSource } from '../lib/observability/alert-learn.js';

test('ALERT_CODE_MAP wires exactly one entry today: egress -> egress', () => {
  assert.equal(ALERT_CODE_MAP.get('egress'), 'egress');
  assert.equal(ALERT_CODE_MAP.size, 1, 'only egress is wired for now (informational/false-positive-prone kinds stay out)');
});

test('isLearnableAlertSource reflects the map', () => {
  assert.equal(isLearnableAlertSource('egress'), true);
  assert.equal(isLearnableAlertSource('unmerged-branch'), false);
  assert.equal(isLearnableAlertSource('injection'), false);
  assert.equal(isLearnableAlertSource('poison'), false);
  assert.equal(isLearnableAlertSource('capture'), false);
  assert.equal(isLearnableAlertSource('attestation'), false);
});

test('alertsToGaps: maps an egress alert to the egress gap shape + ctx', () => {
  const alerts = [{
    id: 'egress::Sensitive data touched: .env::{"view":"sessions","id":"sess-1","path":"D:\\\\proj\\\\.env"}',
    source: 'egress', severity: 'critical', title: 'Sensitive data touched: .env',
    detail: 'a secret/credential file was accessed by an agent session',
    target: { view: 'sessions', id: 'sess-1', path: 'D:\\proj\\.env' }, ts: 0,
  }];
  const out = alertsToGaps(alerts);
  assert.equal(out.length, 1);
  const [g] = out;
  assert.equal(g.alertId, alerts[0].id);
  assert.deepEqual(g.gap, {
    code: 'egress', severity: 'critical',
    message: 'a secret/credential file was accessed by an agent session',
  });
  assert.deepEqual(g.ctx, { project: '', sessionId: 'sess-1' });
});

test('alertsToGaps: falls back to title when detail is empty', () => {
  const alerts = [{ id: 'x', source: 'egress', severity: 'warn', title: 'Sensitive data touched: foo', detail: '', target: { view: 'sessions', id: 's1' }, ts: 0 }];
  assert.equal(alertsToGaps(alerts)[0].gap.message, 'Sensitive data touched: foo');
});

test('alertsToGaps: non-learnable sources are filtered out (informational / false-positive-prone)', () => {
  const alerts = [
    { id: 'a', source: 'unmerged-branch', severity: 'warn', title: 'stale branch', target: { view: 'kanban', project: 'p' }, ts: 0 },
    { id: 'b', source: 'injection', severity: 'warn', title: 'possible injection', target: { view: 'sessions', id: 's1' }, ts: 0 },
    { id: 'c', source: 'poison', severity: 'warn', title: 'quarantined', target: { view: 'kanban', id: 't1' }, ts: 0 },
    { id: 'd', source: 'capture', severity: 'warn', title: 'low coverage', target: { view: 'analytics', tool: 'x' }, ts: 0 },
    { id: 'e', source: 'attestation', severity: 'critical', title: 'guardrail missing', target: { view: 'governance' }, ts: 0 },
  ];
  assert.deepEqual(alertsToGaps(alerts), []);
});

test('alertsToGaps: sessionId comes from target.id only when target.view is sessions', () => {
  const alerts = [{ id: 'a', source: 'egress', severity: 'warn', title: 't', detail: 'd', target: { view: 'kanban', id: 'k1' }, ts: 0 }];
  assert.equal(alertsToGaps(alerts)[0].ctx.sessionId, '');
});

test('alertsToGaps: missing/null target does not throw, sessionId stays empty', () => {
  const alerts = [{ id: 'a', source: 'egress', severity: 'warn', title: 't', detail: 'd', target: null, ts: 0 }];
  const out = alertsToGaps(alerts);
  assert.equal(out.length, 1);
  assert.equal(out[0].ctx.sessionId, '');
});

test('alertsToGaps: tolerates non-array / malformed input', () => {
  assert.deepEqual(alertsToGaps(null), []);
  assert.deepEqual(alertsToGaps(undefined), []);
  assert.deepEqual(alertsToGaps([null, 42, {}]), []);
});
