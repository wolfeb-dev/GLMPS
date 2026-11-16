// server/test/install-hooks-io.test.js
// The byte-for-byte restore is a property of install.mjs's I/O, so this test
// exercises the real files through a temp home: it never touches the real
// ~/.claude or ~/.glmps. Every child process below redirects
// HOME/USERPROFILE to a temp dir in addition to GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR,
// so a gap in the installer's own GLMPS_* wiring can never fall through to the
// operator's real settings file. K Task 13 fix round 1: PRODUCTION HOME IS
// OFF LIMITS - no test here (or anywhere) may stat, read, or write a path
// under the real home; see resolveInstallPaths's own pure tests in
// install-hooks.test.js for the partial-override/homedir-fallback coverage
// that used to require stat-ing the real settings file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../../scripts/install.mjs';
import { HOOK_MANIFEST } from '../../scripts/install-hooks-lib.mjs';

// every repo path is resolved from this file's own
// location, never from process.cwd() - a test run from another directory
// must still spawn THIS worktree's scripts, not whatever sits under cwd.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const installScript = path.join(repoRoot, 'scripts', 'install.mjs');
const chainScript = path.join(repoRoot, 'taps', 'statusline-chain.js');

function tmpLeftovers(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes('.tmp-')) : [];
}

// Every mkdtemp dir made by a test is removed here, pass or fail (M11).
function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hooks-home-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// A full install copies config.example.json to config.json; it lands in the
// temp home, never in the checkout that C1 below watches.
function run(env, ...args) {
  const withConfig = { GLMPS_CONFIG_FILE: path.join(env.HOME ?? os.tmpdir(), 'repo-config.json'), ...env };
  return execFileSync(process.execPath, [installScript, ...args], { env: withConfig, encoding: 'utf8' });
}

function runExpectFailure(env, ...args) {
  try {
    run(env, ...args);
    return null;
  } catch (e) {
    return e;
  }
}

test('install then uninstall restores the original bytes; install twice changes nothing', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const original = '{\n    "model": "opus",\n    "hooks": {}\n}\n';   // 4-space indent: not what JSON.stringify(..., 2) writes
    fs.writeFileSync(file, original);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };
    run(env, '--hooks-only'); const afterOnce = fs.readFileSync(file, 'utf8');
    run(env, '--hooks-only'); assert.equal(fs.readFileSync(file, 'utf8'), afterOnce, 'second install is a no-op');
    run(env, '--hooks-only', '--uninstall'); assert.equal(fs.readFileSync(file, 'utf8'), original, 'byte-for-byte');
  });
});

test('a malformed settings.json refuses with a named error and writes nothing', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const broken = '{ not valid json';
    fs.writeFileSync(file, broken);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    const error = runExpectFailure(env, '--hooks-only');
    assert.ok(error, 'a malformed settings.json must make the installer exit non-zero');
    assert.equal(error.status, 2);
    assert.match(String(error.stderr || error.stdout || error.message), /not valid JSON/, 'the refusal names the reason');
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the file must be left exactly as it was');
  });
});

// the incident that sent a prior run at the real settings
// file happened because an unrecognized flag silently ran the full A/B/C
// install instead of refusing. Any argv entry that is not exactly
// --uninstall or --hooks-only must refuse, name the flag, exit 2, and write
// nothing anywhere - including a typo one character away from a real flag.
for (const badFlag of ['--hooks-onyl', '--uninstal', '--hooks-only-extra', 'garbage', '']) {
  test(`C1: an unknown flag (${JSON.stringify(badFlag)}) refuses and writes nothing`, () => {
    withTempHome((home) => {
      const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
      const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };
      const repoConfig = path.join(repoRoot, 'config.json');
      const beforeMtime = fs.existsSync(repoConfig) ? fs.statSync(repoConfig).mtimeMs : null;

      const error = runExpectFailure(env, badFlag);
      assert.ok(error, `${JSON.stringify(badFlag)} must make the installer exit non-zero`);
      assert.equal(error.status, 2);
      if (badFlag) assert.match(String(error.stderr || error.message), new RegExp(badFlag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the refusal names the exact flag');
      assert.ok(!fs.existsSync(path.join(claude, 'settings.json')), 'no settings.json must be created');
      assert.ok(!fs.existsSync(path.join(home, '.glmps')), 'no .glmps dir must be created');
      const afterMtime = fs.existsSync(repoConfig) ? fs.statSync(repoConfig).mtimeMs : null;
      assert.equal(afterMtime, beforeMtime, 'no new repo config.json must appear either');
    });
  });
}

// Array.prototype.find() returns the found
// element itself, and an empty string is falsy - `node install.mjs "$MODE"`
// with MODE unset silently ran the full install because `find()` found the
// bad '' entry but `if (unknown)` never fired for it. --hooks-only alongside
// a stray empty argv entry must refuse too, not just a bare ''.
test('I1: --hooks-only alongside a stray empty argv entry refuses and writes nothing', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };
    const repoConfig = path.join(repoRoot, 'config.json');
    const beforeMtime = fs.existsSync(repoConfig) ? fs.statSync(repoConfig).mtimeMs : null;

    const error = runExpectFailure(env, '--hooks-only', '');
    assert.ok(error, 'a trailing empty argv entry must make the installer exit non-zero even alongside a real flag');
    assert.equal(error.status, 2);
    assert.ok(!fs.existsSync(path.join(claude, 'settings.json')), 'no settings.json must be created');
    assert.ok(!fs.existsSync(path.join(home, '.glmps')), 'no .glmps dir must be created');
    const afterMtime = fs.existsSync(repoConfig) ? fs.statSync(repoConfig).mtimeMs : null;
    assert.equal(afterMtime, beforeMtime, 'no new repo config.json must appear either');
  });
});

