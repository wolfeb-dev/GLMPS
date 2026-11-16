import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import tls from 'node:tls';
import { createCa, issueServerCert, issueClientCert, hasCriticalNameConstraints, certFingerprint } from '../lib/kernel/x509-lite.js';

const NOW = new Date('2026-11-03T17:00:00Z');

test('createCa yields a parseable self-signed CA', () => {
  const { certPem, keyPem } = createCa({ cn: 'GLMPS Test CA', days: 3650, now: NOW });
  const ca = new crypto.X509Certificate(certPem);
  assert.equal(ca.ca, true);
  assert.match(ca.subject, /CN=GLMPS Test CA/);
  assert.equal(ca.verify(ca.publicKey), true);
  assert.equal(ca.checkIssued(ca), true);
  assert.equal(new Date(ca.validFrom).getUTCFullYear(), 2026);
  assert.equal(new Date(ca.validTo).getUTCFullYear(), 2036);
  assert.ok(crypto.createPrivateKey(keyPem));
});

test('issueServerCert chains to the CA and carries IP and DNS SANs', () => {
  const caPair = createCa({ cn: 'GLMPS Test CA', days: 3650, now: NOW });
  const { certPem, keyPem } = issueServerCert({
    caCertPem: caPair.certPem, caKeyPem: caPair.keyPem,
    ips: ['192.168.1.50'], dnsNames: ['headscale.glmps.internal'], days: 825, now: NOW,
  });
  const ca = new crypto.X509Certificate(caPair.certPem);
  const leaf = new crypto.X509Certificate(certPem);
  assert.equal(leaf.ca, false);
  assert.equal(leaf.verify(ca.publicKey), true);
  assert.equal(leaf.checkIssued(ca), true);
  assert.equal(leaf.checkIP('192.168.1.50'), '192.168.1.50');
  assert.equal(leaf.checkIP('192.168.1.51'), undefined);
  assert.equal(leaf.checkHost('headscale.glmps.internal'), 'headscale.glmps.internal');
  assert.match(leaf.keyUsage?.join(',') ?? '', /1\.3\.6\.1\.5\.5\.7\.3\.1/);
  assert.doesNotThrow(() => tls.createSecureContext({ cert: certPem, key: keyPem }));
});

test('a leaf signed by a different CA does not verify', () => {
  const a = createCa({ cn: 'A', days: 30, now: NOW });
  const b = createCa({ cn: 'B', days: 30, now: NOW });
  const { certPem } = issueServerCert({ caCertPem: a.certPem, caKeyPem: a.keyPem, ips: ['10.0.0.1'], dnsNames: [], days: 30, now: NOW });
  assert.equal(new crypto.X509Certificate(certPem).verify(new crypto.X509Certificate(b.certPem).publicKey), false);
});

test('serials are random and positive', () => {
  const s = new Set();
  for (let i = 0; i < 5; i++) {
    const c = new crypto.X509Certificate(createCa({ cn: 'S', days: 1, now: NOW }).certPem);
    assert.match(c.serialNumber, /^[0-9A-F]+$/);
    assert.ok(parseInt(c.serialNumber.slice(0, 2), 16) < 0x80);
    s.add(c.serialNumber);
  }
  assert.equal(s.size, 5);
});

// Batched review finding 2 (card glmps-2-0-runtime-148): the CA sits in
// LocalMachine Root on every joined device, so it must be unable to vouch for
// anything outside the home network, checked by a real TLS chain verification.
// The hostname check is skipped: the server listens on 127.0.0.1, and the chain
// verdict is what the constraint decides.
function handshake(caPem, leaf) {
  return new Promise((resolve, reject) => {
    const server = tls.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (s) => s.end());
    server.listen(0, '127.0.0.1', () => {
      const sock = tls.connect({ host: '127.0.0.1', port: server.address().port, ca: caPem, rejectUnauthorized: false, checkServerIdentity: () => undefined }, () => {
        const out = { authorized: sock.authorized, error: sock.authorizationError ? String(sock.authorizationError) : null };
        sock.destroy();
        server.close(() => resolve(out));
      });
      sock.on('error', (e) => { server.close(); reject(e); });
    });
  });
}

