// server/lib/observability/wiki-docs.js
// The documentation creator. Turns the page manifest (docs/wiki/pages.json)
// into user guide, admin guide and concept sections; adds the deterministic
// Glossary and Code map pages. Every section carries its group, kind,
// audience and required headings so the renderer, the nav and the checker all
// read the same contract. Sections leave here with no prose: wiki-llm.js
// writes it, except for the deterministic pages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { factTable } from './wiki-facts.js';
import { publicScanHits, shipTextPatterns } from '../governance/private-text-scan.js';

export const PAGES_FILE = path.join('docs', 'wiki', 'pages.json');

// Expand a glob supporting '*' at any single path level (e.g. 'a/*.md').
export function expandGlob(baseDir, pattern) {
  let dirs = [baseDir];
  for (const seg of String(pattern).split('/')) {
    const next = [];
    for (const d of dirs) {
      if (!seg.includes('*')) { next.push(path.join(d, seg)); continue; }
      let entries;
      try { entries = fs.readdirSync(d); } catch { continue; }
      const re = new RegExp('^' + seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      for (const e of entries.sort()) if (re.test(e)) next.push(path.join(d, e));
    }
    dirs = next;
  }
  return dirs.filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

// A page's sources as prompt context within a size budget. The paths become
// the page's "Sources" chips; the text goes to the model and into the hash.
export function gatherSources(sources, { repoRoot, budget = 16000 }) {
  const files = []; const parts = []; let left = budget;
  for (const src of sources ?? []) {
    const matches = src.glob.includes('*') ? expandGlob(repoRoot, src.glob) : [path.join(repoRoot, src.glob)];
    for (const abs of matches.slice(0, src.max || 20)) {
      if (left < 500) break;
      let txt;
      try { txt = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
      const chunk = `// ${rel}\n${txt.split(/\r?\n/).slice(0, src.lines || 40).join('\n')}\n`;
      if (chunk.length > left) continue;
      parts.push(chunk); left -= chunk.length; files.push({ path: rel });
    }
  }
  return { files, sourceText: parts.join('\n') };
}

export function readPagesManifest(repoRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, PAGES_FILE), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const sha1 = (v) => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/** The written (model-authored) documentation and concept sections. */
export function buildDocSections({ repoRoot, manifest, voice, facts }) {
  const groups = new Map((manifest?.groups ?? []).map(g => [g.id, g]));
  return (manifest?.pages ?? []).map((p) => {
    const tpl = voice.templates[p.kind] ?? {};
    const { files, sourceText } = gatherSources(p.sources, { repoRoot });
    const reference = (p.facts ?? []).map(k => factTable(k, facts)).filter(t => t && t.rows.length);
    return {
      slug: p.slug, title: p.title, group: p.group, groupTitle: groups.get(p.group)?.title ?? p.group,
      subgroup: p.subgroup ?? null, order: p.order ?? 0, kind: p.kind,
      audience: p.audience ?? tpl.audience ?? '', required: tpl.headings ?? [],
      angle: p.angle ?? '', files, sourceText, reference, factKinds: p.facts ?? [],
      relatedSlugs: p.related ?? [], related: [], backlinks: [], tags: [p.kind],
      community: p.group, godNodes: [], mermaid: '', proseMd: '', summary: '',
      contentHash: sha1({ v: voice.hash, p, s: sourceText, r: reference }),
    };
  });
}

/** The Glossary page: the glossary file as a table, no model involved. */
export function glossarySection(voice) {
  const terms = voice.glossary.terms ?? [];
  return {
    slug: 'glossary', title: 'Glossary', group: 'concepts', groupTitle: 'Concepts', subgroup: null, order: 99,
    kind: 'glossary', audience: 'Everyone', required: [], deterministic: true, llm: true,
    summary: 'The product terms every page uses, each defined once.',
    proseMd: 'Every page in this wiki uses these terms and only these. The right-hand column lists the words a page should not use in their place.',
    reference: [{ title: 'Terms', columns: ['Term', 'Meaning', 'Not'], rows: terms.map(t => [t.term, t.definition, (t.avoid ?? []).join(', ')]) }],
    files: [{ path: 'docs/wiki/glossary.json' }], relatedSlugs: [], related: [], backlinks: [], tags: ['glossary'],
    community: 'concepts', godNodes: [], mermaid: '', contentHash: sha1({ g: voice.glossary }),
  };
}

/**
 * The Code map page: every subsystem page with its file count, then every
 * tracked file grouped by top-level directory. Replaces the old File Tree,
 * Other and Root pages: nothing is capped and nothing is hidden in a bucket.
 */
export function codeMapSection({ codeSections, trackedFiles, privateNames = [] }) {
  // A file whose path carries private text or dev history (planning docs are
  // named for their ticket) is left out and counted: the page ships with the
  // installer, and the stage refuses any such text (card glmps-2-0-199).
  const patterns = shipTextPatterns(privateNames);
  const listed = (trackedFiles ?? []).filter(f => !publicScanHits(f, patterns).length);
  const withheld = (trackedFiles?.length ?? 0) - listed.length;
  const byTop = new Map();
  for (const f of listed) {
    const top = f.includes('/') ? f.slice(0, f.indexOf('/')) : '(repository root)';
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push(f);
  }
  const tree = [...byTop.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, files]) => ({ dir, files: files.sort() }));
  const rows = codeSections.map(s => [s.title, String(s.files.length), (s.files[0]?.path ?? '').split('/').slice(0, -1).join('/')]);
  return {
    slug: 'code-map', title: 'Code map', group: 'code', groupTitle: 'Code reference', subgroup: null, order: 0,
    kind: 'index', audience: 'Engineers and agents changing the code', required: [], deterministic: true, llm: true,
    summary: withheld
      ? `${codeSections.length} subsystems and ${listed.length} of ${trackedFiles.length} tracked files.`
      : `${codeSections.length} subsystems and all ${listed.length} tracked files.`,
    proseMd: withheld
      ? `Each subsystem below has its own page. The file index lists tracked files by top-level directory; ${withheld} whose names carry private or planning text are not listed.`
      : 'Each subsystem below has its own page. The file index lists every tracked file by top-level directory.',
    reference: [{ title: 'Subsystems', columns: ['Subsystem', 'Files', 'Main directory'], rows, links: codeSections.map(s => s.slug) }],
    tree, files: [], relatedSlugs: [], related: [], backlinks: [], tags: ['index'],
    community: 'code', godNodes: [], mermaid: '', contentHash: sha1({ rows, n: trackedFiles?.length ?? 0, withheld }),
  };
}

/** Resolve relatedSlugs to {slug,title} and fill backlinks across all sections. */
export function linkSections(sections) {
  const meta = new Map(sections.map(s => [s.slug, { slug: s.slug, title: s.title }]));
  for (const s of sections) {
    if (!Array.isArray(s.relatedSlugs)) continue;
    s.related = s.relatedSlugs.map(sl => meta.get(sl)).filter(Boolean);
  }
  for (const s of sections) {
    for (const r of s.related ?? []) {
      const t = sections.find(x => x.slug === r.slug);
      if (!t) continue;
      t.backlinks = Array.isArray(t.backlinks) ? t.backlinks : [];
      if (!t.backlinks.some(b => b.slug === s.slug)) t.backlinks.push({ slug: s.slug, title: s.title });
    }
  }
  return sections;
}
