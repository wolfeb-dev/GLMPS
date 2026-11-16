// server/test/web-alerts-logic.test.js
// glmps-49: pure alert derivation logic (web/shared/alerts-data.js). The bell's
// badge and banner models went with the bell (glmps-2-0-106); the ack filter
// the Alerts page and the Surface Alerts dock share stays. No DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeAlerts } from '../../web/shared/alerts-data.js';

const A = (id, severity, title = id) => ({ id, severity, title, source: 'test' });

test('activeAlerts filters acknowledged ids (Set or array), tolerates empty input', () => {
  const alerts = [A('a', 'critical'), A('b', 'warn'), A('c', 'info')];
  assert.deepEqual(activeAlerts(alerts, new Set(['b'])).map(x => x.id), ['a', 'c']);
  assert.deepEqual(activeAlerts(alerts, ['a', 'c']).map(x => x.id), ['b']);
  assert.deepEqual(activeAlerts(alerts, []), alerts);
  assert.deepEqual(activeAlerts([], new Set(['a'])), []);
  assert.deepEqual(activeAlerts(undefined, undefined), []);
});
