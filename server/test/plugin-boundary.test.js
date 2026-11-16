// affected-tests: always
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PLUGINS_ROOT = path.join(ROOT, 'plugins');
const CORE = ['server', 'hooks', 'taps', 'web', 'scripts'];
const IMPORT_RE = /(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g;
const BANNED_PKGS = /^(mem0ai|openevals|agentevals|openai|zod|better-sqlite3|axios|pg|uuid|langchain|@langchain\/|langsmith|fastembed|onnxruntime)/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(m?js|cjs)$/.test(e.name)) yield p;
  }
}

// A relative specifier is only "into a plugin" once resolved against the
// importing file's own directory: a substring match on "plugins/" wrongly
// flags imports like './lib/plugins/x.js' that never leave server/. Bare
// specifiers have no importer-relative path to resolve, so they are checked
// against BANNED_PKGS directly. Exported because this file is the only
// caller and the rule is unit-tested right below the scan it powers.
export function isPluginOffender(importerAbsPath, spec) {
  const isRelative = spec.startsWith('.') || spec.startsWith('/');
  if (!isRelative) return BANNED_PKGS.test(spec);
  const resolved = path.resolve(path.dirname(importerAbsPath), spec);
  const intoPlugin = resolved === PLUGINS_ROOT || resolved.startsWith(PLUGINS_ROOT + path.sep);
  if (!intoPlugin) return false;
  const rel = path.relative(PLUGINS_ROOT, resolved);
  const allowed = rel === 'host.js' || /^[a-z0-9-]+[\\/]adapter\.js$/.test(rel);
  return !allowed;
}

test('core imports plugins only through the host or an adapter, never an upstream package', () => {
  const offenders = [];
  for (const d of CORE) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      if (f.endsWith('plugin-boundary.test.js')) continue;
      for (const [, spec] of fs.readFileSync(f, 'utf8').matchAll(IMPORT_RE)) {
        if (isPluginOffender(f, spec)) offenders.push(`${path.relative(ROOT, f)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('root package.json has no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

test('a relative import that only contains "plugins" in its own path is not an offender', () => {
  const importer = path.join(ROOT, 'server', 'foo.js');
  assert.equal(isPluginOffender(importer, './lib/plugins/x.js'), false);
});

test('a relative import that escapes into plugins/<name>/vendor is an offender', () => {
  const importer = path.join(ROOT, 'server', 'foo.js');
  assert.equal(isPluginOffender(importer, '../plugins/mem0/vendor/x.js'), true);
});

test('a relative import into plugins/<name>/adapter.js is allowed', () => {
  const importer = path.join(ROOT, 'server', 'foo.js');
  assert.equal(isPluginOffender(importer, '../plugins/claude-model/adapter.js'), false);
});

test('a relative import into plugins/host.js is allowed', () => {
  const importer = path.join(ROOT, 'server', 'foo.js');
  assert.equal(isPluginOffender(importer, '../plugins/host.js'), false);
});

// Phase S (D26): apps/shell is an Electron client of the kernel. Core never
// imports it, and never imports electron, so the zero-dependency rule holds
// for everything the kernel runs.
const APPS_ROOT = path.join(ROOT, 'apps');
const APPS_SCAN = ['server', 'hooks', 'taps', 'web', 'scripts', 'plugins'];
const ANY_IMPORT_RE = /(?:from\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g;

export function isAppsOffender(importerAbsPath, spec) {
  const isRelative = spec.startsWith('.') || spec.startsWith('/');
  if (!isRelative) return /^(apps(\/|$)|electron$|electron\/|electron-builder)/.test(spec);
  const resolved = path.resolve(path.dirname(importerAbsPath), spec);
  return resolved === APPS_ROOT || resolved.startsWith(APPS_ROOT + path.sep);
}

test('core never imports apps/ or electron (the shell is a client, not part of the kernel)', () => {
  const offenders = [];
  for (const d of APPS_SCAN) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      if (f.endsWith('plugin-boundary.test.js')) continue;
      for (const [, spec] of fs.readFileSync(f, 'utf8').matchAll(ANY_IMPORT_RE)) {
        if (isAppsOffender(f, spec)) offenders.push(`${path.relative(ROOT, f)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('a relative import that climbs into apps/ is an offender', () => {
  const importer = path.join(ROOT, 'server', 'lib', 'foo.js');
  assert.equal(isAppsOffender(importer, '../../apps/shell/src/lib/layout.js'), true);
});

test('electron and electron-builder are offenders in core; node built-ins are not', () => {
  const importer = path.join(ROOT, 'server', 'foo.js');
  assert.equal(isAppsOffender(importer, 'electron'), true);
  assert.equal(isAppsOffender(importer, 'electron-builder'), true);
  assert.equal(isAppsOffender(importer, 'node:fs'), false);
});

test('a relative import whose own path merely contains "apps" is not an offender', () => {
  const importer = path.join(ROOT, 'server', 'foo.js');
  assert.equal(isAppsOffender(importer, './lib/apps-registry.js'), false);
});
