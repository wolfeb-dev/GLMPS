#!/usr/bin/env node
// scripts/install.mjs - one-command GLMPS installer.
//   node scripts/install.mjs              wire MC into Claude Code config
//   node scripts/install.mjs --uninstall  revert everything this installed
//   node scripts/install.mjs --hooks-only run/revert only step C (hooks)
//
// Wires three things into the user's Claude Code config with absolute paths:
//   A) ensure repo-root config.json exists (copy from config.example.json)
//   B) statusline tap (mirrors taps/install-tap.js: backup + delegate record)
//   C) every GLMPS hook from the one manifest
//   D) in a tap bundle only: point Claude Code's trace exporter at the local relay
//
// an unrecognized flag used to fall
// through argv.includes() checks and run the full A/B/C install anyway -
// that is exactly what sent a prior run at the real settings file. Every
// path below is refused rather than guessed at the first sign of trouble:
// an unknown flag, a partial GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR override, invalid
// JSON, or an unreadable hooks record all refuse with a named reason and
// write nothing, instead of silently coercing to a default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { buildSettingsPatch } from '../taps/statusline-chain-lib.js';
import { HOOK_MANIFEST, planHookInstall, planHookUninstall, planHookRepoint, resolveInstallPaths, settingsEqual } from './install-hooks-lib.mjs';
import { jsonErrorWhere } from './lib/json-error.mjs';

const scriptsDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsDir);
const chainPath = path.join(repoRoot, 'taps', 'statusline-chain.js');
// Run from a client tap bundle (task 7), the statusline must use the bundled
// node.exe: the client has no Node on PATH. A checkout keeps plain `node`.
const statuslineNode = fs.existsSync(path.join(repoRoot, 'tap-manifest.json')) ? process.execPath : 'node';

// Every path the installer touches comes from this one call, computed fresh
// from the CURRENT process.env/os.homedir() each time - never cached at a
// stale value from module load. Throws PartialHomeOverrideError when
// exactly one of GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR is set; callers below turn
// that into a clean refusal instead of a crash.
function paths() {
  return resolveInstallPaths({ env: process.env, homedir: os.homedir() });
}

function refuse(message) {
  console.error(`GLMPS: ${message}`);
  process.exitCode = 2;
  return false;
}

// A parsed settings.json (or record) must be a plain object - `[]`,
// `5`, `"hello"`, and `null` all parse as valid JSON but are not something
// this installer can spread a patch into.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// For a refusal message: typeof null is 'object', which would misreport a
// literal null as "got object" - name it explicitly instead.
function describeNotObject(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

// settings.json and the files beside it can hold credentials, and a
// JSON.parse message quotes the source around the error: a read failure is
// named by its code, a parse failure by its position only.
function readFailure(e) {
  return e instanceof SyntaxError ? `not valid JSON, ${jsonErrorWhere(e)}` : (e?.code ?? e?.message);
}


// A synchronous sleep for the retry backoff below. install.mjs is
// synchronous throughout (every fs call is the *Sync form), so the backoff
// has to be too - Atomics.wait on a throwaway SharedArrayBuffer is the
// standard way to block synchronously in Node without a native addon.
function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write to a temp file next to the RESOLVED
// target, then rename onto the resolved target - a crash or a concurrent
// read mid-write can never observe a half-written settings.json or hooks
// record this way (rename is atomic on the same filesystem/volume).
//
// Resolving the target with fs.realpathSync first (falling back to the
// path itself only on ENOENT - nothing there yet, so no symlink to worry
// about) means the rename replaces the REAL file's content while leaving an
// existing symlink at `file` untouched - a plain rename onto `file` directly
// would instead replace the symlink itself with a regular file, silently
// detaching an operator's dotfiles link.
//
// renameSync is retried with a bounded backoff (~10 attempts, ~1s
// total by default) before giving up - Defender, an indexer, or an editor
// holding a handle can make a rename fail transiently with EPERM/EACCES/
// EBUSY on Windows. On permanent failure it removes the leftover .tmp file
// and throws a named AtomicWriteError; it never falls back to a direct,
// non-atomic write. `rename`/`maxAttempts`/`backoffMs` are injectable so
// tests can force both a transient and a permanent failure without needing
// to reproduce a real file lock by chance.
//
// - A hard-linked target (a regular file with nlink > 1) is refused
//   with HardLinkedTargetError BEFORE any temp file exists. A rename onto
//   one name of a hard link gives that name a new inode, silently splitting
//   it from its twin; unlike a symlink there is no path to resolve through,
//   and an in-place write would give up atomicity, so refusing is the only
//   safe answer.
// - A realpath/lstat/stat failure other than ENOENT (EACCES, ELOOP)
//   is a named TargetResolveError, and mkdir, the temp write and the rename
//   all sit inside one try that removes the temp file on ANY failure and
//   wraps it as AtomicWriteError.
// - Realpath ENOENT on a path that is itself a symlink means a
//   DANGLING link, not "nothing here yet"; renaming onto it would replace
//   the link with a regular file, so it is refused (DanglingSymlinkError).
// - Only the transient lock codes (EPERM/EACCES/EBUSY) are retried;
//   anything else fails on the first attempt.
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

function resolveWriteTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw namedError('TargetResolveError', `could not resolve the write target ${file} (${e.code ?? e.message}); refusing to write it`);
  }
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return file; // genuinely nothing there yet
    throw namedError('TargetResolveError', `could not inspect the write target ${file} (${e.code ?? e.message}); refusing to write it`);
  }
  if (st.isSymbolicLink()) {
    throw namedError('DanglingSymlinkError', `${file} is a symlink whose target does not exist; refusing to replace the link with a regular file. Fix or remove the link first`);
  }
  return file;
}

