// server/test/install-tap-otel.test.js
// Step D of scripts/install.mjs (card glmps-2-0-runtime-39): in a tap bundle the
// installer points Claude Code's trace exporter at the local relay. Everything
// runs against temp dirs; the real ~/.claude is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installTapOtel, uninstallTapOtel, runInstall, runUninstall } from '../../scripts/install.mjs';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-taptel-')); tmpDirs.push(d); return d; }

function setup({ settings, bundle = true, config } = {}) {
  const root = mkTmp();
  const tapRoot = path.join(root, 'bundle'); fs.mkdirSync(tapRoot);
  if (bundle) fs.writeFileSync(path.join(tapRoot, 'tap-manifest.json'), '{}');
  if (config !== undefined) fs.writeFileSync(path.join(tapRoot, 'tap-config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const claude = path.join(root, 'claude'); fs.mkdirSync(claude);
  const settingsFile = path.join(claude, 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  const recordFile = path.join(root, 'state', 'tap-otel-installed.json');
  return { root, tapRoot, claude, settingsFile, recordFile, args: { settingsFile, recordFile, tapRoot } };
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// The installer logs to the console; capture it so the suite output stays clean and the text is assertable.
function quiet(fn) {
  const log = console.log; const err = console.error; const logs = [];
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try { return { out: fn(), logs }; } finally { console.log = log; console.error = err; }
}

const keys = (port) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
});

test('a tap bundle gets the five exporter keys, port from tap-config.json, other settings kept', () => {
  const s = setup({ settings: { model: 'opus', env: { FOO: 'bar' } }, config: { port: 8200 } });
  quiet(() => installTapOtel(s.args));
  const after = read(s.settingsFile);
  assert.deepEqual(after.env, { FOO: 'bar', ...keys(8200) });
  assert.equal(after.model, 'opus');
  assert.equal(Object.keys(after.env).some((k) => k.startsWith('OTEL_LOG_')), false);
  assert.deepEqual(read(s.recordFile).added, keys(8200));
});

test('port defaults to 8123 with no config, a bad config, or a bad port; a missing settings file is created', () => {
  for (const config of [undefined, '{nope', { port: 'x' }, { port: 99999 }]) {
    const s = setup({ config });
    quiet(() => installTapOtel(s.args));
    assert.equal(read(s.settingsFile).env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, 'http://127.0.0.1:8123/v1/traces', JSON.stringify(config));
  }
});

test('a checkout (no tap-manifest.json) is left alone', () => {
  const s = setup({ settings: { model: 'opus' }, bundle: false });
  const before = fs.readFileSync(s.settingsFile, 'utf8');
  quiet(() => installTapOtel(s.args));
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), before);
  assert.equal(fs.existsSync(s.recordFile), false);
});

test('any key holding a different value skips the whole step and says why', () => {
  const s = setup({ settings: { env: { OTEL_TRACES_EXPORTER: 'console' } } });
  const before = fs.readFileSync(s.settingsFile, 'utf8');
  const { logs } = quiet(() => installTapOtel(s.args));
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), before, 'no partial write');
  assert.equal(fs.existsSync(s.recordFile), false);
  assert.match(logs.join('\n'), /OTEL_TRACES_EXPORTER/);
  assert.match(logs.join('\n'), /skipped/);
});

test('install twice is a no-op; a key already holding our value is not recorded as ours', () => {
  const s = setup({ settings: { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } } });
  quiet(() => installTapOtel(s.args));
  const once = fs.readFileSync(s.settingsFile, 'utf8');
  const rec = read(s.recordFile);
  assert.equal('CLAUDE_CODE_ENABLE_TELEMETRY' in rec.added, false);
  quiet(() => installTapOtel(s.args));
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), once);
  assert.deepEqual(read(s.recordFile), rec);
  quiet(() => uninstallTapOtel(s.args));
  assert.deepEqual(read(s.settingsFile).env, { CLAUDE_CODE_ENABLE_TELEMETRY: '1' }, 'the user key survives');
});

