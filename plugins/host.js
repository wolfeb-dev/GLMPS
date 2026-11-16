import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const registered = new Set();

function entryOf(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const exp = pkg.exports?.['.'] ?? pkg.exports;
  const pick = (e) => (typeof e === 'string' ? e : e && (e.import ? pick(e.import) : e.default ? pick(e.default) : null));
  return path.join(pkgDir, pick(exp) || pkg.module || pkg.main || 'index.js');
}

export function readPlugins(pluginsDir) {
  // Node reports the realpath of a file loaded through a symlink or junction
  // (e.g. a macOS /var/folders tmp path, or a Windows junction), not the path
  // it was opened through. Without this, a pluginsDir reached via a link
  // would compute vendorDir/shimsDir from the link's own path, which then
  // never matches the realpath the hook actually sees.
  const realPluginsDir = fs.realpathSync(pluginsDir);
  return fs.readdirSync(realPluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(realPluginsDir, e.name, 'plugin.json')))
    .map((e) => {
      const root = path.join(realPluginsDir, e.name);
      const meta = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
      const vendorDir = path.join(root, 'vendor');
      const vendorPackages = {};
      if (fs.existsSync(vendorDir)) for (const d of fs.readdirSync(vendorDir)) {
        if (fs.existsSync(path.join(vendorDir, d, 'package.json'))) vendorPackages[d] = entryOf(path.join(vendorDir, d));
      }
      const shims = Object.fromEntries(Object.entries(meta.shims || {}).map(([k, v]) => [k, path.join(root, v)]));
      // plugin.json paths, relative to
      // the plugin root, explicitly exempted from the resolve hook's
      // createRequire/getBuiltinModule source-text refusal. Empty for mem0
      // and judge (neither vendored tree uses either at runtime); embed
      // lists its vendored onnxruntime-web WASM loader
      // (vendor/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs), which uses
      // createRequire(import.meta.url) internally even in the single-
      // threaded, non-JSEP configuration this adapter forces (residual fix
      // wave, CRITICAL: this scan initially refused it outright, so the
      // embed plugin could never load and Mem0 was never configured with a
      // real embedder - see plugins/test/host.test.js's "every current
      // plugin's vendored entry files pass the scan" test).
      const allowCreateRequire = Array.isArray(meta.allowCreateRequire) ? meta.allowCreateRequire : [];
      return {
        name: meta.name, root, vendorDir, shimsDir: path.join(root, 'shims'), shims, vendorPackages, allowCreateRequire,
      };
    });
}

export function registerPluginHooks({ pluginsDir = HERE } = {}) {
  const key = path.resolve(pluginsDir);
  if (registered.has(key)) return;
  register(pathToFileURL(path.join(HERE, 'resolve-hook.mjs')), { data: { plugins: readPlugins(key) } });
  registered.add(key);
}

// A plugin is a directory holding plugin.json, the same test readPlugins uses.
export async function loadAdapter(name, { pluginsDir = HERE } = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`invalid plugin name: ${JSON.stringify(name)}`);
  }
  if (!fs.existsSync(path.join(pluginsDir, name, 'plugin.json'))) {
    throw new Error(`unknown plugin: ${name}`);
  }
  registerPluginHooks({ pluginsDir });
  return import(pathToFileURL(path.join(pluginsDir, name, 'adapter.js')).href);
}
