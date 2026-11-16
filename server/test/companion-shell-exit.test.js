import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withShellExit } from '../../companion/src/shell-exit.ts';

const runner = 'claude --session-id 1 "Read the task described in this file: C:\\Users\\w\\.glmps\\runner\\glmps-2-0-117.prompt.md"';

test('a runner command exits its shell when it ends', () => {
  assert.equal(withShellExit(runner, 'C:\\Program Files\\Git\\bin\\bash.exe'), `${runner}; exit 0`);
  assert.equal(withShellExit(runner, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'), `${runner}; exit 0`);
  assert.equal(withShellExit(runner, 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), `${runner}; exit 0`);
  assert.equal(withShellExit(runner, '/bin/zsh'), `${runner}; exit 0`);
  assert.equal(withShellExit(runner, 'C:\\WINDOWS\\System32\\CMD.EXE'), `${runner} & exit 0`);
});

test('a non-runner command keeps its shell', () => {
  assert.equal(withShellExit('claude --resume 0f0e', 'C:\\Program Files\\Git\\bin\\bash.exe'), 'claude --resume 0f0e');
  assert.equal(withShellExit('', 'bash'), '');
});

test('an unknown or missing shell is left as it was', () => {
  assert.equal(withShellExit(runner, 'C:\\tools\\elvish.exe'), runner);
  assert.equal(withShellExit(runner, undefined), runner);
});
