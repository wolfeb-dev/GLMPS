// apps/shell/test/local-pages.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SCHEME, localPageUrl, resolveLocalPage } from '../src/lib/local-pages.js';

const DIR = path.resolve('/app/renderer');

test('the three pages resolve inside the renderer dir with the right type', () => {
  assert.equal(SCHEME, 'glmps-shell');
  assert.deepEqual(resolveLocalPage('glmps-shell://renderer/splitter.html', DIR),
    { file: path.join(DIR, 'splitter.html'), contentType: 'text/html; charset=utf-8' });
  assert.equal(resolveLocalPage('glmps-shell://renderer/picker.css', DIR).contentType, 'text/css; charset=utf-8');
  assert.equal(resolveLocalPage('glmps-shell://renderer/offline.js', DIR).contentType, 'text/javascript; charset=utf-8');
  assert.equal(resolveLocalPage('glmps-shell://renderer/x.svg', DIR).contentType, 'image/svg+xml');
  assert.equal(resolveLocalPage('glmps-shell://renderer/x.png', DIR).contentType, 'image/png');
});

test('localPageUrl builds the scheme URL', () => {
  assert.equal(localPageUrl('offline.html'), 'glmps-shell://renderer/offline.html');
});

test('traversal, absolute paths, other hosts, other schemes and unknown types are refused', () => {
  for (const u of [
    'glmps-shell://renderer/%2E%2E%2Fmain.js',
    'glmps-shell://renderer/..%5Cmain.js',
    'glmps-shell://renderer/C:/Windows/win.ini',
    'glmps-shell://renderer/%5CWindows%5Cwin.ini',
    'glmps-shell://renderer//etc/passwd',
    'glmps-shell://renderer/a%00.html',
    'glmps-shell://renderer/',
    'glmps-shell://renderer/secret.json',
    'glmps-shell://other/splitter.html',
    'glmps-shell://renderer:99/splitter.html',
    'glmps-shell://user@renderer/splitter.html',
    'file:///app/renderer/splitter.html',
    'https://renderer/splitter.html',
    'not a url',
  ]) assert.equal(resolveLocalPage(u, DIR), null, u);
});

test('dot segments the URL parser collapses can only land inside the renderer dir', () => {
  for (const u of ['glmps-shell://renderer/../main.js', 'glmps-shell://renderer/%2e%2e/main.js', 'glmps-shell://renderer/sub/../../main.js']) {
    const hit = resolveLocalPage(u, DIR);
    assert.ok(hit === null || hit.file.startsWith(DIR + path.sep), u);
  }
});
