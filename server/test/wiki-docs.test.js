// server/test/wiki-docs.test.js
// The page manifest (docs/wiki/pages.json) and the sections built from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandGlob, gatherSources, readPagesManifest, buildDocSections, glossarySection, codeMapSection, linkSections,
} from '../lib/observability/wiki-docs.js';
import { loadVoice, VOICE_DIR } from '../lib/observability/wiki-voice.js';
import { FACT_KINDS } from '../lib/observability/wiki-facts.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const manifest = readPagesManifest(REPO);
const voice = loadVoice();

test('the repo has a page manifest with pages', () => {
  assert.ok(manifest && manifest.pages.length > 0);
});

test('every source glob in docs/wiki/pages.json matches at least one file (a renamed file fails here)', () => {
  const dead = [];
  for (const p of manifest.pages) {
    for (const src of p.sources ?? []) {
      const hits = src.glob.includes('*') ? expandGlob(REPO, src.glob) : (fs.existsSync(path.join(REPO, src.glob)) ? [src.glob] : []);
      if (!hits.length) dead.push(`${p.slug}: ${src.glob}`);
    }
  }
  assert.deepEqual(dead, []);
});

test('every page kind has a template in templates.json', () => {
  const missing = manifest.pages.filter(p => !voice.templates[p.kind]).map(p => `${p.slug}: ${p.kind}`);
  assert.deepEqual(missing, []);
  for (const [kind, t] of Object.entries(voice.templates)) {
    assert.ok(Array.isArray(t.headings) && t.headings.length > 0, `${kind} template has headings`);
    assert.ok(Array.isArray(t.lengthWords) && t.lengthWords.length === 2, `${kind} template has a length range`);
  }
});

test('page slugs are unique and do not collide with the generated pages', () => {
  const slugs = manifest.pages.map(p => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const s of slugs) {
    assert.ok(!s.startsWith('code-'), `${s} would sit in the code reference namespace`);
    assert.ok(!['glossary', 'code-map'].includes(s), `${s} is generated`);
  }
});

test('every related slug exists in the manifest or is a generated page', () => {
  const known = new Set([...manifest.pages.map(p => p.slug), 'glossary', 'code-map']);
  const unknown = manifest.pages.flatMap(p => (p.related ?? []).filter(r => !known.has(r)).map(r => `${p.slug} -> ${r}`));
  assert.deepEqual(unknown, []);
});

test('every page names a declared group, and every declared fact kind is a real one', () => {
  const groups = new Set(manifest.groups.map(g => g.id));
  for (const p of manifest.pages) {
    assert.ok(groups.has(p.group), `${p.slug}: group ${p.group}`);
    for (const k of p.facts ?? []) assert.ok(FACT_KINDS.includes(k), `${p.slug}: fact kind ${k}`);
  }
});

test('the voice directory is the one in this checkout', () => {
  assert.equal(VOICE_DIR, path.join(REPO, 'docs', 'wiki'));
});