function refuseHardLinkedTarget(file, target) {
  let st;
  try {
    st = fs.statSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw namedError('TargetResolveError', `could not inspect the write target ${target} (${e.code ?? e.message}); refusing to write it`);
  }
  if (st.isFile() && st.nlink > 1) {
    throw namedError('HardLinkedTargetError', `${file} is a hard link (${st.nlink} names share it); an atomic replace would split it from its other names, so refusing to write it. Replace the hard link with a symlink or a plain file first`);
  }
}

export function atomicWriteFileSync(file, content, { rename = fs.renameSync, writeFile = fs.writeFileSync, maxAttempts = 10, backoffMs = 100 } = {}) {
  const target = resolveWriteTarget(file);
  refuseHardLinkedTarget(file, target);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`);
  let attempts = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeFile(tmp, content);
    for (;;) {
      attempts++;
      try {
        rename(tmp, target);
        return;
      } catch (e) {
        if (!RETRYABLE_RENAME_CODES.has(e.code) || attempts >= maxAttempts) throw e;
        sleepSyncMs(backoffMs);
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (unlinkErr) {
      if (unlinkErr.code !== 'ENOENT') console.error(`atomic write: could not remove the leftover temp file ${tmp} (${unlinkErr.message}).`);
    }
    const tries = attempts > 1 ? ` after ${attempts} attempts` : '';
    throw namedError('AtomicWriteError', `atomic write to ${file} failed${tries}: ${e.message}`);
  }
}

function writeSettings(settingsFile, obj) {
  atomicWriteFileSync(settingsFile, JSON.stringify(obj, null, 2));
}

// distinguishes "never installed" (ENOENT -> {}) from "installed once,
// record now unreadable" (any other error -> named throw). A corrupt record
// must never be silently treated as empty - that would lose track of hooks
// that may still be sitting in settings.json.
function readRecord(hooksRecordFile) {
  let raw;
  try {
    raw = fs.readFileSync(hooksRecordFile, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    const err = new Error(`hooks record ${hooksRecordFile} could not be read: ${e.message}`);
    err.name = 'HooksRecordReadError';
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`hooks record ${hooksRecordFile} is corrupt (${jsonErrorWhere(e)})`);
    err.name = 'HooksRecordCorruptError';
    throw err;
  }
  // a record that parses as valid JSON but is not a plain object
  // ([]/null/5) is just as untrustworthy as one that fails to parse at
  // all - refuse before any write, rather than spreading a non-object into
  // { added: [...] } later.
  if (!isPlainObject(parsed)) {
    const err = new Error(`hooks record ${hooksRecordFile}'s top level must be an object, got ${describeNotObject(parsed)}`);
    err.name = 'HooksRecordCorruptError';
    throw err;
  }
  return parsed;
}

function writeRecord(hooksRecordFile, obj) {
  atomicWriteFileSync(hooksRecordFile, JSON.stringify(obj, null, 2));
}


function ensureConfig() {
  // GLMPS_CONFIG_FILE is the same override server/lib/paths.js reads, so a test
  // can run a full install without writing the checkout's own config.json.
  const configFile = process.env.GLMPS_CONFIG_FILE || path.join(repoRoot, 'config.json');
  const exampleFile = path.join(repoRoot, 'config.example.json');
  if (fs.existsSync(configFile)) {
    console.log('A) config.json: already exists, leaving as-is.');
    return;
  }
  if (!fs.existsSync(exampleFile)) {
    console.log('A) config.json: missing and no config.example.json to copy - skipped.');
    return;
  }
  fs.copyFileSync(exampleFile, configFile);
  console.log('A) config.json: created from config.example.json.');
}


