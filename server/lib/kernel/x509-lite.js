// Zero-dependency X.509 issuer: private CAs, a server leaf and tap client leaves, ECDSA P-256.
// node:crypto has no certificate builder, so the DER is assembled by hand.
import crypto from 'node:crypto';
import net from 'node:net';

const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const octets = (b) => tlv(0x04, b);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitString = (b, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const ctx = (n, ...p) => tlv(0xa0 | n, ...p);

const oid = (dotted) => {
  const a = dotted.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const chunk = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};

const intFromBytes = (b) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);

const pad = (n) => String(n).padStart(2, '0');
function time(d) {
  const y = d.getUTCFullYear();
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  if (y >= 2050) return tlv(0x18, Buffer.from(`${y}${rest}`));
  return tlv(0x17, Buffer.from(`${pad(y % 100)}${rest}`));
}

const SIG_ALG = seq(oid('1.2.840.10045.4.3.2'));
const DAY = 86400000;

const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

// SubjectKeyIdentifier is the SHA-1 of the subjectPublicKey bits; for P-256 that is the trailing 65-byte point.
const keyId = (spki) => crypto.createHash('sha1').update(spki.subarray(spki.length - 65)).digest();

function serial() {
  const b = crypto.randomBytes(16);
  b[0] = (b[0] & 0x7f) | 0x01;
  return intFromBytes(b);
}

function sign(tbs, privateKey) {
  const sig = crypto.sign('sha256', tbs, privateKey);
  return seq(tbs, SIG_ALG, bitString(sig));
}

const toPem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

function buildTbs({ issuerCn, subjectCn, spki, now, days, extensions }) {
  return seq(
    ctx(0, intFromBytes(Buffer.from([2]))),
    serial(),
    SIG_ALG,
    name(issuerCn),
    seq(time(new Date(now.getTime() - DAY)), time(new Date(now.getTime() + days * DAY))),
    name(subjectCn),
    spki,
    ctx(3, seq(...extensions)),
  );
}

const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemKey = (k) => k.export({ type: 'pkcs8', format: 'pem' });

// The home CA may be trusted by browsers on the home network, so it may only
// vouch for it (card glmps-2-0-runtime-148): RFC1918 and IPv6 ULA addresses
// and the glmps.internal DNS subtree.
export const CA_PERMITTED = Object.freeze({
  ipv4: Object.freeze([['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0']]),
  ipv6: Object.freeze([['fc00::', 'fe00::']]),
  dns: Object.freeze(['glmps.internal']),
});
const quad = (s) => Buffer.from(s.split('.').map(Number));
// net.SocketAddress has no byte view, so expand '::' by hand.
function ipv6Bytes(addr) {
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) throw new Error(`not an IPv6 address: ${addr}`);
  return Buffer.from(groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 0xff]; }));
}
const ipBytes = (ip) => {
  if (net.isIPv4(ip)) return quad(ip);
  if (net.isIPv6(ip)) return ipv6Bytes(ip);
  throw new Error(`not an IP address: ${ip}`);
};
const nameConstraints = ({ ipv4 = [], ipv6 = [], dns = [] }) => seq(ctx(0,
  ...ipv4.map(([addr, mask]) => seq(tlv(0x87, quad(addr), quad(mask)))),
  ...ipv6.map(([addr, mask]) => seq(tlv(0x87, ipv6Bytes(addr), ipv6Bytes(mask)))),
  ...dns.map((d) => seq(tlv(0x82, Buffer.from(d, 'ascii')))),
));

// permitted: null builds an unconstrained CA, which setup refuses to reuse.
export function createCa({ cn, days, now = new Date(), permitted = CA_PERMITTED }) {
  const { privateKey, publicKey } = newKey();
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = buildTbs({
    issuerCn: cn, subjectCn: cn, spki, now, days,
    extensions: [
      ext('2.5.29.19', true, seq(bool(true))),
      ext('2.5.29.15', true, bitString(Buffer.from([0x06]), 1)),
      ext('2.5.29.14', false, octets(keyId(spki))),
      ...(permitted ? [ext('2.5.29.30', true, nameConstraints(permitted))] : []),
    ],
  });
  return { certPem: toPem(sign(tbs, privateKey)), keyPem: pemKey(privateKey) };
}

