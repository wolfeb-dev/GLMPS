// Card glmps-2-0-152: the two CA roles (spec 2026-11-10-glmps-2-0-171) and
// the TLS options the private listener is built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tlsPaths, tlsConfigured, ensureClientCa, ensureHomeServerTls, loadServerTls } from '../lib/kernel/tls-material.js';
import { createCa, issueServerCert, hasCriticalNameConstraints, certFingerprint } from '../lib/kernel/x509-lite.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tlsmat-'));

test('tlsConfigured: home, or provided with a certificate and key; anything else is not configured', () => {
  assert.equal(tlsConfigured({ source: 'home' }), true);
  assert.equal(tlsConfigured({ source: 'provided', certFile: 'a', keyFile: 'b' }), true);
  for (const t of [undefined, null, {}, { source: 'provided' }, { source: 'provided', certFile: 'a' }, { source: 'tailscale' }, 'home']) {
    assert.equal(tlsConfigured(t), false, JSON.stringify(t));
  }
});

test('ensureClientCa creates one GLMPS-only CA once, key readable only by its owner', () => {
  const dir = tmp();
  try {
    const a = ensureClientCa(dir);
    assert.equal(a.created, true);
    const b = ensureClientCa(dir);
    assert.equal(b.created, false);
    assert.equal(b.certPem, a.certPem);
    const p = tlsPaths(dir);
    assert.ok(fs.existsSync(p.clientCaKey));
    assert.equal(new crypto.X509Certificate(a.certPem).ca, true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(p.clientCaKey).mode & 0o077, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ensureHomeServerTls makes a name-constrained home CA and a server cert for the private address, and reissues when the address changes', () => {
  const dir = tmp();
  try {
    const a = ensureHomeServerTls({ stateDir: dir, ips: ['192.168.1.50'] });
    assert.deepEqual([a.caCreated, a.serverIssued], [true, true]);
    const p = tlsPaths(dir);
    assert.equal(hasCriticalNameConstraints(fs.readFileSync(p.homeCaCert, 'utf8')), true);
    assert.equal(new crypto.X509Certificate(fs.readFileSync(p.serverCert, 'utf8')).checkIP('192.168.1.50'), '192.168.1.50');
    const again = ensureHomeServerTls({ stateDir: dir, ips: ['192.168.1.50'] });
    assert.deepEqual([again.caCreated, again.serverIssued], [false, false]);
    const moved = ensureHomeServerTls({ stateDir: dir, ips: ['192.168.1.77'] });
    assert.deepEqual([moved.caCreated, moved.serverIssued], [false, true]);
    assert.equal(new crypto.X509Certificate(fs.readFileSync(p.serverCert, 'utf8')).checkIP('192.168.1.77'), '192.168.1.77');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ensureHomeServerTls refuses an unconstrained CA already in place', () => {
  const dir = tmp();
  try {
    const p = tlsPaths(dir);
    fs.mkdirSync(p.dir, { recursive: true });
    const plain = createCa({ cn: 'old', days: 30, permitted: null });
    fs.writeFileSync(p.homeCaCert, plain.certPem);
    fs.writeFileSync(p.homeCaKey, plain.keyPem);
    assert.throws(() => ensureHomeServerTls({ stateDir: dir, ips: ['10.0.0.5'] }), /no name constraints/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadServerTls (home): leaf plus home CA as the chain, the client CA as the trust for client certs, the home CA as the pinned anchor', () => {
  const dir = tmp();
  try {
    ensureHomeServerTls({ stateDir: dir, ips: ['10.0.0.5'] });
    const t = loadServerTls({ tls: { source: 'home' }, stateDir: dir });
    const p = tlsPaths(dir);
    const homeCa = fs.readFileSync(p.homeCaCert, 'utf8');
    assert.ok(t.cert.startsWith(fs.readFileSync(p.serverCert, 'utf8')));
    assert.ok(t.cert.endsWith(homeCa));
    assert.equal(t.ca, fs.readFileSync(p.clientCaCert, 'utf8'));
    assert.equal(t.trustFingerprint, certFingerprint(homeCa));
    assert.ok(Number.isFinite(t.serverNotAfter));
    assert.ok(t.key.includes('PRIVATE KEY'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadServerTls (provided): enterprise files, the chain root is the pinned anchor; a missing file is a named refusal', () => {
  const dir = tmp();
  try {
    const root = createCa({ cn: 'Corp Root', days: 3650, permitted: null });
    const leaf = issueServerCert({ caCertPem: root.certPem, caKeyPem: root.keyPem, ips: ['10.20.30.40'], dnsNames: [], days: 365 });
    const f = (n, c) => { const x = path.join(dir, n); fs.writeFileSync(x, c); return x; };
    const tls = { source: 'provided', certFile: f('srv.pem', leaf.certPem), keyFile: f('srv.key', leaf.keyPem), chainFile: f('chain.pem', root.certPem) };
    const t = loadServerTls({ tls, stateDir: dir });
    assert.equal(t.cert, leaf.certPem + root.certPem);
    assert.equal(t.trustFingerprint, certFingerprint(root.certPem));
    assert.throws(() => loadServerTls({ tls: { ...tls, keyFile: path.join(dir, 'nope.key') }, stateDir: dir }), /TLS key file/);
    assert.throws(() => loadServerTls({ tls: { source: 'home' }, stateDir: tmp() }), /home server certificate/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadServerTls reports whether the server certificate still covers the bind host (card glmps-2-0-177)', () => {
  const dir = tmp();
  try {
    ensureHomeServerTls({ stateDir: dir, ips: ['10.0.0.5'] });
    assert.equal(loadServerTls({ tls: { source: 'home' }, stateDir: dir, host: '10.0.0.5' }).serverHostCovered, true);
    assert.equal(loadServerTls({ tls: { source: 'home' }, stateDir: dir, host: '10.0.0.9' }).serverHostCovered, false, 'a DHCP address change leaves the certificate naming the old address');
    assert.equal(loadServerTls({ tls: { source: 'home' }, stateDir: dir }).serverHostCovered, null, 'no host given, nothing to check');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