// takes the already-parsed settings (from runInstall's one shared parse)
// so a malformed file is refused once, up front, instead of B silently
// coercing it to {}.
function installStatusline({ settingsFile, stateDir, delegateFile, settings }) {
  const { patched, previousCommand } = buildSettingsPatch(settings, chainPath, statuslineNode);
  // A non-string command (5, {}, []) has no
  // String .includes and used to crash here with a raw TypeError. It is not
  // a command anything can chain to, so refuse by name before any write.
  if (previousCommand !== null && typeof previousCommand !== 'string') {
    return refuse(`settings.json's statusLine.command must be a string, got ${describeNotObject(previousCommand)}; refusing to replace it.`);
  }
  if (previousCommand?.includes('statusline-chain.js')) {
    console.log('B) statusline tap: already installed.');
    return true;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  // back up settings.json only if a backup does not already exist -
  // otherwise a later call would overwrite the first, true backup with an
  // already-modified file. The backup copy itself is now atomic too
  // (read the source, write the copy via the same temp-file-plus-rename
  // path as everything else) - a crash mid-copy must never leave a
  // half-written .mc-backup behind either.
  const mcBackupFile = `${settingsFile}.mc-backup`;
  if (fs.existsSync(settingsFile) && !fs.existsSync(mcBackupFile)) atomicWriteFileSync(mcBackupFile, fs.readFileSync(settingsFile));
  atomicWriteFileSync(delegateFile, JSON.stringify({ command: previousCommand }));
  writeSettings(settingsFile, patched);
  console.log(`B) statusline tap: installed. Previous command saved: ${previousCommand}`);
  return true;
}

// this used to restore-or-delete
// settings.statusLine purely from the delegate record, with no check that
// the CURRENT statusLine was still the GLMPS chain tap. An operator who set
// their own statusLine after install (scenario A: the delegate had no prior
// command, so uninstall used to delete it) or who replaced the chain tap
// with a third statusLine (scenario B: uninstall used to overwrite it with
// the stale delegate value) would have their real, current setting silently
// destroyed. Only ever touch statusLine when it is still, right now,
// the chain tap this installer put there; otherwise leave it and the
// delegate file alone (there is nothing of ours left to undo). The delegate
// is deleted only after a genuine restore/removal - it stops describing
// anything once that happens.
// a settings.json that does not exist, or that
// exists but is empty, is not a malformed-file error - there is nothing to
// parse and therefore nothing to restore. Both now return true with a log
// line, matching a fresh/never-installed machine, instead of refusing.
function uninstallStatusline({ settingsFile, delegateFile }) {
  let raw;
  try {
    raw = fs.readFileSync(settingsFile, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('B) statusline tap: no settings.json found - nothing to restore.');
      return true;
    }
    refuse(`settings.json could not be read (${e.message}); refusing to restore the statusline.`);
    return false;
  }
  if (raw === '') {
    console.log('B) statusline tap: settings.json is empty - nothing to restore.');
    return true;
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    refuse(`settings.json could not be read (${readFailure(e)}); refusing to restore the statusline.`);
    return false;
  }
  if (!isPlainObject(settings)) {
    refuse(`settings.json's top level must be an object, got ${describeNotObject(settings)}; refusing to restore the statusline.`);
    return false;
  }
  // guard against a non-string statusLine.command (a number, object, or
  // array parses fine as JSON but has no .includes method - or the wrong
  // one) before ever calling .includes on it.
  const currentCommand = settings.statusLine?.command;
  if (typeof currentCommand !== 'string' || !currentCommand.includes('statusline-chain.js')) {
    console.log('B) statusline tap: statusLine is no longer the GLMPS chain tap (changed since install) - leaving it as-is.');
    return true;
  }

  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(delegateFile, 'utf-8')).command;
  } catch (e) {
    console.log(`B) statusline tap: no delegate record found (${readFailure(e)}) - nothing to restore.`);
    console.log(`   Manual recovery if needed: restore from ${settingsFile}.mc-backup`);
    return true;
  }
  if (prev) {
    settings.statusLine = { type: 'command', ...(settings.statusLine ?? {}), command: prev };
    writeSettings(settingsFile, settings);
    console.log(`B) statusline tap: restored previous command: ${prev}`);
  } else {
    delete settings.statusLine; // there was no statusline before install
    writeSettings(settingsFile, settings);
    console.log('B) statusline tap: removed (none existed before install).');
  }
  try {
    fs.rmSync(delegateFile);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`B) statusline tap: could not remove the delegate file (${e.message}).`);
  }
  return true;
}


