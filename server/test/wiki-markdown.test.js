import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, mdToHtml } from '../lib/observability/wiki-markdown.js';

test('esc escapes all five HTML-special characters', () => {
  assert.equal(esc('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
});

test('mdToHtml turns [[Title]] into an in-article wikilink', () => {
  const html = mdToHtml('See [[Governance]] for policy details.');
  assert.match(html, /<a class="wikilink" data-wiki="Governance" href="#">Governance<\/a>/);
  assert.ok(!html.includes('[[Governance]]'));
});

test('esc coerces non-strings via String()', () => {
  assert.equal(esc(123), '123');
  assert.equal(esc(null), 'null');
  assert.equal(esc(undefined), 'undefined');
});

test('mdToHtml renders h1/h2/h3 with escaped inline content', () => {
  assert.match(mdToHtml('# Hi'), /<h1>Hi<\/h1>/);
  assert.match(mdToHtml('## Sub'), /<h2>Sub<\/h2>/);
  assert.match(mdToHtml('### Sub sub'), /<h3>Sub sub<\/h3>/);
  assert.match(mdToHtml('# <b>x</b>'), /<h1>&lt;b&gt;x&lt;\/b&gt;<\/h1>/);
});

test('mdToHtml wraps blank-line-separated paragraphs in <p>', () => {
  const html = mdToHtml('para one\n\npara two');
  assert.match(html, /<p>para one<\/p>/);
  assert.match(html, /<p>para two<\/p>/);
});

test('mdToHtml renders GFM pipe tables', () => {
  const html = mdToHtml('a | b\n---|---\n1 | 2');
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<th>b<\/th>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /<td>2<\/td>/);
});

test('mdToHtml fenced mermaid block escapes content and tags pre.mermaid', () => {
  const html = mdToHtml('```mermaid\ngraph TD\nA-->B\n```');
  assert.match(html, /<pre class="mermaid">/);
  assert.match(html, /A--&gt;B/);
  assert.ok(!html.includes('-->'));
});

test('mdToHtml fenced vega-lite block emits data-spec div without parsing JSON', () => {
  const html = mdToHtml('```vega-lite\n{"mark":"bar"}\n```');
  assert.ok(
    html.includes('<div class="vega-lite" data-spec="{&quot;mark&quot;:&quot;bar&quot;}">')
  );
});

test('mdToHtml fenced plain code block escapes and wraps in pre/code', () => {
  const html = mdToHtml('```\n<script>alert(1)</script>\n```');
  assert.match(html, /<pre><code>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>'));
});

test('mdToHtml drops javascript: links, keeping only the escaped text', () => {
  const html = mdToHtml('[x](javascript:alert(1))');
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('x'));
  assert.ok(!html.includes('<a '));
});

test('mdToHtml keeps safe links (http, /, #, .)', () => {
  assert.ok(mdToHtml('[go](https://example.com)').includes('<a href="https://example.com">go</a>'));
  assert.ok(mdToHtml('[go](/path)').includes('<a href="/path">go</a>'));
  assert.ok(mdToHtml('[go](#anchor)').includes('<a href="#anchor">go</a>'));
  assert.ok(mdToHtml('[go](./rel)').includes('<a href="./rel">go</a>'));
});

test('mdToHtml never emits a raw tag from injected input', () => {
  const html = mdToHtml('a <img src=x onerror=y>');
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
});

test('mdToHtml renders unordered lists as <ul><li>', () => {
  const html = mdToHtml('- one\n- two');
  assert.match(html, /<ul>/);
  const liCount = (html.match(/<li>/g) || []).length;
  assert.equal(liCount, 2);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<li>two<\/li>/);
});

test('mdToHtml renders "* " lists too', () => {
  const html = mdToHtml('* one\n* two');
  assert.match(html, /<ul>/);
  assert.equal((html.match(/<li>/g) || []).length, 2);
});

test('mdToHtml renders ordered lists as <ol><li>', () => {
  const html = mdToHtml('1. first\n2. second');
  assert.match(html, /<ol>/);
  assert.match(html, /<li>first<\/li>/);
  assert.match(html, /<li>second<\/li>/);
});

test('mdToHtml applies inline code, bold, italic after escaping', () => {
  const html = mdToHtml('a `code` **bold** *italic*');
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
});

test('mdToHtml inline formatting applies inside headers, list items, and table cells', () => {
  assert.match(mdToHtml('# **Bold** title'), /<h1><strong>Bold<\/strong> title<\/h1>/);
  assert.match(mdToHtml('- a `code` item'), /<li>a <code>code<\/code> item<\/li>/);
  const table = mdToHtml('a | b\n---|---\n**x** | `y`');
  assert.match(table, /<td><strong>x<\/strong><\/td>/);
  assert.match(table, /<td><code>y<\/code><\/td>/);
});

