/**
 * @fileoverview Fire-and-forget notification that a session ended, so the
 * dashboard server can enqueue it for memory distillation
 * (POST /api/memory/distill). Used by the Stop-hook feeder
 * (hooks/capability-feed.js), which runs on every Claude Code session Stop
 * on this machine and must never be slowed down or broken by this call.
 * Fails open: a down server, DNS/connection error, or timeout all resolve
 * normally - this never throws or rejects.
 * Zero deps, Node 18+ ESM.
 */
import http from 'node:http';

/**
 * @param {string} sessionId
 * @param {string} transcriptPath
 * @param {string} cwd
 * @param {{host?: string, port?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<void>} always resolves; never rejects
 */
export function pingMemoryDistill(sessionId, transcriptPath, cwd, { host = '127.0.0.1', port = Number(process.env.GLMPS_PORT || 8123), timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const data = JSON.stringify({ sessionId, transcriptPath, cwd });
      const req = http.request({
        host, port, path: '/api/memory/distill', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      }, (res) => {
        res.resume();
        res.on('end', done);
        res.on('error', done);
      });
      req.on('timeout', () => { req.destroy(); done(); });
      req.on('error', done);
      req.write(data);
      req.end();
    } catch {
      done();
    }
  });
}
