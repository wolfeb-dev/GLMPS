// server/test/editor-roots.test.js
// glmps-50: shared per-OS VS Code-family editor enumeration, reused by the
// cline and copilot-chat adapters. Register docs/future-changes.md #5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  EDITORS, editorStorageDirs, globalStorageDirs, workspaceStorageDirs,
} from '../lib/adapters/editor-roots.js';

const HOME_WIN = 'C:\\Users\\u';
const HOME_NIX = '/home/u';

const REQUIRED = ['Code', 'Cursor', 'Code - Insiders', 'VSCodium', 'Windsurf'];

test('EDITORS covers the required fork list', () => {
  const names = EDITORS.map(e => e[0]);
  for (const r of REQUIRED) assert.ok(names.includes(r), `missing editor: ${r}`);
});

test('win32: roots live under %APPDATA%/<editor>/User/<kind>', () => {
  const dirs = globalStorageDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: HOME_WIN });
  for (const r of REQUIRED) {
    const hit = dirs.find(d => d.dir === path.join('C:\\Users\\u\\AppData\\Roaming', r, 'User', 'globalStorage'));
    assert.ok(hit, `win32 missing ${r}: ${JSON.stringify(dirs.map(d => d.dir))}`);
    assert.ok(hit.label, 'carries a display label');
  }
});

test('win32 without APPDATA env falls back to home AppData/Roaming', () => {
  const dirs = globalStorageDirs({ platform: 'win32', env: {}, home: HOME_WIN });
  assert.ok(dirs.some(d => d.dir === path.join(HOME_WIN, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage')));
});

test('darwin: roots live under ~/Library/Application Support', () => {
  const dirs = workspaceStorageDirs({ platform: 'darwin', env: {}, home: HOME_NIX });
  for (const r of REQUIRED) {
    assert.ok(dirs.some(d => d.dir === path.join(HOME_NIX, 'Library', 'Application Support', r, 'User', 'workspaceStorage')),
      `darwin missing ${r}`);
  }
});

test('linux: roots live under $XDG_CONFIG_HOME (else ~/.config)', () => {
  const xdg = globalStorageDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: HOME_NIX });
  assert.ok(xdg.some(d => d.dir === path.join('/xdg', 'Windsurf', 'User', 'globalStorage')));
  const dflt = globalStorageDirs({ platform: 'linux', env: {}, home: HOME_NIX });
  assert.ok(dflt.some(d => d.dir === path.join(HOME_NIX, '.config', 'Code - Insiders', 'User', 'globalStorage')));
});

test('extra editors are config-extensible and appended with labels', () => {
  const dirs = globalStorageDirs({ platform: 'linux', env: {}, home: HOME_NIX, extra: ['Trae'] });
  assert.ok(dirs.some(d => d.dir === path.join(HOME_NIX, '.config', 'Trae', 'User', 'globalStorage') && d.label === 'Trae'));
});

test('editorStorageDirs is the generic form (kind parameterized)', () => {
  const dirs = editorStorageDirs('chatSessions-test', { platform: 'linux', env: {}, home: HOME_NIX });
  assert.ok(dirs.every(d => d.dir.endsWith(path.join('User', 'chatSessions-test'))));
  assert.equal(new Set(dirs.map(d => d.dir)).size, dirs.length, 'no duplicate roots');
});
