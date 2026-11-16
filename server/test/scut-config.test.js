// Tests for SCUT credential config (server/lib/scut/config.js), plus the
// deep-merge protection on cfg.scut in server.js's startServer (D27 C3).
// Path is injected -> tests use a temp file, never a real secret path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { validateCreds, saveCreds, loadCreds } from '../lib/scut/config.js';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

let n = 0;
function tmpFile() { return join(tmpdir(), `scut-creds-test-${process.pid}-${n++}.json`); }

test('validateCreds enforces token prefixes and non-empty secret', () => {
  assert.equal(validateCreds({ botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 's' }).ok, true);

  const bad = validateCreds({ botToken: 'nope', appToken: 'xapp-1', signingSecret: 's' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /botToken/.test(e)));

  const missing = validateCreds({});
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.length >= 2, true);

  // signingSecret is optional for a Socket-Mode app: valid without it.
  assert.equal(validateCreds({ botToken: 'xoxb-1', appToken: 'xapp-1' }).ok, true);
});

test('saveCreds refuses invalid creds', () => {
  const file = tmpFile();
  assert.throws(() => saveCreds({ botToken: 'x', appToken: 'y', signingSecret: '' }, { file }));
  assert.equal(existsSync(file), false);
});

test('saveCreds then loadCreds round-trips from the file', () => {
  const file = tmpFile();
  try {
    saveCreds({ botToken: 'xoxb-aaa', appToken: 'xapp-bbb', signingSecret: 'sec123' }, { file });
    const got = loadCreds({ file, env: {} });
    assert.equal(got.botToken, 'xoxb-aaa');
    assert.equal(got.appToken, 'xapp-bbb');
    assert.equal(got.signingSecret, 'sec123');
    assert.equal(got.source, 'file');
  } finally {
    rmSync(file, { force: true });
  }
});

test('env vars override the file', () => {
  const file = tmpFile();
  try {
    saveCreds({ botToken: 'xoxb-file', appToken: 'xapp-file', signingSecret: 'filesec' }, { file });
    const env = { SCUT_BOT_TOKEN: 'xoxb-env', SCUT_APP_TOKEN: 'xapp-env', SCUT_SIGNING_SECRET: 'envsec' };
    const got = loadCreds({ file, env });
    assert.equal(got.botToken, 'xoxb-env');
    assert.equal(got.signingSecret, 'envsec');
    assert.equal(got.source, 'env');
  } finally {
    rmSync(file, { force: true });
  }
});

test('a corrupt creds file holding a token-like string never echoes it to the log', () => {
  const file = tmpFile();
  writeFileSync(file, '{"botToken":"xoxb-1-AAAA","appToken": xapp-1-BBBBSECRET}');
  const logged = [];
  const orig = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    const got = loadCreds({ file, env: {} });
    assert.equal(got.source, 'none');
  } finally {
    console.error = orig;
    rmSync(file, { force: true });
  }
  assert.ok(logged.length >= 1, 'the degraded read is still logged');
  for (const line of logged) assert.doesNotMatch(line, /xoxb|xapp|SECRET/);
});

test('loadCreds with no file and no env returns nulls + source none', () => {
  const got = loadCreds({ file: tmpFile(), env: {} });
  assert.equal(got.botToken, null);
  assert.equal(got.appToken, null);
  assert.equal(got.signingSecret, null);
  assert.equal(got.source, 'none');
});

// D27 C3: cfg.scut is deep-merged the same way as graphRebuild/etc
// (server.js), so a config.json that sets only ONE key never wipes its
// siblings out from under the plain top-level Object.assign(cfg, defaults,
// userConfig) that would otherwise replace the whole `scut` sub-object.
test('cfg.scut deep-merges: a config.json that sets only rejoinReopens keeps the other scut defaults', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mc-scut-cfg-'));
  const claudeDir = claudeTmp();
  const configFile = join(stateDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ scut: { rejoinReopens: true } }));
  const h = await startServer({ port: 0, env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir }, configFile });
  try {
    assert.deepEqual(h.cfgScut, { enabled: true, ticketChannels: true, channelMessages: false, rejoinReopens: true });
  } finally {
    await h.close?.();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  }
});
