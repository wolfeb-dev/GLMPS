// apps/shell/test/terminal-recipe-parity.test.js
// The shell opens terminals exactly the way the kernel did before session 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { terminalRecipe } from '../src/lib/terminal-recipe.js';
import { nativeTerminalRecipe } from '../../../server/lib/orchestration/editor-targets.js';

// m2: the full recipe, not only file/args/cwd - detached/stdio/windowsHide/
// shell all matter (shell:false in particular is what keeps a request-
// derived command from ever being re-parsed by cmd.exe a second time).
test('win32 recipe matches the kernel recipe, options included', () => {
  const k = nativeTerminalRecipe({ platform: 'win32', seededCmd: 'claude --resume x', cwd: 'D:\\r' });
  const s = terminalRecipe({ command: 'claude --resume x', cwd: 'D:\\r' });
  assert.deepEqual(s, k);
});

// A command carrying a quoted argument with spaces (the runner's own
// taskInstruction-quoted shape) must parity-match too, not just a bare
// one-word command.
test('win32 recipe matches the kernel recipe for a command with spaces and a quoted argument', () => {
  const command = 'claude --session-id 3f2a9b1c-1111-4222-8333-444455556666 "Read the task described in this file and complete it, then update its backlog card status: D:\\r\\glmps-1.prompt.md"';
  const k = nativeTerminalRecipe({ platform: 'win32', seededCmd: command, cwd: 'D:\\project folder' });
  const s = terminalRecipe({ command, cwd: 'D:\\project folder' });
  assert.deepEqual(s, k);
});

// proves the fix actually works, not only that both
// recipes agree on the flag. Swaps the recipe's own `start ""`/`cmd /k`
// prefix for a harmless `echo` (never opens a window, never runs claude)
// so cmd.exe echoes back EXACTLY the command-line text it received -
// confirming an embedded `"` in `command` survives verbatim under
// windowsVerbatimArguments, where Node's default argv quoting would have
// wrapped and re-escaped it before cmd.exe ever saw it.
// cmd.exe exists only on Windows; the root npm test also
// runs on the ubuntu CI legs, where spawnSync('cmd') fails with ENOENT and
// leaves stdout unset (a TypeError, not a skip).
test('windowsVerbatimArguments actually delivers an embedded quote verbatim (no window, no claude)', { skip: process.platform !== 'win32' && 'cmd.exe only' }, () => {
  const command = 'claude -p "x --mcp-config y" --resume 3f2a9b1c-1111-4222-8333-444455556666';
  const { options } = terminalRecipe({ command, cwd: 'D:\\r' });
  const r = spawnSync('cmd', ['/c', 'echo', command], { windowsHide: true, shell: false, encoding: 'utf8', windowsVerbatimArguments: options.windowsVerbatimArguments });
  assert.equal(r.stdout.trim(), command);
});

test('F18: the shell recipe matches the kernel recipe with an explicit env, including the absolute cmd.exe and NoDefaultCurrentDirectoryInExePath', () => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' };
  const k = nativeTerminalRecipe({ platform: 'win32', seededCmd: 'claude', cwd: 'D:\\r', env });
  const s = terminalRecipe({ command: 'claude', cwd: 'D:\\r', env });
  assert.deepEqual(s, k);
  assert.equal(s.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(s.options.env.NoDefaultCurrentDirectoryInExePath, '1');
});
