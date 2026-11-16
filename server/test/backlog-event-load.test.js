// Card glmps-2-0-runtime-65, AC-1: with a ~4.5 MB board and three writers
// posting devlogs, /api/health stays fast and a board change event no longer
// makes the web client pull the whole board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.js';
import { createBoardDelta } from '../../web/orchestration/board-delta.js';
import { waitFor } from './helpers/wait-for.js';
import { bigBoard } from './helpers/big-board.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv(board) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-load-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog', 'store.json'), JSON.stringify(board));
  return {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: stateDir,
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
  };
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, agent, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)];

test('AC-1: health stays under 200 ms p95 on a 4.5 MB board under 3 writers; events fetch no full board', { timeout: 120000 }, async () => {
  const board = bigBoard(1500, 3000);
  const size = Buffer.byteLength(JSON.stringify(board));
  assert.ok(size > 4_000_000 && size < 5_500_000, `fixture is ${size} bytes`);
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv(board) });
  try {
    const port = srv.port;
    let fullFetches = 0; let idFetches = 0; let events = 0;
    const dashboards = [0, 1, 2].map(() => createBoardDelta({
      waitMs: 50,
      fetchFull: async () => { fullFetches++; return JSON.parse((await req(port, 'GET', '/api/backlog')).text); },
      fetchIds: async (ids) => { idFetches++; return JSON.parse((await req(port, 'GET', `/api/backlog?ids=${ids.join(',')}`)).text); },
      paint: () => {},
    }));
    // Each dashboard starts with its one full load, as the real page does.
    for (const d of dashboards) d.seed(JSON.parse((await req(port, 'GET', '/api/backlog')).text));
    fullFetches = 0;

    const sse = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith('data: ')) continue;
          const p = JSON.parse(chunk.slice(6));
          if (p.type === 'backlog') { assert.ok(p.epoch, 'events carry the boot epoch'); events++; for (const d of dashboards) d.onEvent(p); }
        }
      });
    });

    const lat = [];
    let stop = false;
    const prober = (async () => {
      // At least 40 samples, so the p95 is not just the slowest one.
      while (!stop || lat.length < 40) {
        const t0 = performance.now();
        const r = await req(port, 'GET', '/api/health');
        assert.equal(r.status, 200);
        lat.push(performance.now() - t0);
        await new Promise((r2) => setImmediate(r2));
      }
    })();

    // 36 devlogs a writer, not 12: at ~16 probes a p95 is just the slowest
    // sample, so one stall on a loaded box failed the batched suite.
    const writer = async (w) => {
      for (let n = 0; n < 36; n++) {
        const r = await req(port, 'POST', `/api/backlog/glmps-${w * 100 + n + 1}/devlog`, { by: 'agent', text: `w${w} n${n}` });
        assert.equal(r.status, 200, r.text);
      }
    };
    const t0 = performance.now();
    await Promise.all([writer(1), writer(2), writer(3)]);
    await waitFor(() => events >= 108, { message: 'every board event' });
    for (const d of dashboards) await d.flush();
    const wall = performance.now() - t0;
    stop = true; await prober; sse.destroy();

    const counts = JSON.parse((await req(port, 'GET', '/api/backlog?counts=1')).text);
    assert.equal(counts.counts.queued, 300);
    console.log(`[AC-1] board ${(size / 1e6).toFixed(2)} MB, 3 writers x 36 devlogs, ${events} events, wall ${wall.toFixed(0)} ms`);
    console.log(`[AC-1] health n=${lat.length} p50=${[...lat].sort((a, b) => a - b)[lat.length >> 1].toFixed(1)} ms p95=${p95(lat).toFixed(1)} ms max=${Math.max(...lat).toFixed(1)} ms`);
    console.log(`[AC-1] per dashboard x3: full-board fetches after load=${fullFetches}, card fetches=${idFetches}`);
    assert.ok(events > 0);
    assert.equal(fullFetches, 0, 'a board change event must not trigger a full-board fetch');
    assert.ok(idFetches > 0);
    assert.ok(p95(lat) < 200, `health p95 ${p95(lat)}`);
  } finally { await srv.close(); }
});

test('GET /api/backlog shares one serialization between readers and answers counts cheaply', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv(bigBoard(1500, 3000)) });
  try {
    await req(srv.port, 'GET', '/api/backlog');
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) await req(srv.port, 'GET', '/api/backlog');
    const warm = (performance.now() - t0) / 10;
    const t1 = performance.now();
    for (let i = 0; i < 10; i++) await req(srv.port, 'GET', '/api/backlog?counts=1');
    const counts = (performance.now() - t1) / 10;
    console.log(`[AC-1] warm full board ${warm.toFixed(1)} ms/req, counts ${counts.toFixed(1)} ms/req`);
    assert.ok(counts < 50, `counts ${counts}`);
  } finally { await srv.close(); }
});
