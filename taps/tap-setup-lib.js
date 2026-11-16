// taps/tap-setup-lib.js
// The installer's pure parts (server-and-client-tap task 7): arguments, the
// pairing code and name, the pair request, and who holds the tap port.
import { TAP_PROTOCOL, TAP_PROTOCOL_HEADER } from '../server/lib/kernel/tap-protocol.js';
import { serverUrlFromInstaller } from '../server/lib/kernel/tap-installer-name.js';
import { DEFAULT_PORT, serverUrlPolicy } from './tap-agent-lib.js';

export const PAIR_PATH = '/api/tap/pair';
const CODE_ALPHABET = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/;
const FLAGS_WITH_VALUE = new Set(['--installer', '--server', '--code', '--fingerprint', '--name', '--port', '--source']);
const BARE_FLAGS = new Set(['--uninstall', '--no-start']);

/** {ok:true, opts} or {ok:false, reason}. Unknown flags refuse, as scripts/install.mjs does. */
export function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BARE_FLAGS.has(a)) { opts[a === '--uninstall' ? 'uninstall' : 'noStart'] = true; continue; }
    if (!FLAGS_WITH_VALUE.has(a)) return { ok: false, reason: `unknown flag '${a}'; known flags are ${[...FLAGS_WITH_VALUE, ...BARE_FLAGS].join(', ')}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { ok: false, reason: `${a} needs a value` };
    opts[a.slice(2)] = v;
  }
  if (typeof opts.port === 'string') {
    if (!/^\d{1,5}$/.test(opts.port) || Number(opts.port) < 1 || Number(opts.port) > 65535) return { ok: false, reason: `--port must be 1 to 65535, got ${opts.port}` };
    opts.port = Number(opts.port);
  }
  return { ok: true, opts };
}

/** The server to pair with: --server wins, else the installer's own filename. */
export function resolveServer({ server, installer }) {
  if (server) {
    let u;
    try { u = new URL(server); } catch { return { ok: false, reason: `--server ${server} is not a URL` }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `--server must be http or https, got ${u.protocol}` };
    const p = serverUrlPolicy(u);
    if (!p.ok) return { ok: false, reason: `--server ${server}: ${p.reason}` };
    return { ok: true, server: `${u.protocol}//${u.host}` };
  }
  if (!installer) return { ok: false, reason: 'no server: run the downloaded installer, or pass --server' };
  const r = serverUrlFromInstaller(installer);
  if (!r.ok) return r;
  const p = serverUrlPolicy(new URL(r.server));
  return p.ok ? r : { ok: false, reason: `the installer names ${r.server}: ${p.reason}. Download it from the dashboard at its private address, or pass --server` };
}

/** The code as the server will read it, or null when it cannot be one. */
export function normalizeCode(input) {
  const c = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return CODE_ALPHABET.test(c) ? c : null;
}

export function normalizeName(input, fallback) {
  const n = String(input ?? '').trim() || String(fallback ?? '').trim();
  if (!n || n.length > 64 || /[\u0000-\u001f]/.test(n)) return null;
  return n;
}

// publicKey is the tap's SPKI PEM; its private half never leaves this machine.
export function pairRequest({ server, code, name, tapVersion, publicKey }) {
  return {
    url: `${server}${PAIR_PATH}`,
    method: 'POST',
    headers: { 'content-type': 'application/json', [TAP_PROTOCOL_HEADER]: String(TAP_PROTOCOL) },
    body: JSON.stringify({ code, name, tapVersion, publicKey }),
  };
}

export function pairRefusalText(status, body) {
  const why = body?.error || `HTTP ${status}`;
  if (status === 401) return `the server refused the pairing code (${why}); mint a new code in the dashboard's Settings menu`;
  if (status === 429) return `too many wrong codes from this address (${why}); wait a minute and try again`;
  if (status === 400) return `the server refused the pairing request (${why}); this installer may be older than the server, so download it again from the dashboard`;
  return `pairing failed: ${why}`;
}

// `netstat -ano -p TCP` rows: "  TCP    127.0.0.1:8123   0.0.0.0:0   LISTENING   1234".
// Any local address counts: a wildcard listener also takes 127.0.0.1:<port>.
export function listeningPid(netstatText, port) {
  for (const line of String(netstatText ?? '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^TCP/i.test(f[0]) || f[3].toUpperCase() !== 'LISTENING') continue;
    const local = f[1];
    if (Number(local.slice(local.lastIndexOf(':') + 1)) === port) return Number(f[4]);
  }
  return null;
}

// `tasklist /FI "PID eq N" /FO CSV /NH`: "node.exe","1234","Services","0","50,000 K".
export function imageFromTasklist(text) {
  const m = /^"([^"]+)","(\d+)"/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** May setup take the port? Our own agent already on it is a reinstall, not a clash. */
export function portDecision({ port, pid, image, agentStatus }) {
  if (pid == null) return { ok: true, ownAgent: false };
  if (agentStatus?.agent === 'glmps-tap') return { ok: true, ownAgent: true };
  const who = image ? `${image} (pid ${pid})` : `pid ${pid}`;
  return { ok: false, reason: `port ${port} is already in use by ${who}; the tap agent must listen there. Stop that program, or install with --port <other> if this machine runs its own GLMPS kernel` };
}
