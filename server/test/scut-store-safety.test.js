// A failed read of a scut store must never become an empty store that a
// read-modify-write then persists over the real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindTicketChannel, markHidden, ticketForChannel, listTicketChannels } from '../lib/scut/ticket-channels.js';
import { bindChannel, bindProjectChannels, projectForChannelName } from '../lib/scut/channel-map.js';
import { bindRoom, pruneRooms, getRoom } from '../lib/scut/room-mapper.js';
import { saveSettings, getSettings, addAllowedUser } from '../lib/scut/settings.js';
import { saveCreds, loadCreds } from '../lib/scut/config.js';
import { declarePlan, recordPosted, clearProgress, readProgress, progressPath } from '../lib/scut/progress-store.js';
import { recordPollFailure, channelHealthDir } from '../lib/scut/channel-health.js';

const CORRUPT = '{"channels": {"C1": {"ticketId"';
const quiet = () => {
  const orig = console.error;
  console.error = () => {};
  return () => { console.error = orig; };
};

function corruptFile(name, text = CORRUPT) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scut-store-safety-'));
  const file = path.join(d, name);
  fs.writeFileSync(file, text);
  return file;
}
const untouched = (file, text = CORRUPT) => assert.equal(fs.readFileSync(file, 'utf8'), text, 'the unreadable store was not overwritten');

test('ticket-channels: bind and markHidden refuse to write after a failed read; readers degrade', () => {
  const file = corruptFile('tc.json');
  const restore = quiet();
  try {
    assert.throws(() => bindTicketChannel({ channelId: 'C2', ticketId: 't2' }, { file }), { name: 'JsonStoreError' });
    assert.throws(() => markHidden('t1', true, { file }), { name: 'JsonStoreError' });
    assert.equal(ticketForChannel('C1', { file }), null);
    assert.deepEqual(listTicketChannels({ file }), []);
  } finally { restore(); }
  untouched(file);
});

test('channel-map: bindChannel refuses to write after a failed read; reader degrades', () => {
  const file = corruptFile('cm.json');
  const restore = quiet();
  try {
    assert.throws(() => bindChannel({ name: 'x', project: 'p' }, { file }), { name: 'JsonStoreError' });
    assert.throws(() => bindProjectChannels('glmps', { file }), { name: 'JsonStoreError' });
    assert.equal(projectForChannelName('glmps', { file }), 'glmps-2.0-runtime');
  } finally { restore(); }
  untouched(file);
});

test('room-mapper: bindRoom and pruneRooms refuse to write after a failed read; reader degrades', () => {
  const file = corruptFile('rm.json');
  const restore = quiet();
  try {
    assert.throws(() => bindRoom({ channel: 'C1', thread_ts: '1.1' }, { file }), { name: 'JsonStoreError' });
    assert.throws(() => pruneRooms({}, { file }), { name: 'JsonStoreError' });
    assert.equal(getRoom('C1', '1.1', { file }), null);
  } finally { restore(); }
  untouched(file);
});

test('settings: saveSettings throws instead of replacing an unreadable file with defaults', () => {
  const file = corruptFile('s.json');
  const restore = quiet();
  try {
    assert.throws(() => saveSettings({ bobMode: true }, { file }), { name: 'JsonStoreError' });
    assert.throws(() => addAllowedUser('U1', { file }), { name: 'JsonStoreError' });
    assert.equal(getSettings({ file }).bobMode, false);
  } finally { restore(); }
  untouched(file);
});

test('config: an unreadable creds file loads as absent and saveCreds round-trips atomically', () => {
  const file = corruptFile('scut.json');
  const restore = quiet();
  try {
    assert.equal(loadCreds({ env: {}, file }).source, 'none');
  } finally { restore(); }
  saveCreds({ botToken: 'xoxb-1', appToken: 'xapp-1' }, { file });
  assert.equal(loadCreds({ env: {}, file }).botToken, 'xoxb-1');
});

test('progress-store: declare, record and clear refuse to write after a failed read', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scut-progress-safety-'));
  const file = progressPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"t1": {"plan"');
  const restore = quiet();
  try {
    assert.throws(() => declarePlan(stateDir, 't2', {}), { name: 'JsonStoreError' });
    assert.throws(() => recordPosted(stateDir, 't1', {}), { name: 'JsonStoreError' });
    assert.throws(() => clearProgress(stateDir, 't1'), { name: 'JsonStoreError' });
    assert.deepEqual(readProgress(stateDir), {});
  } finally { restore(); }
  untouched(file, '{"t1": {"plan"');
});

test('channel-health: a corrupt record is logged by name and replaced so alerts keep working', () => {
  const dir = channelHealthDir({ GLMPS_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'scut-health-safety-')) });
  recordPollFailure(dir, { channel: 'C9' }, new Error('x'));
  const file = path.join(dir, 'C9.json');
  fs.writeFileSync(file, '{"channel": "C9", "fail');
  const logs = [];
  const orig = console.error;
  console.error = (m) => logs.push(String(m));
  let rec;
  try { rec = recordPollFailure(dir, { channel: 'C9' }, new Error('y')); } finally { console.error = orig; }
  assert.equal(rec.failures, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /corrupt health record for C9/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).failures, 1);
});
