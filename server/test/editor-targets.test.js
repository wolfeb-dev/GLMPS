import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as et from '../lib/orchestration/editor-targets.js';

test('resolveTarget order: item.target > lastTarget > running > native fallback', () => {
  assert.equal(et.resolveTarget({ item: { target: 'cursor' }, lastTarget: 'vscode', running: ['windsurf'] }), 'cursor');
  assert.equal(et.resolveTarget({ item: {}, lastTarget: 'vscode', running: ['windsurf'] }), 'vscode');
  assert.equal(et.resolveTarget({ item: {}, lastTarget: null, running: ['windsurf'] }), 'windsurf');
  assert.equal(et.resolveTarget({ item: {}, lastTarget: null, running: [] }), 'native-terminal');
});

test('resolveTarget ignores unknown ids', () => {
  assert.equal(et.resolveTarget({ item: { target: 'emacs' }, lastTarget: 'bogus', running: [] }), 'native-terminal');
});

test('seededCommand embeds the prompt-file path in a shell-safe instruction', () => {
  const c = et.seededCommand('claude', 'C:/Users/x/.glmps/runner/glmps-1.prompt.md');
  assert.match(c, /^claude "/);
  assert.match(c, /glmps-1\.prompt\.md/);
  assert.ok(!c.includes('\n'));                       // single line
  assert.equal((c.match(/"/g) || []).length, 2);      // exactly one quoted arg, no nested quotes
});

test('taskInstruction names the file and carries no quotes/newlines', () => {
  const i = et.taskInstruction('/x/glmps-1.prompt.md');
  assert.match(i, /glmps-1\.prompt\.md$/);
  assert.ok(!i.includes('"') && !i.includes('\n'));
});

test('nativeTerminalRecipe is platform-specific and includes cwd', () => {
  const win = et.nativeTerminalRecipe({ platform: 'win32', seededCmd: 'node seed -- claude', cwd: 'C:/repo' });
  assert.equal(win.options.cwd, 'C:/repo');
  assert.ok(Array.isArray(win.args));
  const mac = et.nativeTerminalRecipe({ platform: 'darwin', seededCmd: 'node seed -- claude', cwd: '/repo' });
  assert.equal(mac.file, 'osascript');
  const lin = et.nativeTerminalRecipe({ platform: 'linux', seededCmd: 'node seed -- claude', cwd: '/repo' });
  assert.equal(lin.options.cwd, '/repo');
});

// verified with a harmless no-window probe
// (spawnSync('cmd', ['/c', 'echo', command], { shell: false, windowsHide:
// true }), inspecting cmd.exe's own echoed command line - never claude,
// never /k, never a visible window) that Node's DEFAULT (non-verbatim)
// Windows argv-to-command-line conversion re-escapes a seededCmd argv
// element containing an embedded `"` (wraps it in an extra pair of quotes
// and backslash-escapes the inner ones) before cmd.exe ever sees it - so
// `cmd /k <seededCmd>` would run on a MANGLED command line, not the exact
// text this module built. windowsVerbatimArguments: true stops Node from
// doing that: the probe confirmed the array joins into the literal,
// unmangled command line instead.
test('nativeTerminalRecipe (win32) sets windowsVerbatimArguments so an embedded quote in seededCmd is never re-escaped', () => {
  const win = et.nativeTerminalRecipe({ platform: 'win32', seededCmd: 'claude -p "x --mcp-config y" --resume 3f2a9b1c-1111-4222-8333-444455556666', cwd: 'C:/repo' });
  assert.equal(win.options.windowsVerbatimArguments, true);
  assert.equal(win.options.shell, false, 'verbatim mode still never goes through a real shell');
});

// the darwin AppleScript branch used to interpolate cwd
// unquoted into `cd ${cwd} && ...` - a space breaks the `cd` argument split,
// and any `"`/`\` in it breaks out of the AppleScript "do script" string.
// Round-trips through both layers' escaping instead of pinning a fragile
// literal: undo the AppleScript string escaping, then the POSIX single-quote
// escaping, and the result must be exactly the original cwd.
test('nativeTerminalRecipe (darwin) quotes a cwd with a space or a quote for both the shell and the AppleScript string', () => {
  for (const cwd of ['/Users/x/My Project', "/Users/x/Mike's Project"]) {
    const r = et.nativeTerminalRecipe({ platform: 'darwin', seededCmd: 'claude', cwd });
    const script = r.args[1];
    const m = /cd (.+) && claude/.exec(script);
    assert.ok(m, `expected a cd clause in: ${script}`);
    const asUnescaped = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const shUnquoted = asUnescaped.slice(1, -1).replace(/'\\''/g, "'");
    assert.equal(shUnquoted, cwd);
  }
});

// Pre-step (b) of Task 12b: a raw newline/carriage-return embedded in cwd or
// seededCmd used to pass straight through appleScriptQuote's escaping (which
// only handled \\ and "). AppleScript's `do script` runs its string as if it
// had been typed into Terminal, so an embedded newline would execute
// whatever followed it as a SECOND, independent shell command - not merely a
// cosmetic AppleScript syntax break. Refused by name instead.
test('nativeTerminalRecipe (darwin) refuses a cwd or command carrying a newline or carriage-return', () => {
  assert.throws(
    () => et.nativeTerminalRecipe({ platform: 'darwin', seededCmd: 'claude', cwd: '/repo\nrm -rf /' }),
    /newline|carriage-return/,
  );
  assert.throws(
    () => et.nativeTerminalRecipe({ platform: 'darwin', seededCmd: 'claude\nrm -rf /', cwd: '/repo' }),
    /newline|carriage-return/,
  );
  assert.throws(
    () => et.nativeTerminalRecipe({ platform: 'darwin', seededCmd: 'claude', cwd: '/repo\r\nrm -rf /' }),
    /newline|carriage-return/,
  );
  // An ordinary cwd/command with neither character is unaffected.
  assert.doesNotThrow(() => et.nativeTerminalRecipe({ platform: 'darwin', seededCmd: 'claude', cwd: '/repo' }));
});

// glmps-2-0-218: any VS Code family IDE hosts a session through its companion,
// when it is live or can be started; native-terminal never has a companion.
test('launchTargetFor: an IDE target stays itself when live or launchable, else native', () => {
  assert.equal(et.launchTargetFor('antigravity', { live: ['antigravity'] }), 'antigravity');
  assert.equal(et.launchTargetFor('cursor', { launchable: ['cursor'] }), 'cursor');
  assert.equal(et.launchTargetFor('vscode', { live: ['cursor'], launchable: ['antigravity'] }), 'native-terminal');
  assert.equal(et.launchTargetFor('antigravity', {}), 'native-terminal');
  assert.equal(et.launchTargetFor('antigravity'), 'native-terminal');
  assert.equal(et.launchTargetFor('native-terminal', { live: ['native-terminal'], launchable: ['native-terminal'] }), 'native-terminal');
  assert.equal(et.launchTargetFor('zed', { live: ['zed'] }), 'native-terminal');
});

test('companionRecord is the terminal record the installed companion drains', () => {
  assert.deepEqual(et.companionRecord({ command: 'claude --resume x', cwd: 'D:\\r', now: 5 }),
    { type: 'terminal', target: 'antigravity', command: 'claude --resume x', cwd: 'D:\\r', location: 'editor', ts: 5 });
  assert.equal(et.companionRecord({ command: 'c', now: 1 }).cwd, null);
  assert.equal('name' in et.companionRecord({ command: 'c', now: 1 }), false);
  assert.equal(et.companionRecord({ command: 'c', now: 1, name: 'mc: gemini glmps-2-0-9' }).name, 'mc: gemini glmps-2-0-9');
  assert.equal(et.companionRecord({ command: 'c', now: 1, target: 'cursor' }).target, 'cursor');
});

test('each IDE drains its own request file; antigravity keeps the original name', () => {
  const home = 'C:\\Users\\u';
  const dir = path.join(home, '.glmps', 'requests');
  assert.equal(et.companionRequestsFile(home), path.join(dir, 'resume.jsonl'));
  assert.equal(et.companionRequestsFile(home, 'antigravity'), path.join(dir, 'resume.jsonl'));
  assert.equal(et.companionRequestsFile(home, 'vscode'), path.join(dir, 'resume.vscode.jsonl'));
  assert.equal(et.companionRequestsFile(home, 'vscode-insiders'), path.join(dir, 'resume.vscode-insiders.jsonl'));
  assert.equal(et.companionFileName('cursor'), 'resume.cursor.jsonl');
  assert.equal(et.companionFileName('native-terminal'), null);
});

test('liveIdeTargets reads image names from tasklist CSV, one target each', () => {
  const csv = [
    '"Code.exe","100","Console","1","50,000 K"',
    '"Code - Insiders.exe","101","Console","1","50,000 K"',
    '"Antigravity IDE.exe","102","Console","1","50,000 K"',
    '"notepad.exe","103","Console","1","5,000 K"',
    '"vscode-helper.exe","104","Console","1","5,000 K"',
  ].join('\r\n');
  assert.deepEqual(et.liveIdeTargets(csv).sort(), ['antigravity', 'vscode', 'vscode-insiders']);
  assert.deepEqual(et.liveIdeTargets('"Code - Insiders.exe","1","c","1","2 K"'), ['vscode-insiders']);
  assert.deepEqual(et.liveIdeTargets('"Cursor.exe","1","c","1","2 K"\n"Windsurf.exe","2","c","1","2 K"').sort(), ['cursor', 'windsurf']);
  assert.deepEqual(et.liveIdeTargets(''), []);
  assert.deepEqual(et.liveIdeTargets(null), []);
});

test('resumeCommand builds `<cmd> --resume <uuid>` and refuses anything that is not a session UUID', () => {
  // Same rule as Phase C's isSessionUuid (C Task 7): a mangled id must be refused, never resumed as something else.
  assert.equal(et.resumeCommand('3f2a9b1c-1111-4222-8333-444455556666', 'claude'), 'claude --resume 3f2a9b1c-1111-4222-8333-444455556666');
  assert.equal(et.resumeCommand('abc; rm -rf /', 'claude'), null);
  assert.equal(et.resumeCommand('3f2a-9b', 'claude'), null);
  assert.equal(et.resumeCommand('', 'claude'), null);
  assert.equal(et.resumeCommand(undefined), null);
});

// glmps-2-0-156: a companion line nobody drained for 2 minutes is a stalled launch.
const SID_A = '7980789a-acd2-47f5-a884-1070b9a5073d';
const SID_B = '0c145e2e-6cba-4c04-8ef7-c3af90e2267c';

test('sessionIdOfCommand reads --session-id and --resume, and nothing else', () => {
  assert.equal(et.sessionIdOfCommand(`claude --session-id ${SID_A} "Read the task"`), SID_A);
  assert.equal(et.sessionIdOfCommand(`claude --resume ${SID_B}`), SID_B);
  assert.equal(et.sessionIdOfCommand('claude --session-id not-a-uuid'), null);
  assert.equal(et.sessionIdOfCommand('pwsh'), null);
  assert.equal(et.sessionIdOfCommand(null), null);
});

test('staleCompanionRequests returns only lines older than the limit, skipping junk', () => {
  const now = 1_000_000;
  const text = [
    JSON.stringify({ type: 'terminal', command: `claude --session-id ${SID_A} "x"`, cwd: '/w/155', ts: now - 49 * 60_000 }),
    'not json',
    JSON.stringify({ type: 'terminal', command: `claude --resume ${SID_B}`, cwd: null, ts: now - 30_000 }),
    JSON.stringify({ type: 'terminal', command: 'pwsh', ts: 'soon' }),
    '',
  ].join('\n');
  assert.deepEqual(et.staleCompanionRequests({ text, now, maxAgeMs: 2 * 60_000 }), [
    { sessionId: SID_A, cwd: '/w/155', ts: now - 49 * 60_000, ageMs: 49 * 60_000 },
  ]);
  assert.deepEqual(et.staleCompanionRequests({ text: '', now, maxAgeMs: 1 }), []);
});
