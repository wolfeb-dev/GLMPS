// server/test/cutover-marker.test.js
// D30: the cutover marker that flips the 2.0 hooks' defaults. Scratch homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cutoverActiveFile, cutoverDir, isCutoverActive, productionStateDir, ACTIVE_MARKER_NAME } from '../lib/kernel/cutover-marker.js';

function scratchHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cutover-marker-')); }

test('the marker lives at <home>/.glmps/cutover/active.json', () => {
  const home = scratchHome();
  try {
    assert.equal(productionStateDir(home), path.join(home, '.glmps'));
    assert.equal(cutoverDir(path.join(home, '.glmps')), path.join(home, '.glmps', 'cutover'));
    assert.equal(cutoverActiveFile(home), path.join(home, '.glmps', 'cutover', ACTIVE_MARKER_NAME));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('isCutoverActive is false until the marker exists, then true', () => {
  const home = scratchHome();
  try {
    assert.equal(isCutoverActive(home), false);
    fs.mkdirSync(path.dirname(cutoverActiveFile(home)), { recursive: true });
    fs.writeFileSync(cutoverActiveFile(home), '{}');
    assert.equal(isCutoverActive(home), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a directory named active.json does not read as active (the marker must be a regular file)', () => {
  const home = scratchHome();
  try {
    fs.mkdirSync(cutoverActiveFile(home), { recursive: true });
    assert.equal(isCutoverActive(home), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a failing existence check reads as not active (the shadow defaults), never throws', () => {
  assert.equal(isCutoverActive('X:/nowhere', () => { throw new Error('EACCES'); }), false);
});
