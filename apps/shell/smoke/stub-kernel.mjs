// apps/shell/smoke/stub-kernel.mjs
// A stand-in kernel: GET /healthz (K1 body shape) and a stub dashboard page
// with one external link. Down means down at the socket: the kernel port stops
// listening, so a connect is refused exactly as with a stopped service. While
// it listened and only dropped requests, the supervisor's isKernelAlive (a TCP
// accept) read it as a live but hung kernel and never asked sc.exe to start
// it, so the not-installed phase could never happen.
//
// The probe drives the stub from a separate control port (controlUrl), since
// the kernel port is not there to receive requests while down:
// /__stub/up|down flips it, /__stub/hang-page|resume-page keeps the dashboard
// page request pending indefinitely, and /__stub/hung-count reports how many
// such requests are currently parked, so a check can wait for the real page
// request to have actually reached the server (and be genuinely stuck) before
// flipping the kernel down again - without that wait, a fast local request
// can lose the race to the very next /__stub/down and get its connection
// refused or destroyed instead (a real, different failure, not the hang this
// is meant to exercise).
import http from 'node:http';

const PAGE = '<!doctype html><meta charset="utf-8"><title>stub dashboard</title>'
  + '<a id="ext" href="https://example.com/outside" target="_blank" rel="noopener">outside</a>';

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});

export async function startStubKernel({ healthy: startHealthy = true } = {}) {
  let healthy = true;
  let hangPage = false;
  let hungCount = 0;
  let current = null;
  const servers = [];
  const handler = (req, res) => {
    // A keep-alive socket opened while up can still deliver a request after
    // the listener closed; it gets the same treatment as a refused connect.
    if (!healthy) { req.socket.destroy(); return; }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'up', version: '0.0.0+stub', uptime_s: 1, open_obligations: 2, last_event_ts: Date.now() - 90_000, loops: {} }));
      return;
    }
    if (hangPage) { hungCount += 1; return; } // never respond: closeAllConnections() at teardown reclaims it
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  };
  // A fresh server per up period: close() on the old one only stops new
  // connects, so a request parked on it stays parked across the flap.
  async function goUp(port) {
    const next = http.createServer(handler);
    servers.push(next);
    await listen(next, port);
    current = next;
  }
  function goDown() {
    current?.close();
    current?.closeIdleConnections();
    current = null;
  }
  await goUp(0);
  const port = current.address().port;
  async function setHealthy(v) {
    if (v === healthy) return;
    // Healthy only once the port is bound again (it can be EADDRINUSE on
    // Windows), so a failed up leaves the stub down and a retry re-binds.
    if (v) await goUp(port); else goDown();
    healthy = v;
  }
  await setHealthy(startHealthy);

  const control = http.createServer(async (req, res) => {
    if (req.url === '/__stub/up' || req.url === '/__stub/down') {
      try { await setHealthy(req.url === '/__stub/up'); } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`stub kernel: ${e?.message || e}`); return;
      }
      res.writeHead(204); res.end(); return;
    }
    if (req.url === '/__stub/hang-page' || req.url === '/__stub/resume-page') {
      hangPage = req.url === '/__stub/hang-page';
      if (!hangPage) hungCount = 0; // resumed: any still-parked requests are abandoned, not tracked
      res.writeHead(204); res.end(); return;
    }
    if (req.url === '/__stub/hung-count') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ count: hungCount })); return;
    }
    res.writeHead(404); res.end();
  });
  await listen(control, 0);
  return {
    url: `http://127.0.0.1:${port}`,
    controlUrl: `http://127.0.0.1:${control.address().port}`,
    setHealthy,
    close: () => Promise.all([...servers, control].map((s) => new Promise((resolve) => {
      s.closeAllConnections();
      if (s.listening) s.close(() => resolve()); else resolve();
    }))),
  };
}
