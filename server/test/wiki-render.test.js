import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDoc, renderManifest, sanitizeMermaid } from '../lib/observability/wiki-render.js';

const T0 = Date.UTC(2026, 0, 4);   // Jan 4, 2026
const T1 = Date.UTC(2026, 6, 12);  // Jul 12, 2026

const base = {
  slug: 'server', title: 'Server', community: 3,
  godNodes: ['a'], files: [{ path: 'server/server.js', location: 'L1', degree: 9 }],
  proseMd: 'Intro paragraph.', mermaid: 'graph LR\nA-->B', artifacts: [], llm: false,
};

test('renderDoc emits the doc contract: article, head, summary, glance, body, related', () => {
  const html = renderDoc({
    ...base, kind: 'guide', group: 'documentation', groupTitle: 'Documentation', subgroup: 'User guide',
    summary: 'What this is for.', audience: 'Operators', files: [{ path: 'web/a.js' }],
    related: [{ slug: 'gov', title: 'Governance' }],
  }, { builtAtCommit: 'abcdef1234' });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /<article class="wiki-doc" data-kind="guide">/);
  assert.match(html, /<header class="wd-head"><p class="wd-eyebrow">Documentation \/ User guide<\/p><h1>Server<\/h1><p class="wd-summary">What this is for\.<\/p><dl class="wd-glance">/);
  assert.match(html, /<dt>Audience<\/dt><dd>Operators<\/dd>/);
  assert.match(html, /<dt>Built at<\/dt><dd><code>abcdef1<\/code><\/dd>/);
  assert.match(html, /<span class="wd-chip">web\/a\.js<\/span>/);
  assert.match(html, /<div class="wd-body">[\s\S]*<\/div><!-- \/wd-body -->/);
  assert.match(html, /<nav class="wiki-related"><h2>Related<\/h2>/);
});

test('renderDoc links the shared tokens before the wiki-doc stylesheet', () => {
  const html = renderDoc(base);
  const t = html.indexOf('href="/shared/tokens.css"');
  const c = html.indexOf('href="/observability/wiki-doc.css"');
  assert.ok(t > 0 && c > t, 'tokens.css first, then wiki-doc.css');
});

test('renderDoc escapes the title and loads mermaid only when the page has a diagram', () => {
  const withDiagram = renderDoc({ ...base, kind: 'code', title: 'A<b>"' });
  assert.match(withDiagram, /<title>A&lt;b&gt;&quot;<\/title>/);
  assert.match(withDiagram, /<script src="\/wiki-assets\/mermaid\.min\.js"><\/script>/);
  assert.match(withDiagram, /<pre class="mermaid">graph LR\nA--&gt;B<\/pre>/);
  assert.match(withDiagram, /<code>server\/server\.js<\/code>/);
  const without = renderDoc({ ...base, mermaid: '' });
  assert.ok(!without.includes('mermaid.min.js'));
  assert.ok(!without.includes('wikiDiagrams'));
});

// Regression: mermaid's startOnLoad defaults to true. If initialize() waits
// for the load event, mermaid renders every pre.mermaid first and the page's
// own pass then reads the SVG back as source and swaps in the fallback.
test('the boot script turns mermaid startOnLoad off while it runs, before any load handler', () => {
  const html = renderDoc({ ...base, kind: 'code' });
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const calls = []; const loadHandlers = [];
  const ctx = {
    mermaid: { initialize: (o) => calls.push({ ...o, during: 'script' }), render: async () => ({ svg: '' }) },
    location: { search: '?theme=light' },
    URLSearchParams,
    document: { documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] },
    window: { addEventListener: (ev, fn) => { if (ev === 'load') loadHandlers.push(fn); } },
    parent: { postMessage() {} },
  };
  vm.runInNewContext(inline, ctx);
  assert.equal(calls.length, 1, 'initialize ran while the script was evaluated');
  assert.equal(calls[0].startOnLoad, false);
  assert.equal(calls[0].theme, 'default', 'the light theme param picks the light diagram theme');
});

test('renderDoc renders reference tables as section.wd-reference with table.wd-ledger', () => {
  const html = renderDoc({ ...base, kind: 'admin', reference: [{ title: 'Routes', columns: ['Path', 'Method'], rows: [['/api/<x>', 'GET'], ['/b', '12']] }] });
  assert.match(html, /<section class="wd-reference"><h2>Routes<\/h2><table class="wd-ledger">/);
  assert.match(html, /<td><code>\/api\/&lt;x&gt;<\/code><\/td><td>GET<\/td>/);
  assert.match(html, /<td>12<\/td>/, 'a number in a mixed column stays left-aligned');
});