// preRaw is the settings bytes captured BEFORE any step in this run
// touched the file (runInstall captures it before calling installStatusline
// in the full, non-hooks-only path). The hooks backup must be the true
// pre-change state, not whatever B already rewrote the file to - otherwise
// a full uninstall (B undone, then C undone) can never land back on a
// byte-for-byte match, because C's own backup would still carry B's change.
function installHooks({ settingsFile, hooksRecordFile, hooksBackupFile, raw, preRaw }) {
  // preRaw (when this run's B step ran) is the state from BEFORE
  // anything in this run touched the file; `raw` alone (used naively) is
  // already post-B on the full path, so a file that did not exist before
  // this run at all would look like it always existed by the time C runs.
  const backupSourceRaw = preRaw !== undefined ? preRaw : raw;
  let settings = {};
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      refuse(`settings.json is not valid JSON (${jsonErrorWhere(e)}); refusing to touch it.`);
      return false;
    }
    if (!isPlainObject(parsed)) {
      refuse(`settings.json's top level must be an object, got ${describeNotObject(parsed)}; refusing to touch it.`);
      return false;
    }
    settings = parsed;
  }
  const { patched, added, adopted, entries } = planHookInstall(settings, { repoRoot, nodePath: process.execPath });
  let rec;
  try {
    rec = readRecord(hooksRecordFile);
  } catch (e) {
    refuse(`hooks record is unreadable (${e.message}); refusing to install without knowing what is already tracked.`);
    return false;
  }
  if (!added.length) {
    // Settings are untouched, but the record still lists every entry, so a
    // machine where all of them were registered by hand shows the full set.
    writeRecord(hooksRecordFile, { ...rec, added: rec.added || [], entries });
    console.log(`C) hooks: all ${HOOK_MANIFEST.length} already registered (${adopted.length} adopted).`);
    return true;
  }
  // An empty settings file (0 bytes) and "no file at all" both back
  // up as "nothing to restore" rather than writing an empty backup file
  // that would later crash JSON.parse on every uninstall attempt.
  if (backupSourceRaw != null && backupSourceRaw !== '' && !fs.existsSync(hooksBackupFile)) {
    atomicWriteFileSync(hooksBackupFile, backupSourceRaw);
  }
  // Capture, on the FIRST install only, whether settingsFile existed
  // at all (from the true pre-run state, per M-a above) - a later uninstall
  // uses this to decide whether to remove the file entirely rather than
  // leave a lone {} behind. a file that existed but was empty (0
  // bytes) is a THIRD state - tracked separately so uninstall restores it to
  // empty rather than deleting it or writing literal "{}".
  const existed = rec.existed !== undefined ? rec.existed : backupSourceRaw != null;
  const wasEmptyString = rec.wasEmptyString !== undefined ? rec.wasEmptyString : backupSourceRaw === '';
  // Settings BEFORE the record - if the settings write fails
  // (AtomicWriteError propagates out of writeSettings, uncaught here on
  // purpose), the record must not already claim these hooks are installed,
  // or a retried install would duplicate rec.added against unwritten hooks.
  writeSettings(settingsFile, patched);
  // Settings are already written at this point, so a
  // record-write refusal must not read like "nothing happened" - the hooks
  // ARE in settings but untracked, and uninstall will not know to remove
  // them. Say so, and name every one, so the operator can remove them.
  try {
    writeRecord(hooksRecordFile, { added: [...(rec.added || []), ...added], backup: hooksBackupFile, settingsFile, existed, wasEmptyString, entries });
  } catch (e) {
    if (!KNOWN_REFUSAL_ERRORS.has(e?.name)) throw e;
    const list = added.map((a) => `${a.id} (${a.event}: ${a.command})`).join('; ');
    return refuse(`${e.message}. The hooks WERE written to ${settingsFile} but could not be recorded in ${hooksRecordFile}, so --uninstall will not remove them. Remove these ${added.length} entries by hand (a re-run would adopt them, not record them): ${list}.`);
  }
  console.log(`C) hooks: registered ${added.length}, adopted ${adopted.length}: ${added.map((a) => a.id).join(', ')}`);
  return true;
}

