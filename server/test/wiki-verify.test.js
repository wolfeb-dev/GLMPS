// server/test/wiki-verify.test.js
// one fixture build per checker rule, each failing exactly that rule, plus a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyWikiBuild, WIKI_VERIFY_RULES } from '../lib/observability/wiki-verify.js';

const HEAD = 'a'.repeat(40);
const EM = String.fromCharCode(0x2014);
const page = (title, body = '<p>Prose.</p>') =>
  `<!doctype html><html><head><link rel="stylesheet" href="/observability/wiki-doc.css"></head><body>`
  + `<article class="wiki-doc"><h1>${title}</h1>${body}</article><script src="/wiki-assets/mermaid.min.js"></script></body></html>`;
const SECTIONS = () => [
  { slug: 'server', title: 'Server', llm: true, contentHash: 'h-server', related: [{ slug: 'hooks', title: 'Hooks' }], backlinks: [] },
  { slug: 'hooks', title: 'Hooks & Guards', llm: true, contentHash: 'h-hooks', related: [], backlinks: [{ slug: 'server', title: 'Server' }] },
];

function makeBuild({ sections = SECTIONS(), pages = {}, builtAtCommit = HEAD, graphFingerprint = 'g1:fixture', omit = [], voiceRules = null, facts = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wv-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ builtAtCommit, graphFingerprint, generatedAt: '2026-09-23T00:00:00Z', sections }));
  for (const s of sections) {
    if (omit.includes(s.slug)) continue;
    fs.writeFileSync(path.join(dir, `${s.slug}.html`), pages[s.slug] ?? page(s.title));
  }
  if (voiceRules) fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify(voiceRules));
  if (facts) fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(facts));
  return dir;
}
const rules = (r) => [...new Set(r.failures.map(([rule]) => rule))];

test('the rule list is the spec five plus headings, style, coverage, graph and private-text', () => {
  assert.deepEqual(WIKI_VERIFY_RULES, ['sections', 'em-dash', 'links', 'head', 'size', 'headings', 'style', 'coverage', 'graph', 'private-text']);
});

test('private-text: any file of the build carrying what the stage refuses fails, deterministic pages included', () => {
  const sections = [...SECTIONS(), { slug: 'code-map', title: 'Code map', llm: true, deterministic: true, kind: 'index', contentHash: 'h-map' }];
  const map = page('Code map', '<p>See <a class="wikilink" data-wiki="Server" href="#">Server</a> and <a class="wikilink" data-wiki="Hooks &amp; Guards" href="#">Hooks</a>.</p><li>docs/specs/2026-01-01-glmps-2-0-84-x.md</li>');
  const r = verifyWikiBuild({ buildDir: makeBuild({ sections, pages: {
    'code-map': map,
    server: page('Server', '<p>Kept at C:/Users/zed/state, see <a class="wikilink" data-wiki="Hooks &amp; Guards" href="#">Hooks</a>.</p>'),
  } }), headSha: HEAD });
  const priv = r.failures.filter(([rule]) => rule === 'private-text').map(([, d]) => d);
  assert.equal(priv.length, 2, JSON.stringify(r.failures));
  assert.ok(priv.some(d => d.startsWith('code-map.html: ') && /ticket id/.test(d)));
  assert.ok(priv.some(d => d.startsWith('server.html: ') && /drive path/.test(d)));
  assert.deepEqual(r.offending.map(o => o.slug), ['server'], 'a deterministic page would come back the same, so it is not evicted');
});

test('private-text: the names come from the caller, and the word system is not one under the service account', () => {
  const pages = { server: page('Server', '<p>The system for zed. See <a class="wikilink" data-wiki="Hooks &amp; Guards" href="#">Hooks</a>.</p>') };
  const named = verifyWikiBuild({ buildDir: makeBuild({ pages }), headSha: HEAD, privateNames: ['zed'] });
  assert.ok(named.failures.some(([rule, d]) => rule === 'private-text' && /name zed/.test(d)));
  const service = verifyWikiBuild({ buildDir: makeBuild({ pages }), headSha: HEAD, privateNames: [] });
  assert.deepEqual(service.failures.filter(([rule]) => rule === 'private-text'), []);
});

test('a complete, linked, narrative build at HEAD passes', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({ pages: {
    server: page('Server', '<p>See <a class="wikilink" data-wiki="Hooks &amp; Guards" href="#">Hooks &amp; Guards</a>.</p>'
      + '<nav><a class="related-link" data-wiki-slug="hooks" href="#">Hooks</a></nav>'),
  } }), headSha: HEAD, previous: { sections: 2 } });
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
  assert.equal(r.sections, 2);
  assert.equal(r.llmSections, 2);
});

