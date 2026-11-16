// The Default IDE wizard step's two effects (server/lib/chassis/editor-setup.js):
// save the pick, and install the companion with the IDE's own CLI. Every effect
// is injected: no real IDE, config or process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveEditorPick, installCompanion, findCompanionPackage, installCommand } from '../lib/chassis/editor-setup.js';

const HOME = 'C:\\Users\\op';
const CLI = 'C:\\Users\\op\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd';
const VSIX = 'C:\\Program Files\\GLMPS\\resources\\kernel\\companion\\glmps-companion-0.1.3.vsix';
const existsOnly = (...ps) => (p) => ps.includes(p);

test('saveEditorPick sets both the session target and the Open-files target', () => {
  const saved = [];
  const r = saveEditorPick({ target: 'cursor', saveConfig: (p) => { saved.push(p); return p; } });
  assert.deepEqual(r, { ok: true, target: 'cursor' });
  assert.deepEqual(saved, [{ lastTarget: 'cursor', openTarget: 'cursor' }]);
});

test('saveEditorPick refuses anything that is not one of the six targets', () => {
  const saved = [];
  for (const bad of ['zed', '', null, undefined, '../x', 'vscode; calc']) {
    assert.equal(saveEditorPick({ target: bad, saveConfig: (p) => saved.push(p) }).ok, false);
  }
  assert.deepEqual(saved, []);
  assert.equal(saveEditorPick({ target: 'native-terminal', saveConfig: () => ({}) }).ok, true);
});

test('saveEditorPick reports a write failure by name', () => {
  const r = saveEditorPick({ target: 'vscode', saveConfig: () => { throw new Error('EACCES'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /EACCES/);
});

test('installCommand runs the detected CLI through cmd.exe, fixed flags, nothing else', () => {
  const c = installCommand({ platform: 'win32', cli: CLI, vsix: VSIX, env: { SystemRoot: 'C:\\Windows' } });
  assert.equal(c.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(c.args, ['/d', '/s', '/c', `""${CLI}" --install-extension "${VSIX}" --force"`]);
  assert.equal(c.options.windowsVerbatimArguments, true);
  assert.equal(c.options.shell, false);
});

test('installCommand refuses a path with shell metacharacters or a quote', () => {
  for (const bad of ['C:\\x"&calc\\code.cmd', 'C:\\x\\code.cmd & calc', 'C:\\%PATH%\\code.cmd', 'C:\\x^y\\code.cmd', 'C:\\a|b\\code.cmd']) {
    assert.equal(installCommand({ platform: 'win32', cli: bad, vsix: VSIX, env: {} }), null, bad);
    assert.equal(installCommand({ platform: 'win32', cli: CLI, vsix: bad, env: {} }), null, bad);
  }
});

test('installCompanion installs into the chosen IDE with its detected CLI', () => {
  const calls = [];
  const r = installCompanion({
    target: 'vscode', home: HOME, programFiles: [], kernelDir: 'K', platform: 'win32',
    exists: existsOnly(CLI), findPackage: () => VSIX, run: (cmd) => { calls.push(cmd); return { status: 0, stdout: 'Extension installed', stderr: '' }; },
  });
  assert.deepEqual(r, { ok: true, target: 'vscode' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[3], /--install-extension/);
});

test('installCompanion names why it could not: not installed, no package, install failed, bad target', () => {
  const base = { home: HOME, programFiles: [], kernelDir: 'K', platform: 'win32', exists: existsOnly(CLI), findPackage: () => VSIX, run: () => ({ status: 0, stdout: '', stderr: '' }) };
  assert.equal(installCompanion({ ...base, target: 'cursor' }).reason, 'not-installed');
  assert.equal(installCompanion({ ...base, target: 'vscode', findPackage: () => null }).reason, 'no-package');
  assert.equal(installCompanion({ ...base, target: 'native-terminal' }).reason, 'bad-target');
  assert.equal(installCompanion({ ...base, target: 'zed' }).reason, 'bad-target');
  const failed = installCompanion({ ...base, target: 'vscode', run: () => ({ status: 1, stdout: '', stderr: 'boom' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /install-failed/);
  assert.equal(installCompanion({ ...base, target: 'vscode', run: () => { throw new Error('spawn EINVAL'); } }).ok, false);
});

test('installCompanion never runs anything when the path is unsafe', () => {
  let ran = false;
  const r = installCompanion({
    target: 'vscode', home: HOME, programFiles: [], kernelDir: 'K', platform: 'win32',
    exists: existsOnly(CLI), findPackage: () => 'C:\\x"&calc.vsix', run: () => { ran = true; return { status: 0 }; },
  });
  assert.equal(r.ok, false);
  assert.equal(ran, false);
});

test('findCompanionPackage picks the newest vsix under the kernel companion folder', () => {
  const readdir = (d) => (d.endsWith('companion') ? ['readme.txt', 'glmps-companion-0.1.2.vsix', 'glmps-companion-0.1.10.vsix'] : []);
  assert.match(findCompanionPackage({ kernelDir: 'K', readdir }), /glmps-companion-0\.1\.10\.vsix$/);
  assert.equal(findCompanionPackage({ kernelDir: 'K', readdir: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(findCompanionPackage({ kernelDir: 'K', readdir: () => ['a.txt'] }), null);
});