// stateDir (and therefore the delegate file) must follow GLMPS_STATE_DIR,
// not be silently derived from HOME even when GLMPS_CLAUDE_DIR is also set.
test('I1: the delegate file lands under GLMPS_STATE_DIR, not under a path derived from HOME', () => {
  withTempHome((home) => {
    const claude = path.join(home, 'claude-dir'); fs.mkdirSync(claude, { recursive: true });
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hooks-state-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateHome };
      run(env); // full install, so B (statusline) actually writes the delegate file
      assert.ok(fs.existsSync(path.join(stateHome, 'state', 'statusline-delegate.json')), 'delegate file must be under GLMPS_STATE_DIR/state');
      assert.ok(!fs.existsSync(path.join(home, '.glmps')), 'nothing derived from HOME must be created once GLMPS_STATE_DIR is set');
    } finally {
      fs.rmSync(stateHome, { recursive: true, force: true });
    }
  });
});

// a partial override (exactly one of GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR set) is
// exactly the misconfiguration shape that sent a prior run at a mix of real
// and temp paths. HOME/USERPROFILE point at a THIRD, otherwise-unused temp
// dir here so a fallback-to-HOME bug cannot silently "succeed" by writing
// there instead of refusing.
test('I2: a partial GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR override is refused and writes nothing anywhere', () => {
  withTempHome((home) => {
    const claude = path.join(home, 'claude-only'); fs.mkdirSync(claude, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude };
    delete env.GLMPS_STATE_DIR;

    const error = runExpectFailure(env, '--hooks-only');
    assert.ok(error, 'a partial override must make the installer exit non-zero');
    assert.equal(error.status, 2);
    assert.match(String(error.stderr || error.message), /GLMPS_CLAUDE_DIR.*GLMPS_STATE_DIR|together/i);
    assert.ok(!fs.existsSync(path.join(claude, 'settings.json')), 'nothing written under GLMPS_CLAUDE_DIR');
    assert.ok(!fs.existsSync(path.join(home, '.claude')), 'nothing written under a HOME-derived .claude either');
    assert.ok(!fs.existsSync(path.join(home, '.glmps')), 'nothing written under a HOME-derived .glmps either');
  });
});

// an EMPTY GLMPS_CLAUDE_DIR (not merely a partial
// override) used to be treated as "unset" and fell through to the real
// home. HOME/USERPROFILE point at a dedicated temp dir here, distinct from
// the real home, so a fallback bug is caught by "nothing written under
// HOME either", not just by the process exiting non-zero.
test('I2 (round 2): an empty-string GLMPS_CLAUDE_DIR is refused, never silently treated as unset', () => {
  withTempHome((home) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: '', GLMPS_STATE_DIR: '' };

    const error = runExpectFailure(env, '--hooks-only');
    assert.ok(error, 'an empty-string override must make the installer exit non-zero');
    assert.equal(error.status, 2);
    assert.match(String(error.stderr || error.message), /empty string/i);
    assert.ok(!fs.existsSync(path.join(home, '.claude')), 'nothing written under HOME - an empty override must never fall through to it');
    assert.ok(!fs.existsSync(path.join(home, '.glmps')), 'nothing written under HOME - an empty override must never fall through to it');
  });
});

// uninstallStatusline used to restore or delete
// settings.statusLine purely from the delegate record, without ever
// checking whether the CURRENT statusLine is still the GLMPS chain tap -
// an operator who later set (scenario A) or replaced (scenario B) their own
// statusLine would have it silently destroyed on uninstall.
test('I3 scenario A: delegate had no prior command; operator later sets their own statusLine; uninstall leaves it', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '{}');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env); // full install: B writes the chain tap + a delegate with no prior command

    // Operator now sets their own, unrelated statusLine (replacing the chain tap).
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.statusLine = { type: 'command', command: 'node my-own-statusline.js' };
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));

    run(env, '--uninstall');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.statusLine, { type: 'command', command: 'node my-own-statusline.js' }, "the operator's own statusLine must survive uninstall untouched");
    // nothing of ours was undone, so the delegate is left alone too.
    assert.ok(fs.existsSync(path.join(home, '.glmps', 'state', 'statusline-delegate.json')), 'the delegate file must be left alone when there was nothing of ours to undo');
  });
});

test("I3 scenario B: delegate had a real prior command; operator replaces the chain tap; uninstall leaves the operator's", () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'node my-original-statusline.js' } }, null, 2));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env); // full install: B saves 'node my-original-statusline.js' as the delegate's prev command

    // Operator now replaces the chain tap with a THIRD, different statusLine.
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.statusLine = { type: 'command', command: 'node a-third-statusline.js' };
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));

    run(env, '--uninstall');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.statusLine, { type: 'command', command: 'node a-third-statusline.js' }, "the operator's replacement statusLine must survive uninstall, not be overwritten by the stale delegate value");
    // nothing of ours was undone, so the delegate is left alone too.
    assert.ok(fs.existsSync(path.join(home, '.glmps', 'state', 'statusline-delegate.json')), 'the delegate file must be left alone when there was nothing of ours to undo');
  });
});

