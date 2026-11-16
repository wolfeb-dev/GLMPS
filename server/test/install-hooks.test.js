// server/test/install-hooks.test.js
// Pure: every case passes in-memory settings; nothing touches ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_MANIFEST, planHookInstall, planHookUninstall, hookCommand, resolveInstallPaths, settingsEqual } from '../../scripts/install-hooks-lib.mjs';

const opts = { repoRoot: 'D:\\mc', nodePath: 'C:\\node\\node.exe', manifest: HOOK_MANIFEST };

test('the manifest covers all 24 GLMPS-owned entries: 22 scripts, two of them registered twice', () => {
  assert.equal(HOOK_MANIFEST.length, 24);
  assert.equal(new Set(HOOK_MANIFEST.map((h) => h.id)).size, 24);
  const scripts = new Set(HOOK_MANIFEST.map((h) => h.script));
  assert.equal(scripts.size, 22);
  assert.deepEqual(HOOK_MANIFEST.find((h) => h.id === 'deletion-guard'), { id: 'deletion-guard', event: 'PreToolUse', matcher: 'Bash|PowerShell', script: 'deletion-guard.js' });
  assert.ok(scripts.has('pocock-sync.js'));
  assert.ok(scripts.has('workspace-steer.js'));
  assert.equal(HOOK_MANIFEST.find((h) => h.id === 'workspace-steer').timeout, 50000);
});

test('sync-project-dirs is a SessionStart row that lives under scripts/, not hooks/', () => {
  const row = HOOK_MANIFEST.find((h) => h.id === 'sync-project-dirs');
  assert.deepEqual([row.event, row.matcher, row.script, row.dir], ['SessionStart', '', 'sync-project-dirs.mjs', 'scripts']);
  const { added } = planHookInstall({}, opts);
  assert.equal(added.find((a) => a.id === 'sync-project-dirs').command, '"C:\\node\\node.exe" "D:\\mc\\scripts\\sync-project-dirs.mjs"');
});

test('a hand-registered sync-project-dirs entry is adopted, and a hooks/ file of the same name is not mistaken for it', () => {
  const live = { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: '"node" "D:\\glmps-2.0-runtime\\scripts\\sync-project-dirs.mjs"' }] }] } };
  assert.ok(planHookInstall(live, opts).adopted.includes('sync-project-dirs'));
  const wrongDir = { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: '"node" "D:\\x\\hooks\\sync-project-dirs.mjs"' }] }] } };
  assert.ok(!planHookInstall(wrongDir, opts).adopted.includes('sync-project-dirs'));
});

test('no-emdash is registered for file writes (PreToolUse) and for chat (Stop)', () => {
  const write = HOOK_MANIFEST.find((h) => h.id === 'no-emdash-write');
  const stop = HOOK_MANIFEST.find((h) => h.id === 'no-emdash-stop');
  assert.deepEqual([write.event, write.matcher, write.script], ['PreToolUse', 'Write|Edit|MultiEdit', 'no-emdash.js']);
  assert.deepEqual([stop.event, stop.matcher, stop.script], ['Stop', '', 'no-emdash.js']);
  const { added } = planHookInstall({}, opts);
  assert.ok(added.some((a) => a.id === 'no-emdash-write' && a.command.endsWith('\\hooks\\no-emdash.js"')));
});

test('every manifest script exists in this checkout', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const row of HOOK_MANIFEST) assert.ok(fs.existsSync(path.join(root, row.dir ?? 'hooks', row.script)), `${row.id}: ${row.script}`);
});

// an explicit row-level ceiling so a wedged hook (every
// inner git/HTTP call already has its own short timeout, but a future code
// path that forgets one must not be able to block a tool call for anywhere
// near Claude Code's 600s per-hook default).
// Phase K final review minor: test-file-guard makes the same kind of bounded
// git and board calls as plan-gate, so it gets the same independent 15 s
// (Claude Code hook timeouts are in seconds) outer ceiling.
test('the test-file-guard manifest row has an explicit 15s timeout', () => {
  assert.equal(HOOK_MANIFEST.find((h) => h.id === 'test-file-guard').timeout, 15);
});

test('the plan-gate manifest row has an explicit 15s timeout', () => {
  assert.equal(HOOK_MANIFEST.find((h) => h.id === 'plan-gate').timeout, 15);
});

