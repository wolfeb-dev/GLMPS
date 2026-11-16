// server/test/terminal-program-lookup.test.js
// cmd.exe searches the current directory before PATH, so a claude.bat
// (or cmd.bat) planted in the launch cwd ran as the operator. The recipe now
// starts cmd.exe by absolute path and sets NoDefaultCurrentDirectoryInExePath
// for both cmd processes (and everything they start).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeTerminalRecipe, windowsCmdPath } from '../lib/orchestration/editor-targets.js';

test('F18: the win32 recipe runs cmd.exe by absolute path (outer and inner) and sets NoDefaultCurrentDirectoryInExePath', () => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' };
  const r = nativeTerminalRecipe({ platform: 'win32', seededCmd: 'claude --resume x', cwd: 'D:\\r', env });
  assert.equal(windowsCmdPath(env), 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(r.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(r.args, ['/c', 'start', '""', '"C:\\Windows\\System32\\cmd.exe"', '/k', 'claude --resume x']);
  assert.equal(r.options.env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.equal(r.options.env.PATH, 'C:\\bin', 'the rest of the environment is kept');
  assert.equal(r.options.windowsVerbatimArguments, true);
  assert.equal(r.options.shell, false);
});

test('F18: windowsCmdPath falls back to windir, then C:\\Windows', () => {
  assert.equal(windowsCmdPath({ windir: 'D:\\WIN' }), 'D:\\WIN\\System32\\cmd.exe');
  assert.equal(windowsCmdPath({}), 'C:\\Windows\\System32\\cmd.exe');
});

// Harmless probe: `cmd /d /c <name>` with no window, a .bat that only echoes.
test('F18: with NoDefaultCurrentDirectoryInExePath=1, cmd.exe does not run a program planted in the cwd', { skip: process.platform !== 'win32' && 'cmd.exe only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-f18-'));
  try {
    fs.writeFileSync(path.join(dir, 'zzglmpsprobe.bat'), '@echo PLANTED\r\n');
    const cmdExe = windowsCmdPath(process.env);
    // The host may already export the variable; the control must not inherit it.
    const bare = { ...process.env };
    delete bare.NoDefaultCurrentDirectoryInExePath;
    const control = spawnSync(cmdExe, ['/d', '/c', 'zzglmpsprobe'], { cwd: dir, windowsHide: true, encoding: 'utf8', env: bare });
    assert.match(control.stdout, /PLANTED/, 'control: without the variable cmd.exe runs the planted file');
    const guarded = spawnSync(cmdExe, ['/d', '/c', 'zzglmpsprobe'], { cwd: dir, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } });
    assert.doesNotMatch(guarded.stdout ?? '', /PLANTED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
