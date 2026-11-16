// server/test/operator-settings.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOperatorSettings, saveOperatorTimeZone } from '../lib/operator-settings.js';
import { systemTimeZone, displayTimeZone, setDisplayTimeZone } from '../../web/shared/time-format.js';
import { startServer } from '../server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-optz-'));

test('with nothing saved the zone is the OS zone, marked as such', () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadOperatorSettings(dir), { timeZone: systemTimeZone(), source: 'os' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a saved zone persists and wins; an unknown zone is refused and nothing is written', () => {
  const dir = tmp();
  try {
    assert.deepEqual(saveOperatorTimeZone(dir, 'Mars/Olympus'), { ok: false, error: 'unknown timezone: Mars/Olympus' });
    assert.equal(fs.existsSync(path.join(dir, 'operator.json')), false);
    assert.deepEqual(saveOperatorTimeZone(dir, 'Europe/Berlin'), { ok: true, timeZone: 'Europe/Berlin', source: 'saved' });
    assert.deepEqual(loadOperatorSettings(dir), { timeZone: 'Europe/Berlin', source: 'saved' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt or stale saved value falls back to the OS zone rather than failing', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'operator.json'), '{not json');
    assert.equal(loadOperatorSettings(dir).source, 'os');
    fs.writeFileSync(path.join(dir, 'operator.json'), JSON.stringify({ timeZone: 'Gone/Away' }));
    assert.deepEqual(loadOperatorSettings(dir), { timeZone: systemTimeZone(), source: 'os' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET/POST /api/settings/timezone: read, set, persist across a restart, refuse unknown zones', async () => {
  const base = tmp();
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const before = displayTimeZone();
  let h = await startServer({ port: 0, env });
  const url = (p) => `http://127.0.0.1:${h.port}${p}`;
  const post = (body) => fetch(url('/api/settings/timezone'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await (await fetch(url('/api/settings/timezone'))).json();
    assert.equal(first.timeZone, systemTimeZone());
    assert.equal(first.source, 'os');
    assert.equal(typeof first.label, 'string');

    const bad = await post({ timeZone: 'Mars/Olympus' });
    assert.equal(bad.status, 400);

    const ok = await post({ timeZone: 'America/New_York' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { timeZone: 'America/New_York', source: 'saved', label: 'ET' });
    assert.equal(displayTimeZone(), 'America/New_York', 'server prose switches zone without a restart');

    await h.close();
    setDisplayTimeZone(before);
    h = await startServer({ port: 0, env });
    const again = await (await fetch(url('/api/settings/timezone'))).json();
    assert.equal(again.timeZone, 'America/New_York');
    assert.equal(again.source, 'saved');
    assert.equal(displayTimeZone(), 'America/New_York', 'boot applies the saved zone');
  } finally {
    await h.close?.();
    setDisplayTimeZone(before);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