test('fresh install registers every row with absolute paths', () => {
  const { patched, added, adopted } = planHookInstall({}, opts);
  assert.equal(added.length, HOOK_MANIFEST.length); assert.deepEqual(adopted, []);
  const all = Object.values(patched.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(all.includes(hookCommand('C:\\node\\node.exe', 'D:\\mc', 'done-gate.js')));
  assert.ok(all.every((c) => c.startsWith('"C:\\node\\node.exe" "D:\\mc')));
});

test('install twice is a no-op', () => {
  const once = planHookInstall({}, opts).patched;
  const twice = planHookInstall(once, opts);
  assert.equal(twice.added.length, 0);
  assert.deepEqual(twice.patched, once);
});

test('F1 (scan 2026-10-15): live-install-guard is registered for Bash as well as the file tools', () => {
  const { added } = planHookInstall({}, opts);
  const row = added.find((a) => a.id === 'live-install-guard');
  assert.deepEqual(row.matcher.split('|').sort(), ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
});

test('F1: an older file-tools-only live-install-guard entry gains a Bash group, kept on reinstall and removed on uninstall', () => {
  const cmd = '"node" "D:\\glmps\\hooks\\live-install-guard.js"';
  const old = { hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: cmd }] }] } };
  const first = planHookInstall(old, opts);
  const row = first.added.find((a) => a.id === 'live-install-guard');
  assert.equal(row.matcher, 'Bash');
  assert.ok(!first.adopted.includes('live-install-guard'));
  const lig = first.patched.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.includes('live-install-guard.js')));
  assert.deepEqual(lig.map((g) => g.matcher), ['Write|Edit|MultiEdit|NotebookEdit', 'Bash']);
  const again = planHookInstall(first.patched, opts);
  assert.ok(!again.added.some((a) => a.id === 'live-install-guard'), 'covered now, so adopted');
  assert.ok(again.adopted.includes('live-install-guard'));
  const { patched } = planHookUninstall(first.patched, [row]);
  const left = patched.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.includes('live-install-guard.js')));
  assert.deepEqual(left.map((g) => g.matcher), ['Write|Edit|MultiEdit|NotebookEdit'], 'the hand entry is untouched');
});

test('F1: a wildcard entry for a specific-tools script covers every tool', () => {
  const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hooks/live-install-guard.js' }] }] } };
  const { added, adopted } = planHookInstall(settings, opts);
  assert.ok(adopted.includes('live-install-guard'));
  assert.ok(!added.some((a) => a.id === 'live-install-guard'));
});

test('hand-registered entries are adopted, and foreign entries are preserved', () => {
  const settings = { model: 'x', hooks: {
    PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: '"node" "C:\\Users\\op\\.claude\\hooks\\no-emdash.js"' }] },
                 { matcher: '*', hooks: [{ type: 'command', command: '"node" "D:\\glmps\\hooks\\workspace-steer.js"', timeout: 50000 }] }] } };
  const { patched, adopted } = planHookInstall(settings, opts);
  assert.ok(adopted.includes('workspace-steer'));
  const pre = patched.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(pre.filter((c) => c.includes('workspace-steer.js')).length, 1, 'not duplicated');
  assert.ok(pre.some((c) => c.includes('no-emdash.js')), 'foreign entry kept');
  assert.equal(patched.model, 'x');
});

test('uninstall removes exactly what install added', () => {
  const original = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '"node" "C:\\x\\no-emdash.js"' }] }] }, statusLine: { type: 'command', command: 'y' } };
  const { patched, added } = planHookInstall(original, opts);
  const back = planHookUninstall(patched, added);
  assert.equal(back.removed, added.length);
  assert.deepEqual(back.patched, original);
});


// a same-named .bak file must not be adopted as the real script.
test('adoption regex is end-anchored: a done-gate.js.bak entry must not count as done-gate.js', () => {
  const settings = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '"node" "D:\\mc\\hooks\\done-gate.js.bak"' }] }] } };
  const { added, adopted } = planHookInstall(settings, opts);
  assert.ok(added.some((a) => a.id === 'done-gate'), 'done-gate.js.bak must not be mistaken for done-gate.js');
  assert.ok(!adopted.includes('done-gate'));
});