function uninstallHooks({ settingsFile, hooksRecordFile }) {
  let rec;
  try {
    rec = readRecord(hooksRecordFile);
  } catch (e) {
    refuse(`hooks record is unreadable (${e.message}); refusing to uninstall blind.`);
    return false;
  }
  if (!rec.added?.length) {
    console.log('C) hooks: nothing recorded as installed.');
    return true;
  }
  // refuse if this run's settingsFile does not match the one the record
  // was written against - a different GLMPS_CLAUDE_DIR/home between install
  // and uninstall must never operate on the wrong file.
  if (rec.settingsFile && rec.settingsFile !== settingsFile) {
    refuse(`the hooks record was written for ${rec.settingsFile}, not ${settingsFile}; refusing to uninstall against a different settings file.`);
    return false;
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch (e) {
    // a missing or malformed settings.json on uninstall is a named
    // refusal, not an uncaught stack trace.
    refuse(`settings.json could not be read (${readFailure(e)}); refusing to uninstall.`);
    return false;
  }
  if (!isPlainObject(settings)) {
    refuse(`settings.json's top level must be an object, got ${describeNotObject(settings)}; refusing to uninstall.`);
    return false;
  }
  const { patched, removed, notFound } = planHookUninstall(settings, rec.added);

  let backupRaw = null;
  if (rec.backup) {
    try {
      backupRaw = fs.existsSync(rec.backup) ? fs.readFileSync(rec.backup, 'utf-8') : null;
    } catch (e) {
      console.error(`C) hooks: could not read the backup file (${e.message}); falling back to a non-byte-identical restore.`);
      backupRaw = null;
    }
  }
  // parse the backup exactly once, with a named reason on failure -
  // never re-parse it later outside a try (that is what made a corrupt or
  // empty backup crash every subsequent uninstall attempt: "SyntaxError
  // forever"). An empty backup (0 bytes) is treated the same as no backup.
  let backupParsed;
  if (backupRaw != null && backupRaw !== '') {
    try {
      backupParsed = JSON.parse(backupRaw);
    } catch (e) {
      console.error(`C) hooks: backup file is corrupt (${jsonErrorWhere(e)}); falling back to a non-byte-identical restore.`);
      backupParsed = undefined;
    }
  }
  // order-insensitive, empty-container-aware comparison (see
  // install-hooks-lib.mjs) instead of a JSON.stringify string compare, so
  // an empty-vs-absent hooks key never masquerades as an unrelated change.
  const same = backupParsed !== undefined && settingsEqual(backupParsed, patched);

  if (same) {
    atomicWriteFileSync(settingsFile, backupRaw);
    fs.rmSync(rec.backup);
  } else if (rec.existed === false && settingsEqual(patched, {})) {
    // the file did not exist before install and nothing real is left in
    // it now - remove it, do not leave a lone {} behind.
    if (fs.existsSync(settingsFile)) fs.rmSync(settingsFile);
  } else if (rec.existed === true && rec.wasEmptyString && settingsEqual(patched, {})) {
    // The file existed but was empty (0 bytes) before install, and
    // nothing real is left now - restore it to empty, the documented
    // preference over deleting it or writing literal "{}".
    atomicWriteFileSync(settingsFile, '');
  } else {
    atomicWriteFileSync(settingsFile, JSON.stringify(patched, null, 2));
  }

  // Keep entries that could not be found (and the backup/settingsFile
  // /existed bookkeeping they still need) instead of clearing the whole
  // record - an entry nobody actually removed must not be forgotten.
  const stillPending = rec.added.filter((a) => notFound.includes(a.id));
  if (stillPending.length) {
    writeRecord(hooksRecordFile, { added: stillPending, backup: rec.backup, settingsFile: rec.settingsFile, existed: rec.existed, wasEmptyString: rec.wasEmptyString });
  } else {
    // Nothing left pending - remove the orphaned backup file too (the
    // `same` branch above already did for its own case), so a later,
    // unrelated install never mistakes a stale backup for "already backed
    // up this cycle" and skips taking a fresh one.
    if (!same && rec.backup && fs.existsSync(rec.backup)) fs.rmSync(rec.backup);
    writeRecord(hooksRecordFile, { added: [] });
  }

  const notFoundNote = notFound.length ? `, ${notFound.length} not found (${notFound.join(', ')})` : '';
  console.log(`C) hooks: removed ${removed}${notFoundNote}${same ? ' (original bytes restored)' : ''}.`);
  return true;
}


// Step D (card glmps-2-0-runtime-39): a tap bundle points Claude Code's trace
// exporter at the tap agent's relay, which spools the spans. Prompt, tool-detail
// and tool-content logging stay off (no OTEL_LOG_* keys), so spans stay redacted.
const DEFAULT_TAP_PORT = 8123;

function tapPort(tapRoot) {
  try {
    const port = JSON.parse(fs.readFileSync(path.join(tapRoot, 'tap-config.json'), 'utf-8'))?.port;
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  } catch { /* no config yet: the agent's own default applies */ }
  return DEFAULT_TAP_PORT;
}

function tapOtelEnv(port) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
  };
}

