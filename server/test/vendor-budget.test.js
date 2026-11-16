// affected-tests: always
// server/test/vendor-budget.test.js
// D21: the dashboard's vendored browser assets stay within 1.5 MB (decimal, the
// unit D21's own arithmetic uses: vega 0.83 + globe 0.387 + sortable 0.12 =
// 1.34, "0.16 MB of headroom"). Mermaid is a wiki-only asset (D3) and lives
// outside web/vendor/, referenced only by renderDoc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderDoc } from '../lib/observability/wiki-render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const VENDOR = path.join(WEB, 'vendor');
export const DASHBOARD_VENDOR_BUDGET_BYTES = 1_500_000;
// LICENSES.md records each vendored file's sha256 from the npm tarball (Step 1)
// on a line `sha256 <file> <hex>`; the test re-hashes the file against it.
const recorded = (file) => {
  const escaped = file.replace(/\./g, '\\.'); // escape EVERY '.', not just the first
  const m = fs.readFileSync(path.join(VENDOR, 'LICENSES.md'), 'utf8').match(new RegExp(`^sha256 ${escaped} ([0-9a-f]{64})$`, 'm'));
  assert.ok(m, `LICENSES.md has no sha256 line for ${file}`);
  return m[1];
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('web/vendor/** stays within the D21 budget of 1,500,000 bytes', () => {
  const files = walk(VENDOR).map((f) => ({ f: path.relative(ROOT, f), size: fs.statSync(f).size }));
  const total = files.reduce((a, x) => a + x.size, 0);
  const top = files.sort((a, b) => b.size - a.size).slice(0, 5).map((x) => `${x.f} ${x.size}`).join(', ');
  assert.ok(total <= DASHBOARD_VENDOR_BUDGET_BYTES,
    `web/vendor is ${total} bytes, over the ${DASHBOARD_VENDOR_BUDGET_BYTES}-byte D21 budget. Largest: ${top}`);
});

test('mermaid is not a dashboard asset: it lives in web/wiki-assets/', () => {
  assert.equal(walk(VENDOR).some((f) => /mermaid/i.test(path.basename(f))), false);
  assert.ok(fs.existsSync(path.join(WEB, 'wiki-assets', 'mermaid.min.js')));
});

test('no dashboard file references mermaid.min.js', () => {
  const skip = [path.join(WEB, 'wiki-assets'), path.join(WEB, 'vendor'), path.join(WEB, 'wiki')];
  const hits = walk(WEB)
    .filter((f) => /\.(js|html|css)$/.test(f) && !skip.some((s) => f.startsWith(s + path.sep)))
    .filter((f) => fs.readFileSync(f, 'utf8').includes('mermaid.min.js'))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test('no file under web/ still references the retired /vendor/mermaid.min.js path', () => {
  // the pre-rendered wiki pages (once tracked in a
  // wiki/ subdirectory under web/, since retired by D-W6) were git mv'd
  // along with mermaid.min.js's actual home, but their own baked-in
  // <script src="/vendor/mermaid.min.js"> tags (and manifest.json's search
  // text) still pointed at the old path, 404ing every wiki diagram's script.
  // Unlike the dashboard-only check above, this one covers all of web/ and
  // checks the specific retired path rather than the bare filename (wiki
  // pages correctly reference mermaid.min.js via /wiki-assets/, which must
  // stay allowed).
  const hits = walk(WEB)
    .filter((f) => /\.(js|html|css|json)$/.test(f))
    .filter((f) => fs.readFileSync(f, 'utf8').includes('/vendor/mermaid.min.js'))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test('renderDoc loads mermaid from /wiki-assets/, never /vendor/', () => {
  const html = renderDoc({ title: 'T', mermaid: 'graph TD; a-->b', proseMd: 'x', files: [] });
  assert.match(html, /<script src="\/wiki-assets\/mermaid\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /\/vendor\/mermaid/);
  const custom = renderDoc({ title: 'T', mermaid: 'graph TD; a-->b', proseMd: 'x', files: [] }, { mermaidSrc: '/x/m.js' });
  assert.doesNotMatch(renderDoc({ title: 'T', proseMd: 'x', files: [] }), /mermaid/i, 'no diagram, no mermaid script');
  assert.match(custom, /<script src="\/x\/m\.js"><\/script>/);
});

test('d3 is the pinned 7.9.0 build and the coastlines are world-atlas 2.0.2', () => {
  const d3 = path.join(VENDOR, 'd3.min.js');
  assert.equal(fs.statSync(d3).size, 279706);
  assert.match(fs.readFileSync(d3, 'utf8').slice(0, 60), /^\/\/ https:\/\/d3js\.org v7\.9\.0/);
  assert.equal(sha(d3), recorded('d3.min.js'));
  const atlas = path.join(VENDOR, 'countries-110m.json');
  assert.equal(sha(atlas), recorded('countries-110m.json'));
  const topo = JSON.parse(fs.readFileSync(atlas, 'utf8'));
  assert.equal(topo.type, 'Topology');
  assert.ok(topo.objects.countries && Array.isArray(topo.arcs) && topo.transform);
  assert.match(fs.readFileSync(path.join(VENDOR, 'LICENSES.md'), 'utf8'), /ISC/);
});
