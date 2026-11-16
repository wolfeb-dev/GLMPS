// apps/shell/test/app-identity.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appUserModelId } from '../src/lib/app-identity.js';

test('a packaged build uses the installer appId as its AUMID', () => {
  assert.equal(appUserModelId({ appId: 'dev.glmps.shell2', isPackaged: true }), 'dev.glmps.shell2');
});

test('a dev run gets its own AUMID, so a dev shortcut cannot claim the installed app', () => {
  const id = appUserModelId({ appId: 'dev.glmps.shell2', isPackaged: false });
  assert.notEqual(id, 'dev.glmps.shell2');
  assert.equal(id, 'dev.glmps.shell2.dev');
});

test('main.js sets the AUMID through appUserModelId', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /app\.setAppUserModelId\(appUserModelId\(\{ appId: APP_ID, isPackaged: app\.isPackaged \}\)\)/);
});
