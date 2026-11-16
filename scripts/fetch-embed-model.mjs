// Downloads the two data files the embed plugin needs (the quantized ONNX
// model and its WordPiece vocab) from the Hugging Face repo pinned in
// plugins/embed/plugin.json, verifies each against the SHA-256 recorded
// there, and prints the paths. Model files are data, not code: they are
// never committed to this repo (D24, zero runtime dependencies stays about
// code, not weights, but weights still do not belong in git history).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPaths } from '../server/lib/paths.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_JSON = path.join(HERE, '..', 'plugins', 'embed', 'plugin.json');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function defaultOutDir(env = process.env) {
  return path.join(getPaths(env).stateDir, 'models', 'bge-small-en-v1.5');
}

// Parses argv (process.argv.slice(2)) into { outDir }. With no --out flag,
// falls back to defaultOutDir(env) (<stateDir>/models/bge-small-en-v1.5,
// honouring GLMPS_STATE_DIR). A bare `--out` with nothing after it (either the
// end of argv, or another flag immediately following) is a usage error, not
// a silent fall-through to the default -- writing model data to the wrong
// place because a flag's value was dropped is exactly the kind of mistake
// that should fail loudly.
export function parseArgs(argv, env = process.env) {
  const allowUnpinned = argv.includes('--allow-unpinned');
  const i = argv.indexOf('--out');
  if (i === -1) return { outDir: defaultOutDir(env), allowUnpinned };
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('usage: node scripts/fetch-embed-model.mjs [--out <dir>] [--allow-unpinned]');
  }
  return { outDir: path.resolve(value), allowUnpinned };
}

// Downloads every file listed in plugin.json's `model.files` map into outDir.
// Each file is verified against its recorded SHA-256 when one is present
// (mismatch is a hard error, since a swapped model file is a supply-chain
// risk exactly like a swapped npm tarball). C12: a
// file with no hash recorded at all used to be downloaded and written anyway
// (a warning, not a failure) - the same supply-chain risk a mismatched hash
// already refuses, just silent when the pin is simply absent instead of
// wrong. That now fails closed too, unless the caller explicitly passes
// allowUnpinned:true (the CLI's --allow-unpinned) for the genuine first-run
// bootstrap case that populates plugin.json's pins in the first place.
export async function fetchEmbedModel({ outDir, fetchImpl = fetch, pluginJsonPath = PLUGIN_JSON, allowUnpinned = false } = {}) {
  const meta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  const { repo, files } = meta.model;
  fs.mkdirSync(outDir, { recursive: true });
  const written = {};
  for (const [rel, expectedHash] of Object.entries(files)) {
    const url = `https://huggingface.co/${repo}/resolve/main/${rel}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = sha256(buf);
    if (expectedHash) {
      if (hash !== expectedHash) {
        throw new Error(`${rel}: SHA-256 mismatch (expected ${expectedHash}, got ${hash}) -- refusing to write a file that does not match the pinned hash`);
      }
    } else if (!allowUnpinned) {
      throw new Error(`${rel}: no SHA-256 pinned in plugin.json (computed ${hash}) -- add this under model.files["${rel}"] in plugins/embed/plugin.json, or pass --allow-unpinned for a one-off first-run bootstrap`);
    } else {
      console.warn(`${rel}: no SHA-256 recorded in plugin.json yet; computed ${hash} -- add this under model.files["${rel}"] in plugins/embed/plugin.json to pin it`);
    }
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    written[rel] = dest;
  }
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let outDir; let allowUnpinned;
  try {
    ({ outDir, allowUnpinned } = parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  fetchEmbedModel({ outDir, allowUnpinned })
    .then((written) => { for (const p of Object.values(written)) console.log(p); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
