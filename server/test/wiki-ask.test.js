// server/test/wiki-ask.test.js - DeepWiki-style "ask the wiki" (glmps-44):
// lexical retrieval over wiki sections, grounded prompt, citation parsing,
// and the askWiki orchestrator with injected reader + callModel (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  retrieveSections, buildAskPrompt, parseCitations, askWiki, stripHtml, STRIP_HTML_MAX_CHARS,
} from '../lib/observability/wiki-ask.js';

const S = (slug, title, body = '') => ({ slug, title, body });


test('retrieveSections: a title hit outranks a body hit', () => {
  const sections = [
    S('alpha', 'Session capture', 'nothing relevant here'),
    S('beta', 'Other page', 'session capture is mentioned in the body text'),
  ];
  const out = retrieveSections('how does session capture work?', sections);
  assert.equal(out[0].slug, 'alpha');
  assert.ok(out[0].score > out[1].score, 'title-weighted score beats body-only');
});

test('retrieveSections: slug hits score above body hits and below title hits', () => {
  const sections = [
    S('adapters', 'Something else', ''),
    S('other', 'Something else', 'adapters adapters'),
  ];
  const out = retrieveSections('what are adapters?', sections);
  // slug hit (x2) vs two body hits (x1 each) - tie in raw weight would be 2 vs 2;
  // make body hits singular to assert the ordering cleanly.
  const single = retrieveSections('what are adapters?', [
    S('adapters', 'Something else', ''),
    S('other', 'Something else', 'the adapters live here'),
  ]);
  assert.equal(single[0].slug, 'adapters');
  assert.ok(single[0].score > single[1].score);
  assert.ok(out.length === 2);
});

test('retrieveSections: stopwords and short tokens are ignored', () => {
  const sections = [
    S('noise', 'The and for with how', 'the the the and and how what where'),
    S('signal', 'Governance rules', 'governance'),
  ];
  const out = retrieveSections('how does the governance work and what is it for?', sections);
  assert.equal(out.length, 1, 'stopword-only matches score zero and are dropped');
  assert.equal(out[0].slug, 'signal');
});

test('retrieveSections: question tokenization splits on non-alphanumerics and lowercases', () => {
  const sections = [S('hooks', 'Hooks', 'PreToolUse hook wiring')];
  const out = retrieveSections('What about PRE-TOOL-USE... Hooks?!', sections);
  assert.equal(out[0]?.slug, 'hooks');
});

test('retrieveSections: HTML tags in body are stripped before scoring', () => {
  const sections = [
    S('a', 'Page A', '<div class="governance">nothing</div>'),
    S('b', 'Page B', '<p>governance rules live here</p>'),
  ];
  const out = retrieveSections('governance', sections);
  assert.equal(out.length, 1, 'tag attributes must not count as body text');
  assert.equal(out[0].slug, 'b');
});

test('retrieveSections: deterministic tie-break by slug, top-k default 4', () => {
  const sections = ['zeta', 'yank', 'echo', 'brave', 'alpha', 'mike'].map(
    (slug) => S(slug, 'Server internals', ''));
  const out = retrieveSections('server internals', sections);
  assert.equal(out.length, 4, 'default top-k is 4');
  assert.deepEqual(out.map(s => s.slug), ['alpha', 'brave', 'echo', 'mike'],
    'equal scores order by slug ascending');
});

test('retrieveSections: zero-score sections are never returned', () => {
  const out = retrieveSections('quantum entanglement', [S('a', 'Server', 'http routes')]);
  assert.deepEqual(out, []);
});

test('retrieveSections: k is overridable', () => {
  const sections = ['a', 'b', 'c'].map(slug => S(slug, 'Server', ''));
  assert.equal(retrieveSections('server', sections, { k: 2 }).length, 2);
});


test('buildAskPrompt: contains the question, excerpts, grounding + citation + fallback instructions', () => {
  const prompt = buildAskPrompt('how do adapters work?', [
    { slug: 'adapters', title: 'Adapters', text: 'Adapters detect and extract events.' },
  ]);
  assert.match(prompt, /how do adapters work\?/);
  assert.match(prompt, /Adapters detect and extract events\./);
  assert.match(prompt, /\[adapters\]/, 'excerpt is labeled with its [slug]');
  assert.match(prompt, /ONLY/i, 'instructs answering only from excerpts');
  assert.match(prompt, /\[slug\]/, 'instructs inline [slug] citations');
  assert.match(prompt, /the wiki does not cover this/i, 'instructs the not-covered fallback');
});

