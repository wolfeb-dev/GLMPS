import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));

test('identity: appId never changes (the NSIS GUID derives from it), 2.0 product name and appId never collide with a production shell install', () => {
  assert.equal(pkg.build.appId, 'dev.glmps.shell2');
  assert.equal(pkg.build.productName, 'GLMPS 2.0');
});

test('per-user assisted NSIS installer with the mark as its icon, no publishing, no auto-update', () => {
  assert.deepEqual(pkg.build.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.publish, null);
  assert.equal(JSON.stringify(pkg).includes('electron-updater'), false);
});

test('only runtime files are packaged: no tests, smoke run or build scripts', () => {
  assert.deepEqual(pkg.build.files, ['src/**/*', 'renderer/**/*', 'assets/**/*', 'package.json']);
});

// glmps-2-0-59: the installer carries its own Node and kernel, staged fresh on
// every dist build so a stale bundle never ships.
test('the staged kernel ships as resources/kernel and every dist build restages it', () => {
  assert.deepEqual(pkg.build.extraResources[0], { from: 'kernel-stage', to: 'kernel' });
  assert.match(pkg.scripts.dist, /^npm run stage-kernel && /);
  assert.match(pkg.scripts['dist:dir'], /^npm run stage-kernel && /);
});

// Task 15, L3 / W5 (security review): the Electron fuses were configured but
// nothing pinned them, so a one-line edit could silently re-enable
// ELECTRON_RUN_AS_NODE or --inspect in the packaged exe. Every key and value
// is pinned (an added or removed key fails too). Reading the BUILT exe's fuse
// wire is a cutover check on the operator acceptance list, not a unit test.
test('L3: every Electron fuse key and value is pinned', () => {
  assert.deepEqual(pkg.build.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  });
});

// glmps-2-0-202: the installer shows the MIT license before it installs. The
// path is relative to this package (electron-builder's project dir).
test('the NSIS installer shows the repository LICENSE on a license page', () => {
  assert.equal(pkg.build.nsis.license, '../../LICENSE');
  const file = path.resolve(import.meta.dirname, '..', pkg.build.nsis.license);
  assert.ok(fs.existsSync(file), `${file} must exist`);
  assert.match(fs.readFileSync(file, 'utf8'), /MIT License/);
});