// the mirror image of scenarios A/B - a NORMAL uninstall (statusLine is
// still the chain tap, a genuine restore happens) must delete the delegate
// file, since it no longer describes anything to undo.
test('M5: a normal uninstall (statusLine still the chain tap) deletes the delegate file after restoring', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '{}');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };
    const delegateFile = path.join(home, '.glmps', 'state', 'statusline-delegate.json');

    run(env); // full install
    assert.ok(fs.existsSync(delegateFile), 'install must have written the delegate file');
    run(env, '--uninstall'); // statusLine is still the chain tap, so this is a genuine restore
    assert.ok(!fs.existsSync(delegateFile), 'a genuine restore must delete the delegate file - it no longer describes anything to undo');
  });
});

// M-a: M6's `existed` flag was computed from
// rawAfterB on the full (non-hooks-only) path - the settings file's state
// AFTER installStatusline already created it - so a file that truly did not
// exist before this run started was wrongly recorded as "existed", and
// uninstall left a lone {} behind instead of removing it.
test('M-a: on the full (non-hooks-only) path, a settings file created by this very run is still recognized as "did not exist before"', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    assert.ok(!fs.existsSync(file));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env); // full install: B creates the file, so by the time C runs, raw is non-null
    assert.ok(fs.existsSync(file), 'install must have created the file');
    run(env, '--uninstall');
    assert.ok(!fs.existsSync(file), 'uninstall must remove the file entirely - it did not exist before this run started');
  });
});

// M-e: a settings.json whose top level parses as
// valid JSON but is not a plain object ([] or a bare number) must refuse
// before any write, not be silently spread into or treated as {}.
for (const [label, content] of [['an array', '[]'], ['a number', '5'], ['a string', '"hello"'], ['null', 'null']]) {
  test(`M-e: a top-level settings value that is ${label} refuses and writes nothing`, () => {
    withTempHome((home) => {
      const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
      const file = path.join(claude, 'settings.json');
      fs.writeFileSync(file, content);
      const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

      const error = runExpectFailure(env, '--hooks-only');
      assert.ok(error, `${label} must make the installer exit non-zero`);
      assert.equal(error.status, 2);
      assert.equal(fs.readFileSync(file, 'utf8'), content, 'the file must be left exactly as it was');
    });
  });
}

// a malformed settings.json must refuse before EITHER B or C touches
// anything - not have B silently coerce it to {} while C separately (and
// inconsistently) refuses.
test('I3: a malformed settings.json refuses a full install before touching statusLine or hooks', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const broken = '{ still not json';
    fs.writeFileSync(file, broken);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    const error = runExpectFailure(env); // full install: exercises B and C both
    assert.ok(error);
    assert.equal(error.status, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'settings.json must be untouched');
    assert.ok(!fs.existsSync(file + '.mc-backup'), 'B must not have taken a backup');
    assert.ok(!fs.existsSync(file + '.glmps-hooks-backup'), 'C must not have taken a backup');
    assert.ok(!fs.existsSync(path.join(home, '.glmps')), 'no state dir must have been created');
  });
});

// an empty (0-byte) settings.json must never crash JSON.parse, on
// install OR on repeated uninstall attempts ("SyntaxError forever").
// M-i: the end state is decided and documented here - a file that existed
// before install (even empty) is restored to empty (0 bytes), not deleted
// and not left as literal "{}". Only a file that never existed at all (M6)
// is removed entirely.
test('I4: an empty settings.json round-trips without crashing, and is restored to empty (not deleted, not {})', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env, '--hooks-only');
    run(env, '--hooks-only', '--uninstall');
    assert.ok(fs.existsSync(file), 'a file that existed before install (even empty) must still exist after uninstall');
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'restored to empty, not {} and not deleted');
    // A second uninstall attempt (nothing left recorded) must also not crash.
    run(env, '--hooks-only', '--uninstall');
  });
});

// a corrupt hooks-installed.json must refuse install rather than
// silently return {} and lose track of hooks that may already be sitting
// in settings.json.
test('I5: a corrupt hooks record refuses install without clobbering it or settings.json', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const stateBase = path.join(home, '.glmps'); fs.mkdirSync(stateBase, { recursive: true });
    const file = path.join(claude, 'settings.json');
    const originalSettings = '{"model":"opus"}';
    fs.writeFileSync(file, originalSettings);
    const recordFile = path.join(stateBase, 'hooks-installed.json');
    const corruptRecord = '{ not json either';
    fs.writeFileSync(recordFile, corruptRecord);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateBase };

    const error = runExpectFailure(env, '--hooks-only');
    assert.ok(error);
    assert.equal(error.status, 2);
    assert.equal(fs.readFileSync(recordFile, 'utf8'), corruptRecord, 'the corrupt record must be left exactly as it was');
    assert.equal(fs.readFileSync(file, 'utf8'), originalSettings, 'settings.json must be untouched');
  });
});

// --hooks-only must leave A (config.json) and B (statusline) alone.
test('I7a: --hooks-only leaves the statusline and repo config untouched', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const stateBase = path.join(home, '.glmps');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateBase };
    const repoConfig = path.join(repoRoot, 'config.json');
    const beforeMtime = fs.existsSync(repoConfig) ? fs.statSync(repoConfig).mtimeMs : null;

    run(env, '--hooks-only');

    const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
    assert.ok(!('statusLine' in settings), '--hooks-only must never add a statusLine key');
    assert.ok(!fs.existsSync(path.join(stateBase, 'state')), '--hooks-only must never create the statusline state dir');
    const afterMtime = fs.existsSync(repoConfig) ? fs.statSync(repoConfig).mtimeMs : null;
    assert.equal(afterMtime, beforeMtime, '--hooks-only must never touch the repo config.json');
  });
});

