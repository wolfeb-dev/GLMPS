// Tests for SCUT runtime settings (server/lib/scut/settings.js). Temp file injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, existsSync } from 'node:fs';
import { getSettings, saveSettings, getBobMode, setBobMode, getAllowedUsers, addAllowedUser, getOutbound, setOutbound, getHeartbeatMinutes, setHeartbeatMinutes, getAvatarBaseUrl, setAvatarBaseUrl, getParkHours, setParkHours, getProjectSystems, getDefaultProjects } from '../lib/scut/settings.js';

let n = 0;
const tmp = () => join(tmpdir(), `scut-settings-${process.pid}-${n++}.json`);

test('defaults: bobMode is OFF when no file exists', () => {
  assert.equal(getBobMode({ file: tmp() }), false);
  assert.equal(getSettings({ file: tmp() }).bobMode, false);
});

test('setBobMode persists and getBobMode reads it back', () => {
  const file = tmp();
  try {
    assert.equal(setBobMode(true, { file }), true);
    assert.equal(getBobMode({ file }), true);
    assert.equal(setBobMode(false, { file }), false);
    assert.equal(getBobMode({ file }), false);
  } finally { rmSync(file, { force: true }); }
});

test('saveSettings merges a patch over existing settings', () => {
  const file = tmp();
  try {
    saveSettings({ bobMode: true }, { file });
    const s = saveSettings({ somethingElse: 1 }, { file });
    assert.equal(s.bobMode, true);       // preserved
    assert.equal(s.somethingElse, 1);    // added
  } finally { rmSync(file, { force: true }); }
});

test('a corrupt settings file falls back to defaults (never throws)', () => {
  const file = tmp();
  try {
    writeFileSync(file, '{not json');
    assert.equal(getBobMode({ file }), false);
    assert.equal(getSettings({ file }).bobMode, false);
  } finally { rmSync(file, { force: true }); }
});

test('allowlist: default empty (fail-closed); addAllowedUser appends + dedupes', () => {
  const file = tmp();
  try {
    assert.deepEqual(getAllowedUsers({ file }), []);
    assert.deepEqual(addAllowedUser('U1', { file }), ['U1']);
    assert.deepEqual(addAllowedUser('U1', { file }), ['U1']);       // no duplicate
    assert.deepEqual(addAllowedUser('U2', { file }), ['U1', 'U2']);
    assert.deepEqual(getAllowedUsers({ file }), ['U1', 'U2']);
    assert.deepEqual(addAllowedUser('', { file }), ['U1', 'U2']);   // falsy = no-op
  } finally { rmSync(file, { force: true }); }
});

test('outbound defaults to both', () => {
  const file = tmp();
  assert.equal(getOutbound({ file }), 'both');
});

test('setOutbound accepts thread, channel, and both; rejects garbage', () => {
  const file = tmp();
  try {
    assert.equal(setOutbound('channel', { file }), 'channel');
    assert.equal(getOutbound({ file }), 'channel');
    assert.equal(setOutbound('thread', { file }), 'thread');
    assert.equal(getOutbound({ file }), 'thread');
    assert.equal(setOutbound('both', { file }), 'both');
    assert.equal(getOutbound({ file }), 'both');
    assert.throws(() => setOutbound('carrier-pigeon', { file }));
  } finally { rmSync(file, { force: true }); }
});

test('heartbeat: defaults to 5 minutes', () => {
  const file = tmp();
  assert.equal(getHeartbeatMinutes({ file }), 5);
  assert.equal(getSettings({ file }).heartbeatMinutes, 5);
});

test('setHeartbeatMinutes persists and getHeartbeatMinutes reads it back; 0 disables', () => {
  const file = tmp();
  try {
    assert.equal(setHeartbeatMinutes(10, { file }), 10);
    assert.equal(getHeartbeatMinutes({ file }), 10);
    assert.equal(setHeartbeatMinutes(0, { file }), 0);
    assert.equal(getHeartbeatMinutes({ file }), 0);
  } finally { rmSync(file, { force: true }); }
});

test('setHeartbeatMinutes rejects negatives and non-numbers', () => {
  const file = tmp();
  try {
    assert.throws(() => setHeartbeatMinutes(-1, { file }));
    assert.throws(() => setHeartbeatMinutes('five', { file }));
    assert.throws(() => setHeartbeatMinutes(NaN, { file }));
  } finally { rmSync(file, { force: true }); }
});