// Skips whole (never a partial write) when the user already has a different
// exporter configured. Only keys that were absent are recorded as ours, so an
// identical value the user set themselves survives uninstall.
export function installTapOtel({ settingsFile, recordFile, tapRoot = repoRoot }) {
  if (!fs.existsSync(path.join(tapRoot, 'tap-manifest.json'))) return true;
  let raw = null;
  try {
    raw = fs.readFileSync(settingsFile, 'utf-8');
  } catch (e) {
    if (e.code !== 'ENOENT') return refuse(`settings.json could not be read (${e.code ?? e.message}); refusing to add the tap exporter.`);
  }
  let settings = {};
  if (raw) {
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      return refuse(`settings.json is not valid JSON (${jsonErrorWhere(e)}); refusing to add the tap exporter.`);
    }
    if (!isPlainObject(settings)) return refuse(`settings.json's top level must be an object, got ${describeNotObject(settings)}; refusing to add the tap exporter.`);
  }
  if (settings.env !== undefined && !isPlainObject(settings.env)) {
    console.log(`D) tap exporter: skipped, settings.json's env is ${describeNotObject(settings.env)}, not an object.`);
    return true;
  }
  const env = settings.env ?? {};
  const wanted = tapOtelEnv(tapPort(tapRoot));
  const conflicts = Object.keys(wanted).filter((k) => env[k] !== undefined && env[k] !== wanted[k]);
  if (conflicts.length) {
    console.log(`D) tap exporter: skipped, settings.json env already sets ${conflicts.join(', ')} to a different value (your own exporter).`);
    return true;
  }
  const toAdd = Object.keys(wanted).filter((k) => env[k] === undefined);
  if (!toAdd.length) {
    console.log('D) tap exporter: already configured.');
    return true;
  }
  let rec;
  try {
    rec = readRecord(recordFile);
  } catch (e) {
    return refuse(`tap exporter record is unreadable (${e.message}); refusing to install without knowing what is already tracked.`);
  }
  const mcBackupFile = `${settingsFile}.mc-backup`;
  if (raw && !fs.existsSync(mcBackupFile)) atomicWriteFileSync(mcBackupFile, raw);
  const createdEnv = rec.createdEnv ?? settings.env === undefined;
  settings.env = { ...env, ...Object.fromEntries(toAdd.map((k) => [k, wanted[k]])) };
  writeSettings(settingsFile, settings);
  try {
    writeRecord(recordFile, { settingsFile, createdEnv, added: { ...(rec.added ?? {}), ...Object.fromEntries(toAdd.map((k) => [k, wanted[k]])) } });
  } catch (e) {
    if (!KNOWN_REFUSAL_ERRORS.has(e?.name)) throw e;
    return refuse(`${e.message}. The tap exporter keys WERE written to ${settingsFile} but could not be recorded, so --uninstall will not remove them: ${toAdd.join(', ')}.`);
  }
  console.log(`D) tap exporter: set ${toAdd.length} env keys in settings.json (spans go to the local relay).`);
  return true;
}

// Removes only keys still holding the value this installer wrote.
export function uninstallTapOtel({ settingsFile, recordFile }) {
  let rec;
  try {
    rec = readRecord(recordFile);
  } catch (e) {
    return refuse(`tap exporter record is unreadable (${e.message}); refusing to uninstall blind.`);
  }
  if (!isPlainObject(rec.added) || !Object.keys(rec.added).length) {
    console.log('D) tap exporter: nothing recorded as installed.');
    return true;
  }
  if (rec.settingsFile && rec.settingsFile !== settingsFile) {
    return refuse(`the tap exporter record was written for ${rec.settingsFile}, not ${settingsFile}; refusing to uninstall against a different settings file.`);
  }
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch (e) {
    if (e.code !== 'ENOENT') return refuse(`settings.json could not be read (${readFailure(e)}); refusing to remove the tap exporter.`);
  }
  let removed = 0;
  if (settings !== null) {
    if (!isPlainObject(settings)) return refuse(`settings.json's top level must be an object, got ${describeNotObject(settings)}; refusing to remove the tap exporter.`);
    if (isPlainObject(settings.env)) {
      for (const [k, v] of Object.entries(rec.added)) {
        if (settings.env[k] === v) { delete settings.env[k]; removed++; }
      }
      if (rec.createdEnv && !Object.keys(settings.env).length) delete settings.env;
      if (removed) writeSettings(settingsFile, settings);
    }
  }
  fs.rmSync(recordFile, { force: true });
  console.log(`D) tap exporter: removed ${removed} env keys.`);
  return true;
}

