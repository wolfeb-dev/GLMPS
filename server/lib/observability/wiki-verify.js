// server/lib/observability/wiki-verify.js
// The wiki loop's CHECKER (program plan section 4, D-W2). Deterministic and
// separate from the maker: it only reads a finished build directory. Five rules:
//   sections  every manifest section has a page and is narrative (llm: true)
//   em-dash   no em-dash or horizontal bar in any page's article
//   links     every internal link resolves inside the build (and, given webDir,
//             every absolute asset link resolves under web/)
//   head      builtAtCommit equals the HEAD the build was asked for
//   size      at least 50% of the published build's section count
//   headings  every written page has its template's required level-2 headings
//   style     every written page passes the voice lint (wiki-voice.js), read
//             from the build's voice.json so the checker needs nothing else
//   coverage  every fact in the build's facts.json (config key, route, loop,
//             task, variable) appears on a page that declares that fact kind
//   graph     the manifest records the fingerprint of the graph it was built
//             from (graph-fingerprint.js), so freshness can see graph drift
//   private-text  no file of the build carries what the installer stage
//             refuses (shipTextPatterns), deterministic pages included, so a
//             build that publishes is one the stage accepts (card glmps-2-0-199)
// `offending` names only sections whose CONTENT was rejected (em-dash, links,
// headings, style),
// so the loop can evict exactly those from the narrative cache.
import fs from 'node:fs';
import path from 'node:path';
import { esc } from './wiki-markdown.js';
import { lintPage, partsFromHtml } from './wiki-voice.js';
import { publicScanHits, shipTextPatterns } from '../governance/private-text-scan.js';
import { FACT_KINDS } from './wiki-facts.js';
import { GRAPH_FINGERPRINT_PREFIX } from './graph-fingerprint.js';

export const WIKI_VERIFY_RULES = Object.freeze(['sections', 'em-dash', 'links', 'head', 'size', 'headings', 'style', 'coverage', 'graph', 'private-text']);

const EM_DASH = new RegExp('[' + String.fromCharCode(0x2014) + String.fromCharCode(0x2015) + ']');
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function articleOf(html) {
  const a = html.indexOf('<article');
  const b = html.lastIndexOf('</article>');
  return a >= 0 && b > a ? html.slice(a, b) : html;
}

function listBuildFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listBuildFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