// every generated command is run through Git Bash on Windows, so a `$`
// or a backtick in a path would be shell-interpolated rather than literal.
test('hookCommand rejects a repoRoot or nodePath containing $ or a backtick', () => {
  assert.throws(() => hookCommand('C:\\node\\node.exe', 'D:\\weird$root', 'done-gate.js'), /\$|backtick/i);
  assert.throws(() => hookCommand('C:\\node`.exe', 'D:\\mc', 'done-gate.js'), /\$|backtick/i);
});

// M2/M3: planHookUninstall must report which recorded entries it could not
// find, so the caller can keep tracking them instead of silently dropping
// the bookkeeping for an entry nobody actually removed.
test('planHookUninstall reports ids it could not find', () => {
  const settings = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'X' }] }] } };
  const added = [
    { id: 'done-gate', event: 'Stop', matcher: '', command: 'X' },
    { id: 'capability-feed', event: 'Stop', matcher: '', command: 'Y-not-there' },
    { id: 'decision-log', event: 'SessionStart', matcher: '', command: 'Z-no-such-event' },
  ];
  const { removed, notFound } = planHookUninstall(settings, added);
  assert.equal(removed, 1);
  assert.deepEqual(notFound.sort(), ['capability-feed', 'decision-log']);
});

// the byte-restore decision must not depend on JSON key order, and an
// empty/absent hooks key (or per-event array) at the same position must
// compare equal - otherwise the exact-bytes restore never fires just
// because planHookInstall's `hooks || {}` created an object that was never
// there before.
test('settingsEqual treats an empty/absent hooks key as equal and ignores object key order', () => {
  assert.ok(settingsEqual({ model: 'opus', hooks: {} }, { model: 'opus' }));
  assert.ok(settingsEqual({ hooks: {}, model: 'opus' }, { model: 'opus', hooks: {} }));
  assert.ok(settingsEqual({ hooks: { Stop: [] } }, {}));
  assert.ok(!settingsEqual({ model: 'opus' }, { model: 'sonnet' }));
  assert.ok(!settingsEqual({ hooks: { Stop: [{ matcher: '', hooks: [] }] } }, {}));
});

// I2/I6: resolveInstallPaths is the pure, injectable-homedir replacement for
// the old top-level `os.homedir()` constants; every case here uses a fake
// homedir string and never touches the real filesystem.
// Phase K final review, SHARED HELPER ruling: the home fallback (neither
// GLMPS_CLAUDE_DIR nor GLMPS_STATE_DIR set) is production's own path, so these
// pure cases force a non-test context; the backstop test below proves a test
// process is refused the fallback outright.
const notTest = { processEnv: {}, argv: ['node', 'install.mjs'] };

// A hardcoded 'X:\\...' literal is not an absolute path on POSIX (no leading
// separator), so path.join/path.resolve inside resolveInstallPaths silently
// treat it as a relative segment and prefix it with the repo's cwd there -
// the exact mismatch CI caught on Linux. These fixtures are absolute on
// whichever platform the suite actually runs on (drive letter on win32,
// leading slash on posix), and every expected value below is built with the
// same `path` module resolveInstallPaths itself uses, so the assertions stay
// meaningful (still proves homedir vs. override precedence and the exact
// segments joined) without hardcoding a separator.
const FAKE_HOME = process.platform === 'win32' ? 'X:\\fake-home' : '/fake-home';
const REAL_HOME = process.platform === 'win32' ? 'X:\\real-home' : '/real-home';
const CLAUDE_OVERRIDE = process.platform === 'win32' ? 'Y:\\claude' : '/y-claude';
const STATE_OVERRIDE = process.platform === 'win32' ? 'Y:\\state' : '/y-state';

test('resolveInstallPaths: in a test process, the home fallback is refused (backstop), and explicit overrides still resolve', () => {
  assert.throws(() => resolveInstallPaths({ env: {}, homedir: REAL_HOME }),
    (e) => e.name === 'TestProcessHomeFallbackError' && /test process/i.test(e.message));
  assert.throws(() => resolveInstallPaths({ env: {}, homedir: REAL_HOME, processEnv: { GLMPS_TEST: '1' }, argv: ['node', 'install.mjs'] }),
    (e) => e.name === 'TestProcessHomeFallbackError');
  const p = resolveInstallPaths({ env: { GLMPS_CLAUDE_DIR: CLAUDE_OVERRIDE, GLMPS_STATE_DIR: STATE_OVERRIDE }, homedir: REAL_HOME });
  assert.equal(p.settingsFile, path.join(CLAUDE_OVERRIDE, 'settings.json'));
});