// a hand-registered workspace-steer.js is adopted, not duplicated, and
// must survive a real install-then-uninstall cycle untouched.
test('I7b: a hand-registered workspace-steer.js survives install then --uninstall', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    // Single backslash per separator, matching a real Windows command
    // string (round 2 M-i caught this fixture over-escaped to a double
    // backslash, which refersTo's regex never matched - silently masking a
    // real duplicate that only the broader "every command referring to
    // workspace-steer.js" check below now catches).
    const handRegistered = '"node" "D:\\glmps\\hooks\\workspace-steer.js"';
    const original = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: handRegistered, timeout: 50000 }] }] } }, null, 2);
    fs.writeFileSync(file, original);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env, '--hooks-only');
    const afterInstall = JSON.parse(fs.readFileSync(file, 'utf8'));
    const preToolUseCommands = afterInstall.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    // M-i: count every command REFERRING to workspace-steer.js, not just an
    // exact string match to the original - a duplicate registered under a
    // different exact string (still pointing at the same script) would slip
    // past an exact-equality check.
    assert.equal(preToolUseCommands.filter((c) => c.includes('workspace-steer.js')).length, 1, 'the hand-registered entry must survive install, not duplicated under any spelling');

    run(env, '--hooks-only', '--uninstall');
    const afterUninstall = JSON.parse(fs.readFileSync(file, 'utf8'));
    const survivingCommands = afterUninstall.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    assert.equal(survivingCommands.filter((c) => c.includes('workspace-steer.js')).length, 1, 'the hand-registered entry must survive uninstall too - it was adopted, not added');
  });
});

// M-i: install with one GLMPS_CLAUDE_DIR, then attempt uninstall against a
// DIFFERENT one (same GLMPS_STATE_DIR, so the record is found) - must refuse,
// never uninstall against the wrong settings file.
test('M-i: uninstall refuses when settingsFile does not match the one the record was written for', () => {
  withTempHome((home) => {
    const claudeA = path.join(home, 'claude-a'); fs.mkdirSync(claudeA, { recursive: true });
    const claudeB = path.join(home, 'claude-b'); fs.mkdirSync(claudeB, { recursive: true });
    const stateBase = path.join(home, '.glmps');
    const envA = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claudeA, GLMPS_STATE_DIR: stateBase };
    const envB = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claudeB, GLMPS_STATE_DIR: stateBase };

    run(envA, '--hooks-only');
    const error = runExpectFailure(envB, '--hooks-only', '--uninstall');
    assert.ok(error, 'uninstalling against a different settingsFile must refuse');
    assert.equal(error.status, 2);
    assert.match(String(error.stderr || error.message), /different settings file|does not match/i);
    assert.ok(fs.existsSync(path.join(claudeA, 'settings.json')), 'the real installed file must be untouched by the failed cross-file uninstall');
  });
});

// M-i / M5: uninstall against a malformed settings.json is a named refusal,
// not an uncaught stack trace.
test('M-i (M5): uninstall with a malformed settings.json refuses with a named error', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env, '--hooks-only'); // install cleanly first, so there is a real record to try to act on
    fs.writeFileSync(file, '{ broken after install');

    const error = runExpectFailure(env, '--hooks-only', '--uninstall');
    assert.ok(error, 'uninstall against a malformed settings.json must exit non-zero');
    assert.equal(error.status, 2);
    assert.match(String(error.stderr || error.message), /could not be read|not valid JSON/i);
  });
});

// M-i / M7: a refusal never also prints "Done" - a human or a script
// grepping for success must never see both a non-zero exit and a success
// line in the same run.
test('M-i (M7): a refusal never also prints "Done"', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '{ not valid json');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    const error = runExpectFailure(env, '--hooks-only');
    assert.ok(error);
    assert.doesNotMatch(String(error.stdout || ''), /Done/, 'a refusal must never also print Done');
  });
});

// the hooks backup must capture the file's state BEFORE installStatusline
// changed it, or a full uninstall (B undone, then C undone) can never land
// back on a byte-for-byte match.
test('M4: a full install then full uninstall restores byte-identical content', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    // 4-space indent, no trailing newline: not what JSON.stringify(x, null, 2)
    // would produce, so this only passes via the true byte-for-byte restore
    // path, never by coincidentally matching the JSON.stringify fallback.
    const original = '{\n    "model": "opus"\n}';
    fs.writeFileSync(file, original);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env); // full install: both B and C touch the file
    run(env, '--uninstall'); // full uninstall: B undone, then C undone
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'byte-for-byte, even though two separate steps each changed the file');
  });
});

// when settingsFile did not exist before install, uninstall must remove
// the file it created, not leave a lone {} behind.
test('M6: install with no settings file at all; uninstall removes the file it created', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    assert.ok(!fs.existsSync(file));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env, '--hooks-only');
    assert.ok(fs.existsSync(file), 'install must have created the file');
    run(env, '--hooks-only', '--uninstall');
    assert.ok(!fs.existsSync(file), 'uninstall must remove the file entirely, not leave {}');
  });
});

