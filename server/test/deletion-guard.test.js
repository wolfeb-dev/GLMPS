import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDeleteCommand, isGuardedSession, DELETE_ALTERNATIVE } from '../lib/governance/deletion-guard.js';

const DENIED = [
  'rm a.txt',
  'rm -rf build',
  '/usr/bin/rm -f x',
  'unlink a.txt',
  'rmdir empty',
  'shred -u secret',
  'del a.txt',
  'erase a.txt',
  'rd /s /q build',
  'cmd /c "del /q a.txt"',
  'Remove-Item -Recurse -Force build',
  'remove-item a.txt',
  'ri a.txt',
  'powershell -Command "Remove-Item a.txt"',
  'git clean -fdx',
  'git -C D:/repo clean -f',
  'git reset --hard HEAD~1',
  'git rm a.txt',
  'git rm -r dir',
  'find . -name "*.tmp" -delete',
  'find . -name x -exec rm {} \\;',
  'ls | xargs rm',
  'sudo rm -rf /tmp/x',
  'npx rimraf dist',
  'npx -y rimraf dist',
  'bash -c "rm -rf x"',
  'cd sub && rm a',
  'echo ok; rm a',
  'node -e "require(\'fs\').rmSync(\'x\', { recursive: true })"',
  'node -e "fs.unlinkSync(\'x\')"',
  'node --eval "require(\'fs\').promises.rm(\'x\')"',
  'python -c "import shutil; shutil.rmtree(\'x\')"',
  'python3 -c "import os; os.remove(\'x\')"',
  'py -c "from pathlib import Path; Path(\'x\').unlink()"',
  '[System.IO.File]::Delete("a.txt")',
  '[IO.Directory]::Delete("d", $true)',
];

const ALLOWED = [
  'mv a.txt a.txt.old',
  'git mv a.txt a.txt.old',
  'Rename-Item a.txt a.txt.old',
  'ren a.txt a.txt.old',
  'move a.txt a.txt.old',
  'cp a.txt a.txt.bak',
  'Copy-Item a.txt b.txt',
  'git rm --cached a.txt',
  'git rm -r --cached dir',
  'git clean -n',
  'git clean --dry-run -d',
  'git reset --soft HEAD~1',
  'git reset HEAD a.txt',
  'echo "rm -rf is denied"',
  'git commit -m "rm stale files"',
  'grep -rn rmSync server',
  'node --test server/test/x.test.js',
  'node -e "console.log(1)"',
  'python -c "print(1)"',
  'ls -la',
  'npm run format',
  'npx prettier --check .',
];

for (const cmd of DENIED) {
  test(`denies: ${cmd}`, () => {
    const v = checkDeleteCommand(cmd);
    assert.equal(v.block, true, JSON.stringify(v));
    assert.match(v.reason, /copy/i);
    assert.match(v.reason, /\.old/);
  });
}

for (const cmd of ALLOWED) {
  test(`allows: ${cmd}`, () => {
    const v = checkDeleteCommand(cmd);
    assert.equal(v.block, false, JSON.stringify(v));
  });
}

test('the deny message names copy and rename to <name>.old', () => {
  assert.match(DELETE_ALTERNATIVE, /copy/i);
  assert.match(DELETE_ALTERNATIVE, /<name>\.old/);
});

test('unparseable or empty input is allowed, never thrown', () => {
  for (const c of [undefined, null, '', '"unterminated', 42]) assert.equal(checkDeleteCommand(c).block, false);
});

test('a runner role is an agent session; no role is the operator', () => {
  assert.equal(isGuardedSession({ GLMPS_ROLE: 'worker' }), true);
  assert.equal(isGuardedSession({ GLMPS_ROLE: 'reviewer' }), true);
  assert.equal(isGuardedSession({}), false);
  assert.equal(isGuardedSession({ GLMPS_ROLE: 'nonsense' }), false);
});

test('GLMPS_DELETION_GUARD widens to every session or turns the guard off', () => {
  assert.equal(isGuardedSession({ GLMPS_DELETION_GUARD: 'all' }), true);
  assert.equal(isGuardedSession({ GLMPS_ROLE: 'worker', GLMPS_DELETION_GUARD: 'off' }), false);
});
