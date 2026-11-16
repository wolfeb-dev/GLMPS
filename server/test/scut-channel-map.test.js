// Tests for the persistent channel->project map (server/lib/scut/channel-map.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  channelsPath,
  bindChannel,
  bindProjectChannels,
  projectForChannelName,
  listChannelBindings,
} from '../lib/scut/channel-map.js';

// A call that passes no systems reads the SCUT settings file: point it at an
// empty temp one so no test reads the real installation's.
process.env.SCUT_SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scut-settings-')), 'scut-settings.json');

const systems = { 'Acme-App': 'epsilon-eridani', 'Northwind Portal': 'poseidon' };

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scut-channels-'));
  return path.join(d, 'channels.json');
}

test('an unknown channel name resolves to nothing', () => {
  assert.equal(projectForChannelName('random', { file: tmpFile() }), null);
});

test('bindProjectChannels registers BOTH names so either mode routes', () => {
  const file = tmpFile();
  const names = bindProjectChannels('Acme-App', { file, systems });
  assert.deepEqual(names.sort(), ['acme-app', 'epsilon-eridani']);
  assert.equal(projectForChannelName('acme-app', { file, systems: {} }), 'Acme-App');
  assert.equal(projectForChannelName('epsilon-eridani', { file, systems: {} }), 'Acme-App');
});

test('a star system from the settings resolves even with nothing persisted', () => {
  assert.equal(projectForChannelName('poseidon', { file: tmpFile(), systems }), 'Northwind Portal');
  assert.equal(projectForChannelName('poseidon', { file: tmpFile(), systems: {} }), null);
});

test('AC-2: #glmps routes to 2.0 with the alias table gone', async () => {
  const mod = await import('../lib/scut/channel-map.js');
  assert.equal('STATIC_ALIASES' in mod, false);
  assert.equal(projectForChannelName('glmps', { file: tmpFile() }), 'glmps-2.0-runtime');
  assert.equal(projectForChannelName('glmps', { file: tmpFile(), table: { target: 'glmps-2.0' } }), 'glmps-2.0');
});

test('a channel bound to an old 2.0 project name routes to the canonical project', () => {
  const file = tmpFile();
  bindChannel({ name: 'glmps-2-0', project: 'glmps-2-0' }, { file });
  assert.equal(projectForChannelName('glmps-2-0', { file }), 'glmps-2.0-runtime');
});

test('a persisted binding wins over the static reverse map', () => {
  const file = tmpFile();
  bindChannel({ name: 'poseidon', project: 'Acme-App' }, { file });
  assert.equal(projectForChannelName('poseidon', { file, systems }), 'Acme-App');
});

test('channelsPath resolves from an injected env, not the real process env', () => {
  const explicit = path.join(os.tmpdir(), 'x', 'channels.json');
  assert.equal(channelsPath(undefined, { SCUT_CHANNELS_FILE: explicit }), explicit);
  const dir = path.join(os.tmpdir(), 'st');
  assert.equal(channelsPath(undefined, { GLMPS_STATE_DIR: dir }), path.join(dir, 'scut', 'channels.json'));
});

test('a corrupt channels file reads as empty and never throws', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{nope');
  assert.deepEqual(listChannelBindings({ file }), []);
  assert.equal(projectForChannelName('poseidon', { file, systems }), 'Northwind Portal'); // settings fallback still works
});

test('1.0 retired: a channel bound to glmps, or #sol unbound, resolves to nothing', () => {
  const file = tmpFile();
  assert.equal(projectForChannelName('sol', { file }), null);
  bindChannel({ name: 'sol', project: 'glmps' }, { file });
  bindChannel({ name: 'glmps', project: 'glmps' }, { file });
  assert.equal(projectForChannelName('sol', { file }), null);
  assert.equal(projectForChannelName('glmps', { file }), null);
});

test('writes are atomic - no .tmp survives', () => {
  const file = tmpFile();
  bindChannel({ name: 'a', project: 'p' }, { file });
  assert.equal(fs.existsSync(file + '.tmp'), false);
});
