// glmps-71: a sqlite-steps source that yields no events must not be
// re-drained on every poll.
//
// Found live: the agy-cli adapter was recording ~208 capture misses PER SECOND
// against 223 static .db files. The mtime gate in the poll loop was working;
// the *rehydrate* branch beside it was not gated at all:
//
//   if (!eventLog.has(desc.id) && prev.lastIdx > -1) drain(-1, ...)
//
// It exists to refill the in-memory ring after a restart, so it deliberately
// ignores mtime. But when a source produces ZERO events, `eventLog` never gains
// an entry for that id, so `!eventLog.has(desc.id)` stays true forever while a
// stale `lastIdx > -1` sits in offsets.json from when the source did have data.
// The result is one full re-drain per descriptor per poll, indefinitely.
//
// This is not agy-specific: it is reachable by any `sqlite-steps` source
// (hermes uses the same path) whose rows stop producing events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-redrain-'));
  tmpDirs.push(tmp);
  fs.mkdirSync(path.join(tmp, 'claude', '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    tmp,
    env: {
      GLMPS_CLAUDE_DIR: path.join(tmp, 'claude'),
      GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
      GLMPS_STATE_DIR: path.join(tmp, 'state'),
      GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
      GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
      GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
      GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
      GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
      GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
      GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
      GLMPS_UNMERGED_SCAN: 'off',
    },
  };
}

test('a zero-event sqlite-steps source with a stale offset is not re-drained every poll', { skip: !DatabaseSync }, async () => {
  resetAdapterHealth();
  const { tmp, env } = mkEnv();
  const conv = path.join(tmp, 'agy-cli', 'conversations');
  fs.mkdirSync(conv, { recursive: true });

  // The live shape: a .db that agy replaced with metadata-only tables, so the
  // `steps` table it once had is gone.
  const base = 'cccccccc-0000-0000-0000-000000000003';
  const file = path.join(conv, `${base}.db`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE gen_metadata (k TEXT, v TEXT)');
  db.close();

  // Seed the stale offset the live box actually carries (lastIdx=3 from when
  // the DB still had steps), with a matching mtime so the mtime gate is
  // satisfied and only the rehydrate branch can fire.
  const offsetsFile = path.join(env.GLMPS_STATE_DIR, 'state', 'offsets.json');
  fs.mkdirSync(path.dirname(offsetsFile), { recursive: true });
  fs.writeFileSync(offsetsFile, JSON.stringify({
    [`sql:agy:${base}`]: { lastIdx: 3, mtime: fs.statSync(file).mtimeMs },
  }));

  const srv = await startServer({ port: 0, pollMs: 50, env: env });
  try {
    await new Promise(r => setTimeout(r, 300));
    const early = adapterHealth()['agy-cli']?.misses ?? 0;
    await new Promise(r => setTimeout(r, 600));
    const late = adapterHealth()['agy-cli']?.misses ?? 0;

    // Before the fix this grows by one per poll (~12 over 600ms at pollMs=50)
    // and on the live server it grew at 208/second.
    assert.equal(late, early,
      `re-drained every poll: misses went ${early} -> ${late} while the file never changed`);
  } finally {
    resetAdapterHealth();
    await srv.close();
  }
});

test('a .db with no steps table is not reported as schema drift', { skip: !DatabaseSync }, async () => {
  resetAdapterHealth();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nosteps-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'sidecar.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE trajectory_meta (k TEXT, v TEXT)');
  db.close();

  const { extractSteps } = await import('../lib/adapters/agy-cli.js');
  const out = extractSteps(file, -1);

  assert.deepEqual(out.events, []);
  // A sidecar DB is not a conversation log and never was: absence of the table
  // is a classification fact, not upstream schema drift. health.js's own
  // contract is that only shape mismatches on successfully-read records count.
  assert.deepEqual(adapterHealth(), {},
    'a steps-less DB must not mark the adapter degraded');
  resetAdapterHealth();
});

test('a locked steps DB is transient, not schema drift', { skip: !DatabaseSync }, async () => {
  resetAdapterHealth();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-locked-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'busy.db');

  // Hold an exclusive write transaction open so the reader's query hits
  // SQLITE_BUSY. The open itself succeeds, so this lands in the query catch,
  // which is the path that used to mark the adapter degraded.
  const writer = new DatabaseSync(file);
  writer.exec('CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB)');
  writer.exec('PRAGMA locking_mode = EXCLUSIVE');
  writer.exec('BEGIN EXCLUSIVE');
  writer.exec("INSERT INTO steps (idx, step_type, step_payload) VALUES (1, 15, x'00')");

  const { extractSteps } = await import('../lib/adapters/agy-cli.js');
  const out = extractSteps(file, -1);

  assert.deepEqual(out.events, []);
  assert.deepEqual(adapterHealth(), {},
    'a transient lock must not mark the adapter degraded');

  try { writer.exec('COMMIT'); } catch {}
  writer.close();
  resetAdapterHealth();
});
