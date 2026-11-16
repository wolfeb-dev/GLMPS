#!/usr/bin/env node
// Colour-debt gate: counts raw hex colour literals (#rgb, #rrggbb, #rrggbbaa)
// used as values in rules, per stylesheet under web/, and fails when a file
// exceeds its committed baseline (or a stylesheet absent from the baseline has
// any). A literal that equals a token's value cannot follow the theme, so the
// number only goes down. Custom-property definitions (--x: #abc) are the one
// place a literal is the source of truth and are not counted; comments, url()
// payloads, strings and selectors (#id) are ignored.
//
//   node scripts/css-hex-gate.mjs            check, exit 1 on a regression
//   node scripts/css-hex-gate.mjs --update   rewrite the baseline (refuses to
//                                            raise an existing file's count)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const BASELINE_PATH = path.join(here, 'css-hex-gate.baseline.json');
const SKIP_DIRS = new Set(['vendor', 'wiki-assets', 'node_modules']);
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;

export function countHex(css) {
  const body = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\([^)]*\)/g, 'url()')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let n = 0;
  for (const m of body.matchAll(/\{([^{}]*)\}/g)) {
    const decls = m[1].replace(/(^|;|\s)--[\w-]+\s*:[^;]*(?=;|$)/g, '$1');
    n += (decls.match(HEX) || []).length;
  }
  return n;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.name.endsWith('.css')) out.push(path.join(dir, e.name));
  }
  return out;
}

export function scan(root = ROOT) {
  const counts = {};
  for (const f of walk(path.join(root, 'web'), []).sort()) {
    counts[path.relative(root, f).split(path.sep).join('/')] = countHex(fs.readFileSync(f, 'utf8'));
  }
  return counts;
}

export function loadBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).files;
}

export function compare(counts, baseline) {
  const failures = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (n > allowed) failures.push({ file, count: n, allowed, isNew: !(file in baseline) });
  }
  return failures;
}

function main() {
  const counts = scan();
  if (process.argv.includes('--update')) {
    const old = fs.existsSync(BASELINE_PATH) ? loadBaseline() : {};
    const raised = compare(counts, old).filter((f) => f.file in old);
    if (raised.length) { console.error('refusing to raise a baseline: ' + raised.map((f) => f.file).join(', ')); process.exit(1); }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ note: 'Raw hex colour literals per stylesheet; may only go down. See scripts/css-hex-gate.mjs.', files: counts }, null, 2) + '\n');
    console.log('baseline written');
    return;
  }
  const failures = compare(counts, loadBaseline());
  for (const f of failures) console.error(`${f.file}: ${f.count} hex literals, baseline ${f.allowed}${f.isNew ? ' (new stylesheet)' : ''}`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`css-hex-gate: ${total} literals across ${Object.keys(counts).length} stylesheets, ${failures.length} over baseline`);
  process.exit(failures.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