test('resolveInstallPaths: HOME only resolves every path under the fake home', () => {
  const p = resolveInstallPaths({ env: {}, homedir: FAKE_HOME, ...notTest });
  assert.equal(p.settingsFile, path.join(FAKE_HOME, '.claude', 'settings.json'));
  assert.equal(p.stateDir, path.join(FAKE_HOME, '.glmps', 'state'));
  assert.equal(p.delegateFile, path.join(FAKE_HOME, '.glmps', 'state', 'statusline-delegate.json'));
  assert.equal(p.hooksRecordFile, path.join(FAKE_HOME, '.glmps', 'hooks-installed.json'));
  assert.equal(p.mcBackupFile, p.settingsFile + '.mc-backup');
  assert.equal(p.hooksBackupFile, p.settingsFile + '.glmps-hooks-backup');
});

test('resolveInstallPaths: GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR override the homedir entirely', () => {
  const p = resolveInstallPaths({ env: { GLMPS_CLAUDE_DIR: CLAUDE_OVERRIDE, GLMPS_STATE_DIR: STATE_OVERRIDE }, homedir: REAL_HOME });
  assert.equal(p.settingsFile, path.join(CLAUDE_OVERRIDE, 'settings.json'));
  assert.equal(p.stateDir, path.join(STATE_OVERRIDE, 'state'));
  assert.equal(p.hooksRecordFile, path.join(STATE_OVERRIDE, 'hooks-installed.json'));
});

test('resolveInstallPaths: a partial GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR override is refused', () => {
  assert.throws(() => resolveInstallPaths({ env: { GLMPS_CLAUDE_DIR: CLAUDE_OVERRIDE }, homedir: REAL_HOME }), /together/);
  assert.throws(() => resolveInstallPaths({ env: { GLMPS_STATE_DIR: STATE_OVERRIDE }, homedir: REAL_HOME }), /together/);
});

// round 1 treated an empty-string override as
// "unset", which meant `GLMPS_CLAUDE_DIR=""` silently fell through to the REAL
// homedir - exactly the incident's failure mode, just reachable through an
// empty string instead of an absent variable. An empty string in EITHER
// override is now refused outright, regardless of the other one's value.
test('resolveInstallPaths: an empty-string GLMPS_CLAUDE_DIR or GLMPS_STATE_DIR is refused, never silently treated as unset', () => {
  assert.throws(() => resolveInstallPaths({ env: { GLMPS_CLAUDE_DIR: '', GLMPS_STATE_DIR: '' }, homedir: 'X:\\real-home' }), /empty string/i);
  assert.throws(() => resolveInstallPaths({ env: { GLMPS_CLAUDE_DIR: '' }, homedir: 'X:\\real-home' }), /empty string/i);
  assert.throws(() => resolveInstallPaths({ env: { GLMPS_STATE_DIR: '' }, homedir: 'X:\\real-home' }), /empty string/i);
});

test('resolveInstallPaths: an empty GLMPS_CLAUDE_DIR alongside a real GLMPS_STATE_DIR is refused', () => {
  assert.throws(() => resolveInstallPaths({ env: { GLMPS_CLAUDE_DIR: '', GLMPS_STATE_DIR: 'Y:\\state' }, homedir: 'X:\\real-home' }), /empty string/i);
});

// M-c: an unquoted hand-registered command with trailing arguments (no
// closing quote right after the script name) must still be adopted, not
// duplicated - only a longer filename sharing the same prefix (M8's
// done-gate.js.bak) must be excluded.
test('adoption anchor accepts a quote, an apostrophe, whitespace, or end of string - not just a quote', () => {
  const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hooks/workspace-steer.js --verbose' }] }] } };
  const { adopted } = planHookInstall(settings, opts);
  assert.ok(adopted.includes('workspace-steer'), 'an unquoted command with trailing arguments must still be adopted');
});

test('adoption anchor still excludes a longer filename sharing the same prefix, unquoted', () => {
  const settings = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node hooks/done-gate.js.bak' }] }] } };
  const { added, adopted } = planHookInstall(settings, opts);
  assert.ok(added.some((a) => a.id === 'done-gate'));
  assert.ok(!adopted.includes('done-gate'));
});

