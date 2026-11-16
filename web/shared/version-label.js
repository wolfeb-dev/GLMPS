// The running version in the header, read from /healthz ("<package version>+<sha>").
// Text only via textContent; stays hidden when /healthz is unreachable.
const VERSION = /^(\d+\.\d+\.\d+)(?:\+([0-9a-f]{7,40}|unknown))?$/;

export function parseVersion(raw) {
  const m = VERSION.exec(String(raw ?? ''));
  if (!m) return null;
  return { version: m[1], sha: m[2] && m[2] !== 'unknown' ? m[2] : '' };
}

export async function mountVersion(el, fetchImpl = (u) => fetch(u)) {
  if (!el) return;
  try {
    const res = await fetchImpl('/healthz');
    if (!res?.ok) return;
    const v = parseVersion((await res.json())?.version);
    if (!v) return;
    el.textContent = `v${v.version}`;
    el.title = v.sha ? `commit ${v.sha}` : '';
    el.hidden = false;
  } catch { /* the label is optional */ }
}