test('sections: a missing page or a structural stub fails only "sections", and is not cache-offending', () => {
  const stub = SECTIONS(); stub[1].llm = false;
  const r1 = verifyWikiBuild({ buildDir: makeBuild({ sections: stub }), headSha: HEAD });
  assert.deepEqual(rules(r1), ['sections']);
  assert.match(r1.failures[0][1], /structural stub: hooks/);
  assert.deepEqual(r1.offending, []);
  const r2 = verifyWikiBuild({ buildDir: makeBuild({ omit: ['hooks'] }), headSha: HEAD });
  assert.deepEqual(rules(r2), ['sections']);
  assert.match(r2.failures[0][1], /missing page hooks\.html/);
});

test('em-dash: an em-dash inside the article fails only "em-dash" and flags that section', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({ pages: { server: page('Server', `<p>fast ${EM} safe</p>`) } }), headSha: HEAD });
  assert.deepEqual(rules(r), ['em-dash']);
  assert.deepEqual(r.offending, [{ slug: 'server', contentHash: 'h-server' }]);
});

test('links: a dangling wikilink or related link fails only "links" and flags that section', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({ pages: {
    server: page('Server', '<p><a class="wikilink" data-wiki="Nowhere" href="#">Nowhere</a></p>'),
  } }), headSha: HEAD });
  assert.deepEqual(rules(r), ['links']);
  assert.deepEqual(r.offending, [{ slug: 'server', contentHash: 'h-server' }]);
  const r2 = verifyWikiBuild({ buildDir: makeBuild({ pages: {
    hooks: page('Hooks & Guards', '<nav><a class="related-link" data-wiki-slug="ghost" href="#">Ghost</a></nav>'),
  } }), headSha: HEAD });
  assert.deepEqual(rules(r2), ['links']);
});

test('links: absolute asset links are checked against webDir when given', () => {
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wv-web-'));
  fs.mkdirSync(path.join(webDir, 'observability'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'observability', 'wiki-doc.css'), '');
  const r = verifyWikiBuild({ buildDir: makeBuild(), headSha: HEAD, webDir });
  assert.deepEqual(rules(r), ['links']);
  assert.match(r.failures[0][1], /\/wiki-assets\/mermaid\.min\.js does not resolve/);
  fs.mkdirSync(path.join(webDir, 'wiki-assets'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'wiki-assets', 'mermaid.min.js'), '');
  assert.equal(verifyWikiBuild({ buildDir: makeBuild(), headSha: HEAD, webDir }).ok, true);
});

test('graph: a manifest with no graph fingerprint (or not a g1: one) fails only "graph"', () => {
  for (const graphFingerprint of [null, '', 'sha1:abc']) {
    const r = verifyWikiBuild({ buildDir: makeBuild({ graphFingerprint }), headSha: HEAD });
    assert.deepEqual(rules(r), ['graph']);
    assert.deepEqual(r.offending, []);
  }
});

test('head: builtAtCommit other than the requested HEAD fails only "head"', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({ builtAtCommit: 'b'.repeat(40) }), headSha: HEAD });
  assert.deepEqual(rules(r), ['head']);
});

test('size: fewer than 50% of the published section count fails only "size"', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild(), headSha: HEAD, previous: { sections: 5 } });
  assert.deepEqual(rules(r), ['size']);
  assert.equal(verifyWikiBuild({ buildDir: makeBuild(), headSha: HEAD, previous: { sections: 4 } }).ok, true);
  assert.equal(verifyWikiBuild({ buildDir: makeBuild(), headSha: HEAD, previous: null }).ok, true);
});

test('an unreadable manifest is a "sections" failure, never a throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wv-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ nope');
  const r = verifyWikiBuild({ buildDir: dir, headSha: HEAD });
  assert.equal(r.ok, false);
  assert.deepEqual(rules(r), ['sections']);
});

const RULES = { bannedWords: ['robust', 'just'], maxAvgSentenceWords: 22, properNouns: [], terms: [] };
const doc = (title, inner, tail = '') =>
  `<!doctype html><html><head><link rel="stylesheet" href="/observability/wiki-doc.css"></head><body>`
  + `<article class="wiki-doc"><header class="wd-head"><h1>${title}</h1></header><div class="wd-body">${inner}</div><!-- /wd-body -->${tail}</article></body></html>`;
const written = (over = {}) => [
  { slug: 'server', title: 'Server', kind: 'guide', required: ['Purpose'], factKinds: [], llm: true, contentHash: 'h-server', related: [], backlinks: [], ...over },
];