// renameSync was called exactly
// once. On Windows, Defender, an indexer, or an editor holding a handle can
// make a rename fail transiently with EPERM/EACCES/EBUSY; a single failed
// attempt used to exit with a raw stack trace, leave the .tmp file behind,
// and (in installHooks specifically) the record had already been written
// before settings - a re-install would then duplicate rec.added. Tests
// inject a fake `rename` so real transient failures never have to be
// reproduced by chance.
test('I-A: atomicWriteFileSync retries a failing rename (EBUSY) and succeeds once it stops failing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-'));
  try {
    const file = path.join(dir, 'settings.json');
    let calls = 0;
    const rename = (tmp, dest) => {
      calls++;
      if (calls < 3) {
        const e = new Error('resource busy or locked');
        e.code = 'EBUSY';
        throw e;
      }
      fs.renameSync(tmp, dest);
    };
    atomicWriteFileSync(file, 'hello', { rename, backoffMs: 1 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
    assert.equal(calls, 3, 'must have retried exactly twice before succeeding on the third attempt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('I-A: atomicWriteFileSync exhausts retries, throws a named AtomicWriteError, leaves no .tmp file, writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-'));
  try {
    const file = path.join(dir, 'settings.json');
    const rename = () => {
      const e = new Error('resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    };
    assert.throws(() => atomicWriteFileSync(file, 'hello', { rename, maxAttempts: 3, backoffMs: 1 }), /AtomicWriteError/);
    assert.ok(!fs.existsSync(file), 'the target must never be written on a permanent failure');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'M-g: no .tmp- file left behind after a permanent failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// I-B: a plain rename onto a symlinked settings.json replaces
// the symlink itself with a regular file, silently detaching the operator's
// dotfiles link (a real, common setup: ~/.claude/settings.json symlinked
// into a dotfiles repo).
test('I-B: atomicWriteFileSync preserves a symlinked target, updating what it points to', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-symlink-'));
  try {
    const real = path.join(dir, 'real-settings.json');
    fs.writeFileSync(real, 'original');
    const link = path.join(dir, 'settings.json');
    try {
      fs.symlinkSync(real, link);
    } catch (e) {
      t.skip(`platform refused to create a symlink without privilege (${e.code ?? e.message})`);
      return;
    }
    atomicWriteFileSync(link, 'updated');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink itself must survive the write, not be replaced by a regular file');
    assert.equal(fs.readFileSync(real, 'utf8'), 'updated', 'the real target must receive the new content');
    assert.equal(fs.readFileSync(link, 'utf8'), 'updated', 'reading through the link shows the new content too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('I-B: atomicWriteFileSync on a target that does not exist yet just creates a regular file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-nolink-'));
  try {
    const file = path.join(dir, 'settings.json');
    atomicWriteFileSync(file, 'fresh');
    assert.equal(fs.readFileSync(file, 'utf8'), 'fresh');
    assert.ok(!fs.lstatSync(file).isSymbolicLink());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// a full uninstall against a settings.json that
// does not exist at all, or that exists but is empty, is not a malformed
// file - there is nothing to parse and nothing to restore. Both must
// succeed (exit 0) with a log line, matching a never-installed machine.
test('M1: a full uninstall with no settings.json at all succeeds ("nothing to restore"), not a refusal', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };
    const out = run(env, '--uninstall'); // must not throw
    assert.match(out, /nothing to restore/i);
  });
});

test('M1: a full uninstall with a 0-byte settings.json succeeds ("nothing to restore"), not a refusal', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    fs.writeFileSync(path.join(claude, 'settings.json'), '');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };
    const out = run(env, '--uninstall');
    assert.match(out, /nothing to restore/i);
  });
});

// the second half - when the statusline step genuinely refuses (a
// malformed settings.json, not the "nothing to restore" no-op above), the
// hooks uninstall must never run at all.
test('M1: when the statusline step refuses, the hooks uninstall never runs', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env, '--hooks-only'); // install hooks first, so there IS a record that a wrongful uninstallHooks run would change
    const recordFile = path.join(home, '.glmps', 'hooks-installed.json');
    const recordBefore = fs.readFileSync(recordFile, 'utf8');
    fs.writeFileSync(file, '{ broken now');

    const error = runExpectFailure(env, '--uninstall');
    assert.ok(error, 'a malformed settings.json must still make the whole uninstall exit non-zero');
    assert.equal(fs.readFileSync(recordFile, 'utf8'), recordBefore, 'the hooks record must be untouched - uninstallHooks must never have run after the statusline step refused');
    // the record check above passes even without the
    // short-circuit, because uninstallHooks refuses the same malformed file
    // on its own. What discriminates is that the hooks step never SPOKE:
    // its own refusal ends "refusing to uninstall.", the statusline step's
    // ends "refusing to restore the statusline.".
    const stderr = String(error.stderr || '');
    assert.match(stderr, /refusing to restore the statusline\./, 'the statusline step is the one that refused');
    assert.doesNotMatch(stderr, /refusing to uninstall\./, 'the hooks step must never have run, so its refusal must never appear');
  });
});

// a hooks-installed.json that parses as valid
// JSON but is not a plain object ([] or null) is just as untrustworthy as
// one that fails to parse - refuses before any write.
for (const [label, content] of [['an array', '[]'], ['null', 'null']]) {
  test(`M3: a hooks record whose top level is ${label} refuses install without clobbering it`, () => {
    withTempHome((home) => {
      const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
      const stateBase = path.join(home, '.glmps'); fs.mkdirSync(stateBase, { recursive: true });
      const recordFile = path.join(stateBase, 'hooks-installed.json');
      fs.writeFileSync(recordFile, content);
      const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateBase };

      const error = runExpectFailure(env, '--hooks-only');
      assert.ok(error, `${label} must make the installer exit non-zero`);
      assert.equal(error.status, 2);
      assert.equal(fs.readFileSync(recordFile, 'utf8'), content, 'the record must be left exactly as it was');
      assert.ok(!fs.existsSync(path.join(claude, 'settings.json')), 'settings.json must not have been created either');
    });
  });
}