export function verifyWikiBuild({ buildDir, headSha, previous = null, webDir = null, privateNames = [] } = {}) {
  const failures = [];
  const offending = new Map();
  const flag = (s) => { if (s && !offending.has(s.slug)) offending.set(s.slug, { slug: s.slug, contentHash: s.contentHash ?? null }); };

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8')); }
  catch (e) {
    return { ok: false, failures: [['sections', `manifest.json unreadable: ${e.message}`]], offending: [], sections: 0, llmSections: 0 };
  }
  const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
  if (!sections.length) failures.push(['sections', 'manifest lists no sections']);
  const bySlug = new Map(sections.map(s => [s.slug, s]));
  const titles = new Set(sections.map(s => String(s.title ?? '').toLowerCase()));

  const pages = new Map();
  for (const s of sections) {
    let html;
    try { html = fs.readFileSync(path.join(buildDir, `${s.slug}.html`), 'utf8'); }
    catch (e) { failures.push(['sections', `missing page ${s.slug}.html (${e.code ?? e.message})`]); continue; }
    pages.set(s.slug, html);
    if (s.llm !== true) failures.push(['sections', `structural stub: ${s.slug}`]);
  }

  for (const [slug, html] of pages) {
    if (EM_DASH.test(articleOf(html))) { failures.push(['em-dash', `${slug}.html`]); flag(bySlug.get(slug)); }
  }

  for (const s of sections) {
    for (const r of [...(s.related || []), ...(s.backlinks || [])]) {
      if (r?.slug && !bySlug.has(r.slug)) { failures.push(['links', `${s.slug}: manifest link to unknown section ${r.slug}`]); flag(s); }
    }
  }
  for (const [slug, html] of pages) {
    const s = bySlug.get(slug);
    for (const m of html.matchAll(/data-wiki-slug="([^"]*)"/g)) {
      const t = unesc(m[1]);
      if (!bySlug.has(t)) { failures.push(['links', `${slug}.html: related link to unknown section ${t}`]); flag(s); }
    }
    for (const m of html.matchAll(/class="wikilink" data-wiki="([^"]*)"/g)) {
      const t = unesc(m[1]);
      if (!titles.has(t.toLowerCase()) && !bySlug.has(t.toLowerCase())) {
        failures.push(['links', `${slug}.html: wikilink to unknown page "${t}"`]); flag(s);
      }
    }
    for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const u = unesc(m[1]);
      if (!u || u.startsWith('#') || /^(https?:|mailto:|data:)/i.test(u)) continue;
      const clean = u.split(/[?#]/)[0];
      const target = clean.startsWith('/') ? (webDir ? path.join(webDir, clean.slice(1)) : null) : path.join(buildDir, clean);
      if (target && !fs.existsSync(target)) failures.push(['links', `${slug}.html: ${u} does not resolve`]);
    }
  }

  const readJson = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(buildDir, f), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; failures.push(['sections', `${f} unreadable: ${e.message}`]); return null; }
  };
  const rules = readJson('voice.json');
  if (rules) {
    for (const [slug, html] of pages) {
      const s = bySlug.get(slug);
      if (!s || s.deterministic || !s.kind || s.kind === 'index' || s.kind === 'glossary') continue;
      for (const [rule, detail] of lintPage(partsFromHtml(html), { kind: s.kind, required: s.required ?? [], rules })) {
        if (rule === 'private-text') continue;
        failures.push([rule === 'headings' ? 'headings' : 'style', `${slug}.html: ${rule}: ${detail}`]);
        flag(s);
      }
    }
  }
  const shipPatterns = shipTextPatterns(privateNames);
  for (const rel of listBuildFiles(buildDir)) {
    const buf = fs.readFileSync(path.join(buildDir, ...rel.split('/')));
    if (buf.subarray(0, 8000).includes(0)) continue;
    const hits = publicScanHits(buf.toString('utf8'), shipPatterns);
    if (!hits.length) continue;
    failures.push(['private-text', `${rel}: ${hits.length} hit(s), first ${hits[0].pattern}: ${JSON.stringify(hits[0].match)}`]);
    // A written page is rewritten on the next build; a deterministic one would
    // come back the same, so it is reported but not evicted.
    const s = rel.endsWith('.html') ? bySlug.get(rel.slice(0, -5)) : null;
    if (s && !s.deterministic) flag(s);
  }

  const facts = readJson('facts.json');
  if (facts) {
    const label = { config: 'key', routes: 'path', loops: 'name', tasks: 'name', env: 'name' };
    for (const kind of FACT_KINDS) {
      const rows = Array.isArray(facts[kind]) ? facts[kind] : [];
      if (!rows.length) continue;
      const owners = sections.filter(s => (s.factKinds ?? []).includes(kind));
      if (!owners.length) { failures.push(['coverage', `no page declares the ${kind} facts (${rows.length})`]); continue; }
      const text = owners.map(s => pages.get(s.slug) ?? '').join('\n');
      const missing = rows.filter(r => !text.includes(esc(String(r[label[kind]]))));
      if (missing.length) {
        failures.push(['coverage', `${missing.length} ${kind} fact(s) on no page, e.g. ${missing.slice(0, 3).map(r => r[label[kind]]).join(', ')}`]);
      }
    }
  }

  if (manifest.builtAtCommit !== headSha) {
    failures.push(['head', `builtAtCommit ${manifest.builtAtCommit ?? 'null'} != HEAD ${headSha}`]);
  }
  if (typeof manifest.graphFingerprint !== 'string' || !manifest.graphFingerprint.startsWith(GRAPH_FINGERPRINT_PREFIX)) {
    failures.push(['graph', `manifest records no graph fingerprint (graphFingerprint ${JSON.stringify(manifest.graphFingerprint ?? null)})`]);
  }
  const prevCount = Number(previous?.sections) || 0;
  if (prevCount > 0 && sections.length < Math.ceil(prevCount * 0.5)) {
    failures.push(['size', `${sections.length} sections vs ${prevCount} in the published build (below 50%)`]);
  }

  return {
    ok: failures.length === 0, failures, offending: [...offending.values()],
    sections: sections.length, llmSections: sections.filter(s => s.llm === true).length,
  };
}