// node:crypto exposes no extension parser; an Extension is SEQUENCE { OID
// 2.5.29.30, BOOLEAN TRUE, ... }, so the DER prefix is exact.
const CRITICAL_NC = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e, 0x01, 0x01, 0xff]);
export function hasCriticalNameConstraints(certPem) {
  return new crypto.X509Certificate(certPem).raw.includes(CRITICAL_NC);
}

const commonName = (subject) => /^CN=(.*)$/m.exec(subject)?.[1];

export function issueServerCert({ caCertPem, caKeyPem, ips = [], dnsNames = [], days, now = new Date() }) {
  const ca = new crypto.X509Certificate(caCertPem);
  const caKey = crypto.createPrivateKey(caKeyPem);
  const { privateKey, publicKey } = newKey();
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const names = [
    ...dnsNames.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
    ...ips.map((ip) => tlv(0x87, ipBytes(ip))),
  ];
  if (!names.length) throw new Error('issueServerCert needs at least one IP or DNS name');
  const caSpki = ca.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = buildTbs({
    // An address as the CN reads as a DNS name to OpenSSL's CN constraint check
    // when the leaf has no DNS SAN, failing the CA's DNS subtree; clients match
    // on the SANs, so the CN is only a label.
    issuerCn: commonName(ca.subject), subjectCn: dnsNames[0] ?? 'GLMPS server', spki, now, days,
    extensions: [
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)),
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, seq(...names)),
      ext('2.5.29.14', false, octets(keyId(spki))),
      ext('2.5.29.35', false, seq(tlv(0x80, keyId(caSpki)))),
    ],
  });
  return { certPem: toPem(sign(tbs, caKey)), keyPem: pemKey(privateKey) };
}

/** Lowercase hex SHA-256 of a certificate's DER, the form pinned at pairing and stored per client. */
export const certFingerprint = (certPem) => new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();

export const CLIENT_CERT_DAYS = 397;
const CLIENT_ID_RE = /^cli_[A-Za-z0-9_-]{1,64}$/;

/** Is this a tap public key the client CA will sign (SPKI PEM, P-256 or RSA 2048+)? */
export function validTapPublicKey(publicKeyPem) {
  try { tapPublicKey(publicKeyPem); return true; } catch { return false; }
}

function tapPublicKey(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length > 8192) throw new TypeError('the tap public key is not a valid SPKI PEM');
  let key;
  try { key = crypto.createPublicKey(publicKeyPem); } catch { throw new TypeError('the tap public key is not a valid SPKI PEM'); }
  const t = key.asymmetricKeyType;
  const d = key.asymmetricKeyDetails ?? {};
  const ok = (t === 'ec' && d.namedCurve === 'prime256v1') || (t === 'rsa' && d.modulusLength >= 2048);
  if (!ok) throw new TypeError('the tap public key must be ECDSA P-256 or RSA of at least 2048 bits');
  return key.export({ type: 'spki', format: 'der' });
}

/**
 * A tap's client certificate: client id in the CN and a urn:glmps:client URI
 * SAN, clientAuth only, signed by the GLMPS client-issuing CA over the public
 * key the tap generated (no CSR: the pairing code already proves the request).
 */
export function issueClientCert({ caCertPem, caKeyPem, publicKeyPem, clientId, days = CLIENT_CERT_DAYS, now = new Date() }) {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) throw new TypeError(`not a client id: ${clientId}`);
  const spki = tapPublicKey(publicKeyPem);
  const ca = new crypto.X509Certificate(caCertPem);
  const caKey = crypto.createPrivateKey(caKeyPem);
  const caSpki = ca.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = buildTbs({
    issuerCn: commonName(ca.subject), subjectCn: clientId, spki, now, days,
    extensions: [
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)),
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.2'))),
      ext('2.5.29.17', false, seq(tlv(0x86, Buffer.from(`urn:glmps:client:${clientId}`, 'ascii')))),
      ext('2.5.29.14', false, octets(crypto.createHash('sha1').update(spki).digest())),
      ext('2.5.29.35', false, seq(tlv(0x80, keyId(caSpki)))),
    ],
  });
  const certPem = toPem(sign(tbs, caKey));
  return { certPem, notAfter: Date.parse(new crypto.X509Certificate(certPem).validTo), fingerprint256: certFingerprint(certPem) };
}
