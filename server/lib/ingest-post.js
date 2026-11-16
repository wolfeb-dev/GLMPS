/**
 * @fileoverview Bounded, fail-open POST of a hook's store write to the server
 * (or, on a client, to the tap relay on the same loopback port). Shared by the
 * Stop and PostToolUse hooks that used to write the server's stores directly.
 * Never throws or rejects. Zero deps, Node 18+ ESM.
 */
import http from 'node:http';

/**
 * @param {string} route e.g. '/api/ingest/qa-trends'
 * @param {object} body
 * @param {{host?: string, port?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{sent: boolean, status?: number|null}>} sent:false only when
 *   the connection never opened (refused, DNS, connect timeout): the caller then
 *   falls back to the direct store write. Any answer, or a timeout after the
 *   connection opened, is sent:true because the server may have applied it.
 */
export function postIngest(route, body, { host = '127.0.0.1', port = Number(process.env.GLMPS_PORT || 8123), timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const data = JSON.stringify(body);
      if (typeof data !== 'string') return done({ sent: false });
      let connected = false;
      const req = http.request({
        host, port, path: route, method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        res.resume();
        res.on('end', () => done({ sent: true, status: res.statusCode }));
        res.on('error', () => done({ sent: true, status: res.statusCode }));
      });
      req.on('socket', (sock) => {
        if (!sock.connecting) { connected = true; return; }
        sock.once('connect', () => { connected = true; });
      });
      const timer = setTimeout(() => {
        done(connected ? { sent: true, status: null } : { sent: false });
        req.destroy();
      }, timeoutMs);
      timer.unref?.();
      req.on('error', () => done(connected ? { sent: true, status: null } : { sent: false }));
      req.on('close', () => clearTimeout(timer));
      req.end(data);
    } catch {
      done({ sent: false });
    }
  });
}
