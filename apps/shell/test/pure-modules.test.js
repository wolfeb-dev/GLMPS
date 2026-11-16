// apps/shell/test/pure-modules.test.js
// The pure modules run in the root npm test on Node 22/24/26 with no npm
// install, so they must never import electron (or any package).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SHELL = path.resolve(import.meta.dirname, '..');
const PURE_DIRS = [path.join(SHELL, 'src', 'lib'), path.join(SHELL, 'src', 'lib', 'setup'), path.join(SHELL, 'scripts')];
const IMPORT_RE = /(?:from\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g;

test('pure shell modules import only node: built-ins and relative files', () => {
  const offenders = [];
  for (const dir of PURE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(m?js)$/.test(name) || name === 'render-icons.mjs') continue;
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const [, spec] of text.matchAll(IMPORT_RE)) {
        if (!spec.startsWith('node:') && !spec.startsWith('.')) offenders.push(`${name} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('apps/shell/package.json pins electron and electron-builder exactly', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SHELL, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies.electron, '44.4.5');
  assert.equal(pkg.devDependencies['electron-builder'], '26.15.3');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'src/main.js');
});