function smallRepo() {
  const root = tmp('mc-docs-');
  fs.writeFileSync(path.join(root, 'a.md'), 'alpha text\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'one.js'), 'one\n');
  fs.writeFileSync(path.join(root, 'src', 'two.js'), 'two\n');
  return root;
}
const SMALL = {
  groups: [{ id: 'documentation', title: 'Documentation' }],
  pages: [
    { slug: 'ops', title: 'Operate it', group: 'documentation', subgroup: 'Admin guide', kind: 'admin', order: 2, angle: 'Run it.',
      sources: [{ glob: 'a.md' }, { glob: 'src/*.js', max: 1 }], facts: ['routes', 'tasks'], related: ['other'] },
    { slug: 'other', title: 'Other page', group: 'documentation', kind: 'concept', sources: [] },
  ],
};
const FACTS = { routes: [{ method: 'GET', path: '/x' }], tasks: [] };
const build = (over = {}) => buildDocSections({ repoRoot: smallRepo(), manifest: SMALL, voice, facts: FACTS, ...over });

test('buildDocSections carries the group, kind, template headings, sources and reference tables', () => {
  const [ops, other] = build();
  assert.equal(ops.slug, 'ops');
  assert.equal(ops.groupTitle, 'Documentation');
  assert.equal(ops.subgroup, 'Admin guide');
  assert.equal(ops.kind, 'admin');
  assert.deepEqual(ops.required, voice.templates.admin.headings);
  assert.equal(ops.audience, voice.templates.admin.audience);
  assert.deepEqual(ops.files, [{ path: 'a.md' }, { path: 'src/one.js' }], 'max:1 limits a glob');
  assert.match(ops.sourceText, /\/\/ a\.md\nalpha text/);
  assert.deepEqual(ops.reference.map(t => t.title), ['Routes'], 'a fact kind with no rows gets no table');
  assert.deepEqual(ops.factKinds, ['routes', 'tasks']);
  assert.deepEqual(ops.relatedSlugs, ['other']);
  assert.equal(ops.proseMd, '');
  assert.equal(other.subgroup, null);
  assert.deepEqual(other.reference, []);
});

test('buildDocSections without a manifest gives no sections', () => {
  assert.deepEqual(buildDocSections({ repoRoot: smallRepo(), manifest: null, voice, facts: {} }), []);
});

test('contentHash is stable for identical input', () => {
  const root = smallRepo();
  const a = buildDocSections({ repoRoot: root, manifest: SMALL, voice, facts: FACTS });
  const b = buildDocSections({ repoRoot: root, manifest: SMALL, voice, facts: FACTS });
  assert.deepEqual(a.map(s => s.contentHash), b.map(s => s.contentHash));
});

test('contentHash changes when the voice hash changes', () => {
  const root = smallRepo();
  const a = buildDocSections({ repoRoot: root, manifest: SMALL, voice, facts: FACTS });
  const b = buildDocSections({ repoRoot: root, manifest: SMALL, voice: { ...voice, hash: 'other' }, facts: FACTS });
  assert.notEqual(a[0].contentHash, b[0].contentHash);
  assert.notEqual(a[1].contentHash, b[1].contentHash, 'a voice edit rewrites every page');
});

test('contentHash changes when a source file text changes, and only for the page that reads it', () => {
  const root = smallRepo();
  const a = buildDocSections({ repoRoot: root, manifest: SMALL, voice, facts: FACTS });
  fs.writeFileSync(path.join(root, 'a.md'), 'alpha text, edited\n');
  const b = buildDocSections({ repoRoot: root, manifest: SMALL, voice, facts: FACTS });
  assert.notEqual(a[0].contentHash, b[0].contentHash);
  assert.equal(a[1].contentHash, b[1].contentHash);
});

test('contentHash changes when a fact the page tabulates changes', () => {
  const root = smallRepo();
  const a = buildDocSections({ repoRoot: root, manifest: SMALL, voice, facts: FACTS });
  const b = buildDocSections({ repoRoot: root, manifest: SMALL, voice, facts: { routes: [{ method: 'GET', path: '/y' }] } });
  assert.notEqual(a[0].contentHash, b[0].contentHash);
});

test('gatherSources honours the per-source line limit and skips missing files', () => {
  const root = tmp('mc-docs-src-');
  fs.writeFileSync(path.join(root, 'long.txt'), Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'));
  const { files, sourceText } = gatherSources([{ glob: 'long.txt', lines: 3 }, { glob: 'missing.txt' }], { repoRoot: root });
  assert.deepEqual(files, [{ path: 'long.txt' }]);
  assert.match(sourceText, /line2/);
  assert.doesNotMatch(sourceText, /line3/);
});

test('gatherSources stays inside its size budget', () => {
  const root = tmp('mc-docs-budget-');
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(root, 'small.txt'), 'y');
  const { files } = gatherSources([{ glob: 'big.txt', lines: 5 }, { glob: 'small.txt' }], { repoRoot: root, budget: 1000 });
  assert.deepEqual(files, [{ path: 'small.txt' }], 'a chunk larger than what is left is skipped');
});

test('expandGlob matches * within one path level, sorted, files only', () => {
  const root = smallRepo();
  fs.mkdirSync(path.join(root, 'src', 'sub'));
  assert.deepEqual(expandGlob(root, 'src/*.js').map(p => path.basename(p)), ['one.js', 'two.js']);
  assert.deepEqual(expandGlob(root, 'nope/*.js'), []);
});

test('readPagesManifest is null when the repo has none', () => {
  assert.equal(readPagesManifest(tmp('mc-docs-none-')), null);
});

test('glossarySection is a deterministic table of every glossary term', () => {
  const g = glossarySection(voice);
  assert.equal(g.slug, 'glossary');
  assert.equal(g.kind, 'glossary');
  assert.equal(g.deterministic, true);
  assert.equal(g.reference[0].rows.length, voice.glossary.terms.length);
  assert.deepEqual(g.reference[0].rows[0], [voice.glossary.terms[0].term, voice.glossary.terms[0].definition, voice.glossary.terms[0].avoid.join(', ')]);
  const changed = glossarySection({ ...voice, glossary: { ...voice.glossary, terms: [] } });
  assert.notEqual(g.contentHash, changed.contentHash);
});

const CODE = [
  { slug: 'code-alpha', title: 'Alpha', files: [{ path: 'server/lib/alpha/a.js' }, { path: 'server/lib/alpha/b.js' }] },
  { slug: 'code-beta', title: 'Beta', files: [{ path: 'web/beta/c.js' }] },
];
const TRACKED = ['web/beta/c.js', 'README.md', 'server/lib/alpha/b.js', 'server/lib/alpha/a.js', 'docs/x.md', 'server/test/a.test.js'];

test('codeMapSection lists every tracked file under its top-level directory and links each code section', () => {
  const m = codeMapSection({ codeSections: CODE, trackedFiles: TRACKED });
  assert.equal(m.slug, 'code-map');
  assert.equal(m.kind, 'index');
  assert.equal(m.deterministic, true);
  assert.equal(m.group, 'code');
  assert.deepEqual(m.tree.map(t => t.dir), ['(repository root)', 'docs', 'server', 'web']);
  assert.deepEqual(m.tree.flatMap(t => t.files).sort(), [...TRACKED].sort(), 'no file is dropped, tests included');
  assert.deepEqual(m.tree.find(t => t.dir === 'server').files, ['server/lib/alpha/a.js', 'server/lib/alpha/b.js', 'server/test/a.test.js']);
  const table = m.reference[0];
  assert.deepEqual(table.links, ['code-alpha', 'code-beta']);
  assert.deepEqual(table.rows, [['Alpha', '2', 'server/lib/alpha'], ['Beta', '1', 'web/beta']]);
  assert.match(m.summary, /2 subsystems and all 6 tracked files/);
});

test('codeMapSection leaves out and counts files whose names carry dev history or private text', () => {
  const tracked = [...TRACKED, 'docs/specs/2026-01-01-glmps-2-0-84-thing.md', '.gemini/settings.json', 'notes/zed-todo.md'];
  const m = codeMapSection({ codeSections: CODE, trackedFiles: tracked, privateNames: ['zed'] });
  assert.deepEqual(m.tree.flatMap(t => t.files).sort(), [...TRACKED].sort());
  assert.match(m.summary, /2 subsystems and 6 of 9 tracked files/);
  assert.match(m.proseMd, /3 whose names carry private or planning text are not listed/);
  const clean = codeMapSection({ codeSections: CODE, trackedFiles: TRACKED, privateNames: ['zed'] });
  assert.notEqual(m.contentHash, clean.contentHash);
});

test('codeMapSection with no tracked files still lists the subsystems', () => {
  const m = codeMapSection({ codeSections: CODE, trackedFiles: [] });
  assert.deepEqual(m.tree, []);
  assert.equal(m.reference[0].rows.length, 2);
});

test('codeMapSection hash changes when the file count changes', () => {
  const a = codeMapSection({ codeSections: CODE, trackedFiles: TRACKED });
  const b = codeMapSection({ codeSections: CODE, trackedFiles: TRACKED.slice(1) });
  assert.notEqual(a.contentHash, b.contentHash);
});

test('linkSections resolves relatedSlugs and fills backlinks', () => {
  const secs = [
    { slug: 'a', title: 'A', relatedSlugs: ['b', 'c', 'ghost'], related: [], backlinks: [] },
    { slug: 'b', title: 'B', relatedSlugs: ['a'], related: [], backlinks: [] },
    { slug: 'c', title: 'C', relatedSlugs: [], related: [], backlinks: [] },
  ];
  linkSections(secs);
  const by = Object.fromEntries(secs.map(s => [s.slug, s]));
  assert.deepEqual(by.a.related, [{ slug: 'b', title: 'B' }, { slug: 'c', title: 'C' }], 'an unknown slug is dropped');
  assert.deepEqual(by.a.backlinks, [{ slug: 'b', title: 'B' }]);
  assert.deepEqual(by.b.backlinks, [{ slug: 'a', title: 'A' }]);
  assert.deepEqual(by.c.backlinks, [{ slug: 'a', title: 'A' }]);
});

test('linkSections keeps a code section\'s own related list and does not duplicate backlinks', () => {
  const secs = [
    { slug: 'code-a', title: 'A', related: [{ slug: 'code-b', title: 'B' }], backlinks: [] },
    { slug: 'code-b', title: 'B', related: [], backlinks: [{ slug: 'code-a', title: 'A' }] },
  ];
  linkSections(secs);
  assert.deepEqual(secs[0].related, [{ slug: 'code-b', title: 'B' }]);
  assert.deepEqual(secs[1].backlinks, [{ slug: 'code-a', title: 'A' }]);
});