test('renderDoc lists files in details.wd-files for code pages only', () => {
  assert.match(renderDoc({ ...base, kind: 'code' }), /<details class="wd-files"><summary>Files \(1\)<\/summary>/);
  assert.ok(!renderDoc({ ...base, kind: 'guide' }).includes('wd-files'));
});

test('renderDoc ignores a bodyHtml field: no authored markup is ever injected', () => {
  const html = renderDoc({ ...base, bodyHtml: '<div class="fx-card">Hi</div>', authored: true });
  assert.ok(!html.includes('fx-card'));
});

test('prose containing a script tag is escaped, never raw', () => {
  const html = renderDoc({ ...base, proseMd: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.match(html, /&lt;script&gt;alert\(1\)/);
});

test('vega-lite artifact pulls in vega-embed and a data-spec div', () => {
  const html = renderDoc({ ...base, llm: true, artifacts: [{ type: 'vega-lite', spec: { mark: 'bar' } }] });
  assert.match(html, /\/vendor\/vega-embed\.min\.js/);
  assert.match(html, /class="vega-lite" data-spec="\{&quot;mark&quot;:&quot;bar&quot;\}"/);
});

test('no vega artifact => vega-embed not loaded', () => {
  const html = renderDoc(base);
  assert.ok(!html.includes('vega-embed.min.js'));
});

test('mermaid artifact rendered as escaped pre.mermaid', () => {
  const html = renderDoc({ ...base, llm: true, artifacts: [{ type: 'mermaid', spec: 'flowchart TD\nX-->Y' }] });
  assert.match(html, /<pre class="mermaid">flowchart TD\nX--&gt;Y<\/pre>/);
});

// glmps: every generated wiki page must be free of em-dashes (the prompt bans
// them and wiki-markdown.js strips them from prose), but this literal fallback
// string lived in renderDoc's boot <script> template, entirely outside the
// markdown/prose pipeline, so it kept a hardcoded em-dash. EM_DASH is built
// via fromCharCode so this test file never contains a raw em-dash itself.
const EM_DASH = String.fromCharCode(0x2014);

test('renderDoc: the mermaid-fallback summary text uses a hyphen, not an em-dash', () => {
  const html = renderDoc(base);
  assert.ok(!html.includes(EM_DASH), 'renderDoc output must never contain a literal em-dash');
  assert.ok(html.includes('Diagram (source, could not render)'));
});

test('sanitizeMermaid repairs single-dash flowchart arrows to -->', () => {
  // the exact bug: a flowchart edge written `->` (parse error) becomes `-->`
  assert.equal(sanitizeMermaid('flowchart TD\n  A["a"] -> B["b"]'), 'flowchart TD\n  A["a"] --> B["b"]');
  assert.equal(sanitizeMermaid('graph LR\n  A->B'), 'graph LR\n  A-->B');
  // already-valid arrows are untouched (no `--->` doubling, dotted/thick kept)
  assert.equal(sanitizeMermaid('flowchart TD\n  A --> B'), 'flowchart TD\n  A --> B');
  assert.equal(sanitizeMermaid('flowchart TD\n  A -.-> B'), 'flowchart TD\n  A -.-> B');
  assert.equal(sanitizeMermaid('flowchart TD\n  A ==> B'), 'flowchart TD\n  A ==> B');
});

test('sanitizeMermaid leaves sequenceDiagram arrows (valid ->/->>)  intact', () => {
  const seq = 'sequenceDiagram\n  Alice->John: hi\n  John-->>Alice: yo';
  assert.equal(sanitizeMermaid(seq), seq);
});

test('renderDoc applies the mermaid sanitizer to flowchart artifacts', () => {
  // labels are HTML-escaped by esc(), so quotes become &quot; in the output
  const html = renderDoc({ ...base, llm: true, artifacts: [{ type: 'mermaid', spec: 'flowchart TD\n  A["x"] -> B["y"]' }] });
  assert.match(html, /A\[&quot;x&quot;\] --&gt; B\[&quot;y&quot;\]/);          // repaired to -->
  assert.ok(!/A\[&quot;x&quot;\] -&gt; B/.test(html), 'no single-dash arrow survives');
});

test('renderDoc leads with the prose summary (before the diagram) and no duplicate h1', () => {
  const html = renderDoc({ ...base, proseMd: '# Server\n\nThe server ties everything together.' });
  assert.equal((html.match(/<h1>/g) || []).length, 1, 'leading # stripped from prose -> one h1');
  assert.ok(html.includes('The server ties everything together'));
  assert.ok(html.indexOf('The server ties everything') < html.indexOf('wiki-arch'), 'summary precedes the diagram');
});

test('renderDoc renders a Related pages nav with in-article links', () => {
  const html = renderDoc({ ...base, related: [{ slug: 'gov', title: 'Governance' }], backlinks: [] });
  assert.match(html, /<nav class="wiki-related">/);
  assert.match(html, /<a class="related-link" data-wiki-slug="gov" href="#">Governance<\/a>/);
});

test('renderManifest lists sections and flags tierLlm', () => {
  const m = renderManifest([base, { ...base, slug: 's2', llm: true }], { builtAtCommit: 'abc' });
  assert.equal(m.builtAtCommit, 'abc');
  assert.equal(m.tierLlm, true);
  assert.equal(m.sections.length, 2);
  const s0 = m.sections[0];
  assert.equal(s0.slug, 'server'); assert.equal(s0.title, 'Server');
  assert.equal(s0.community, 3); assert.equal(s0.llm, false); assert.equal(s0.fileCount, 1);
});

test('renderManifest tierLlm false when no llm sections', () => {
  assert.equal(renderManifest([base]).tierLlm, false);
});

test('renderManifest emits contentHash + created/updated per section', () => {
  const ms = renderManifest([{ ...base, contentHash: 'hh', createdTs: T0, updatedTs: T1 }]).sections[0];
  assert.equal(ms.contentHash, 'hh');
  assert.equal(ms.createdTs, T0);
  assert.equal(ms.updatedTs, T1);
});

test('renderManifest date fields are null when absent (back-compat)', () => {
  const ms = renderManifest([base]).sections[0];
  assert.equal(ms.createdTs, null);
  assert.equal(ms.updatedTs, null);
});

test('renderDoc shows the Updated date in the at-a-glance strip when present', () => {
  const html = renderDoc({ ...base, createdTs: T0, updatedTs: T1 });
  assert.match(html, /<dt>Updated<\/dt><dd>Jul 12, 2026<\/dd>/);
});

test('renderDoc omits the Updated entry when timestamps absent', () => {
  assert.ok(!renderDoc(base).includes('<dt>Updated</dt>'));
});

test('renderManifest carries related/backlinks/tags + a search haystack', () => {
  const s = { ...base, related: [{ slug: 'gov', title: 'Governance' }], backlinks: [{ slug: 'x', title: 'X' }], tags: ['js', 'md'], proseMd: 'Alpha beta gamma delta epsilon.' };
  const ms = renderManifest([s]).sections[0];
  assert.deepEqual(ms.related, [{ slug: 'gov', title: 'Governance' }]);
  assert.deepEqual(ms.backlinks, [{ slug: 'x', title: 'X' }]);
  assert.deepEqual(ms.tags, ['js', 'md']);
  assert.ok(ms.searchText.includes('Server'));            // title
  assert.ok(ms.searchText.includes('server/server.js'));  // file path
  assert.ok(ms.searchText.includes('Alpha beta gamma'));  // prose snippet
});

test('renderDoc renders inline code in the summary, escaped, without a nested paragraph', () => {
  const html = renderDoc({ slug: 'a', title: 'A', kind: 'admin', summary: 'Edit `config.json` <now>.', proseMd: '' });
  assert.match(html, /<p class="wd-summary">Edit <code>config\.json<\/code> &lt;now&gt;\.<\/p>/);
});

test('a ledger column is right-aligned only when every cell is a number', () => {
  const html = renderDoc({ slug: 'a', title: 'A', kind: 'admin', proseMd: '', reference: [
    { title: 'T', columns: ['Key', 'Default', 'Count'], rows: [['a', 'null', '3'], ['b', '5000', '12']] }] });
  assert.match(html, /<td>null<\/td>/);
  assert.match(html, /<td>5000<\/td>/);
  assert.match(html, /<td class="wd-num">12<\/td>/);
});

test('renderManifest gives the nav a plain-text summary', () => {
  const m = renderManifest([{ slug: 'a', title: 'A', summary: 'Use **Surface** with `config.json`.' }]);
  assert.equal(m.sections[0].summary, 'Use Surface with config.json.');
});
