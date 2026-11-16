// taps/tap-agent-lib.js
// The tap agent's pure parts: where its home is, its config file, the
// heartbeat request, which editors are installed, and the status it reports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TAP_PROTOCOL, TAP_PROTOCOL_HEADER } from '../server/lib/kernel/tap-protocol.js';
import { isPrivateAddress } from '../server/lib/governance/access-guard.js';

// The relay's port (task 12): hooks and agents on a client keep calling 127.0.0.1:8123.
export const DEFAULT_PORT = 8123;
export const HEARTBEAT_PATH = '/api/tap/heartbeat';

export function tapHome(env = process.env, homeDir = os.homedir()) {
  if (env.GLMPS_TAP_HOME) return env.GLMPS_TAP_HOME;
  return path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'GLMPS', 'tap');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const INTERNAL_NAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*glmps\.internal$/;

/**
 * Scan F7 and card glmps-2-0-152: the tap sends its token on every request,
 * so plain http is allowed only on loopback, and https only to this network
 * (a private address literal or a glmps.internal name), never off it.
 */
export function serverUrlPolicy(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(host)) return { ok: true };
    return { ok: false, reason: `plain http to ${url.hostname} would send the client token in cleartext; use https to the server's private address, or loopback` };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: `the server must be http or https, got ${url.protocol}` };
  if (LOOPBACK_HOSTS.has(host) || isPrivateAddress(host) || INTERNAL_NAME_RE.test(host)) return { ok: true };
  return { ok: false, reason: `${url.hostname} is not on the local network; GLMPS is reached only at a private address (10/8, 172.16/12, 192.168/16, fc00::/7) or a glmps.internal name` };
}

const ABS_ROOT_RE = /^(?:[A-Za-z]:[\\/]|\/)/;
const cleanList = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());

// Project roots are what this client may be asked to open or edit: its config
// list, else GLMPS_PROJECT_ROOTS. Relative entries are dropped, never resolved.
export function readConfig(home, env = process.env) {
  let raw;
  try { raw = fs.readFileSync(path.join(home, 'tap-config.json'), 'utf8'); } catch { return { ok: false, reason: 'no-config' }; }
  let c;
  try { c = JSON.parse(raw); } catch { return { ok: false, reason: 'invalid-config' }; }
  const invalid = { ok: false, reason: 'invalid-config' };
  if (!c || typeof c !== 'object' || Array.isArray(c)) return invalid;
  const server = c.server;
  if (typeof server !== 'string' || !server) return invalid;
  const port = c.port ?? DEFAULT_PORT;
  let url;
  try { url = new URL(server); } catch { return invalid; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalid;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return invalid;
  // A server URL on this machine at the agent's own port would heartbeat the agent itself.
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (local && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port) return invalid;
  if (typeof c.clientId !== 'string' || !c.clientId) return invalid;
  if (typeof c.name !== 'string' || !c.name) return invalid;
  if (!serverUrlPolicy(url).ok) return { ok: false, reason: 'insecure-server' };
  const rootsRaw = Array.isArray(c.projectRoots) ? cleanList(c.projectRoots) : String(env.GLMPS_PROJECT_ROOTS ?? '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  const editorArgs = Array.isArray(c.editorArgs) && c.editorArgs.every((a) => typeof a === 'string') ? c.editorArgs : ['-g', '{path}'];
  return { ok: true, config: {
    server: String(server).replace(/\/+$/, ''), clientId: c.clientId, name: c.name, port,
    projectRoots: rootsRaw.filter((r) => ABS_ROOT_RE.test(r)).slice(0, 64),
    editorCommand: typeof c.editorCommand === 'string' && c.editorCommand ? c.editorCommand : 'antigravity', editorArgs,
  } };
}

// The client id is deliberately not in the body: the server resolves it from the token.
export function heartbeatRequest({ config, token, tapVersion, spoolDepth, dataRoots, tools, projectRoots }) {
  return {
    url: `${config.server}${HEARTBEAT_PATH}`,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, [TAP_PROTOCOL_HEADER]: String(TAP_PROTOCOL) },
    body: JSON.stringify({ tapVersion, spoolDepth, dataRoots, tools, projectRoots }),
  };
}

// Detect-only (spec row 8): a directory's existence, nothing read from inside it.
const TOOL_DIRS = {
  aider: ['.aider'],
  continue: ['.continue'],
  cursor: ['.cursor'],
  windsurf: ['.codeium/windsurf', '.windsurf'],
  zed: ['.config/zed', 'AppData/Roaming/Zed'],
};
export function detectTools(homeDir = os.homedir()) {
  const isDir = (rel) => { try { return fs.statSync(path.join(homeDir, ...rel.split('/'))).isDirectory(); } catch { return false; } };
  return Object.keys(TOOL_DIRS).filter((t) => TOOL_DIRS[t].some(isDir)).sort();
}

// The guard's named refusals for a client token without the matching certificate (card glmps-2-0-152).
const CERT_REFUSAL_RE = /^client-(certificate-|must-re-pair$)/;

export function classifyHeartbeat({ status, error, body = null }) {
  if (error) return { state: 'offline', reason: `server unreachable: ${error}` };
  if (status === 200) return { state: 'paired', reason: null };
  if (status === 401) {
    const why = typeof body?.error === 'string' ? body.error : null;
    if (why && CERT_REFUSAL_RE.test(why)) return { state: 'unpaired', certificate: 'refused', reason: `the server refused this client's certificate (${why}); pair this client again from the dashboard (Pair again)` };
    return { state: 'unpaired', reason: `the server does not accept this token${why ? ` (${why})` : ''}; it may have been revoked, so pair this client again` };
  }
  if (status === 426) return { state: 'protocol-too-old', reason: 'the server requires a newer tap protocol' };
  return { state: 'offline', reason: `server answered ${status}` };
}

// No token field exists here on purpose.
export function statusDocument({ version, state, reason = null, config, lastHeartbeatTs = null, spoolDepth = 0, tools = [], spool = null, shipper = null, mirror = null, actions = null, git = null, certificate = null, now = Date.now() }) {
  return {
    ok: true, agent: 'glmps-tap', version, state, reason,
    server: config?.server ?? null, clientId: config?.clientId ?? null, name: config?.name ?? null,
    protocol: TAP_PROTOCOL, lastHeartbeatTs, spoolDepth, tools, spool, shipper, mirror, actions, git, certificate, now,
  };
}
