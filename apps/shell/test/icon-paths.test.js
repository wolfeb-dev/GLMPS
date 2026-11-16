import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { iconDir } from '../src/lib/icon-paths.js';

const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));

test('a packaged build takes icons from real files under resources, never from inside app.asar', () => {
  assert.equal(iconDir({ isPackaged: true, resourcesPath: '/r/resources', assetsDir: '/r/resources/app.asar/assets' }), '/r/resources');
});

test('a dev run keeps assets/, and a packaged run without a resources path falls back to it', () => {
  assert.equal(iconDir({ isPackaged: false, resourcesPath: '/x', assetsDir: '/a' }), '/a');
  assert.equal(iconDir({ isPackaged: true, resourcesPath: undefined, assetsDir: '/a' }), '/a');
});

test('extraResources copies every shipped .ico to resources/ so the resolver finds them', () => {
  assert.deepEqual(pkg.build.extraResources[1], { from: 'assets', to: '.', filter: ['*.ico'] });
  for (const name of ['icon', 'tray-up', 'tray-degraded', 'tray-down']) {
    assert.ok(fs.existsSync(path.resolve(import.meta.dirname, '..', 'assets', `${name}.ico`)), name);
  }
});

test('the NSIS include refreshes the Explorer icon cache with SHCNE_ASSOCCHANGED', () => {
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
  const nsh = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!macro customInstall[\s\S]*System::Call 'shell32::SHChangeNotify\(i 0x08000000, i 0, p 0, p 0\)'[\s\S]*!macroend/);
});
