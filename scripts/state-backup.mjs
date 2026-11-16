#!/usr/bin/env node
// scripts/state-backup.mjs
// Operator CLI for the nightly state-dir backup (card glmps-2-0-runtime-42).
//
//   node scripts/state-backup.mjs run [--state <dir>] [--target <dir>] [--same-disk-ok]
//   node scripts/state-backup.mjs verify [<backupDir>] [--state <dir>] [--target <dir>]
//   node scripts/state-backup.mjs restore <backupDir> <newStateDir> [--state <dir>]
//   node scripts/state-backup.mjs drill [<backupDir>] [--state <dir>] [--target <dir>]
//   node scripts/state-backup.mjs enable --target <dir> [--hour N] [--config <file>] [--apply]
//
// The state dir defaults to the one the server uses (GLMPS_STATE_DIR or
// ~/.glmps); the target defaults to config.json backup.targetDir.
// `enable` is a dry run until --apply, and backs config.json up first, into
// <state>/backups/config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStateBackup, verifyBackup, restoreBackup } from '../server/lib/kernel/state-backup.js';
import { getPaths, configFileFor } from '../server/lib/paths.js';
import { snapshotConfig } from '../server/lib/config-snapshot.js';
import * as backlogStore from '../server/lib/orchestration/backlog-store.js';

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/**
 * Restore a backup into a fresh temp dir, boot a throwaway kernel on it and
 * check /healthz and the card count, then stop it and remove the temp dir.
 * The throwaway kernel runs with every actor off and the queue tick parked, so
 * restored cards and tokens can never launch a session or post to Slack.
 */
export async function drillBackup({ backupDir, liveStateDir = null }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-drill-'));
  const stateDir = path.join(tempDir, 'state');
  const result = { ok: false, booted: false, cards: null, tempDir };
  let srv = null;
  try {
    try { await restoreBackup(backupDir, stateDir, { liveStateDir }); }
    catch (e) { return { ...result, reason: e.message }; }
    fs.rmSync(path.join(stateDir, 'runner', 'config.json'), { force: true });
    const expected = backlogStore.load(stateDir).items.length;

    const configFile = path.join(tempDir, 'config.json');
    const off = { enabled: false };
    fs.writeFileSync(configFile, JSON.stringify({
      scut: off, nightly: off, huddle: off, wikiLoop: off, graphRebuild: off, graphifyUpdate: off, qaTrends: off,
      graphIntegrity: off, vitalsTrends: off, platformAutonomy: off, backup: { targetDir: null }, runnerTickMs: 24 * 3600 * 1000,
    }));
    const dirs = Object.fromEntries(['claude', 'ag', 'gemini-tmp', 'vscode', 'agy', 'codex', 'copilot', 'hermes', 'opencode'].map((n) => [n, path.join(tempDir, n)]));
    fs.mkdirSync(path.join(dirs.claude, '.claude-manager'), { recursive: true });
    fs.mkdirSync(path.join(dirs.ag, 'brain'), { recursive: true });
    const env = {
      ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CONFIG_FILE: configFile, GLMPS_CLAUDE_DIR: dirs.claude, GLMPS_ANTIGRAVITY_DIR: dirs.ag,
      GLMPS_GEMINI_TMP_DIR: dirs['gemini-tmp'], GLMPS_VSCODE_STORAGE_DIR: dirs.vscode, GLMPS_AGY_CLI_DIR: dirs.agy, GLMPS_CODEX_DIR: dirs.codex,
      GLMPS_COPILOT_CLI_DIR: dirs.copilot, GLMPS_HERMES_DIR: dirs.hermes, GLMPS_OPENCODE_DIR: dirs.opencode, GLMPS_UNMERGED_SCAN: 'off', GLMPS_SCUT: 'off',
    };
    const { startServer } = await import('../server/server.js');
    srv = await startServer({ port: 0, pollMs: 100000, env, configFile, restartFn: () => {} });
    result.booted = true;
    const base = `http://127.0.0.1:${srv.port}`;
    const health = await fetch(`${base}/healthz`);
    if (!health.ok) return { ...result, reason: `/healthz answered ${health.status}` };
    const board = await fetch(`${base}/api/backlog`);
    if (!board.ok) return { ...result, reason: `/api/backlog answered ${board.status}` };
    const cards = (await board.json()).items?.length ?? null;
    result.cards = cards;
    if (cards !== expected) return { ...result, reason: `restored board has ${cards} cards, the backup's store has ${expected}` };
    return { ...result, ok: true };
  } catch (e) {
    return { ...result, reason: `drill error: ${e?.message ?? e}` };
  } finally {
    try { await srv?.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
}

/** Write `backup` into config.json; a dry run unless apply. Throws a named reason on an unusable target. */
export function enableBackup({ configFile, stateDir, target, hour = null, apply = false, now = Date.now }) {
  const warnings = [];
  createStateBackup({ stateDir, targetDir: target, requireSecondDisk: false }).checkTarget();
  try { createStateBackup({ stateDir, targetDir: target }).checkTarget(); }
  catch (e) { if (e.reason === 'target-same-volume') warnings.push('the target is on the same volume as the state dir; runs will fail until it is a second disk'); else throw e; }
  const current = readJson(configFile) ?? {};
  const backup = { ...(current.backup || {}), targetDir: path.resolve(target), ...(hour != null ? { hour } : {}) };
  const next = { ...current, backup };
  const out = { applied: false, configFile, backup, warnings, backupFile: null };
  if (!apply) return out;
  out.backupFile = snapshotConfig(configFile, { stateDir, now: () => new Date(now()) });
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + '\n');
  return { ...out, applied: true };
}

function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply' || a === '--same-disk-ok') flags[a.slice(2)] = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { flags, pos };
}