test('headings: a page missing a required heading fails only "headings" and is offending', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({
    sections: written(), voiceRules: RULES,
    pages: { server: doc('Server', '<h2>Something else</h2><p>Text.</p>') },
  }), headSha: HEAD });
  assert.deepEqual(rules(r), ['headings']);
  assert.match(r.failures[0][1], /missing "## Purpose"/);
  assert.deepEqual(r.offending, [{ slug: 'server', contentHash: 'h-server' }]);
});

test('style: a banned word in the body fails only "style" and is offending', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({
    sections: written(), voiceRules: RULES,
    pages: { server: doc('Server', '<h2>Purpose</h2><p>It is robust.</p>') },
  }), headSha: HEAD });
  assert.deepEqual(rules(r), ['style']);
  assert.match(r.failures[0][1], /banned-word: "robust"/);
  assert.equal(r.offending.length, 1);
});

test('style: a page that follows the voice passes, and a banned word inside a reference table is not linted', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({
    sections: written(), voiceRules: RULES,
    pages: { server: doc('Server', '<h2>Purpose</h2><p>It runs the loop.</p><section class="wd-reference"><table><tr><td>robust</td></tr></table></section>') },
  }), headSha: HEAD });
  assert.deepEqual(r.failures, []);
});

test('style: deterministic pages (glossary, index) are not linted', () => {
  const sections = [
    { slug: 'glossary', title: 'Glossary', kind: 'glossary', deterministic: true, required: ['Purpose'], llm: true, contentHash: 'g', related: [], backlinks: [] },
    { slug: 'code-map', title: 'Code map', kind: 'index', deterministic: true, required: ['Purpose'], llm: true, contentHash: 'c', related: [], backlinks: [] },
  ];
  const bad = doc('X', '<p>It is just robust.</p>');
  const r = verifyWikiBuild({ buildDir: makeBuild({ sections, voiceRules: RULES, pages: { glossary: bad, 'code-map': bad } }), headSha: HEAD });
  assert.deepEqual(r.failures, []);
});

test('style: without voice.json the lint is skipped (fail open)', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({
    sections: written(), pages: { server: doc('Server', '<p>It is robust.</p>') },
  }), headSha: HEAD });
  assert.deepEqual(r.failures, []);
});

test('coverage: a fact absent from the owning page fails only "coverage"', () => {
  const facts = { config: [{ key: 'wikiLoop.everyMs', value: '1' }, { key: 'wikiLoop.keepBuilds', value: '3' }] };
  const body = '<h2>Purpose</h2><p>Text.</p><section class="wd-reference"><table><tr><td><code>wikiLoop.everyMs</code></td></tr></table></section>';
  const r = verifyWikiBuild({ buildDir: makeBuild({
    sections: written({ factKinds: ['config'] }), voiceRules: RULES, facts, pages: { server: doc('Server', body) },
  }), headSha: HEAD });
  assert.deepEqual(rules(r), ['coverage']);
  assert.match(r.failures[0][1], /1 config fact\(s\) on no page, e\.g\. wikiLoop\.keepBuilds/);
  assert.deepEqual(r.offending, [], 'coverage is not a content rejection, so nothing is evicted from the cache');
  const full = body.replace('</td></tr>', '</td></tr><tr><td><code>wikiLoop.keepBuilds</code></td></tr>');
  const ok = verifyWikiBuild({ buildDir: makeBuild({
    sections: written({ factKinds: ['config'] }), voiceRules: RULES, facts, pages: { server: doc('Server', full) },
  }), headSha: HEAD });
  assert.deepEqual(ok.failures, []);
});

test('coverage: a fact kind that no page declares fails "coverage"', () => {
  const r = verifyWikiBuild({ buildDir: makeBuild({
    sections: written(), voiceRules: RULES, facts: { routes: [{ method: 'GET', path: '/api/x' }] },
    pages: { server: doc('Server', '<h2>Purpose</h2><p>Text.</p>') },
  }), headSha: HEAD });
  assert.deepEqual(rules(r), ['coverage']);
  assert.match(r.failures[0][1], /no page declares the routes facts \(1\)/);
});

test('coverage: fact labels are matched HTML-escaped, as the renderer writes them', () => {
  const facts = { routes: [{ method: 'GET', path: '/api/a&b' }] };
  const r = verifyWikiBuild({ buildDir: makeBuild({
    sections: written({ factKinds: ['routes'] }), voiceRules: RULES, facts,
    pages: { server: doc('Server', '<h2>Purpose</h2><p>Text.</p><table><tr><td><code>/api/a&amp;b</code></td></tr></table>') },
  }), headSha: HEAD });
  assert.deepEqual(r.failures, []);
});
