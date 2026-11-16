// server/lib/observability/wiki-render.js
// Assemble a wiki section into a self-contained static HTML document + build the
// manifest. Zero-dep. All dynamic text is escaped via wiki-markdown's esc(); the
// document is meant to be served and embedded ONLY inside a sandboxed iframe.
// Every page uses one frame (spec 2.C): eyebrow, title, summary, an
// at-a-glance strip, the body, generated reference tables, Related. No source
// HTML is ever injected.

import { esc, mdToHtml } from './wiki-markdown.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Absolute UTC date, e.g. "Jul 12, 2026". UTC (not locale) so the baked-in
// article date is deterministic and test-stable across machines/timezones.
function fmtDate(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Repair the most common LLM Mermaid mistake: a FLOWCHART edge written with a
// single-dash arrow `->` (the flowchart edge operator is `-->`; a lone `->`
// is a parse error that degrades the whole diagram to the source-fallback).
// Scoped strictly to flowchart/graph diagrams so real `->`/`->>` arrows in
// sequenceDiagrams stay intact. A single-dash `->` is one NOT already preceded
// by a dash/dot/equals/angle (which would make it part of a valid `-->`,
// `-.->`, `==>`, `<-->`), so those are left alone.
export function sanitizeMermaid(src) {
  const text = String(src ?? '');
  const first = (text.match(/^\s*([^\r\n]*)/)?.[1] || '').trim();
  if (!/^(flowchart|graph)\b/.test(first)) return text;
  return text.replace(/([^-.=<>])->/g, '$1-->');
}

function artifactHtml(a) {
  if (!a || !a.type) return '';
  if (a.type === 'mermaid') return `<figure class="wiki-fig"><pre class="mermaid">${esc(sanitizeMermaid(String(a.spec ?? '')))}</pre></figure>`;
  if (a.type === 'vega-lite') return `<figure class="wiki-fig"><div class="vega-lite" data-spec="${esc(JSON.stringify(a.spec ?? {}))}"></div></figure>`;
  return '';
}

// Drop a leading "# ..." heading: model prose repeats the page title, which
// would duplicate the doc's own <h1>.
function stripLeadingH1(md) {
  return String(md ?? '').replace(/^\s*#\s+.*(?:\r?\n)+/, '');
}

// In-article "Related" nav: real hyperlinks to related + back-linked sections.
// Clicks are relayed to the parent frame (see the boot script).
function relatedNav(s) {
  const seen = new Set(); const items = [];
  for (const it of [...(Array.isArray(s.related) ? s.related : []), ...(Array.isArray(s.backlinks) ? s.backlinks : [])]) {
    if (it && it.slug && it.slug !== s.slug && !seen.has(it.slug)) { seen.add(it.slug); items.push(it); }
  }
  if (!items.length) return '';
  const links = items.map(it =>
    `<a class="related-link" data-wiki-slug="${esc(it.slug)}" href="#">${esc(it.title || it.slug)}</a>`).join('');
  return `<nav class="wiki-related"><h2>Related</h2><div class="wiki-related-links">${links}</div></nav>`;
}

const NUM_RE = /^\d[\d,.]*$/;

// A generated reference table in the Surface ledger style. The first column is
// the identifier a reader looks up (and the checker's coverage rule keys on);
// `links` (optional, one slug per row) makes that cell a page link.
function ledgerTable(t) {
  // Right-align a column only when every cell in it is a number; a mixed
  // column (config defaults) reads as ragged otherwise.
  const numCol = t.columns.map((_, j) => t.rows.length > 0 && t.rows.every(r => NUM_RE.test(String(r[j] ?? ''))));
  const head = `<tr>${t.columns.map((c, j) => `<th${numCol[j] ? ' class="wd-num"' : ''}>${esc(c)}</th>`).join('')}</tr>`;
  const rows = t.rows.map((r, i) => {
    const cells = r.map((c, j) => {
      const v = String(c ?? '');
      if (j === 0) {
        const slug = Array.isArray(t.links) ? t.links[i] : null;
        return slug
          ? `<td><a class="related-link" data-wiki-slug="${esc(slug)}" href="#">${esc(v)}</a></td>`
          : `<td><code>${esc(v)}</code></td>`;
      }
      return numCol[j] ? `<td class="wd-num">${esc(v)}</td>` : `<td>${esc(v)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="wd-ledger"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function referenceHtml(tables) {
  const list = (Array.isArray(tables) ? tables : []).filter(t => t && Array.isArray(t.rows) && t.rows.length);
  if (!list.length) return '';
  const one = list.length === 1;
  const body = list.map(t => `${one ? '' : `<h3>${esc(t.title)}</h3>`}${ledgerTable(t)}`).join('');
  return `<section class="wd-reference"><h2>${one ? esc(list[0].title) : 'Reference'}</h2>${body}</section>`;
}

function filesHtml(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '';
  const rows = list.map(f => {
    const loc = f.location ? `<td>${esc(String(f.location))}</td>` : '<td></td>';
    const deg = typeof f.degree === 'number' ? `<td class="wd-num">${esc(String(f.degree))}</td>` : '<td></td>';
    return `<tr><td><code>${esc(f.path)}</code></td>${loc}${deg}</tr>`;
  }).join('');
  return `<details class="wd-files"><summary>Files (${list.length})</summary><table class="wd-ledger"><thead><tr><th>File</th><th>Location</th><th>Links</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

function treeHtml(tree) {
  if (!Array.isArray(tree) || !tree.length) return '';
  const groups = tree.map(g =>
    `<details class="wd-tree"><summary>${esc(g.dir)}/ (${g.files.length})</summary><ul class="wd-tree-list">${g.files.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul></details>`).join('');
  return `<section class="wd-reference"><h2>File index</h2>${groups}</section>`;
}

function glanceHtml(s, builtAtCommit) {
  const items = [];
  if (s.audience) items.push(`<div><dt>Audience</dt><dd>${esc(s.audience)}</dd></div>`);
  if (builtAtCommit) items.push(`<div><dt>Built at</dt><dd><code>${esc(String(builtAtCommit).slice(0, 7))}</code></dd></div>`);
  if (typeof s.updatedTs === 'number') items.push(`<div><dt>Updated</dt><dd>${esc(fmtDate(s.updatedTs))}</dd></div>`);
  const src = (Array.isArray(s.files) ? s.files : []).slice(0, s.kind === 'code' ? 0 : 8);
  if (src.length) items.push(`<div class="wd-sources"><dt>Sources</dt><dd>${src.map(f => `<span class="wd-chip">${esc(f.path)}</span>`).join('')}</dd></div>`);
  return items.length ? `<dl class="wd-glance">${items.join('')}</dl>` : '';
}

/** Render one section into a full self-contained HTML document string. */
export function renderDoc(section, {
  vendorBase = '/vendor', tokensHref = '/shared/tokens.css', cssHref = '/observability/wiki-doc.css',
  mermaidSrc = '/wiki-assets/mermaid.min.js', builtAtCommit = null,
} = {}) {
  const s = section || {};
  const title = esc(s.title ?? 'Untitled');
  const artifacts = Array.isArray(s.artifacts) ? s.artifacts : [];
  const hasVega = artifacts.some(a => a && a.type === 'vega-lite');
  const eyebrow = [s.groupTitle, s.subgroup].filter(Boolean).map(esc).join(' / ');

  const archDiagram = s.mermaid
    ? `<figure class="wiki-fig wiki-arch"><figcaption>How it connects</figcaption><pre class="mermaid">${esc(sanitizeMermaid(String(s.mermaid)))}</pre></figure>`
    : '';
  const prose = mdToHtml(stripLeadingH1(s.proseMd || ''));
  const body = [prose, archDiagram, artifacts.map(artifactHtml).join('\n'), referenceHtml(s.reference), treeHtml(s.tree), s.kind === 'code' ? filesHtml(s.files) : '']
    .filter(Boolean).join('\n');
  const hasMermaid = body.includes('class="mermaid"');

  const vegaScripts = hasVega
    ? `<script src="${vendorBase}/vega.min.js"></script>\n<script src="${vendorBase}/vega-lite.min.js"></script>\n<script src="${vendorBase}/vega-embed.min.js"></script>\n`
    : '';
  // D21: mermaid (3.5 MB) loads only on a page that has a diagram. Each
  // diagram renders with its own try/catch: one that fails to parse degrades
  // to a collapsible source block instead of Mermaid's "Syntax error" box.
  // initialize() must run here, synchronously, not in the load handler:
  // mermaid's own startOnLoad defaults to true and renders every pre.mermaid
  // on load, after which this code read the SVG back as "source", failed to
  // parse it and replaced a good diagram with the fallback.
  const mermaidBoot = hasMermaid ? `
if(typeof mermaid!=='undefined'){
  mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:document.documentElement.dataset.theme==='light'?'default':'dark'});
}
function wikiDiagrams(){
  if(typeof mermaid==='undefined') return Promise.resolve();
  var blocks=document.querySelectorAll('pre.mermaid'), p=Promise.resolve();
  Array.prototype.forEach.call(blocks,function(el,i){
    p=p.then(function(){
      var code=el.textContent, id='mmd'+i;
      return mermaid.render(id, code).then(function(out){
        var box=document.createElement('div'); box.className='mermaid-svg'; box.innerHTML=out.svg; el.replaceWith(box);
      },function(){
        var stray=document.getElementById(id); if(stray&&stray.parentNode) stray.parentNode.removeChild(stray);
        var d=document.createElement('details'); d.className='mermaid-fallback';
        var sm=document.createElement('summary'); sm.textContent='Diagram (source, could not render)'; d.appendChild(sm);
        var pre=document.createElement('pre'); pre.textContent=code; d.appendChild(pre);
        el.replaceWith(d);
      });
    });
  });
  return p;
}
window.addEventListener('load',wikiDiagrams);` : '';
  const boot = `<script>
(function(){
  // The parent passes its effective theme; the tokens stylesheet keys on it.
  var t=new URLSearchParams(location.search).get('theme');
  if(t==='light'||t==='dark') document.documentElement.dataset.theme=t;
})();${mermaidBoot}
window.addEventListener('load',function(){
  if(typeof vegaEmbed==='function'){
    document.querySelectorAll('.vega-lite').forEach(function(el){
      try{vegaEmbed(el,JSON.parse(el.getAttribute('data-spec')||'{}'),{actions:false,theme:'dark'});}
      catch(e){el.textContent='(chart failed to render)';}
    });
  }
});
// In-article links ([[wikilinks]] + Related) relay to the parent frame, which
// switches the article (the iframe is sandboxed and cannot self-navigate).
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('.wikilink,.related-link'):null;
  if(!a) return;
  e.preventDefault();
  var msg=a.classList.contains('related-link')
    ?{type:'wiki-nav',slug:a.getAttribute('data-wiki-slug')}
    :{type:'wiki-nav',title:a.getAttribute('data-wiki')};
  try{parent.postMessage(msg,'*');}catch(_){}
});
</script>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${esc(tokensHref)}">
<link rel="stylesheet" href="${esc(cssHref)}">
</head><body>
<article class="wiki-doc" data-kind="${esc(s.kind ?? 'code')}">
<header class="wd-head">${eyebrow ? `<p class="wd-eyebrow">${eyebrow}</p>` : ''}<h1>${title}</h1>${s.summary ? `<p class="wd-summary">${mdToHtml(s.summary).replace(/^<p>|<\/p>$/g, '')}</p>` : ''}${glanceHtml(s, builtAtCommit)}</header>
<div class="wd-body">
${body}
</div><!-- /wd-body -->
${relatedNav(s)}
</article>
${hasMermaid ? `<script src="${esc(mermaidSrc)}"></script>\n` : ''}${vegaScripts}${boot}
</body></html>`;
}

// Plain-text search haystack for a section: title + summary + file paths + a
// prose snippet (uses the FINAL prose, so written content is searchable).
function searchTextFor(s) {
  const stripped = String(s.proseMd ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>_\-|]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const parts = [
    s.title ?? '', s.summary ?? '', s.subgroup ?? '',
    ...(Array.isArray(s.tags) ? s.tags : []),
    ...(Array.isArray(s.files) ? s.files.map(f => f.path) : []),
    stripped.slice(0, 1000),
  ];
  return parts.join(' ');
}

/** Build the manifest object listing all sections (+ connectivity + search). */
export function renderManifest(sections, { builtAtCommit = null, graphFingerprint = null, generatedAt = null, voiceHash = null } = {}) {
  const list = Array.isArray(sections) ? sections : [];
  return {
    builtAtCommit,
    graphFingerprint,
    generatedAt,
    voiceHash,
    tierLlm: list.some(s => s && s.llm),
    sections: list.map(s => ({
      slug: s.slug,
      title: s.title,
      group: s.group ?? null,
      subgroup: s.subgroup ?? null,
      order: typeof s.order === 'number' ? s.order : 0,
      kind: s.kind ?? null,
      audience: s.audience ?? null,
      // The nav shows this as plain text, so the Markdown markers go.
      summary: String(s.summary ?? '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'),
      required: Array.isArray(s.required) ? s.required : [],
      factKinds: Array.isArray(s.factKinds) ? s.factKinds : [],
      deterministic: !!s.deterministic,
      community: s.community,
      llm: !!s.llm,
      fileCount: Array.isArray(s.files) ? s.files.length : 0,
      // contentHash = the narrative-cache key (also a staleness aid in the UI).
      // created/updated come from git history of the section's files (see
      // wiki-git-dates.js) and drive the freshness display. Null when unknown.
      contentHash: s.contentHash ?? null,
      createdTs: typeof s.createdTs === 'number' ? s.createdTs : null,
      updatedTs: typeof s.updatedTs === 'number' ? s.updatedTs : null,
      related: Array.isArray(s.related) ? s.related : [],
      backlinks: Array.isArray(s.backlinks) ? s.backlinks : [],
      tags: Array.isArray(s.tags) ? s.tags : [],
      searchText: searchTextFor(s),
    })),
  };
}