export async function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const { flags, pos } = parseArgs(rest);
  const configFile = flags.config ?? configFileFor({ env });
  const stateDir = path.resolve(flags.state ?? getPaths(env).stateDir);
  const targetDir = flags.target ?? readJson(configFile)?.backup?.targetDir ?? null;
  const sb = () => createStateBackup({ stateDir, targetDir, requireSecondDisk: !flags['same-disk-ok'] });
  const say = (s) => process.stdout.write(`${s}\n`);
  try {
    if (cmd === 'run') {
      const r = await sb().run();
      say(`backup written: ${r.dir} (${r.files} files, ${r.bytes} bytes, weekly ${r.weekly ?? 'unchanged'}, ${r.mirrored} mirror files, ${r.pruned.length} pruned)`);
      return 0;
    }
    if (cmd === 'verify') {
      const v = pos[0] ? await verifyBackup(pos[0]) : await sb().verify();
      say(v.ok ? `ok: ${v.checked} files match the manifest` : `FAILED: ${v.reason}`);
      return v.ok ? 0 : 1;
    }
    if (cmd === 'restore') {
      if (pos.length < 2) throw new Error('usage: restore <backupDir> <newStateDir>');
      const r = await restoreBackup(pos[0], pos[1], { liveStateDir: stateDir });
      say(`restored ${r.files} files and ${r.mirrored} mirror files into ${pos[1]}`);
      return 0;
    }
    if (cmd === 'drill') {
      const dir = pos[0] ?? sb().newestDaily();
      if (!dir) throw new Error('no complete daily backup to drill');
      const r = await drillBackup({ backupDir: dir, liveStateDir: stateDir });
      say(r.ok ? `drill ok: kernel booted on the restore, ${r.cards} cards match` : `drill FAILED: ${r.reason}`);
      return r.ok ? 0 : 1;
    }
    if (cmd === 'enable') {
      if (!flags.target) throw new Error('usage: enable --target <dir> [--hour N] [--config <file>] [--apply]');
      const r = enableBackup({ configFile, stateDir, target: flags.target, hour: flags.hour != null ? Number(flags.hour) : null, apply: !!flags.apply });
      for (const w of r.warnings) say(`warning: ${w}`);
      say(`${r.applied ? 'applied' : 'dry run (pass --apply to write)'}: ${r.configFile} backup = ${JSON.stringify(r.backup)}`);
      if (r.backupFile) say(`previous config saved to ${r.backupFile}`);
      if (r.applied) say('restart the server (settings gear, Restart server) to start the state-backup loop');
      return 0;
    }
    throw new Error('usage: state-backup.mjs run | verify | restore | drill | enable');
  } catch (e) {
    process.stderr.write(`state-backup: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
