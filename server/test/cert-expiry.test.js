// server/test/cert-expiry.test.js
// Card glmps-2-0-152: the server certificate and every paired client's
// certificate are checked daily, and each raises an alert 30 days before expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certExpiryFindings, CERT_WARN_DAYS } from '../lib/kernel/cert-expiry.js';
import { collectAlerts } from '../lib/observability/alert-sources.js';

const DAY = 86400000;
const NOW = Date.parse('2026-11-10T18:00:00Z');

test('findings: inside 30 days or past expiry, for the server and each paired client; revoked or certless clients are skipped', () => {
  assert.equal(CERT_WARN_DAYS, 30);
  const f = certExpiryFindings({
    now: NOW,
    serverNotAfter: NOW + 10 * DAY,
    clients: [
      { id: 'cli_soon', name: 'laptop', paired: true, certNotAfter: NOW + 29 * DAY },
      { id: 'cli_fine', name: 'desk', paired: true, certNotAfter: NOW + 31 * DAY },
      { id: 'cli_gone', name: 'old', paired: true, certNotAfter: NOW - DAY },
      { id: 'cli_rev', name: 'rev', paired: false, certNotAfter: NOW + DAY },
      { id: 'cli_none', name: 'pre-mtls', paired: true, certNotAfter: null },
    ],
  });
  assert.deepEqual(f.map((x) => [x.kind, x.clientId ?? null, x.expired]), [
    ['server', null, false], ['client', 'cli_soon', false], ['client', 'cli_gone', true],
  ]);
  assert.deepEqual(certExpiryFindings({ now: NOW, serverNotAfter: null, clients: [] }), [], 'a loopback-only kernel has no server certificate to watch');
});

test('alerts: one warn per certificate, an expired one is critical, and the target opens the Clients view', () => {
  const alerts = collectAlerts({ certExpiry: [
    { kind: 'server', notAfter: NOW + 10 * DAY, expired: false },
    { kind: 'client', clientId: 'cli_soon', name: 'laptop', notAfter: NOW + 29 * DAY, expired: false },
    { kind: 'client', clientId: 'cli_gone', name: 'old', notAfter: NOW - DAY, expired: true },
  ] }).filter((a) => a.source === 'cert-expiry');
  assert.equal(alerts.length, 3);
  const server = alerts.find((a) => /server certificate/i.test(a.title));
  assert.equal(server.severity, 'warn');
  assert.match(server.detail, /provision-server-box/);
  const gone = alerts.find((a) => a.title.includes('old'));
  assert.equal(gone.severity, 'critical');
  assert.match(gone.detail, /rotate|re-pair/i);
  assert.deepEqual(alerts.find((a) => a.title.includes('laptop')).target, { view: 'clients', clientId: 'cli_soon', notAfter: NOW + 29 * DAY });
});

test('a server certificate that no longer covers the bind host is a critical finding and alert (card glmps-2-0-177)', () => {
  const f = certExpiryFindings({ now: NOW, serverNotAfter: NOW + 300 * DAY, serverHost: '10.0.0.9', serverHostCovered: false, clients: [] });
  assert.deepEqual(f, [{ kind: 'server-host', host: '10.0.0.9' }]);
  assert.deepEqual(certExpiryFindings({ now: NOW, serverNotAfter: NOW + 300 * DAY, serverHost: '10.0.0.5', serverHostCovered: true }), []);
  const [a] = collectAlerts({ certExpiry: f }).filter((x) => x.source === 'cert-expiry');
  assert.equal(a.severity, 'critical');
  assert.match(a.title, /10\.0\.0\.9/);
  assert.match(a.detail, /provision-server-box/);
  assert.deepEqual(a.target, { view: 'clients' });
});

test('the client certificate alert names the action the Clients panel offers (card glmps-2-0-177)', () => {
  const [a] = collectAlerts({ certExpiry: [{ kind: 'client', clientId: 'cli_soon', name: 'laptop', notAfter: NOW + DAY, expired: false }] })
    .filter((x) => x.source === 'cert-expiry');
  assert.match(a.detail, /Pair again/);
  assert.doesNotMatch(a.detail, /Rotate/, 'a rotation needs the tap\'s new key, which the browser never holds');
});