// M-d: a pathological or accidentally-cyclic-shaped settings object must
// never stack-overflow the byte-restore comparison. A depth cap returns
// false (not equal) past the cap - the safe fallback, since it is the same
// answer as "something else changed", which never destroys data (it just
// skips the byte-for-byte shortcut).
function deepNest(n) {
  let obj = {};
  for (let i = 0; i < n; i++) obj = { a: obj };
  return obj;
}
test('settingsEqual: a depth cap prevents a stack overflow on deeply nested input, returning false', () => {
  const deepA = deepNest(20000);
  const deepB = deepNest(20000);
  assert.doesNotThrow(() => settingsEqual(deepA, deepB));
  assert.equal(settingsEqual(deepA, deepB), false, 'past the depth cap, the safe answer is false, never a crash');
});

// planHookInstall/planHookUninstall's clone()
// used a bare JSON.parse(JSON.stringify(o)), which can stack-overflow on a
// pathologically deep settings object the same way settingsEqual could
// before round 2's depth cap. Refuses (throws a named error) rather than
// crashing or silently truncating - a truncated clone would then get
// WRITTEN to settings.json, silently losing data past the cut point.
test('planHookInstall refuses a pathologically deep settings object instead of crashing or truncating it', () => {
  const deep = deepNest(20000);
  assert.throws(() => planHookInstall(deep, opts), /too deep|maximum depth/i);
});

// M-f: a relative GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR must resolve against the
// current working directory so later string comparisons (I2's
// settingsFile-mismatch refusal) are not fooled by two different relative
// spellings of the same real directory.
test('resolveInstallPaths: relative GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR are resolved to absolute paths', () => {
  const p = resolveInstallPaths({ env: { GLMPS_CLAUDE_DIR: 'relative-claude', GLMPS_STATE_DIR: 'relative-state' }, homedir: 'X:\\real-home' });
  assert.ok(path.isAbsolute(p.settingsFile), `expected an absolute path, got ${p.settingsFile}`);
  assert.equal(p.settingsFile, path.join(path.resolve('relative-claude'), 'settings.json'));
});

// denial-feed and park-wake-context were registered by hand only.
test('denial-feed (PermissionDenied) and park-wake-context (PostToolUse) are manifest rows', () => {
  const denial = HOOK_MANIFEST.find((h) => h.id === 'denial-feed');
  assert.equal(denial.event, 'PermissionDenied');
  assert.equal(denial.script, 'denial-feed.js');
  const park = HOOK_MANIFEST.find((h) => h.id === 'park-wake-context');
  assert.equal(park.event, 'PostToolUse');
  assert.equal(park.script, 'park-wake-context.js');
  const { patched } = planHookInstall({}, opts);
  assert.ok(patched.hooks.PermissionDenied.some((g) => g.hooks[0].command === hookCommand(opts.nodePath, opts.repoRoot, 'denial-feed.js')));
});

test('an identical hand-registered denial-feed or park-wake-context entry is adopted, not duplicated', () => {
  const hand = {
    hooks: {
      PermissionDenied: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand(opts.nodePath, opts.repoRoot, 'denial-feed.js') }] }],
      PostToolUse: [{ matcher: 'Bash|BashOutput|TaskOutput', hooks: [{ type: 'command', command: hookCommand(opts.nodePath, opts.repoRoot, 'park-wake-context.js') }] }],
    },
  };
  const { patched, added, adopted } = planHookInstall(hand, opts);
  assert.ok(adopted.includes('denial-feed'));
  assert.ok(adopted.includes('park-wake-context'));
  assert.ok(!added.some((a) => a.id === 'denial-feed' || a.id === 'park-wake-context'));
  assert.equal(patched.hooks.PermissionDenied.length, 1);
  assert.equal(patched.hooks.PostToolUse.filter((g) => g.hooks.some((h) => /park-wake-context/.test(h.command))).length, 1);
});

test('hookCommand rejects a double quote in the node path or repo root', () => {
  assert.throws(() => hookCommand('C:\\node\\node.exe', 'D:\\a"b', 'done-gate.js'), /double quote/i);
  assert.throws(() => hookCommand('C:\\no"de.exe', 'D:\\mc', 'done-gate.js'), /double quote/i);
});
