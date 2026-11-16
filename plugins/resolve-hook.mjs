// Vendored upstream code keeps its original bare imports. This maps each one
// to the plugin's shim, allows built-ins and packages vendored in the same
// plugin, and REFUSES anything else so nothing loads from node_modules.
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

let plugins = [];
export async function initialize(data) { plugins = plugins.concat(data.plugins); }

const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const isBare = (s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('file:') && !/^[a-zA-Z]:[\\/]/.test(s);
// on win32's case-insensitive
// filesystem, a relative import that traverses a differently-cased
// directory segment (e.g. '../Vendor/y.js' when the real directory is
// 'vendor') resolves to the SAME real file as far as Node/the OS are
// concerned, but Node's resolver does not re-derive the on-disk casing - it
// returns the URL built from the literal specifier text. An exact-string
// containment check then misses it entirely: ownerOf() returns undefined,
// silently skipping every one of this hook's protections (unmapped-import
// refusal, escape detection, CommonJS refusal) for that file and everything
// it imports. Comparing case-insensitively on win32 only (POSIX filesystems
// are case-sensitive; folding case there would let a spoofed differently-
// cased path masquerade as the real one) matches the filesystem's own
// semantics instead of a stricter-than-reality string check.
const IS_WIN32 = process.platform === 'win32';
const foldCase = (p) => (IS_WIN32 ? p.toLowerCase() : p);
const inside = (file, dir) => {
  const f = foldCase(file);
  const d = foldCase(dir);
  return f === d || f.startsWith(d + path.sep);
};
const ownerOf = (file) => plugins.find((p) => inside(file, p.vendorDir) || inside(file, p.shimsDir));

export async function resolve(specifier, context, next) {
  if (!context.parentURL?.startsWith('file:')) return next(specifier, context);
  const parent = fileURLToPath(context.parentURL);
  const owner = ownerOf(parent);
  if (!owner) return next(specifier, context);

  // Some node: built-ins (e.g. node:sqlite, node:test on certain Node builds)
  // are missing from builtinModules. Any node:-prefixed specifier is trusted
  // and passed straight through rather than refused as "unmapped".
  if (specifier.startsWith('node:') || BUILTIN.has(specifier)) return next(specifier, context);

  if (isBare(specifier)) {
    if (owner.shims[specifier]) return { url: pathToFileURL(owner.shims[specifier]).href, shortCircuit: true };
    if (owner.vendorPackages[specifier]) return { url: pathToFileURL(owner.vendorPackages[specifier]).href, shortCircuit: true };
    throw new Error(`plugin ${owner.name}: unmapped import '${specifier}'`);
  }

  // A relative/absolute import from inside vendor/ or shims/ can otherwise
  // walk out of the plugin entirely (path traversal) or reach into a
  // node_modules directory that happens to sit somewhere in the tree. Let
  // Node resolve it, then check where it actually landed.
  const result = await next(specifier, context);
  if (result.url?.startsWith('file:')) {
    const resolvedPath = fileURLToPath(result.url);
    const escapesRoot = !inside(resolvedPath, owner.root);
    const hitsNodeModules = resolvedPath.split(path.sep).includes('node_modules');
    if (escapesRoot || hitsNodeModules) {
      throw new Error(`plugin ${owner.name}: import escapes the plugin (${specifier})`);
    }
  }
  return result;
}

// createRequire(import.meta.url)('x')
// and process.getBuiltinModule('x') (a global - no import statement at all)
// both reach real Node module-loading machinery OUTSIDE this hook's
// resolve()/load() chain entirely, exactly like the bare require() calls
// the CommonJS refusal above already guards against. A source-text scan is
// the only way to catch process.getBuiltinModule (nothing to resolve() at
// all), so both identifiers are checked the same way for consistency.
const UNSAFE_IDENTIFIER = /\b(createRequire|getBuiltinModule)\b/;

export async function load(url, context, next) {
  const owner = url.startsWith('file:') ? ownerOf(fileURLToPath(url)) : undefined;
  const result = await next(url, context);
  // CommonJS require() calls run outside this hook chain entirely, so a
  // vendored .cjs (or package.json-default-commonjs .js) file could reach
  // node_modules with no way for us to see it. Refuse the format outright
  // instead of trying to police require() from the inside.
  if (owner && result.format === 'commonjs') {
    throw new Error(`plugin ${owner.name}: CommonJS is not supported in vendor/shims (${url})`);
  }
  if (owner && typeof result.source !== 'undefined') {
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    const match = source.match(UNSAFE_IDENTIFIER);
    if (match) {
      const relPath = path.relative(owner.root, fileURLToPath(url)).split(path.sep).join('/');
      const allowed = Array.isArray(owner.allowCreateRequire) && owner.allowCreateRequire.includes(relPath);
      if (!allowed) {
        throw new Error(
          `plugin ${owner.name}: ${match[1]} is not allowed in vendor/shims (${url}) unless '${relPath}' is listed in plugin.json's allowCreateRequire`,
        );
      }
    }
  }
  return result;
}
