import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalName } from '../../companion/src/terminal-name.ts';
import { withShellExit } from '../../companion/src/shell-exit.ts';

test('AC-6: a named request titles its tab by name, else by the command as before', () => {
  assert.equal(terminalName({ name: 'mc: gemini glmps-2-0-9', command: 'node "x"' }), 'mc: gemini glmps-2-0-9');
  assert.equal(terminalName({ command: 'claude --session-id 1 "go"' }), 'mc: claude');
  assert.equal(terminalName({ name: '  ', command: 'claude' }), 'mc: claude');
  assert.equal(terminalName({ name: 5, command: '' }), 'mc terminal');
  assert.equal(terminalName({ name: 'mc: x\u001b[2J' + 'y'.repeat(80) }).length, 60);
});

test('AC-6: a vendor tab command closes its shell when the session ends, like a Claude card', () => {
  const cmd = 'node "D:\\glmps-2.0-live\\apps\\shell\\scripts\\vendor-session.mjs" "C:\\Users\\w\\.glmps2\\runner\\glmps-2-0-9.vendor-session.json" "C:\\Users\\w\\.glmps2\\runner\\glmps-2-0-9.prompt.md"';
  assert.equal(withShellExit(cmd, 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), `${cmd}; exit 0`);
});
