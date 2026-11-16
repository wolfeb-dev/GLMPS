// Card glmps-2-0-152: a remote client reaches the kernel only over the private
// HTTPS listener with its client certificate. CI has no private interface, so
// the kernel is configured for a private address and its HTTPS listener binds
// the loopback alias 127.0.0.2 (startServer's listenHostOverride); a request
// sourced there takes the remote path, and the server certificate is still
// checked against the configured address.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { ensureHomeServerTls, ensureClientCa } from '../../lib/kernel/tls-material.js';
import { issueClientCert } from '../../lib/kernel/x509-lite.js';

export const PRIVATE_HOST = '192.168.50.10';
export const LISTEN_ALIAS = '127.0.0.2';

export function tapKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** The issuer the server builds: the state dir's client CA over the tap's public key. */
export function certIssuer(stateDir) {
  return ({ clientId, publicKeyPem }) => {
    const ca = ensureClientCa(stateDir);
    return issueClientCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, publicKeyPem, clientId });
  };
}

/**
 * Home TLS material in the state dir and a config.json for a private bind.
 * Returns what a remote caller needs: the home CA to trust and startServer's extra options.
 */
export function privateBind({ stateDir, configFile, config = {} }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const t = ensureHomeServerTls({ stateDir, ips: [PRIVATE_HOST] });
  fs.writeFileSync(configFile, JSON.stringify({ ...config, host: PRIVATE_HOST, tls: { source: 'home' } }));
  return { homeCaPem: fs.readFileSync(t.paths.homeCaCert, 'utf8'), trustFingerprint: t.caFingerprint, startOpts: { configFile, listenHostOverride: LISTEN_ALIAS } };
}

/** Pair a client straight in the store with a real certificate; returns its token, key and certificate. */
export function pairWithCert(store, stateDir, { name = 'laptop', actor = 'test', ...rest } = {}) {
  const keys = tapKeyPair();
  const issue = certIssuer(stateDir);
  const out = store.pair({ name, actor, ...rest, issueCert: (clientId) => issue({ clientId, publicKeyPem: keys.publicKeyPem }) });
  return { clientId: out.clientId, token: out.token, cert: out.certificate.certPem, key: keys.privateKeyPem, notAfter: out.certificate.notAfter };
}

/**
 * One HTTPS request to the private listener from the remote alias.
 * client: { cert, key } to present a client certificate (omit for none).
 */
export function remoteHttps(port, { method = 'GET', path: p, token, body, client, ca, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      host: `${PRIVATE_HOST}:${port}`, 'x-glmps-tap-protocol': '1',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
    };
    // A header passed as null is removed, so a test can send a request that lacks one of the defaults.
    for (const k of Object.keys(h)) if (h[k] == null) delete h[k];
    const req = https.request({
      // localAddress: without it the kernel would see 127.0.0.1 and take the loopback path.
      host: LISTEN_ALIAS, localAddress: LISTEN_ALIAS, port, method, path: p, headers: h, ca,
      ...(client ? { cert: client.cert, key: client.key } : {}),
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(PRIVATE_HOST, cert),
      agent: false,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: b, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
