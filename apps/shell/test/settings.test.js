// apps/shell/test/settings.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, settingsFile, normalizeSettings, loadSettings, saveSettings, createSettingsWriter, boundsVisible } from '../src/lib/settings.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-shell-settings-'));

test('a missing file loads the defaults with no warning', () => {
  const dir = tmp();
  const r = loadSettings({ file: settingsFile(dir) });
  assert.deepEqual(r.settings, { ...DEFAULT_SETTINGS });
  assert.equal(r.warning, null);
});

test('save then load round-trips, atomically through a temp file', () => {
  const dir = tmp();
  const file = settingsFile(path.join(dir, 'GLMPS2'));
  saveSettings({ file, settings: { ...DEFAULT_SETTINGS, splitRatio: 0.5, swapped: true, bounds: { x: 10, y: 20, width: 1300, height: 850 } } });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  const r = loadSettings({ file });
  assert.equal(r.settings.splitRatio, 0.5);
  assert.equal(r.settings.swapped, true);
  assert.deepEqual(r.settings.bounds, { x: 10, y: 20, width: 1300, height: 850 });
});

test('a corrupt file is moved aside, defaults load, and the warning names the backup', () => {
  const dir = tmp();
  const file = settingsFile(dir);
  fs.writeFileSync(file, '{ "splitRatio": 0.4,');
  const r = loadSettings({ file, now: () => 1234 });
  assert.deepEqual(r.settings, { ...DEFAULT_SETTINGS });
  assert.equal(r.warning.kind, 'corrupt');
  assert.equal(r.warning.backup, `${file}.bad-1234`);
  assert.equal(fs.existsSync(`${file}.bad-1234`), true);
  assert.equal(fs.existsSync(file), false);
});

test('an unreadable file (not ENOENT) loads defaults with an unreadable warning', () => {
  const fsImpl = { readFileSync() { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } };
  const r = loadSettings({ file: 'x/shell.json', fsImpl });
  assert.equal(r.warning.kind, 'unreadable');
  assert.match(r.warning.error, /EACCES/);
});

test('hand-edited values are type-checked and clamped', () => {
  const s = normalizeSettings({ splitRatio: 7, slackVisible: 'yes', bounds: { x: 1.5, y: 0, width: 800, height: 600 }, kernelUrl: '  http://127.0.0.1:9000 ', extra: 1 });
  assert.equal(s.splitRatio, 0.9);
  assert.equal(s.slackVisible, true);
  assert.equal(s.bounds, null);
  assert.equal(s.kernelUrl, 'http://127.0.0.1:9000');
  assert.equal('extra' in s, false);
  assert.deepEqual(normalizeSettings([1, 2]), { ...DEFAULT_SETTINGS });
});

test('the writer debounces updates into one save and reports a failed save', () => {
  const dir = tmp();
  const file = settingsFile(dir);
  const timers = [];
  const errors = [];
  const w = createSettingsWriter({ file, initial: DEFAULT_SETTINGS, onError: (e) => errors.push(e.message),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  w.update({ splitRatio: 0.4 });
  w.update({ swapped: true });
  assert.equal(fs.existsSync(file), false);
  timers.at(-1).fn();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.splitRatio, 0.4);
  assert.equal(saved.swapped, true);
  const broken = createSettingsWriter({ file, initial: DEFAULT_SETTINGS, onError: (e) => errors.push(e.message),
    fsImpl: { mkdirSync() {}, writeFileSync() { throw new Error('disk full'); }, renameSync() {} } });
  assert.equal(broken.flush(), false);
  assert.deepEqual(errors, ['disk full']);
});

test('the writer refuses to be built without an error sink', () => {
  assert.throws(() => createSettingsWriter({ file: 'x', initial: DEFAULT_SETTINGS }), /onError is required/);
});

test('boundsVisible: on-screen, mostly off-screen, and a detached monitor', () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.equal(boundsVisible({ x: 100, y: 100, width: 1200, height: 800 }, areas), true);
  assert.equal(boundsVisible({ x: 1880, y: 100, width: 1200, height: 800 }, areas), false); // 40 px visible
  assert.equal(boundsVisible({ x: 2200, y: 100, width: 1200, height: 800 }, areas), false); // second monitor gone
  assert.equal(boundsVisible(null, areas), false);
});

// Card glmps-2-0-runtime-12: Run at startup is on by default.
test('Run at startup defaults on for a fresh install and for a file that never set it', () => {
  assert.equal(DEFAULT_SETTINGS.launchAtLogin, true);
  assert.equal(DEFAULT_SETTINGS.version, 2);
  assert.equal(normalizeSettings({}).launchAtLogin, true);
  assert.equal(normalizeSettings({ version: 2 }).launchAtLogin, true);
});

test('a version-1 file always carried the old false default, so its false migrates to on', () => {
  assert.equal(normalizeSettings({ version: 1, launchAtLogin: false }).launchAtLogin, true);
  assert.equal(normalizeSettings({ launchAtLogin: false }).launchAtLogin, true, 'no version is a version-1 file');
  assert.equal(normalizeSettings({ version: 1, launchAtLogin: true }).launchAtLogin, true);
  assert.equal(normalizeSettings({ version: 1 }).version, 2);
});

test('an explicit off chosen under version 2 stays off, through save and load', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shset-')), 'shell.json');
  saveSettings({ file, settings: { ...DEFAULT_SETTINGS, launchAtLogin: false } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  assert.equal(loadSettings({ file }).settings.launchAtLogin, false);
  assert.equal(normalizeSettings(normalizeSettings({ version: 2, launchAtLogin: false })).launchAtLogin, false);
});

test('the in-app kernel keys are trimmed strings or null', () => {
  const s = normalizeSettings({ kernelCheckout: ' D:/glmps-2.0-runtime ', kernelNode: 'C:/node/node.exe', kernelAssetsDir: '' });
  assert.equal(s.kernelCheckout, 'D:/glmps-2.0-runtime');
  assert.equal(s.kernelNode, 'C:/node/node.exe');
  assert.equal(s.kernelAssetsDir, null);
  assert.equal(normalizeSettings({ kernelCheckout: 5 }).kernelCheckout, null);
});

test('kernelEnv keeps only GLMPS_ keys with non-empty string values, trimmed', () => {
  const s = normalizeSettings({ kernelEnv: {
    GLMPS_ASSETS_WRITE_DIR: ' D:/glmps-2.0-dev/assets ', GLMPS_EMPTY: '  ', GLMPS_NUM: 5, NODE_OPTIONS: '--inspect', PATH: 'x', mc_lower: 'a',
  } });
  assert.deepEqual(s.kernelEnv, { GLMPS_ASSETS_WRITE_DIR: 'D:/glmps-2.0-dev/assets' });
  assert.deepEqual(normalizeSettings({}).kernelEnv, {});
  assert.deepEqual(normalizeSettings({ kernelEnv: ['GLMPS_A'] }).kernelEnv, {});
  assert.deepEqual(normalizeSettings({ kernelEnv: 'GLMPS_A=1' }).kernelEnv, {});
  assert.deepEqual(DEFAULT_SETTINGS.kernelEnv, {});
});

test('setupWizardDismissed defaults to false and only a real boolean survives normalizing', () => {
  assert.equal(DEFAULT_SETTINGS.setupWizardDismissed, false);
  assert.equal(normalizeSettings({ version: 2, setupWizardDismissed: true }).setupWizardDismissed, true);
  assert.equal(normalizeSettings({ version: 2, setupWizardDismissed: 'yes' }).setupWizardDismissed, false);
});