// A write deep inside installStatusline/installHooks/uninstallHooks
// can throw a named AtomicWriteError (a rename that never succeeded) or
// SettingsTooDeepError (planHookInstall/planHookUninstall's clone refused a
// pathological settings object) - both are anticipated, named failure modes
// that must become a clean refusal, not an uncaught stack trace. Anything
// else is a genuine bug and must NOT be swallowed here.
const KNOWN_REFUSAL_ERRORS = new Set(['AtomicWriteError', 'SettingsTooDeepError', 'HardLinkedTargetError', 'DanglingSymlinkError', 'TargetResolveError']);
function asRefusal(fn) {
  try {
    return fn();
  } catch (e) {
    if (KNOWN_REFUSAL_ERRORS.has(e?.name)) return refuse(`${e.message}.`);
    throw e;
  }
}

export function runInstall({ hooksOnly = false, tapRoot = repoRoot } = {}) {
  return asRefusal(() => runInstallUnsafe({ hooksOnly, tapRoot }));
}

function runInstallUnsafe({ hooksOnly = false, tapRoot = repoRoot } = {}) {
  let P;
  try {
    P = paths();
  } catch (e) {
    return refuse(`${e.message}. Nothing was written.`);
  }
  // one shared parse up front - a malformed settings.json refuses
  // before EITHER B or C touches anything, instead of B silently coercing
  // it to {} while C separately (and inconsistently) refuses.
  // A read failure other than "no file" (EISDIR, EACCES) used to
  // escape as a raw stack trace; it is a named refusal now.
  let raw = null;
  try {
    raw = fs.readFileSync(P.settingsFile, 'utf-8');
  } catch (e) {
    if (e.code !== 'ENOENT') return refuse(`settings.json could not be read (${e.code ?? e.message}); refusing to touch it. Nothing was written.`);
  }
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return refuse(`settings.json is not valid JSON (${jsonErrorWhere(e)}); refusing to touch it. Nothing was written.`);
    }
    // A valid-JSON, non-object top level ([], 5, "hello", null) is
    // refused here too - before either B or C ever tries to spread a patch
    // into it.
    if (!isPlainObject(parsed)) {
      return refuse(`settings.json's top level must be an object, got ${describeNotObject(parsed)}; refusing to touch it. Nothing was written.`);
    }
  }
  // Thread an explicit ok/false status through instead of reading
  // process.exitCode back at the end - a global mutable flag is one more
  // thing that could be set by something unrelated and misreported here.
  let preRaw;
  if (!hooksOnly) {
    preRaw = raw; // captured BEFORE installStatusline changes the file
    ensureConfig();
    if (!installStatusline({ ...P, settings: raw ? JSON.parse(raw) : {} })) return false;
  }
  const rawAfterB = hooksOnly ? raw : (fs.existsSync(P.settingsFile) ? fs.readFileSync(P.settingsFile, 'utf-8') : null);
  if (!installHooks({ ...P, raw: rawAfterB, preRaw })) return false;
  if (hooksOnly) return true;
  return installTapOtel({ settingsFile: P.settingsFile, recordFile: P.tapOtelRecordFile, tapRoot });
}

export function runUninstall({ hooksOnly = false } = {}) {
  return asRefusal(() => runUninstallUnsafe({ hooksOnly }));
}

function runUninstallUnsafe({ hooksOnly = false } = {}) {
  let P;
  try {
    P = paths();
  } catch (e) {
    return refuse(`${e.message}. Nothing was written.`);
  }
  // a genuine statusline refusal (a malformed settings.json, not the
  // "nothing to restore" no-op) must stop here - proceeding to uninstall
  // hooks against a file whose state B already declined to trust is not
  // safe just because C parses it independently.
  // Before the statusline and hooks steps, so their byte-for-byte restore sees the
  // settings as they were before this step wrote its keys.
  if (!hooksOnly && !uninstallTapOtel({ settingsFile: P.settingsFile, recordFile: P.tapOtelRecordFile })) return false;
  if (!hooksOnly && !uninstallStatusline(P)) return false;
  return uninstallHooks(P);
}

// Guard: only execute when this file is run directly, not when imported
// (glmps-init.mjs imports runInstall with its own, unrelated argv).

const KNOWN_FLAGS = new Set(['--uninstall', '--hooks-only', '--dry-run']);

/**
 * After a checkout move: points every GLMPS hook and the statusline tap that
 * runs from `fromRoot` at this checkout instead. Dry run lists each change;
 * otherwise settings.json and the install record are backed up and rewritten.
 * Returns { ok, changes, backup }.
 */
