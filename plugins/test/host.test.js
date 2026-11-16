import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadAdapter } from '../host.js';

test('a vendored bare import resolves to the plugin shim', async () => {
  const m = await loadAdapter('fixture', { pluginsDir: import.meta.dirname });
  assert.equal(m.hello('ab'), '...ab1');
});

test('an unmapped bare import from vendor throws instead of reaching node_modules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  // Node 22.5 has no module-syntax detection default: a plain .js file with no
  // ancestor package.json declaring "type" defaults to CommonJS, so the ESM
  // import/export syntax below would fail to parse without this.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'bad', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad', 'plugin.json'), JSON.stringify({ name: 'bad', contract: 'embed@1', upstream: [], shims: {}, patches: [] }));
  fs.writeFileSync(path.join(dir, 'bad', 'vendor', 'x.js'), "import 'definitely-not-a-shim';\nexport const x = 1;\n");
  fs.writeFileSync(path.join(dir, 'bad', 'adapter.js'), "export * from './vendor/x.js';\n");
  await assert.rejects(loadAdapter('bad', { pluginsDir: dir }), /plugin bad: unmapped import 'definitely-not-a-shim'/);
});

test('a node:-prefixed import passes through even when missing from builtinModules (node:test on Node 22.5.0)', async () => {
  // node:test is confirmed absent from builtinModules on real Node 22.5.0 (the
  // engines floor) yet importable with no flag, so it is a clean exemplar of
  // the gap this hook closes. node:sqlite was tried first but throws
  // ERR_UNKNOWN_BUILTIN_MODULE on 22.5.0 without --experimental-sqlite (only
  // fixed at 22.13+), which is an unrelated failure this test should not have
  // to depend on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'nodetestcheck', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nodetestcheck', 'plugin.json'), JSON.stringify({ name: 'nodetestcheck', contract: 'embed@1', upstream: [], shims: {}, patches: [] }));
  fs.writeFileSync(
    path.join(dir, 'nodetestcheck', 'vendor', 'x.js'),
    "import { test } from 'node:test';\nexport const hasTest = typeof test === 'function';\n"
  );
  fs.writeFileSync(path.join(dir, 'nodetestcheck', 'adapter.js'), "export { hasTest } from './vendor/x.js';\n");
  const m = await loadAdapter('nodetestcheck', { pluginsDir: dir });
  assert.equal(m.hasTest, true);
});

test('a commonjs vendor file is refused, since its require() calls would bypass the resolve hook', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'cjs', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cjs', 'plugin.json'), JSON.stringify({ name: 'cjs', contract: 'embed@1', upstream: [], shims: {}, patches: [] }));
  fs.writeFileSync(path.join(dir, 'cjs', 'vendor', 'x.cjs'), "module.exports = { x: 1 };\n");
  fs.writeFileSync(path.join(dir, 'cjs', 'adapter.js'), "export { x } from './vendor/x.cjs';\n");
  await assert.rejects(loadAdapter('cjs', { pluginsDir: dir }), /plugin cjs: CommonJS is not supported in vendor\/shims/);
});

test('a relative import from vendor/ that escapes the plugin root is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'escape', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'outside.js'), 'export const hi = 1;\n');
  fs.writeFileSync(path.join(dir, 'escape', 'plugin.json'), JSON.stringify({ name: 'escape', contract: 'embed@1', upstream: [], shims: {}, patches: [] }));
  fs.writeFileSync(path.join(dir, 'escape', 'vendor', 'x.js'), "export { hi } from '../../outside.js';\n");
  fs.writeFileSync(path.join(dir, 'escape', 'adapter.js'), "export { hi } from './vendor/x.js';\n");
  await assert.rejects(loadAdapter('escape', { pluginsDir: dir }), /plugin escape: import escapes the plugin/);
});

test('a relative import from vendor/ into a node_modules path is refused even if it stays inside the plugin root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'nmescape', 'vendor'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'nmescape', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nmescape', 'node_modules', 'evil.js'), 'export const evil = 1;\n');
  fs.writeFileSync(path.join(dir, 'nmescape', 'plugin.json'), JSON.stringify({ name: 'nmescape', contract: 'embed@1', upstream: [], shims: {}, patches: [] }));
  fs.writeFileSync(path.join(dir, 'nmescape', 'vendor', 'x.js'), "export { evil as x } from '../node_modules/evil.js';\n");
  fs.writeFileSync(path.join(dir, 'nmescape', 'adapter.js'), "export { x } from './vendor/x.js';\n");
  await assert.rejects(loadAdapter('nmescape', { pluginsDir: dir }), /plugin nmescape: import escapes the plugin/);
});

