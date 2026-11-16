// server/test/usage-capture-health.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageCaptureFindings, readUsageCaptureInputs } from '../lib/observability/usage-capture-health.js';
import { collectAlerts } from '../lib/observability/alert-sources.js';

const H = 3600 * 1000;
const NOW = 1_800_000_000_000;
const CHAIN = 'node "C:/x/taps/statusline-chain.js"';
const live = (ageMs, tool = 'claude-code') => ({ id: `s-${ageMs}`, tool, lastTs: NOW - ageMs });

test('healthy: tap wired and a recent record -> no findings', () => {
  const f = usageCaptureFindings({ settingsReadable: true, statusLineCommand: CHAIN, everInstalled: true,
    lastRecordMs: NOW - 10 * 60 * 1000, sessions: [live(60 * 1000)], nowMs: NOW });
  assert.deepEqual(f, []);
});

test('displaced: statusLine no longer runs the chain -> one displaced finding, silence suppressed', () => {
  const f = usageCaptureFindings({ settingsReadable: true, statusLineCommand: 'node C:/other/tap.js', everInstalled: true,
    lastRecordMs: NOW - 21 * 24 * H, sessions: [live(60 * 1000)], nowMs: NOW });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'displaced');
  assert.equal(f[0].command, 'node C:/other/tap.js');
});

test('displaced: a missing statusLine counts once the tap was ever installed', () => {
  const f = usageCaptureFindings({ settingsReadable: true, statusLineCommand: null, everInstalled: true,
    lastRecordMs: NOW - H, sessions: [], nowMs: NOW });
  assert.deepEqual(f.map(x => x.kind), ['displaced']);
});

test('fresh install (tap never installed) and unreadable settings -> no displaced finding', () => {
  assert.deepEqual(usageCaptureFindings({ settingsReadable: true, statusLineCommand: null, everInstalled: false,
    lastRecordMs: null, sessions: [live(60 * 1000)], nowMs: NOW }), []);
  assert.deepEqual(usageCaptureFindings({ settingsReadable: false, statusLineCommand: null, everInstalled: true,
    lastRecordMs: NOW - H, sessions: [], nowMs: NOW }), []);
});

test('silent: a live Claude Code session and no record for 6h -> one silent finding', () => {
  const f = usageCaptureFindings({ settingsReadable: true, statusLineCommand: CHAIN, everInstalled: true,
    lastRecordMs: NOW - 7 * H, sessions: [live(5 * 60 * 1000), live(60 * 1000, 'antigravity')], nowMs: NOW });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'silent');
  assert.equal(f[0].liveSessions, 1);
  assert.equal(f[0].lastRecordMs, NOW - 7 * H);
});

test('silent: no live Claude Code session, or record inside the window, or custom threshold -> no finding', () => {
  const base = { settingsReadable: true, statusLineCommand: CHAIN, everInstalled: true, nowMs: NOW };
  assert.deepEqual(usageCaptureFindings({ ...base, lastRecordMs: NOW - 7 * H, sessions: [live(8 * H), live(60 * 1000, 'antigravity')] }), []);
  assert.deepEqual(usageCaptureFindings({ ...base, lastRecordMs: NOW - 5 * H, sessions: [live(60 * 1000)] }), []);
  assert.deepEqual(usageCaptureFindings({ ...base, lastRecordMs: NOW - 7 * H, sessions: [live(60 * 1000)], silentHours: 12 }), []);
});

test('readUsageCaptureInputs reads the statusLine command, install evidence and newest record mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucap-'));
  try {
    const settingsFile = path.join(root, 'settings.json');
    const stateDir = path.join(root, 'state');
    assert.deepEqual(readUsageCaptureInputs({ settingsFile, stateDir }),
      { settingsReadable: false, statusLineCommand: null, everInstalled: false, lastRecordMs: null });

    fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: CHAIN } }));
    fs.mkdirSync(path.join(stateDir, 'usage'), { recursive: true });
    const older = path.join(stateDir, 'usage', '2026-10-01.ndjson');
    const newer = path.join(stateDir, 'usage', '2026-10-02.ndjson');
    fs.writeFileSync(older, '{}\n');
    fs.writeFileSync(newer, '{}\n');
    fs.utimesSync(older, new Date(NOW - 2 * H), new Date(NOW - 2 * H));
    fs.utimesSync(newer, new Date(NOW - H), new Date(NOW - H));
    const r = readUsageCaptureInputs({ settingsFile, stateDir });
    assert.equal(r.settingsReadable, true);
    assert.equal(r.statusLineCommand, CHAIN);
    assert.equal(r.everInstalled, true);
    assert.equal(Math.round(r.lastRecordMs / 1000), Math.round((NOW - H) / 1000));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readUsageCaptureInputs: the delegate file alone is install evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucap-'));
  try {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'statusline-delegate.json'), '{"command":null}');
    const r = readUsageCaptureInputs({ settingsFile: path.join(root, 'nope.json'), stateDir });
    assert.equal(r.everInstalled, true);
    assert.equal(r.lastRecordMs, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectAlerts: displaced is critical, silent is warn, titles stay stable across ticks', () => {
  const displaced = collectAlerts({ usageCapture: [{ kind: 'displaced', command: 'node other.js' }] });
  const d = displaced.filter(a => a.source === 'usage-capture');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'critical');
  assert.match(d[0].detail, /node other\.js/);

  const a1 = collectAlerts({ usageCapture: [{ kind: 'silent', lastRecordMs: NOW - 7 * H, liveSessions: 1, silentHours: 6 }] })
    .filter(a => a.source === 'usage-capture');
  const a2 = collectAlerts({ usageCapture: [{ kind: 'silent', lastRecordMs: NOW - 7 * H, liveSessions: 3, silentHours: 6 }] })
    .filter(a => a.source === 'usage-capture');
  assert.equal(a1.length, 1);
  assert.equal(a1[0].severity, 'warn');
  assert.equal(a1[0].id, a2[0].id);
});

test('GET /api/alerts raises the critical alert for the glmps-188 state (tap displaced, usage stale)', async () => {
  const { startServer } = await import('../server.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-'));
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node C:/other/tap.js' } }));
  fs.mkdirSync(path.join(stateDir, 'usage'), { recursive: true });
  const rec = path.join(stateDir, 'usage', '2026-09-28.ndjson');
  fs.writeFileSync(rec, '{"sid":"s1","capturedAt":1}\n');
  const old = new Date(Date.now() - 21 * 24 * H);
  fs.utimesSync(rec, old, old);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const body = await (await fetch(`http://127.0.0.1:${h.port}/api/alerts`)).json();
    const hits = body.alerts.filter(a => a.source === 'usage-capture');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, 'critical');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