// M-b: when uninstall finishes with nothing pending
// and no byte-restore happened, the orphaned hooks-backup file must be
// removed too - otherwise a later, unrelated install would see it still
// exists and skip taking its own fresh backup.
test('M-b: the orphaned hooks-backup file is removed after a full uninstall that falls back to the non-byte-identical write', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'opus' }, null, 2));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env, '--hooks-only');
    const backupFile = `${file}.glmps-hooks-backup`;
    assert.ok(fs.existsSync(backupFile), 'install must have taken a hooks backup');

    // An unrelated change after install forces the `same` byte-restore check
    // to fail on uninstall, exercising the non-byte-identical fallback path.
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.unrelatedKey = 'operator added this after install';
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));

    run(env, '--hooks-only', '--uninstall');
    assert.ok(!fs.existsSync(backupFile), 'the orphaned backup must be removed once nothing is left pending, even on the fallback write path');
  });
});

// taps/statusline-chain.js read its delegate from
// os.homedir()/.glmps unconditionally, while the installer writes
// it under GLMPS_STATE_DIR - a real mismatch whenever GLMPS_STATE_DIR is set (as
// it always is in this project's own dev/test worktrees, per .claude/
// settings.json's env block, not just in this test). HOME/USERPROFILE point
// at a dedicated, otherwise-empty temp dir so a fallback bug would show up
// as "delegate not found" rather than accidentally finding a real one.
test('round 3 M6: statusline-chain.js reads its delegate from GLMPS_STATE_DIR, not a HOME-derived path', () => {
  withTempHome((home) => {
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hooks-chain-state-'));
    try {
      fs.mkdirSync(path.join(stateHome, 'state'), { recursive: true });
      fs.writeFileSync(path.join(stateHome, 'state', 'statusline-delegate.json'), JSON.stringify({ command: 'echo mc-state-dir-delegate-worked' }));
      const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: path.join(home, '.claude'), GLMPS_STATE_DIR: stateHome };
      const out = execFileSync(process.execPath, [chainScript], { input: '{}', env, encoding: 'utf8' });
      assert.match(out, /mc-state-dir-delegate-worked/, 'the chain must have found and run the GLMPS_STATE_DIR delegate, not silently found nothing');
    } finally {
      fs.rmSync(stateHome, { recursive: true, force: true });
    }
  });
});


// Item 1: a rename onto one name of a hard-linked file
// gives that name a new inode and silently splits it from its twin (the
// operator's dotfiles copy would stop receiving updates, and vice versa).
// There is no path to resolve through, unlike a symlink, so the only safe
// answer is to refuse before writing anything.
test('round 4 item 1: atomicWriteFileSync refuses a hard-linked target with HardLinkedTargetError and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-hardlink-'));
  try {
    const real = path.join(dir, 'real-settings.json');
    fs.writeFileSync(real, 'original');
    const link = path.join(dir, 'settings.json');
    fs.linkSync(real, link);
    assert.throws(() => atomicWriteFileSync(link, 'updated'), (e) => e.name === 'HardLinkedTargetError' && /hard link/i.test(e.message));
    assert.equal(fs.readFileSync(real, 'utf8'), 'original', 'the twin must be byte-identical to before');
    assert.equal(fs.readFileSync(link, 'utf8'), 'original', 'the named path must be byte-identical to before');
    assert.equal(fs.statSync(link).nlink, 2, 'the two names must still share one inode');
    assert.deepEqual(tmpLeftovers(dir), [], 'no .tmp- file may be created, let alone left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('round 4 item 1: a hooks-only install against a hard-linked settings.json exits 2 and leaves both names untouched', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const twin = path.join(home, 'dotfiles-settings.json');
    const original = '{"model":"opus"}';
    fs.writeFileSync(twin, original);
    fs.linkSync(twin, file);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    const error = runExpectFailure(env, '--hooks-only');
    assert.ok(error, 'a hard-linked settings.json must make the installer exit non-zero');
    assert.equal(error.status, 2, 'a named refusal, not a crash');
    assert.match(String(error.stderr || ''), /hard link/i, 'the refusal names the reason');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.readFileSync(twin, 'utf8'), original);
    assert.equal(fs.statSync(file).nlink, 2);
    assert.deepEqual(tmpLeftovers(claude), []);
  });
});

// Item 2: the temp file is removed on EVERY failure path, not only after
// the rename retries are exhausted - a write that dies half-way (disk full)
// used to leave a partial .tmp- file next to settings.json forever.
test('round 4 item 2: an injected tmp-write failure throws AtomicWriteError and leaves no .tmp- file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-writefail-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, 'original');
    const writeFile = (p) => {
      fs.writeFileSync(p, 'partial');
      const e = new Error('no space left on device');
      e.code = 'ENOSPC';
      throw e;
    };
    assert.throws(() => atomicWriteFileSync(file, 'updated', { writeFile }), (e) => e.name === 'AtomicWriteError' && /no space left/.test(e.message));
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(tmpLeftovers(dir), [], 'the partial temp file must be removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Item 2, installer level: a write that genuinely cannot land (the delegate
// path is occupied by a directory, so the rename onto it fails) exits 2
// with a named refusal and leaves no temp file in the state dir.
test('round 4 item 2: an installer-level write failure exits 2 and leaves no .tmp- file', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const stateBase = path.join(home, '.glmps');
    const stateDir = path.join(stateBase, 'state');
    fs.mkdirSync(path.join(stateDir, 'statusline-delegate.json'), { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateBase };

    const error = runExpectFailure(env);
    assert.ok(error, 'an unwritable delegate must make the installer exit non-zero');
    assert.equal(error.status, 2, 'a named refusal, not a crash');
    assert.match(String(error.stderr || ''), /atomic write/i);
    assert.deepEqual(tmpLeftovers(stateDir), []);
  });
});

