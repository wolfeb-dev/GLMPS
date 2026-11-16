// Config snapshots land under the state folder's backups area, never beside
// config.json in a checkout root (card glmps-2-0-runtime-152). Temp dirs only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotConfig, configSnapshotDir } from '../lib/config-snapshot.js';

const roots = [];
after(() => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} } });

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-snap-'));
  roots.push(root);
  const checkout = path.join(root, 'checkout'); const stateDir = path.join(root, 'state');
  fs.mkdirSync(checkout, { recursive: true });
  const configFile = path.join(checkout, 'config.json');
  fs.writeFileSync(configFile, '{"port":8123}');
  return { root, checkout, stateDir, configFile };
}

test('AC-3: a snapshot is written under <stateDir>/backups/config, not beside config.json', () => {
  const f = mk();
  const now = () => new Date('2026-11-04T12:34:56.789Z');
  const snap = snapshotConfig(f.configFile, { stateDir: f.stateDir, now });
  assert.equal(configSnapshotDir(f.stateDir), path.join(f.stateDir, 'backups', 'config'));
  assert.equal(path.dirname(snap), configSnapshotDir(f.stateDir));
  assert.equal(path.basename(snap), 'config.json.20261104T123456789Z.bak');
  assert.equal(fs.readFileSync(snap, 'utf8'), '{"port":8123}');
  assert.deepEqual(fs.readdirSync(f.checkout), ['config.json']);

  const again = snapshotConfig(f.configFile, { stateDir: f.stateDir, now });
  assert.notEqual(again, snap, 'a second snapshot in the same millisecond never overwrites the first');
  assert.equal(fs.readdirSync(configSnapshotDir(f.stateDir)).length, 2);
});

test('a missing config file is no snapshot', () => {
  const f = mk();
  assert.equal(snapshotConfig(path.join(f.checkout, 'absent.json'), { stateDir: f.stateDir }), null);
  assert.equal(fs.existsSync(configSnapshotDir(f.stateDir)), false);
});
