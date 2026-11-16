// server/lib/kernel/tap-installer-name.js
// The tap installer carries the server URL in its filename (server-and-client-tap
// task 7), so the signed file stays byte-identical for every server and holds no
// secret. One module, used by the download route and bundled into the installer.
// Windows filenames cannot hold ':' or '/', so the URL is spelled
// glmps-tap-setup_<scheme>_<host>_<port>.exe.

export const INSTALLER_PREFIX = 'glmps-tap-setup';
// DNS names and IPv4 literals; '_' never appears in a hostname, so it can separate.
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

/** The installer filename for a server URL; throws on a URL it cannot spell. */
export function installerFileName(serverUrl) {
  const u = new URL(serverUrl);
  const scheme = u.protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https') throw new TypeError(`unsupported scheme ${scheme}`);
  if (!HOST_RE.test(u.hostname)) throw new TypeError(`host ${u.hostname} cannot be carried in a filename`);
  const port = Number(u.port || (scheme === 'https' ? 443 : 80));
  return `${INSTALLER_PREFIX}_${scheme}_${u.hostname}_${port}.exe`;
}

// A browser saving a second copy appends " (1)"; a copy can also gain " - Copy".
const NAME_RE = new RegExp(`^${INSTALLER_PREFIX}_(https?)_([A-Za-z0-9.-]+)_(\\d{1,5})(?: \\(\\d+\\)| - Copy(?: \\(\\d+\\))?)?\\.exe$`, 'i');

/** {ok:true, server} or {ok:false, reason} from an installer path or filename. */
export function serverUrlFromInstaller(fileOrPath) {
  const base = String(fileOrPath ?? '').split(/[\\/]/).pop();
  const m = NAME_RE.exec(base);
  if (!m) return { ok: false, reason: `the installer's filename (${base || 'none'}) does not name a server; download it again from the dashboard's Settings menu, or pass --server` };
  const [, scheme, host, portText] = m;
  const port = Number(portText);
  if (!HOST_RE.test(host) || !validPort(port)) return { ok: false, reason: `the installer's filename names an invalid server (${host}:${portText})` };
  return { ok: true, server: `${scheme.toLowerCase()}://${host.toLowerCase()}:${port}` };
}

/** The server URL a browser reached us at, from its Host header; null when unusable. */
export function serverUrlFromHost(hostHeader, { scheme = 'http' } = {}) {
  const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(String(hostHeader ?? ''));
  if (!m || !HOST_RE.test(m[1])) return null;
  const port = m[2] ? Number(m[2]) : (scheme === 'https' ? 443 : 80);
  if (!validPort(port)) return null;
  return `${scheme}://${m[1].toLowerCase()}:${port}`;
}