// Item 2: a realpath failure other than ENOENT (here ELOOP-like: a symlink
// cycle) is a named refusal, never a raw stack trace.
test('round 4 item 2: a symlink cycle at the target is a named TargetResolveError refusal', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-loop-'));
  try {
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    try {
      fs.symlinkSync(b, a);
      fs.symlinkSync(a, b);
    } catch (e) {
      t.skip(`platform refused to create a symlink without privilege (${e.code ?? e.message})`);
      return;
    }
    assert.throws(() => atomicWriteFileSync(a, 'x'), (e) => e.name === 'TargetResolveError');
    assert.ok(fs.lstatSync(a).isSymbolicLink() && fs.lstatSync(b).isSymbolicLink(), 'both links survive');
    assert.deepEqual(tmpLeftovers(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Item 3: a symlink whose target does not exist used to be treated as
// "nothing here yet", so the rename replaced the link itself with a regular
// file - silently detaching the operator's dotfiles link. Refuse instead.
test('round 4 item 3: a dangling symlink target is refused with DanglingSymlinkError, the link left intact', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-dangling-'));
  try {
    const missing = path.join(dir, 'dotfiles', 'settings.json');
    const link = path.join(dir, 'settings.json');
    try {
      fs.symlinkSync(missing, link, 'file');
    } catch (e) {
      t.skip(`platform refused to create a symlink without privilege (${e.code ?? e.message})`);
      return;
    }
    assert.throws(() => atomicWriteFileSync(link, 'x'), (e) => e.name === 'DanglingSymlinkError');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink must survive, not be replaced by a regular file');
    assert.ok(!fs.existsSync(missing), 'nothing is created at the dangling target either');
    assert.deepEqual(tmpLeftovers(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Items 5 and 6: installer-level proof of the settings-before-record order.
// The record is made unwritable by hard-linking it (it still READS fine, so
// install gets past readRecord). The settings write must already have
// happened when the record write refuses, and the refusal must tell the
// operator exactly which hooks are now in settings but untracked.
test('round 4 items 5-6: a record-write failure exits 2 after settings were written, and names the untracked hooks', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '{"model":"opus"}');
    const stateBase = path.join(home, '.glmps'); fs.mkdirSync(stateBase);
    const recordFile = path.join(stateBase, 'hooks-installed.json');
    fs.writeFileSync(recordFile, '{}');
    fs.linkSync(recordFile, path.join(home, 'record-twin.json'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateBase };

    const error = runExpectFailure(env, '--hooks-only');
    assert.ok(error, 'a record that cannot be written must make the installer exit non-zero');
    assert.equal(error.status, 2, 'a named refusal, not a crash');
    const stderr = String(error.stderr || '');
    assert.match(stderr, /hard link/i, 'the underlying reason is named');

    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const commands = Object.values(settings.hooks || {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
    assert.equal(commands.length, HOOK_MANIFEST.length, 'settings were written BEFORE the record (I-A order)');
    assert.equal(fs.readFileSync(recordFile, 'utf8'), '{}', 'the record is untouched');

    assert.match(stderr, /written to/i, 'the refusal says the hooks WERE written to settings');
    assert.ok(stderr.includes(file), 'and names the settings file they were written to');
    for (const row of HOOK_MANIFEST) assert.ok(stderr.includes(row.id), `and names hook ${row.id} so the operator can remove it`);
  });
});

// Item 7: only the transient Windows lock codes are worth retrying; any
// other failure (ENOENT, EXDEV, EISDIR) will fail the same way every time,
// so it fails fast instead of burning the full backoff budget.
for (const code of ['ENOENT', 'EXDEV', 'EISDIR']) {
  test(`round 4 item 7: a non-transient rename failure (${code}) is not retried`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-nonretry-'));
    try {
      const file = path.join(dir, 'settings.json');
      let calls = 0;
      const rename = () => {
        calls++;
        const e = new Error(`simulated ${code}`);
        e.code = code;
        throw e;
      };
      assert.throws(() => atomicWriteFileSync(file, 'hello', { rename, maxAttempts: 5, backoffMs: 1 }), (e) => e.name === 'AtomicWriteError');
      assert.equal(calls, 1, `${code} must fail on the first attempt, not be retried`);
      assert.deepEqual(tmpLeftovers(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`round 4 item 7: a transient rename failure (${code}) is retried`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-atomic-retry-'));
    try {
      const file = path.join(dir, 'settings.json');
      let calls = 0;
      const rename = (tmp, dest) => {
        calls++;
        if (calls < 2) {
          const e = new Error(`simulated ${code}`);
          e.code = code;
          throw e;
        }
        fs.renameSync(tmp, dest);
      };
      atomicWriteFileSync(file, 'hello', { rename, backoffMs: 1 });
      assert.equal(calls, 2);
      assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Item 8, M4 (uninstall side): a statusLine.command that is not a string
// has no .includes of its own; uninstall must treat it as "not ours" and
// leave it alone, exiting 0.
test('round 4 item 8 (M4): uninstall leaves a non-string statusLine.command alone and exits 0', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '{}');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    run(env);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.statusLine = { type: 'command', command: 5 };
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));

    const out = run(env, '--uninstall'); // throws (and fails the test) on a non-zero exit
    assert.match(out, /no longer the GLMPS chain tap/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, { type: 'command', command: 5 });
  });
});

// Item 8, M4 (install side, found while writing the test above): the same
// non-string command crashed INSTALL with a raw TypeError
// (previousCommand?.includes is not a function). It is refused by name, and
// nothing is written.
test('round 4 item 8 (M4): install refuses a non-string statusLine.command by name and writes nothing', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const original = '{"statusLine":{"type":"command","command":5}}';
    fs.writeFileSync(file, original);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    const error = runExpectFailure(env);
    assert.ok(error);
    assert.equal(error.status, 2, 'a named refusal, not a TypeError crash');
    assert.match(String(error.stderr || ''), /statusLine\.command/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.ok(!fs.existsSync(`${file}.mc-backup`));
    assert.ok(!fs.existsSync(path.join(home, '.glmps')), 'no state dir is created either');
  });
});

// the .mc-backup copy goes through the SAME temp-file-plus-rename
// path as every other write here, not a plain fs.copyFileSync. A bytes-only
// assertion ("the backup matches the original") cannot tell the two apart -
// copyFileSync would produce identical bytes on the ordinary case and only
// diverges once the destination is a dangling symlink, where it silently
// FOLLOWS the link and creates a new file at whatever the link points to
// (exactly the symlink-planting attack atomicWriteFileSync's DanglingSymlinkError
// refusal exists to close). Put the dangling symlink at .mc-backup itself and
// assert the installer refuses instead of writing through it.
test('round 4 item 8 (M2): a dangling symlink at .mc-backup is refused, not followed', (t) => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const file = path.join(claude, 'settings.json');
    const original = '{\n    "model": "opus"\n}';
    fs.writeFileSync(file, original);
    const backupFile = `${file}.mc-backup`;
    const danglingTarget = path.join(home, 'planted-elsewhere.json'); // must not exist yet
    try {
      fs.symlinkSync(danglingTarget, backupFile, 'file');
    } catch (e) {
      t.skip(`platform refused to create a symlink without privilege (${e.code ?? e.message})`);
      return;
    }
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    const error = runExpectFailure(env);
    assert.ok(error, 'a dangling .mc-backup symlink must make the installer refuse, not silently follow it');
    assert.equal(error.status, 2, 'a named refusal, not a crash');
    assert.match(String(error.stderr || ''), /symlink/i, 'the refusal names the reason');
    assert.ok(fs.lstatSync(backupFile).isSymbolicLink(), 'the symlink itself must survive, not be replaced by a regular file');
    assert.ok(!fs.existsSync(danglingTarget), 'nothing may be created at the dangling target - a copyFileSync would have followed the link and written the backup there');
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'settings.json itself must be untouched');
    assert.deepEqual(tmpLeftovers(claude), []);
  });
});

// Found while working item 2: a settings.json path occupied by a directory
// crashed install with a raw EISDIR stack trace from the up-front read.
test('round 4: a settings.json that is a directory is a named refusal, not a crash', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude');
    fs.mkdirSync(path.join(claude, 'settings.json'), { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: path.join(home, '.glmps') };

    const error = runExpectFailure(env, '--hooks-only');
    assert.ok(error);
    assert.equal(error.status, 2, 'a named refusal, not a crash');
    assert.match(String(error.stderr || ''), /settings\.json could not be read/);
    assert.ok(!fs.existsSync(path.join(home, '.glmps')), 'nothing written');
  });
});