test('AC-2: the CA is name-constrained to private IPv4 and glmps.internal, enforced in a real TLS handshake', async () => {
  const caPair = createCa({ cn: 'GLMPS Test CA', days: 3650, now: NOW });
  const plain = createCa({ cn: 'Unconstrained', days: 3650, now: NOW, permitted: null });
  assert.equal(hasCriticalNameConstraints(caPair.certPem), true);
  const leaf = (ips, dnsNames, ca = caPair) => issueServerCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, ips, dnsNames, days: 30, now: NOW });
  for (const [ips, dns] of [[['192.168.1.50'], []], [['10.1.2.3'], []], [['172.20.0.9'], []], [[], ['headscale.glmps.internal']], [['192.168.1.50'], ['glmps.internal']]]) {
    const r = await handshake(caPair.certPem, leaf(ips, dns));
    assert.deepEqual(r, { authorized: true, error: null }, `in scope ${ips} ${dns}`);
  }
  for (const [ips, dns] of [[['8.8.8.8'], []], [['172.32.0.1'], []], [[], ['example.com']], [[], ['glmps.internal.example.com']], [['192.168.1.50'], ['www.bank.com']]]) {
    const r = await handshake(caPair.certPem, leaf(ips, dns));
    assert.equal(r.authorized, false, `out of scope ${ips} ${dns}`);
    assert.ok(r.error, `${ips} ${dns}: a named verification error`);
    // Control: the same leaf from an unconstrained CA is accepted, so the
    // rejection above is the constraint and nothing else about the leaf.
    assert.deepEqual(await handshake(plain.certPem, leaf(ips, dns, plain)), { authorized: true, error: null }, `control ${ips} ${dns}`);
  }
});

test('hasCriticalNameConstraints is false for a CA built without them', () => {
  const plain = createCa({ cn: 'Plain', days: 30, now: NOW, permitted: null });
  assert.equal(hasCriticalNameConstraints(plain.certPem), false);
  assert.equal(new crypto.X509Certificate(plain.certPem).ca, true);
});

// Card glmps-2-0-152: the client-issuing CA signs a tap certificate over a
// public key the tap generated; the server never sees the private key.
test('issueClientCert binds the tap public key to the client id, for clientAuth only', () => {
  const caPair = createCa({ cn: 'GLMPS Client CA', days: 3650, now: NOW, permitted: null });
  const tapKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = tapKey.publicKey.export({ type: 'spki', format: 'pem' });
  const out = issueClientCert({ caCertPem: caPair.certPem, caKeyPem: caPair.keyPem, publicKeyPem, clientId: 'cli_0123abcd', now: NOW });
  const leaf = new crypto.X509Certificate(out.certPem);
  assert.equal(leaf.ca, false);
  assert.equal(leaf.checkIssued(new crypto.X509Certificate(caPair.certPem)), true);
  assert.equal(leaf.verify(new crypto.X509Certificate(caPair.certPem).publicKey), true);
  assert.match(leaf.subject, /CN=cli_0123abcd/);
  assert.match(leaf.subjectAltName, /URI:urn:glmps:client:cli_0123abcd/);
  assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.2']);
  assert.equal(leaf.publicKey.export({ type: 'spki', format: 'pem' }), publicKeyPem);
  const days = Math.round((Date.parse(leaf.validTo) - NOW.getTime()) / 86400000);
  assert.equal(days, 397);
  assert.equal(out.notAfter, Date.parse(leaf.validTo));
  assert.equal(out.fingerprint256, certFingerprint(out.certPem));
  assert.match(out.fingerprint256, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => tls.createSecureContext({ cert: out.certPem, key: tapKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
});

test('issueClientCert refuses a malformed key or client id', () => {
  const caPair = createCa({ cn: 'C', days: 30, now: NOW, permitted: null });
  const good = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => issueClientCert({ caCertPem: caPair.certPem, caKeyPem: caPair.keyPem, publicKeyPem: 'nope', clientId: 'cli_x' }), /public key/);
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => issueClientCert({ caCertPem: caPair.certPem, caKeyPem: caPair.keyPem, publicKeyPem: weak, clientId: 'cli_x' }), /public key/);
  assert.throws(() => issueClientCert({ caCertPem: caPair.certPem, caKeyPem: caPair.keyPem, publicKeyPem: good, clientId: 'bad id' }), /client id/);
});

test('certFingerprint matches the SHA-256 Node reports, in lowercase hex', () => {
  const { certPem } = createCa({ cn: 'F', days: 1, now: NOW });
  assert.equal(certFingerprint(certPem), new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase());
});

test('the home CA also permits IPv6 ULA, and a server cert can carry an IPv6 SAN', async () => {
  const caPair = createCa({ cn: 'GLMPS Test CA', days: 3650, now: NOW });
  const leaf = issueServerCert({ caCertPem: caPair.certPem, caKeyPem: caPair.keyPem, ips: ['fd12:3456:789a::5'], dnsNames: [], days: 30, now: NOW });
  assert.equal(new crypto.X509Certificate(leaf.certPem).checkIP('fd12:3456:789a::5'), 'fd12:3456:789a::5');
  assert.deepEqual(await handshake(caPair.certPem, leaf), { authorized: true, error: null });
  const outside = issueServerCert({ caCertPem: caPair.certPem, caKeyPem: caPair.keyPem, ips: ['2001:db8::1'], dnsNames: [], days: 30, now: NOW });
  assert.equal((await handshake(caPair.certPem, outside)).authorized, false);
});