test('mdToHtml never lets inline markup escape unwhitelisted HTML', () => {
  const html = mdToHtml('*<script>*');
  assert.ok(!html.includes('<script>'));
});

test('mdToHtml treats everything else as plain escaped text', () => {
  const html = mdToHtml('plain & <b> text');
  assert.match(html, /<p>plain &amp; &lt;b&gt; text<\/p>/);
});

// glmps: model output can still slip an em-dash (U+2014) or horizontal bar
// (U+2015) despite the prompt's style guidance. Belt-and-suspenders: strip
// both to a spaced hyphen in rendered PROSE only, never inside fenced code /
// mermaid / vega-lite blocks (source there must stay byte-exact). EM_DASH /
// HORIZ_BAR are built via fromCharCode so this test file never contains a raw
// em-dash byte sequence itself.
const EM_DASH = String.fromCharCode(0x2014);
const HORIZ_BAR = String.fromCharCode(0x2015);

test('mdToHtml replaces an em-dash in a paragraph with a spaced hyphen', () => {
  const html = mdToHtml(`one${EM_DASH}two`);
  assert.ok(!html.includes(EM_DASH), 'em-dash must not survive into rendered prose');
  assert.match(html, /<p>one - two<\/p>/);
});

test('mdToHtml replaces a horizontal-bar dash (U+2015) with a spaced hyphen too', () => {
  const html = mdToHtml(`one${HORIZ_BAR}two`);
  assert.ok(!html.includes(HORIZ_BAR));
  assert.match(html, /<p>one - two<\/p>/);
});

test('mdToHtml strips em-dashes inside headers, list items, and table cells', () => {
  assert.match(mdToHtml(`# a${EM_DASH}b`), /<h1>a - b<\/h1>/);
  assert.match(mdToHtml(`- a${EM_DASH}b`), /<li>a - b<\/li>/);
  const table = mdToHtml(`a | b\n---|---\nx${EM_DASH}y | z`);
  assert.match(table, /<td>x - y<\/td>/);
});

test('mdToHtml leaves an em-dash inside a fenced code block untouched (not prose)', () => {
  const html = mdToHtml(`\`\`\`js\n// a${EM_DASH}b\n\`\`\``);
  assert.ok(html.includes('a' + EM_DASH + 'b'), 'em-dash inside fenced code must survive verbatim');
});

test('mdToHtml leaves an em-dash inside a mermaid fence untouched (diagram source must stay exact)', () => {
  const html = mdToHtml(`\`\`\`mermaid\ngraph TD\nA["a${EM_DASH}b"] --> B\n\`\`\``);
  assert.ok(html.includes('a' + EM_DASH + 'b'), 'em-dash inside a mermaid label must survive verbatim');
});

test('a "> Tip:" quote becomes an aside.wd-callout-tip', () => {
  const html = mdToHtml('> Tip: the search box filters every group.');
  assert.equal(html, '<aside class="wd-callout wd-callout-tip"><p class="wd-callout-label">Tip</p><p>the search box filters every group.</p></aside>');
});

test('a "> Warning:" quote becomes an aside.wd-callout-warning, case-insensitively and across quote lines', () => {
  const html = mdToHtml('> warning: this deletes the state directory.\n> Back it up first.');
  assert.match(html, /^<aside class="wd-callout wd-callout-warning"><p class="wd-callout-label">Warning<\/p>/);
  assert.match(html, /this deletes the state directory\. Back it up first\.<\/p><\/aside>$/);
});

test('a plain quote stays a blockquote', () => {
  assert.equal(mdToHtml('> Just a quote.'), '<blockquote><p>Just a quote.</p></blockquote>');
  assert.equal(mdToHtml('> Note: not a callout label.'), '<blockquote><p>Note: not a callout label.</p></blockquote>');
});

test('callout and quote content is escaped', () => {
  const tip = mdToHtml('> Tip: use <script>alert(1)</script> & "quotes"');
  assert.ok(!tip.includes('<script>'));
  assert.match(tip, /use &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
  const quote = mdToHtml('> <img src=x onerror=alert(1)>');
  assert.ok(!quote.includes('<img'));
  assert.match(quote, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a [[Title|label]] wikilink shows the label and links the title', () => {
  assert.equal(mdToHtml('Open [[Read a session|a session]].'),
    '<p>Open <a class="wikilink" data-wiki="Read a session" href="#">a session</a>.</p>');
});
