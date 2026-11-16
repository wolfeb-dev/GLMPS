// server/test/wiki-no-downgrade.test.js
// Integration test for the CLI end to end: a structural (no --llm) rebuild
// must never overwrite an existing narrative (llm:true) page with a bare
// Tier-1 structural stub just because its contentHash no longer matches
// (e.g. .cache.json is gitignored and absent on a fresh checkout, so every
// no-llm rebuild there is a guaranteed cache miss on every section). This is
// the bug that repeatedly destroyed committed wiki prose. See
// scripts/wiki-build-cli.mjs and server/lib/observability/wiki-preserve.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', '..', 'scripts', 'wiki-build-cli.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

// A single-section graph: five files (the default minFiles for a page) under a
// non-generic directory ('widgets'), so buildSections groups them into exactly
// one subsystem section slugged 'code-widgets'. The tmp root has no
// docs/wiki/pages.json, so no documentation pages are built either.
function makeGraph() {
  return {
    built_at_commit: 'fresh0000',
    nodes: [1, 2, 3, 4, 5].map(i => (
      { id: `n${i}`, label: `Widget ${i}`, community: 0, source_file: `src/widgets/foo${i}.js`, source_location: 'L1' })),
    links: [],
  };
}

function setupRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wiki-nodown-'));
  fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(makeGraph()));
  return root;
}

test('no-llm rebuild on a cache miss preserves an existing narrative page (does not downgrade to a structural stub)', () => {
  const root = setupRoot();
  const outDir = path.join(root, 'wiki-out');
  fs.mkdirSync(outDir, { recursive: true });

  // Seed a PRIOR build result as if a previous --llm run had authored real
  // narrative for the 'widgets' slug, at some now-stale contentHash.
  const priorManifest = {
    builtAtCommit: 'oldcommit', generatedAt: '2026-01-01T00:00:00Z', tierLlm: true,
    sections: [{
      slug: 'code-widgets', title: 'Widgets', community: 'widgets', llm: true, fileCount: 1,
      contentHash: 'STALE_HASH_DOES_NOT_MATCH_FRESH_BUILD',
      createdTs: 1700000000000, updatedTs: 1700000000000,
      related: [], backlinks: [], tags: ['js'], searchText: 'Widgets preserved narrative',
    }],
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(priorManifest, null, 2));
  const priorHtml = '<!doctype html><html><body><article class="wiki-doc"><h1>Widgets</h1>'
    + '<p>PRESERVED_NARRATIVE_MARKER_XYZ this is real hand-grounded prose from a prior --llm run.</p>'
    + '</article></body></html>';
  fs.writeFileSync(path.join(outDir, 'code-widgets.html'), priorHtml);

  // Run WITHOUT --llm. contentHash for the freshly-built section will not
  // equal the stale one above, so this is a guaranteed cache miss.
  const res = runCli([root, '--out', outDir]);
  assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const entry = manifest.sections.find(s => s.slug === 'code-widgets');
  assert.ok(entry, 'widgets section still present in the manifest');
  assert.equal(entry.llm, true, 'a no-llm rebuild must not downgrade llm:true to false');

  const html = fs.readFileSync(path.join(outDir, 'code-widgets.html'), 'utf8');
  assert.ok(html.includes('PRESERVED_NARRATIVE_MARKER_XYZ'),
    'prior narrative prose must survive a no-llm cache-miss rebuild, not be replaced by a structural stub');
});

test('no-llm rebuild with no prior page still emits a normal structural stub (fresh build, nothing to preserve)', () => {
  const root = setupRoot();
  const outDir = path.join(root, 'wiki-out');

  const res = runCli([root, '--out', outDir]);
  assert.equal(res.status, 0, `CLI failed: ${res.stderr}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const entry = manifest.sections.find(s => s.slug === 'code-widgets');
  assert.ok(entry, 'widgets section present');
  assert.equal(entry.llm, false, 'first build with no --llm and no prior page is a plain structural stub');
});
