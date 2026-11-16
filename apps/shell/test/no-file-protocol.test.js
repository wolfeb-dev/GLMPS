// affected-tests: always
// apps/shell/test/no-file-protocol.test.js
// The packaged app turns GrantFileProtocolExtraPrivileges off, so a file://
// page inside app.asar loads as an empty document (glmps-2-0-63). Local pages
// must go through the glmps-shell scheme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('no shell source loads a page with loadFile(', () => {
  for (const f of walk(path.join(ROOT, 'src')).filter((p) => /\.(c|m)?js$/.test(p))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\.loadFile\(/, f);
  }
});

test('no renderer html references a file:// URL', () => {
  for (const f of walk(path.join(ROOT, 'renderer')).filter((p) => p.endsWith('.html'))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /file:\/\//i, f);
  }
});

test('the dashboard and Slack roles can never navigate to the local scheme', async () => {
  const { classifyUrl } = await import('../src/lib/navigation.js');
  for (const role of ['dashboard', 'slack']) {
    assert.equal(classifyUrl({ role, url: 'glmps-shell://renderer/splitter.html', kernelOrigin: 'http://127.0.0.1:8123' }), 'block');
  }
});
