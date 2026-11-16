// server/test/api-speed-phase1.test.js
// Card glmps-2-0-53 phase 1, P1: gzip on JSON, backlog counts without the
// list, and the card each session ran for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { startServer } from '../server.js';
import { writeJson, acceptsGzip } from '../lib/http-json.js';
import { buildSessionCardIndex, createSessionCardLookup, withCards } from '../lib/orchestration/session-cards.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv(items) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-speed-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog', 'store.json'), JSON.stringify({ items, seq: 0, seqs: {} }));
  return {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: stateDir,
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
  };
}

function rawGet(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const items = [
  { id: 'c-1', title: 'First card', state: 'held', runSession: { sessionId: 's-1' } },
  { id: 'c-2', title: 'Second card', state: 'held' },
  { id: 'c-3', title: 'Third card', state: 'queued' },
  { id: 'c-4', title: 'x'.repeat(4000), state: 'done' },
];

test('GET /api/backlog?counts=1 answers counts by state without the list; JSON over 1 KB is gzipped only when accepted', async () => {
  const srv = await startServer({ port: 0, pollMs: 1000, env: mkEnv(items) });
  try {
    const counts = await rawGet(srv.port, '/api/backlog?counts=1');
    const body = JSON.parse(counts.body.toString());
    assert.deepEqual(body, { counts: { held: 2, queued: 1, done: 1 } });

    const slim = JSON.parse((await rawGet(srv.port, '/api/backlog?fields=id,state')).body.toString());
    assert.deepEqual(slim.items.map((i) => Object.keys(i).sort()), [['id', 'state'], ['id', 'state'], ['id', 'state'], ['id', 'state']]);

    const plain = await rawGet(srv.port, '/api/backlog');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(plain.body.toString()).items.length, 4);

    const gz = await rawGet(srv.port, '/api/backlog', { 'accept-encoding': 'gzip, br' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'accept-encoding');
    assert.equal(JSON.parse(zlib.gunzipSync(gz.body).toString()).items.length, 4);
  } finally { await srv.close(); }
});

test('writeJson leaves small bodies uncompressed and honours accept-encoding', () => {
  const out = [];
  const res = { writeHead: (code, h) => out.push({ code, h }), end: (b) => out.push({ b }) };
  writeJson({ headers: { 'accept-encoding': 'gzip' } }, res, 200, { ok: true });
  assert.equal(out[0].h['content-encoding'], undefined);
  assert.equal(out[1].b, '{"ok":true}');
  assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'deflate, br' } }), false);
  assert.equal(acceptsGzip({ headers: {} }), false);
});

test('sessions carry the card they ran for; the store is re-read only when it changes', () => {
  const index = buildSessionCardIndex(items);
  assert.deepEqual(index.get('s-1'), { id: 'c-1', title: 'First card' });
  assert.equal(index.size, 1);
  const rows = withCards([{ id: 's-1', name: 'a' }, { id: 's-2' }], index);
  assert.deepEqual(rows[0].card, { id: 'c-1', title: 'First card' });
  assert.equal('card' in rows[1], false);

  let loads = 0; let mtime = 1;
  const lookup = createSessionCardLookup('/state', { load: () => { loads++; return { items }; }, stat: () => ({ mtimeMs: mtime, size: 10 }) });
  lookup(); lookup();
  assert.equal(loads, 1);
  mtime = 2; lookup();
  assert.equal(loads, 2);
});

test('a session card carries its gate verdict when the card has one (glmps-2-0-63)', () => {
  const index = buildSessionCardIndex([
    { id: 'c-1', title: 'Gated', runSession: { sessionId: 's-1' }, gate: { status: 'PASS', risk: 'P2' } },
    { id: 'c-2', title: 'No gate', runSession: { sessionId: 's-2' }, gate: null },
  ]);
  assert.deepEqual(index.get('s-1'), { id: 'c-1', title: 'Gated', gate: 'PASS' });
  assert.deepEqual(index.get('s-2'), { id: 'c-2', title: 'No gate' });
});