test('buildAskPrompt: caps each excerpt (~4k) and the total (~16k)', () => {
  const big = 'x'.repeat(10000);
  const excerpts = Array.from({ length: 8 }, (_, i) => ({ slug: `s${i}`, title: `S${i}`, text: big }));
  const prompt = buildAskPrompt('q', excerpts);
  assert.ok(!prompt.includes('x'.repeat(4001)), 'no single excerpt exceeds ~4k chars');
  // Count only the excerpt payload (long x-runs), not incidental letters in the
  // instruction text (the word "excerpts" contains an x).
  const totalX = (prompt.match(/x{100,}/g) || []).reduce((n, run) => n + run.length, 0);
  assert.ok(totalX <= 16000, `total excerpt budget respected (got ${totalX})`);
});


test('parseCitations: extracts known slugs, drops unknown ones, dedupes in order', () => {
  const { answer, citations } = parseCitations(
    'Adapters extract events [adapters]. The server routes them [server] [adapters] [made-up].',
    ['adapters', 'server']);
  assert.deepEqual(citations, ['adapters', 'server']);
  assert.match(answer, /\[adapters\]/, 'answer keeps the [slug] markers intact');
});

test('parseCitations: no citations yields an empty list', () => {
  const { citations } = parseCitations('the wiki does not cover this', ['a']);
  assert.deepEqual(citations, []);
});


test('stripHtml: drops tags, script/style bodies, decodes entities, collapses whitespace', () => {
  const html = '<html><script>evil()</script><style>.x{}</style><h1>Title</h1>\n\n<p>a &amp; b &lt;c&gt;</p></html>';
  assert.equal(stripHtml(html), 'Title a & b <c>');
});

test('stripHtml: matches the old regex semantics on edge cases', () => {
  assert.equal(stripHtml('a < b and c > d'), 'a d');
  assert.equal(stripHtml('x < y'), 'x < y', 'a lone < with no > after it stays literal');
  assert.equal(stripHtml('<SCRIPT type=x>bad()</script>ok'), 'ok');
  assert.equal(stripHtml('<script>never closed <b>bold</b>'), 'never closed bold', 'an unclosed script is only a tag');
  assert.equal(stripHtml('<scripted>t</scripted>'), 't', 'a longer tag name is not a script block');
  assert.equal(stripHtml('<style>a</style><style>b'), 'b');
});

// Scan 2026-10-15 F3: repo-supplied text must not stall the event loop.
test('F3: stripHtml is linear on a long run of < and on unclosed script tags, and caps its input', () => {
  for (const evil of ['<'.repeat(400_000), '<script'.repeat(60_000), '<a'.repeat(200_000) + 'x']) {
    const t0 = performance.now();
    stripHtml(evil);
    assert.ok(performance.now() - t0 < 1000, 'well under a second');
  }
  const big = 'word '.repeat(STRIP_HTML_MAX_CHARS);
  assert.ok(stripHtml(big).length <= STRIP_HTML_MAX_CHARS);
});


test('askWiki: retrieves, reads section HTML, prompts, and parses citations', async () => {
  const sections = [
    S('adapters', 'Adapters', 'adapter detect discover extract'),
    S('server', 'Server', 'http routes'),
  ];
  const read = [];
  const prompts = [];
  const result = await askWiki({
    question: 'how do adapters extract events?',
    sections,
    readSectionHtml: async (slug) => { read.push(slug); return `<p>${slug} page body</p>`; },
    callModel: async (prompt) => { prompts.push(prompt); return 'They extract per line [adapters]. Also [nope].'; },
  });
  assert.ok(read.includes('adapters'), 'reader called for retrieved sections');
  assert.match(prompts[0], /adapters page body/, 'prompt carries stripped section HTML');
  assert.equal(result.answer, 'They extract per line [adapters]. Also [nope].');
  assert.deepEqual(result.citations, ['adapters']);
  assert.ok(result.retrieved.includes('adapters'));
});

test('askWiki: no lexical match short-circuits without calling the model', async () => {
  let called = 0;
  const result = await askWiki({
    question: 'zzzz qqqq',
    sections: [S('a', 'Server', 'routes')],
    readSectionHtml: async () => '<p>x</p>',
    callModel: async () => { called++; return 'nope'; },
  });
  assert.equal(called, 0);
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.retrieved, []);
  assert.match(result.answer, /does not cover/i);
});

test('askWiki: unreadable sections are skipped; all-unreadable short-circuits', async () => {
  const sections = [S('a', 'Server', ''), S('b', 'Server', '')];
  let called = 0;
  const result = await askWiki({
    question: 'server',
    sections,
    readSectionHtml: async () => null,
    callModel: async () => { called++; return 'x'; },
  });
  assert.equal(called, 0, 'no excerpts -> never calls the model');
  assert.match(result.answer, /does not cover/i);
});
