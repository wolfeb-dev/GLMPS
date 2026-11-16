// Where a URL may open. Origins are compared with the WHATWG URL parser, never
// with string prefixes (security checklist item 13: a startsWith test lets
// https://app.slack.com.attacker.test through).
export const SLACK_HOME = 'https://app.slack.com/client';
const MAX_EXTERNAL_URL = 2081; // shell.openExternal limit on Windows (electron-44.4.5/api/shell.md)

export function isSlackHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  return h === 'slack.com' || h.endsWith('.slack.com');
}

function parse(url) {
  try { return new URL(url); } catch { return null; }
}

// Shared by permissions.js (the media/display-capture grant) and
// screen-share.js (the display-media request handler): a slack-role session
// can still host a cross-origin frame, so the grant is scoped to the actual
// requesting origin, never the partition alone.
export function isSlackOrigin(origin) {
  const u = parse(origin);
  return Boolean(u) && u.protocol === 'https:' && isSlackHost(u.hostname);
}

export function classifyUrl({ role, url, kernelOrigin }) {
  const u = parse(url);
  if (!u) return 'block';
  const web = u.protocol === 'https:' || u.protocol === 'http:';
  const toKernel = web && u.origin === kernelOrigin;
  const toSlack = u.protocol === 'https:' && isSlackHost(u.hostname);
  if (role === 'dashboard') {
    if (toKernel) return 'internal';
    if (toSlack) return 'to-slack';
  } else if (role === 'slack') {
    if (toSlack) return 'internal';
    if (toKernel) return 'to-dashboard';
  } else {
    return 'block';
  }
  if (web || u.protocol === 'mailto:') return 'external';
  return 'block';
}

export function externalUrl(url) {
  const u = parse(url);
  if (!u || !['https:', 'http:', 'mailto:'].includes(u.protocol)) return null;
  if (u.username || u.password) return null;
  // the parser leaves a mailto path's `"`, whitespace, `<`, `>`
  // and backtick raw, and the Windows mail handler receives the href on a
  // command line (argument splitting). Refused rather than re-encoded.
  if (u.protocol === 'mailto:' && /["\s<>`]/.test(u.href)) return null;
  return u.href.length <= MAX_EXTERNAL_URL ? u.href : null;
}
