// server/lib/kernel/tls-material.js
// The two CA roles of local-only remote access (spec
// docs/specs/2026-11-10-glmps-2-0-171-local-only-mtls.md, card glmps-2-0-152):
// server-trust (the certificate the private listener presents: GLMPS's own
// name-constrained home CA, or files from an enterprise PKI) and client-issuing
// (a GLMPS-only CA that signs tap certificates, trusted only by this server and
// never installed in any OS store). Shared by the server and the provisioning script.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createCa, issueServerCert, hasCriticalNameConstraints, certFingerprint } from './x509-lite.js';

const HOME_CA_DAYS = 3650;
const CLIENT_CA_DAYS = 3650;
// Browsers cap a leaf at 398 days; the home server cert stays under it.
const SERVER_CERT_DAYS = 397;

export function tlsPaths(stateDir) {
  const dir = path.join(stateDir, 'tls');
  return {
    dir,
    homeCaCert: path.join(dir, 'home-ca.pem'), homeCaKey: path.join(dir, 'home-ca.key'),
    serverCert: path.join(dir, 'server.pem'), serverKey: path.join(dir, 'server.key'),
    clientCaCert: path.join(dir, 'client-ca.pem'), clientCaKey: path.join(dir, 'client-ca.key'),
  };
}

/** Is a config.json `tls` block one the private listener can be built from? */
export function tlsConfigured(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.source === 'home') return true;
  return t.source === 'provided' && typeof t.certFile === 'string' && !!t.certFile && typeof t.keyFile === 'string' && !!t.keyFile;
}

const writeKey = (file, pem) => fs.writeFileSync(file, pem, { mode: 0o600 });

/** The client-issuing CA, created on first use. */
export function ensureClientCa(stateDir, { now = new Date() } = {}) {
  const p = tlsPaths(stateDir);
  if (fs.existsSync(p.clientCaCert) && fs.existsSync(p.clientCaKey)) {
    return { certPem: fs.readFileSync(p.clientCaCert, 'utf8'), keyPem: fs.readFileSync(p.clientCaKey, 'utf8'), created: false };
  }
  fs.mkdirSync(p.dir, { recursive: true });
  // Unconstrained on purpose: it signs client certificates, which name a client
  // id rather than a host, and only this server ever trusts it.
  const ca = createCa({ cn: 'GLMPS Client CA', days: CLIENT_CA_DAYS, now, permitted: null });
  writeKey(p.clientCaKey, ca.keyPem);
  fs.writeFileSync(p.clientCaCert, ca.certPem);
  return { ...ca, created: true };
}

const covers = (certPem, ips, dnsNames) => {
  try {
    const c = new crypto.X509Certificate(certPem);
    return ips.every((ip) => c.checkIP(ip) === ip) && dnsNames.every((d) => c.checkHost(d) === d);
  } catch { return false; }
};

/**
 * The home server-trust material: a name-constrained CA (an existing one is
 * reused only when constrained) and a server certificate covering the given
 * private addresses and names, reissued when they change.
 */
export function ensureHomeServerTls({ stateDir, ips = [], dnsNames = [], now = new Date() }) {
  const p = tlsPaths(stateDir);
  fs.mkdirSync(p.dir, { recursive: true });
  let caCreated = false;
  let ca;
  if (fs.existsSync(p.homeCaCert) && fs.existsSync(p.homeCaKey)) {
    ca = { certPem: fs.readFileSync(p.homeCaCert, 'utf8'), keyPem: fs.readFileSync(p.homeCaKey, 'utf8') };
    if (!hasCriticalNameConstraints(ca.certPem)) {
      throw new Error(`the home CA in ${p.dir} has no name constraints, so it could vouch for any site; move it aside and rerun`);
    }
  } else {
    ca = createCa({ cn: 'GLMPS Home CA', days: HOME_CA_DAYS, now });
    writeKey(p.homeCaKey, ca.keyPem);
    fs.writeFileSync(p.homeCaCert, ca.certPem);
    caCreated = true;
  }
  let serverIssued = false;
  const current = fs.existsSync(p.serverCert) && fs.existsSync(p.serverKey) ? fs.readFileSync(p.serverCert, 'utf8') : null;
  const chainsToCa = current && (() => { try { return new crypto.X509Certificate(current).checkIssued(new crypto.X509Certificate(ca.certPem)); } catch { return false; } })();
  if (caCreated || !current || !chainsToCa || !covers(current, ips, dnsNames)) {
    const leaf = issueServerCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, ips, dnsNames, days: SERVER_CERT_DAYS, now });
    writeKey(p.serverKey, leaf.keyPem);
    fs.writeFileSync(p.serverCert, leaf.certPem);
    serverIssued = true;
  }
  return { caCreated, serverIssued, caFingerprint: certFingerprint(ca.certPem), paths: p };
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/g;
function readOrRefuse(file, what) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`${what} ${file} cannot be read (${e?.code ?? e?.message ?? e})`); }
}

/**
 * The private listener's TLS options plus what the expiry loop and the pairing
 * screen need: the server leaf's expiry and the pinned trust anchor's fingerprint.
 */
export function loadServerTls({ tls, stateDir, host = null }) {
  if (!tlsConfigured(tls)) throw new Error('no TLS configuration: set "tls": { "source": "home" } or { "source": "provided", "certFile", "keyFile", "chainFile" } in config.json');
  const p = tlsPaths(stateDir);
  let leaf, key, chain;
  if (tls.source === 'home') {
    if (!fs.existsSync(p.serverCert) || !fs.existsSync(p.serverKey) || !fs.existsSync(p.homeCaCert)) {
      throw new Error(`the home server certificate is missing from ${p.dir}; run node scripts/provision-server-box.mjs --apply`);
    }
    leaf = fs.readFileSync(p.serverCert, 'utf8');
    key = fs.readFileSync(p.serverKey, 'utf8');
    chain = fs.readFileSync(p.homeCaCert, 'utf8');
  } else {
    leaf = readOrRefuse(tls.certFile, 'TLS certificate file');
    key = readOrRefuse(tls.keyFile, 'TLS key file');
    chain = tls.chainFile ? readOrRefuse(tls.chainFile, 'TLS chain file') : '';
  }
  const ensureNl = (s) => (s && !s.endsWith('\n') ? `${s}\n` : s);
  const certs = [...`${ensureNl(leaf)}${ensureNl(chain)}`.matchAll(PEM_RE)].map((m) => m[0]);
  if (!certs.length) throw new Error('the TLS certificate file holds no PEM certificate');
  const leafCert = new crypto.X509Certificate(certs[0]);
  const anchor = certs[certs.length - 1];
  return {
    cert: ensureNl(leaf) + ensureNl(chain),
    key,
    ca: ensureClientCa(stateDir).certPem,
    serverNotAfter: Date.parse(leafCert.validTo),
    // A DHCP address change leaves the certificate naming the old address; the expiry loop alerts on false.
    serverHostCovered: host ? Boolean(net.isIP(host) ? leafCert.checkIP(host) : leafCert.checkHost(host)) : null,
    trustFingerprint: certFingerprint(anchor),
  };
}
