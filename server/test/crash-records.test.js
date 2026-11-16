// server/test/crash-records.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { kernelCrashAlerts } from '../lib/kernel/crash-records.js';
import { startServer } from '../server.js';

function writeRecord(stateDir, iso, extra = {}) {
  fs.mkdirSync(path.join(stateDir, 'crashes'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'crashes', `${iso.replace(/[:.]/g, '-')}.json`), JSON.stringify({
    detectedAt: iso, lastOkAt: '2026-10-03T06:51:00.000Z', lastExit: { code: 3, signal: null, kind: 'crashed' }, restart: { ok: true, pid: 1 }, ...extra }));
}

test('recent crash records become kernel-crash alerts naming the cause; old ones do not', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crashrec-'));
  try {
    const now = Date.parse('2026-10-13T12:00:00.000Z');
    writeRecord(stateDir, '2026-10-13T11:00:00.000Z');
    writeRecord(stateDir, '2026-10-01T11:00:00.000Z');
    const alerts = kernelCrashAlerts(stateDir, { now });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].source, 'kernel-crash');
    assert.equal(alerts[0].severity, 'warn');
    assert.match(alerts[0].detail, /code 3/);
    assert.match(alerts[0].detail, /2026-10-03T06:51/);
    assert.deepEqual(kernelCrashAlerts(path.join(stateDir, 'nope'), { now }), []);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('a host reboot with no exit record is named as the likely cause', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crashrec-'));
  try {
    writeRecord(stateDir, '2026-10-13T11:00:00.000Z', { lastExit: null, hostRebootedSinceLastOk: true });
    assert.match(kernelCrashAlerts(stateDir, { now: Date.parse('2026-10-13T12:00:00.000Z') })[0].detail, /host rebooted/);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('a supervisor that gave up is named as such, and a null signal is not reported as a cause', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crashrec-'));
  try {
    writeRecord(stateDir, '2026-10-13T11:00:00.000Z', { lastExit: { code: 75, signal: null, kind: 'restart', expected: false, gaveUp: 'more than 5 restarts in 60 s' } });
    const d = kernelCrashAlerts(stateDir, { now: Date.parse('2026-10-13T12:00:00.000Z') })[0].detail;
    assert.match(d, /gave up/);
    assert.doesNotMatch(d, /signal/);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('a stale exit record is not named as the cause', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crashrec-'));
  try {
    writeRecord(stateDir, '2026-10-13T11:00:00.000Z', { lastExit: null, lastExitStale: { code: 3, kind: 'crashed' } });
    const d = kernelCrashAlerts(stateDir, { now: Date.parse('2026-10-13T12:00:00.000Z') })[0].detail;
    assert.doesNotMatch(d, /code 3/);
    assert.match(d, /no exit record/);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('a repeated outage shows its count on one row', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crashrec-'));
  try {
    writeRecord(stateDir, '2026-10-13T11:00:00.000Z', { count: 4, lastTs: '2026-10-13T11:20:00.000Z', restart: { ok: false } });
    const alerts = kernelCrashAlerts(stateDir, { now: Date.parse('2026-10-13T12:00:00.000Z') });
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].detail, /4 times, last 2026-10-13T11:20/);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('a recovered outage says it restarted after N failed attempts; a pending start says it may still complete', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crashrec-'));
  try {
    writeRecord(stateDir, '2026-10-13T11:00:00.000Z', { restart: { ok: true, pid: 3 }, failedRestarts: [{ errors: ['a'] }, { errors: ['b'] }] });
    writeRecord(stateDir, '2026-10-13T11:30:00.000Z', { restart: { ok: false, reason: 'budget', pending: true } });
    const [a, b] = kernelCrashAlerts(stateDir, { now: Date.parse('2026-10-13T12:00:00.000Z') });
    assert.match(a.detail, /restarted after 2 failed attempts/i);
    assert.match(b.detail, /may still complete/);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('the restarted kernel shows a recent crash record in /api/alerts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crashalert-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gt'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vs'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'),
    GLMPS_CODEX_DIR: path.join(tmp, 'cx'), GLMPS_HERMES_DIR: path.join(tmp, 'hm'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'oc'), GLMPS_UNMERGED_SCAN: 'off' };
  writeRecord(env.GLMPS_STATE_DIR, new Date(Date.now() - 60_000).toISOString());
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: '/api/alerts' }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject);
    });
    assert.ok((body.alerts ?? []).some((a) => a.source === 'kernel-crash'), JSON.stringify(body).slice(0, 400));
  } finally { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