// on win32's case-insensitive
// filesystem, a relative import that traverses a differently-cased
// directory segment (e.g. '../Vendor/y.js' when the real directory on disk
// is 'vendor') resolves to the SAME real file, but ownerOf()'s exact-string
// containment check used to miss it - the resolved URL's path string does
// not start with owner.vendorDir's stored (correctly-cased) prefix, so
// ownerOf() returned undefined and every one of the hook's protections
// (unmapped-import refusal, escape detection, CommonJS refusal) was
// silently skipped for that file and everything it imports.
test('a relative import that reaches its target through a differently-cased directory segment is still owned and contained (win32 case-insensitivity)', async (t) => {
  if (process.platform !== 'win32') { t.skip('case-insensitive-filesystem gap is win32-specific'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'casetest', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'casetest', 'plugin.json'), JSON.stringify({ name: 'casetest', contract: 'embed@1', upstream: [], shims: {}, patches: [] }));
  // x.js reaches y.js via a directory segment ("Vendor") cased differently
  // than the real on-disk directory ("vendor") - the identical file on a
  // case-insensitive filesystem, but a different string.
  fs.writeFileSync(path.join(dir, 'casetest', 'vendor', 'x.js'), "export { y } from '../Vendor/y.js';\n");
  // y.js's own unmapped bare import must still be refused - if ownerOf()
  // lost track of it over the case mismatch, this would instead surface as
  // Node's own module-not-found error, not our containment error.
  fs.writeFileSync(path.join(dir, 'casetest', 'vendor', 'y.js'), "import 'definitely-not-a-shim';\nexport const y = 1;\n");
  fs.writeFileSync(path.join(dir, 'casetest', 'adapter.js'), "export { y } from './vendor/x.js';\n");
  await assert.rejects(loadAdapter('casetest', { pluginsDir: dir }), /plugin casetest: unmapped import 'definitely-not-a-shim'/);
});

// createRequire(import.meta.url)('x')
// or import('node:module').getBuiltinModule('x') both reach real Node
// module loading machinery OUTSIDE this hook's resolve()/load() chain
// entirely (require() calls run through Node's synchronous CJS resolver,
// which never calls back into our ESM hook), so a vendored file could use
// either to reach node_modules with no way for this hook to ever see the
// specifier. Refused by source-text scan unless the plugin's plugin.json
// explicitly allowlists that file's path.
test('a vendored file using createRequire is refused, since it could require() a dependency this hook never sees', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'creq', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'creq', 'plugin.json'), JSON.stringify({ name: 'creq', contract: 'embed@1', upstream: [], shims: {}, patches: [] }));
  fs.writeFileSync(
    path.join(dir, 'creq', 'vendor', 'x.js'),
    "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const x = require('definitely-not-a-shim');\n",
  );
  fs.writeFileSync(path.join(dir, 'creq', 'adapter.js'), "export { x } from './vendor/x.js';\n");
  await assert.rejects(loadAdapter('creq', { pluginsDir: dir }), /plugin creq:.*createRequire/);
});

test('a vendored file using getBuiltinModule is refused for the same reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'gbm', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gbm', 'plugin.json'), JSON.stringify({ name: 'gbm', contract: 'embed@1', upstream: [], shims: {}, patches: [] }));
  fs.writeFileSync(
    path.join(dir, 'gbm', 'vendor', 'x.js'),
    // process.getBuiltinModule is a global - no import statement needed at
    // all, which is exactly why a source-text scan (not an import-specifier
    // check) is the only way to catch it.
    "export const x = process.getBuiltinModule('fs');\n",
  );
  fs.writeFileSync(path.join(dir, 'gbm', 'adapter.js'), "export { x } from './vendor/x.js';\n");
  await assert.rejects(loadAdapter('gbm', { pluginsDir: dir }), /plugin gbm:.*getBuiltinModule/);
});

test('a vendored file using createRequire is allowed when its path is explicitly listed in plugin.json allowCreateRequire', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(dir, 'creqok', 'vendor'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'creqok', 'plugin.json'),
    JSON.stringify({ name: 'creqok', contract: 'embed@1', upstream: [], shims: {}, patches: [], allowCreateRequire: ['vendor/x.js'] }),
  );
  fs.writeFileSync(
    path.join(dir, 'creqok', 'vendor', 'x.js'),
    "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const x = 1;\nvoid require;\n",
  );
  fs.writeFileSync(path.join(dir, 'creqok', 'adapter.js'), "export { x } from './vendor/x.js';\n");
  const m = await loadAdapter('creqok', { pluginsDir: dir });
  assert.equal(m.x, 1);
});

