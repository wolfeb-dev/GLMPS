import net from 'node:net';

// The supervision loop's checker: GET <kernel>/healthz (K1). Every failure is
// returned as a named reason; nothing is thrown or swallowed.
export async function checkHealth({ kernelUrl, fetchImpl = fetch, timeoutMs = 2000 }) {
  const url = new URL('/healthz', kernelUrl).href;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
  if (res.status !== 200) return { ok: false, reason: `http-${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { ok: false, reason: 'bad-body' }; }
  if (!body || (body.status !== 'up' && body.status !== 'degraded')) return { ok: false, reason: 'bad-body' };
  return { ok: true, body };
}

// Who holds the kernel's port when it answers HTTP but not as a kernel (card
// glmps-2-0-214): 'tap' for the GLMPS Tap agent, which says so on its own
// status route, else 'other'.
export async function identifyPortHolder({ kernelUrl, fetchImpl = fetch, timeoutMs = 2000 }) {
  try {
    const res = await fetchImpl(new URL('/tap/status', kernelUrl).href, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return 'other';
    const body = await res.json();
    return body?.agent === 'glmps-tap' ? 'tap' : 'other';
  } catch {
    return 'other';
  }
}

// True when something accepts a TCP connection at the kernel's address. The
// supervisor uses it to tell a slow kernel (never restart it) from a gone one.
export function tcpAccepts({ kernelUrl, timeoutMs = 1000, connect = net.connect }) {
  const u = new URL(kernelUrl);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve) => {
    const sock = connect({ host: u.hostname, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
