// The wiki ships in the installer (card glmps-2-0-193): the page plan may read
// only files the kernel release profile ships, so an installed copy can rebuild
// every page from what it has and no operator-only text reaches the prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES, classify } from '../../scripts/release-builder.mjs';
import { HISTORY_PATTERNS, publicScanHits, publicScanPatterns } from '../lib/governance/private-text-scan.js';
import { expandGlob, readPagesManifest } from '../lib/observability/wiki-docs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = readPagesManifest(REPO);

const filesOf = (glob) => (glob.includes('*')
  ? expandGlob(REPO, glob).map((p) => path.relative(REPO, p).replace(/\\/g, '/'))
  : (fs.existsSync(path.join(REPO, glob)) ? [glob] : []));

test('every source of every wiki page is a file the kernel profile ships', () => {
  const refused = [];
  for (const p of manifest.pages) {
    for (const src of p.sources ?? []) {
      for (const rel of filesOf(src.glob)) {
        const c = classify(rel, PROFILES.kernel);
        if (!c?.out) refused.push(`${p.slug}: ${rel}${c?.deny ? ` (${c.deny})` : ''}`);
      }
    }
  }
  assert.deepEqual(refused, []);
});

test('the page plan and the voice files ship with the kernel and the mirror', () => {
  for (const profile of [PROFILES.kernel, PROFILES.mirror]) {
    for (const f of ['docs/wiki/pages.json', 'docs/wiki/style.md', 'docs/wiki/templates.json', 'docs/wiki/glossary.json', 'README.md']) {
      assert.deepEqual(classify(f, profile), { out: f }, f);
    }
  }
});

test('the shipped page plan and voice files carry no private text', () => {
  const patterns = [...publicScanPatterns([]), ...HISTORY_PATTERNS];
  for (const f of fs.readdirSync(path.join(REPO, 'docs', 'wiki'))) {
    const hits = publicScanHits(fs.readFileSync(path.join(REPO, 'docs', 'wiki', f), 'utf8'), patterns);
    assert.deepEqual(hits.map((h) => `${h.pattern}: ${h.match}`), [], f);
  }
});

test('no other planning doc ships', () => {
  for (const f of ['docs/specs/x.md', 'docs/decisions.md', 'docs/glmps-2-instance.md', 'docs/research/a.md', 'docs/wikipedia/x.md']) {
    assert.ok(!classify(f, PROFILES.kernel)?.out, f);
  }
});
