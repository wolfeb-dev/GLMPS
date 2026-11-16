// Restore drill and CLI for state backups (card glmps-2-0-runtime-42): a backup
// is restored into a fresh dir and a real kernel is booted on it. Temp dirs only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createStateBackup } from '../lib/kernel/state-backup.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { drillBackup, enableBackup } from '../../scripts/state-backup.mjs';

const run = promisify(execFile);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'state-backup.mjs');
const roots = [];
after(() => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} } });

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-drill-'));
  roots.push(root);
  const stateDir = path.join(root, 'state'); const targetDir = path.join(root, 'target');
  fs.mkdirSync(stateDir, { recursive: true }); fs.mkdirSync(targetDir, { recursive: true });
  backlogStore.addItemTo(stateDir, { project: 'p', title: 'first card', prompt: 'x' }, { trust: 'operator' });
  backlogStore.addItemTo(stateDir, { project: 'p', title: 'second card', prompt: 'y' }, { trust: 'operator' });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{"port":1}');
  return { root, stateDir, targetDir };
}

test('the drill restores a backup, boots a real kernel on it and finds the same cards', { timeout: 60000 }, async () => {
  const s = seed();
  const res = await createStateBackup({ stateDir: s.stateDir, targetDir: s.targetDir, requireSecondDisk: false }).run();
  const before = backlogStore.load(s.stateDir).items.length;
  assert.equal(before, 2);
  const out = await drillBackup({ backupDir: res.dir, liveStateDir: s.stateDir });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.cards, 2);
  assert.equal(out.booted, true);
  assert.equal(fs.existsSync(out.tempDir), false, 'the temp dir is removed');
});

test('the drill fails on a damaged backup instead of booting it', { timeout: 60000 }, async () => {
  const s = seed();
  const res = await createStateBackup({ stateDir: s.stateDir, targetDir: s.targetDir, requireSecondDisk: false }).run();
  fs.writeFileSync(path.join(res.dir, 'config.json'), 'tampered');
  const out = await drillBackup({ backupDir: res.dir, liveStateDir: s.stateDir });
  assert.equal(out.ok, false);
  assert.match(out.reason, /verify/);
});

test('enable is a dry run by default and --apply backs the config up first', () => {
  const s = seed();
  const configFile = path.join(s.root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ port: 8123, scut: { enabled: true } }));
  const dry = enableBackup({ configFile, stateDir: s.stateDir, target: s.targetDir, hour: 4, apply: false });
  assert.equal(dry.applied, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { port: 8123, scut: { enabled: true } });
  assert.deepEqual(fs.readdirSync(s.root).filter(n => n.includes('.bak')), []);

  const done = enableBackup({ configFile, stateDir: s.stateDir, target: s.targetDir, hour: 4, apply: true, now: () => Date.UTC(2026, 10, 3, 12) });
  assert.equal(done.applied, true);
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(cfg.port, 8123);
  assert.equal(cfg.backup.targetDir, path.resolve(s.targetDir));
  assert.equal(cfg.backup.hour, 4);
  assert.deepEqual(fs.readdirSync(s.root).filter(n => n.includes('.bak')), [], 'nothing beside config.json');
  const snapDir = path.join(s.stateDir, 'backups', 'config');
  assert.equal(done.backupFile, path.join(snapDir, 'config.json.20261103T120000000Z.bak'));
  const baks = fs.readdirSync(snapDir).filter(n => n.startsWith('config.json.') && n.endsWith('.bak'));
  assert.equal(baks.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapDir, baks[0]), 'utf8')), { port: 8123, scut: { enabled: true } });
  assert.throws(() => enableBackup({ configFile, stateDir: s.stateDir, target: path.join(s.stateDir, 'bk'), apply: true }), /target-inside-state/);
});

test('the CLI runs, verifies and restores', { timeout: 60000 }, async () => {
  const s = seed();
  const base = ['--state', s.stateDir, '--target', s.targetDir, '--same-disk-ok'];
  const ran = await run(process.execPath, [script, 'run', ...base]);
  assert.match(ran.stdout, /backup written/);
  const ver = await run(process.execPath, [script, 'verify', ...base]);
  assert.match(ver.stdout, /ok/);
  const dir = path.join(s.targetDir, 'daily', fs.readdirSync(path.join(s.targetDir, 'daily'))[0]);
  const out = path.join(s.root, 'restored');
  await run(process.execPath, [script, 'restore', dir, out, '--state', s.stateDir]);
  assert.equal(fs.readFileSync(path.join(out, 'config.json'), 'utf8'), '{"port":1}');
  await assert.rejects(run(process.execPath, [script, 'restore', dir, out, '--state', s.stateDir]), /not-empty/);
});
