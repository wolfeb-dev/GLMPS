// apps/shell/test/app-id.test.js
// The AUMID passed to app.setAppUserModelId must equal the NSIS installer's
// appId (electron-builder nsis.md), or toasts resolve to the wrong/missing
// shortcut and a 2.0 build could collide with a production shell's AUMID.
// Static text reads only - main.js imports electron, so it is never
// import()-ed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SHELL = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(SHELL, 'package.json'), 'utf8'));
const mainSrc = fs.readFileSync(path.join(SHELL, 'src', 'main.js'), 'utf8');

test('main.js APP_ID (the AUMID) equals package.json build.appId', () => {
  const match = mainSrc.match(/export const APP_ID = '([^']+)';/);
  assert.ok(match, 'APP_ID literal not found in main.js');
  assert.equal(match[1], pkg.build.appId);
});