test('avatar base URL: unset by default', () => {
  assert.equal(getAvatarBaseUrl({ file: tmp(), env: {} }), null);
});

test('setAvatarBaseUrl round-trips and normalizes the trailing slash', () => {
  const file = tmp();
  try {
    assert.equal(setAvatarBaseUrl('https://cdn.example/scut/', { file }), 'https://cdn.example/scut');
    assert.equal(getAvatarBaseUrl({ file, env: {} }), 'https://cdn.example/scut');
    assert.equal(setAvatarBaseUrl(null, { file }), null);   // clearing it is allowed
    assert.equal(getAvatarBaseUrl({ file, env: {} }), null);
    assert.equal(setAvatarBaseUrl('', { file }), null);
  } finally { rmSync(file, { force: true }); }
});

test('SCUT_AVATAR_BASE_URL wins over the settings file', () => {
  const file = tmp();
  try {
    setAvatarBaseUrl('https://cdn.example/scut', { file });
    assert.equal(getAvatarBaseUrl({ file, env: { SCUT_AVATAR_BASE_URL: 'https://env.example/a/' } }),
      'https://env.example/a');
    // an unusable env value does not shadow a good stored one
    assert.equal(getAvatarBaseUrl({ file, env: { SCUT_AVATAR_BASE_URL: 'http://nope' } }),
      'https://cdn.example/scut');
  } finally { rmSync(file, { force: true }); }
});

test('setAvatarBaseUrl throws on a URL Slack could never fetch', () => {
  const file = tmp();
  try {
    // The loopback mistake is the whole reason this validates at all.
    assert.throws(() => setAvatarBaseUrl('http://127.0.0.1:8123/assets', { file }), /https/);
    assert.throws(() => setAvatarBaseUrl('file:///tmp/x', { file }), /https/);
    assert.throws(() => setAvatarBaseUrl('not a url', { file }), /https/);
  } finally { rmSync(file, { force: true }); }
});

test('a hand-edited bad value reads as unset instead of breaking every post', () => {
  const file = tmp();
  try {
    saveSettings({ avatarBaseUrl: 'file:///tmp/x' }, { file });
    assert.equal(getAvatarBaseUrl({ file, env: {} }), null);
  } finally { rmSync(file, { force: true }); }
});

test('parkHours defaults to 168, persists via setter, 0 disables', () => {
  const file = tmp();
  try {
    assert.equal(getParkHours({ file }), 168);
    setParkHours(6, { file });
    assert.equal(getParkHours({ file }), 6);
    setParkHours(0, { file });
    assert.equal(getParkHours({ file }), 0);
  } finally { rmSync(file, { force: true }); }
});

test('parkHours: corrupt stored value falls back, setter rejects garbage', () => {
  const file = tmp();
  try {
    saveSettings({ parkHours: 'soon' }, { file });
    assert.equal(getParkHours({ file }), 168);
    assert.throws(() => setParkHours(-1, { file }));
    assert.throws(() => setParkHours(NaN, { file }));
  } finally { rmSync(file, { force: true }); }
});

test('saveSettings is atomic - no .tmp survives', () => {
  const file = tmp();
  try {
    saveSettings({ bobMode: true }, { file });
    assert.equal(existsSync(file + '.tmp'), false);
    assert.equal(existsSync(file), true);
  } finally { rmSync(file, { force: true }); }
});

test('project channels are installation data: empty by default, read back when saved, junk dropped', () => {
  const file = tmp();
  try {
    assert.deepEqual(getProjectSystems({ file }), {});
    assert.deepEqual(getDefaultProjects({ file }), []);
    saveSettings({ projectSystems: { 'Acme-App': 'epsilon-eridani', bad: 42, '': 'x' }, defaultProjects: [' Acme-App ', '', 7] }, { file });
    assert.deepEqual(getProjectSystems({ file }), { 'Acme-App': 'epsilon-eridani' });
    assert.deepEqual(getDefaultProjects({ file }), ['Acme-App']);
    saveSettings({ projectSystems: ['not', 'a', 'map'], defaultProjects: 'nope' }, { file });
    assert.deepEqual(getProjectSystems({ file }), {});
    assert.deepEqual(getDefaultProjects({ file }), []);
  } finally {
    rmSync(file, { force: true });
  }
});