test('uninstall removes only keys still holding the value written, then the record', () => {
  const s = setup({ settings: { model: 'opus' } });
  quiet(() => installTapOtel(s.args));
  const edited = read(s.settingsFile);
  edited.env.OTEL_TRACES_EXPORTER = 'console';
  fs.writeFileSync(s.settingsFile, JSON.stringify(edited));
  quiet(() => uninstallTapOtel(s.args));
  assert.deepEqual(read(s.settingsFile).env, { OTEL_TRACES_EXPORTER: 'console' });
  assert.equal(fs.existsSync(s.recordFile), false);
});

test('uninstall drops an env block the installer created, and keeps one the user had', () => {
  const fresh = setup({ settings: { model: 'opus' } });
  quiet(() => installTapOtel(fresh.args));
  quiet(() => uninstallTapOtel(fresh.args));
  assert.deepEqual(read(fresh.settingsFile), { model: 'opus' });
  const had = setup({ settings: { env: { FOO: 'bar' } } });
  quiet(() => installTapOtel(had.args));
  quiet(() => uninstallTapOtel(had.args));
  assert.deepEqual(read(had.settingsFile), { env: { FOO: 'bar' } });
});

test('uninstall with no record is a no-op, and a corrupt record or different settings file refuses', () => {
  const s = setup({ settings: { model: 'opus' } });
  const before = fs.readFileSync(s.settingsFile, 'utf8');
  assert.equal(quiet(() => uninstallTapOtel(s.args)).out, true);
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), before);
  fs.mkdirSync(path.dirname(s.recordFile), { recursive: true });
  fs.writeFileSync(s.recordFile, '{nope');
  const prev = process.exitCode;
  assert.equal(quiet(() => uninstallTapOtel(s.args)).out, false);
  fs.writeFileSync(s.recordFile, JSON.stringify({ settingsFile: path.join(s.root, 'elsewhere', 'settings.json'), added: keys(8123) }));
  assert.equal(quiet(() => uninstallTapOtel(s.args)).out, false);
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), before);
  process.exitCode = prev;
});

test('a settings.json whose env is not an object is skipped, not overwritten', () => {
  const s = setup({ settings: { env: 'nope' } });
  const before = fs.readFileSync(s.settingsFile, 'utf8');
  quiet(() => installTapOtel(s.args));
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), before);
});

test('runInstall wires step D for a bundle and runUninstall reverses it, under redirected dirs', () => {
  const s = setup({ settings: { model: 'opus' }, config: { port: 8300 } });
  const stateBase = path.join(s.root, 'mcstate');
  const saved = { c: process.env.GLMPS_CLAUDE_DIR, s: process.env.GLMPS_STATE_DIR, f: process.env.GLMPS_CONFIG_FILE };
  // The checkout's config.json is never written: install-hooks-io's C1 test
  // runs in a parallel process and fails if it sees that file appear.
  const cfg = path.join(s.root, 'repo-config.json');
  process.env.GLMPS_CLAUDE_DIR = s.claude; process.env.GLMPS_STATE_DIR = stateBase; process.env.GLMPS_CONFIG_FILE = cfg;
  try {
    assert.equal(quiet(() => runInstall({ tapRoot: s.tapRoot })).out, true);
    assert.equal(read(s.settingsFile).env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, 'http://127.0.0.1:8300/v1/traces');
    assert.equal(quiet(() => runUninstall()).out, true);
    assert.equal(read(s.settingsFile).env, undefined);
    assert.equal(fs.existsSync(path.join(stateBase, 'tap-otel-installed.json')), false);
  } finally {
    if (saved.c === undefined) delete process.env.GLMPS_CLAUDE_DIR; else process.env.GLMPS_CLAUDE_DIR = saved.c;
    if (saved.s === undefined) delete process.env.GLMPS_STATE_DIR; else process.env.GLMPS_STATE_DIR = saved.s;
    if (saved.f === undefined) delete process.env.GLMPS_CONFIG_FILE; else process.env.GLMPS_CONFIG_FILE = saved.f;
  }
});