// CRITICAL: B8(a)'s
// createRequire/getBuiltinModule scan is a blanket refusal unless a plugin
// explicitly allowlists a path, so it can silently block a CURRENT plugin's
// own real runtime path if that plugin's allowCreateRequire is empty but one
// of its vendored files legitimately needs createRequire (as
// onnxruntime-web's WASM loader does, even single-threaded/non-JSEP). The
// embed contract test that would otherwise catch this
// (plugins/embed/test/adapter.test.js) is SKIPPED unless GLMPS_EMBED_MODEL_DIR
// is set, so it never runs under plain `npm test`. This test drives each
// current plugin's REAL adapter through its REAL runtime path (with fake
// hosts, no network, no real model) so a plugin.json missing a needed
// allowCreateRequire entry fails an always-run test, not only a
// conditionally-skipped one.
test('every current plugin\'s vendored entry files pass the createRequire/getBuiltinModule scan when exercised through the real hook', async () => {
  const hookRefusal = /is not allowed in vendor\/shims|unmapped import|CommonJS is not supported|import escapes the plugin/;

  // judge: the vendored openevals prompt files are imported at the adapter's
  // own module top-level, so loading the adapter alone already exercises
  // them through the real hook.
  const judge = await loadAdapter('judge');
  assert.equal(judge.CONTRACT, 'judge@1');

  // mem0: vendor/mem0ai/dist/oss/index.mjs is imported lazily, only once a
  // Memory instance is actually needed, so a real add() call (fake
  // chatCompletion/embedder, no network) is needed to reach it.
  const mem0 = await loadAdapter('mem0');
  mem0.configureHost({
    chatCompletion: async () => ({ choices: [{ message: { content: '{"memory":[]}' } }] }),
    embedder: { dims: 8, embedQuery: async () => new Array(8).fill(0), embedDocuments: async (ts) => ts.map(() => new Array(8).fill(0)) },
    dbDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-scan-mem0-')),
  });
  await mem0.add({ project: 'scan-check', messages: [{ role: 'user', content: 'hello' }] });

  // embed: vendor/onnxruntime-web/dist/{ort.wasm.mjs,ort-wasm-simd-threaded.mjs}
  // only load once createEmbedder actually builds an inference session; a
  // present-but-garbage model is enough to reach that without a real model.
  const embed = await loadAdapter('embed');
  const embedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-scan-embed-'));
  fs.mkdirSync(path.join(embedDir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(embedDir, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\n');
  fs.writeFileSync(path.join(embedDir, 'onnx', 'model_quantized.onnx'), Buffer.from('not a real onnx model'));
  await assert.rejects(embed.createEmbedder({ modelDir: embedDir }), (err) => {
    assert.doesNotMatch(err.message, hookRefusal, 'must not be the resolve hook\'s containment refusal');
    assert.doesNotMatch(err.message, /createRequire|getBuiltinModule/, 'must not be the hook\'s createRequire/getBuiltinModule refusal');
    return true;
  });
});

test('a pluginsDir reached through a symlink/junction still resolves through its shim (realpath match)', async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-real-'));
  fs.writeFileSync(path.join(real, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(real, 'fixture', 'vendor', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(real, 'fixture', 'shims'), { recursive: true });
  fs.writeFileSync(
    path.join(real, 'fixture', 'plugin.json'),
    JSON.stringify({ name: 'fixture', contract: 'embed@1', upstream: [], shims: { 'left-pad': 'shims/leftpad.js' }, patches: [] })
  );
  fs.writeFileSync(path.join(real, 'fixture', 'adapter.js'), "export { hello } from './vendor/lib/index.js';\n");
  fs.writeFileSync(path.join(real, 'fixture', 'vendor', 'lib', 'index.js'), "import leftPad from 'left-pad';\nexport const hello = (s) => leftPad(s, 5);\n");
  fs.writeFileSync(path.join(real, 'fixture', 'shims', 'leftpad.js'), "export default function leftPad(s, n) { return String(s).padStart(n, '.'); }\n");

  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-link-'));
  const link = path.join(linkParent, 'link');
  // 'junction' works on Windows without elevated privileges; on POSIX it falls
  // back to a plain symlink. Both reproduce the same class of bug: Node
  // reports the *realpath* of a file loaded through a link, so a plugin
  // registered against the link's own path would never match its own
  // vendor/shims directories.
  fs.symlinkSync(real, link, 'junction');

  const m = await loadAdapter('fixture', { pluginsDir: link });
  assert.equal(m.hello('ab'), '...ab');
});

test('review P4: loadAdapter refuses a name that is not a plain plugin id', async () => {
  for (const name of ['../server/server', '..', '.', 'a/b', 'a\b', 'Fixture', 'fix ture', '', 'fixture/..', undefined, null, 42]) {
    await assert.rejects(loadAdapter(name, { pluginsDir: import.meta.dirname }), /invalid plugin name/, String(name));
  }
});

test('review P4: loadAdapter refuses a well-formed name that is not a known plugin', async () => {
  await assert.rejects(loadAdapter('test', { pluginsDir: import.meta.dirname }), /unknown plugin/);
  await assert.rejects(loadAdapter('no-such-plugin', { pluginsDir: import.meta.dirname }), /unknown plugin/);
});