export function runRepoint({ fromRoot, dryRun = false, toRoot = repoRoot, now = Date.now, out = console.log } = {}) {
  let p;
  try { p = paths(); } catch (e) { refuse(`${e.message}; nothing was written.`); return { ok: false, changes: [] }; }
  const { settingsFile, hooksRecordFile } = p;
  let raw;
  try { raw = fs.readFileSync(settingsFile, 'utf-8'); } catch (e) { refuse(`settings.json could not be read (${readFailure(e)}); nothing was written.`); return { ok: false, changes: [] }; }
  let settings;
  try { settings = JSON.parse(raw); } catch (e) { refuse(`settings.json is not valid JSON (${jsonErrorWhere(e)}); refusing to touch it.`); return { ok: false, changes: [] }; }
  if (!isPlainObject(settings)) { refuse(`settings.json's top level must be an object, got ${describeNotObject(settings)}; refusing to touch it.`); return { ok: false, changes: [] }; }
  let record;
  try { record = readRecord(hooksRecordFile); } catch (e) { refuse(`${e.message}; nothing was written.`); return { ok: false, changes: [] }; }
  const plan = planHookRepoint(settings, { fromRoot, toRoot, record });
  // The script each moved command now names: from the new root to the next quote or space.
  const scriptIn = (cmd) => {
    const fold = (s) => s.replace(/\\/g, '/').toLowerCase();
    const i = fold(cmd).indexOf(fold(toRoot).replace(/\/+$/, ''));
    return i < 0 ? null : /^[^"'\s]+/.exec(cmd.slice(i))?.[0] ?? null;
  };
  const missing = plan.changes.filter((c) => { const s = scriptIn(c.to); return !s || !fs.existsSync(s); });
  if (missing.length) {
    refuse(`${missing.length} repointed script(s) do not exist under ${toRoot} (first: ${missing[0].to}); nothing was written.`);
    return { ok: false, changes: plan.changes };
  }
  for (const c of plan.changes) out(`  ${dryRun ? 'would repoint' : 'repoint'} ${c.where}: ${c.from} -> ${c.to}`);
  if (!plan.changes.length) { out(`repoint: no GLMPS hook or statusline tap runs from ${fromRoot}; nothing to do.`); return { ok: true, changes: [] }; }
  if (dryRun) { out(`repoint (dry run): ${plan.changes.length} entr${plan.changes.length === 1 ? 'y' : 'ies'} would move to ${toRoot}.`); return { ok: true, changes: plan.changes }; }
  const backup = `${settingsFile}.bak-repoint-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
  atomicWriteFileSync(backup, raw);
  if (fs.existsSync(hooksRecordFile)) atomicWriteFileSync(`${hooksRecordFile}.bak-repoint-${path.basename(backup).split('-repoint-')[1]}`, fs.readFileSync(hooksRecordFile));
  writeSettings(settingsFile, plan.patched);
  if (fs.existsSync(hooksRecordFile)) writeRecord(hooksRecordFile, plan.record);
  out(`repoint: moved ${plan.changes.length} entr${plan.changes.length === 1 ? 'y' : 'ies'} to ${toRoot}; previous settings saved to ${backup}.`);
  return { ok: true, changes: plan.changes, backup };
}

function main() {
  const extraArgs = process.argv.slice(2);
  const repointArg = extraArgs.find((a) => a.startsWith('--repoint-from='));
  if (repointArg) {
    const fromRoot = repointArg.slice('--repoint-from='.length);
    const rest = extraArgs.filter((a) => a !== repointArg && a !== '--dry-run');
    if (!fromRoot || rest.length) { refuse(`--repoint-from=<dir> takes only --dry-run alongside it; nothing was written.`); return; }
    console.log(`GLMPS: repointing hooks from ${fromRoot} to ${repoRoot}${extraArgs.includes('--dry-run') ? ' (dry run)' : ''}...`);
    runRepoint({ fromRoot, dryRun: extraArgs.includes('--dry-run') });
    return;
  }
  if (extraArgs.includes('--dry-run')) { refuse('--dry-run is only for --repoint-from=<dir>; nothing was written.'); return; }
  // Array.prototype.find() returns the found
  // ELEMENT, and an empty string is falsy - `node install.mjs ""` found the
  // bad '' entry via find(), but `if (unknown)` never fired for a falsy
  // find() result, so the full install ran anyway. filter().length is never
  // fooled by which element was found.
  const unknownArgs = extraArgs.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknownArgs.length) {
    refuse(`unknown flag '${unknownArgs[0]}'; known flags are --uninstall and --hooks-only. Nothing was written.`);
    return;
  }
  const uninstall = extraArgs.includes('--uninstall');
  const hooksOnly = extraArgs.includes('--hooks-only');
  if (uninstall) {
    console.log('GLMPS: uninstalling...');
    if (runUninstall({ hooksOnly })) console.log('Done. (config.json left in place.)');
  } else {
    console.log(`GLMPS: installing (repo: ${repoRoot})...`);
    if (runInstall({ hooksOnly })) console.log('Done. Run the dashboard with: node server/server.js');
  }
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