test('one install records every manifest entry, added or adopted, with the command that runs', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const stateBase = path.join(home, '.glmps');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateBase };
    run(env, '--hooks-only');
    const rec = JSON.parse(fs.readFileSync(path.join(stateBase, 'hooks-installed.json'), 'utf8'));
    assert.equal(rec.entries.length, HOOK_MANIFEST.length);
    assert.deepEqual(rec.entries.map((e) => e.id), HOOK_MANIFEST.map((h) => h.id));
    assert.ok(rec.entries.every((e) => e.status === 'added'));
    assert.equal(rec.added.length, HOOK_MANIFEST.length);
  });
});

test('when every entry is already registered, the record still lists all of them as adopted, a loose copy by its own path', () => {
  withTempHome((home) => {
    const claude = path.join(home, '.claude'); fs.mkdirSync(claude);
    const stateBase = path.join(home, '.glmps');
    const loose = `"node" "${path.join(claude, 'hooks', 'no-emdash.js')}"`;
    const groups = {};
    for (const h of HOOK_MANIFEST) {
      const command = h.script === 'no-emdash.js' ? loose : `"node" "${path.join('D:', 'rt', h.dir ?? 'hooks', h.script)}"`;
      (groups[h.event] ||= []).push({ matcher: h.matcher, hooks: [{ type: 'command', command }] });
    }
    const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ hooks: groups }, null, 2));
    const before = fs.readFileSync(file, 'utf8');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: claude, GLMPS_STATE_DIR: stateBase };
    run(env, '--hooks-only');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'settings untouched');
    const rec = JSON.parse(fs.readFileSync(path.join(stateBase, 'hooks-installed.json'), 'utf8'));
    assert.equal(rec.entries.length, HOOK_MANIFEST.length);
    assert.ok(rec.entries.every((e) => e.status === 'adopted'));
    assert.equal(rec.entries.find((e) => e.id === 'no-emdash-stop').command, loose);
    assert.deepEqual(rec.added, []);
  });
});
