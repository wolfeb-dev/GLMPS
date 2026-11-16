// server/test/bind-proxy-guard.test.js
// A same-host proxy never turns a remote request into a trusted loopback one
// (security review point 2). The Tailscale bind and Serve guard this file once
// covered were retired by card glmps-2-0-152; the private bind is covered by
// remote-bind-policy.test.js and mtls-remote.integration.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peerAddress, checkAccess, isLoopback } from '../lib/governance/access-guard.js';

test('peerAddress: a loopback request carrying a forwarding header is not loopback', () => {
  assert.equal(peerAddress('127.0.0.1', {}), '127.0.0.1');
  assert.equal(peerAddress('192.168.1.77', { 'x-forwarded-for': '1.2.3.4' }), '192.168.1.77');
  for (const h of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via']) {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const p = peerAddress(addr, { [h]: 'x' });
      assert.equal(isLoopback(p), false, `${addr} + ${h}`);
    }
  }
});

test('a proxied loopback request needs the token like any remote one', () => {
  const base = { method: 'POST', pathname: '/api/backlog', token: 'secret', host: '127.0.0.1:8123', localPort: 8123 };
  // What a same-host reverse proxy sends when it relays to 127.0.0.1.
  const headers = { 'x-forwarded-host': 'glmps.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.168.1.77' };
  assert.deepEqual(checkAccess({ ...base, remoteAddress: '127.0.0.1' }), { allow: true });
  assert.deepEqual(checkAccess({ ...base, remoteAddress: peerAddress('127.0.0.1', headers) }), { allow: false, status: 401 });
  assert.deepEqual(checkAccess({ ...base, remoteAddress: peerAddress('127.0.0.1', headers), presentedToken: 'secret' }), { allow: true });
});
