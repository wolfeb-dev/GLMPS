// server/lib/observability/wiki-build.js
// Deterministic "Tier-1" wiki section builder: turns a graphify graph.json
// object into per-SUBSYSTEM wiki sections with no LLM involved.
//
// Sections are grouped by the first MEANINGFUL directory segment of each node's
// source_file (e.g. server/lib/observability/x.js and web/observability/y.js both
// -> "observability"), NOT by raw graphify community id. graphify graphs can be
// file-level or symbol-level; symbol-level communities degenerate into single-file
// clusters (hundreds of symbols in one big file), which make terrible wiki
// sections. Directory grouping is stable across that granularity and yields real
// subsystems. Pure function: same input -> same slugs, mermaid, and hashes.
import crypto from 'node:crypto';

// Generic path segments that carry no subsystem meaning - skip them so a repo
// that is mostly server/... or web/... still groups by the first MEANINGFUL segment
// (observability, governance, ...) rather than collapsing to Server/Web.
const GENERIC_SEG = new Set([
  'server', 'web', 'lib', 'src', 'app', 'test', 'tests',
  'dist', 'build', 'node_modules', '',
]);

// The subsystem key for a DIRECTORY, given its path segments: the first
// non-generic segment, else the top directory, else '(root)'. Exported because
// wiki-file-tree.js resolves a dir to its subsystem page through this exact
// logic - a parallel lookup table would drift the moment a section is renamed.
export function groupKeyForDirs(dirs) {
  const segs = Array.isArray(dirs) ? dirs : [];
  for (const seg of segs) {
    if (!GENERIC_SEG.has(String(seg).toLowerCase())) return String(seg).toLowerCase();
  }
  if (segs.length) return String(segs[0]).toLowerCase();
  return '(root)';
}

// The subsystem key for a file: delegates to groupKeyForDirs on its directory
// segments.
function groupKey(sourceFile) {
  return groupKeyForDirs(String(sourceFile ?? '').split('/').slice(0, -1));
}

// Display-title overrides for auto-generated code-subsystem pages whose raw
// directory name no longer matches its user-facing pillar label. The page's
// slug still derives from the raw key (see buildOneSection), so the URL and
// all cross-links stay stable - only the shown title changes. `evaluation` is
// the on-disk dir for the pillar the UI now labels "Evolution" (the dir can't
// be renamed: global ~/.claude hooks reference server/lib/evaluation/* by path).
const SUBSYSTEM_LABELS = {
  evaluation: 'Evolution (internals)',
  // web/overview/ is the Stage Board view (stage-board.js, stage-board-calc.js,
  // workspace-view.js - dashboard.js moved out to web/shared/roster.js and the
  // rest of it was deleted, D24, Task 14). Naming it "Overview" collided with
  // the CURATED Overview topic and silently overwrote it (glmps-110) - the
  // code page won because it is written last. Named for what it is; the
  // curated guide keeps the `overview` slug.
  overview: 'Stage Board',
};

// Explicit slug overrides. SUBSYSTEM_LABELS alone is not enough: a label override
// deliberately keeps the slug on the RAW KEY for URL stability, so relabelling
// `overview` would still have produced slug `overview` and still collided.
const SUBSYSTEM_SLUGS = { overview: 'stage-board' };
const NO_PAGE_KEYS = new Set(['(root)', 'docs']);
// Tests and fixtures are listed on the Code map, not grouped into a subsystem:
// server/test alone would otherwise be a 631-file page called Server.
const isTestFile = (f) => /(^|\/)(test|tests|__tests__|fixtures)\//.test(f) || /\.test\.[cm]?[jt]s$/.test(f);
// A subsystem needs this many files for a page of its own.
const MIN_PAGE_FILES = 5;

export function buildSections(graph, { maxSections = Infinity, minFiles = MIN_PAGE_FILES, reservedSlugs = [], readFile } = {}) {
  // glmps-20: reads a section's own file BODIES to fold into
  // contentHash (see sourceDigest below). Injected, default no-op, so this
  // function stays pure/offline for unit tests -- same pattern as
  // sectionGitDates' injected `runGitLog`. The real CLI passes a disk reader.
  const readSource = typeof readFile === 'function' ? readFile : () => '';
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph?.links) ? graph.links : [];
  const builtAtCommit = graph?.built_at_commit ?? null;

  const degree = new Map();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  // Group nodes by subsystem key (skip nodes with no source_file - they cannot
  // be placed or cited).
  const groups = new Map();
  for (const n of nodes) {
    if (!n.source_file || isTestFile(n.source_file)) continue;
    const key = groupKey(n.source_file);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  // File count per group (sections are about files, so rank by file breadth).
  const fileCount = (arr) => new Set(arr.map(n => n.source_file)).size;

  const keys = [...groups.keys()].sort((a, b) => {
    const fa = fileCount(groups.get(a)), fb = fileCount(groups.get(b));
    if (fb !== fa) return fb - fa;
    return String(a).localeCompare(String(b));
  });

  // Only real subsystems get a page. Files at the repo root and the docs tree
  // are not a subsystem, and the long tail past maxSections is not folded into
  // an "Other" bucket: all of them are listed on the Code map page instead.
  const keptKeys = keys.filter(k => !NO_PAGE_KEYS.has(k) && fileCount(groups.get(k)) >= minFiles).slice(0, maxSections);
  const sectionGroups = keptKeys.map(k => ({ key: k, nodes: groups.get(k), keys: [k] }));

  const nodeSectionKey = new Map();
  for (const [k, ns] of groups) for (const n of ns) nodeSectionKey.set(n.id, k);

  const titleByKey = new Map();
  for (const k of keys) titleByKey.set(k, SUBSYSTEM_LABELS[k] ?? titleCase(k));

  // Seeded with slugs owned by OTHER section producers (the curated topics, the
  // file tree). buildSections cannot see them, so without this it silently mints a
  // duplicate and the CLI's last write wins - destroying a page (glmps-110).
  const usedSlugs = new Set(reservedSlugs);
  const sections = sectionGroups.map(g =>
    buildOneSection(g, { degree, links, nodeSectionKey, titleByKey, usedSlugs, readFile: readSource })
  );

  // Resolve cross-links (related) and reverse-links (backlinks) to {slug,title}.
  const metaByKey = new Map(sections.map(s => [s.community, { slug: s.slug, title: s.title }]));
  const referencedBy = new Map(); // section key -> Set of keys that link to it
  for (const s of sections) {
    for (const k of s.relatedKeys) {
      if (!referencedBy.has(k)) referencedBy.set(k, new Set());
      referencedBy.get(k).add(s.community);
    }
  }
  for (const s of sections) {
    s.related = s.relatedKeys.map(k => metaByKey.get(k)).filter(Boolean);
    s.backlinks = [...(referencedBy.get(s.community) ?? [])]
      .map(k => metaByKey.get(k)).filter(Boolean)
      .sort((a, b) => a.title.localeCompare(b.title));
    delete s.relatedKeys;
  }

  return { sections, builtAtCommit };
}

function buildOneSection(group, ctx) {
  const { degree, links, nodeSectionKey, titleByKey, usedSlugs, readFile } = ctx;
  const sectionNodes = group.nodes;
  const title = titleByKey.get(group.key);

  const godNodeObjs = topByDegree(sectionNodes, degree, 5);
  const godNodes = godNodeObjs.map(n => String(n.label ?? n.id));

  const fileMap = new Map();
  for (const n of sectionNodes) {
    if (!n.source_file) continue;
    const deg = degree.get(n.id) ?? 0;
    const existing = fileMap.get(n.source_file);
    if (!existing || deg > existing.degree) {
      fileMap.set(n.source_file, { path: n.source_file, location: n.source_location ?? null, degree: deg });
    }
  }
  const files = [...fileMap.values()]
    .sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path));

  // Mermaid: the section's top files as nodes, plus edges to other sections.
  // The diagram: this subsystem as a labelled box holding its top files, an
  // arrow to each subsystem it depends on and from each one that depends on
  // it. Every node carries a quoted, readable label; ids never show.
  const topFiles = files.slice(0, 6);
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const thisNode = `S_${sanitizeId(group.key)}`;
  const lines = ['graph LR', `  subgraph ${thisNode}[${q(title)}]`];
  const fileId = (p) => 'F_' + sanitizeId(p);
  for (const f of topFiles) {
    lines.push(`    ${fileId(f.path)}[${q(basename(f.path))}]`);
  }
  lines.push('  end');
  // Directional cross-links from graphify's source->target edges: outKeys are
  // subsystems THIS one depends on (related); the reverse (incoming) becomes
  // backlinks in the global pass. allCross (union) drives the diagram edges.
  const outKeys = new Map();
  const allCross = new Map();
  // Mermaid edge labels must stay STABLE and parser-safe: a display-title
  // override (SUBSYSTEM_LABELS, e.g. "Evolution (internals)") must NOT leak into
  // the arch diagram, because (a) special chars like "()" break Mermaid parsing
  // and (b) changing a label churns every neighbor's contentHash, busting the
  // narrative cache. Diagrams use the plain titleCase key; the override title is
  // used only for the page header + the related-nav (outKeys).
  const edgeLabel = (k) => (SUBSYSTEM_LABELS[k] ? titleCase(k) : titleByKey.get(k));
  for (const link of links) {
    const sk = nodeSectionKey.get(link.source);
    const tk = nodeSectionKey.get(link.target);
    if (sk === undefined || tk === undefined) continue;
    if (sk === group.key && tk !== group.key) { outKeys.set(tk, titleByKey.get(tk)); allCross.set(tk, edgeLabel(tk)); }
    else if (tk === group.key && sk !== group.key) { allCross.set(sk, edgeLabel(sk)); }
  }
  // Root files and docs are not subsystems; an arrow to them is noise.
  for (const k of [...allCross.keys()].filter(k => !NO_PAGE_KEYS.has(k)).sort((a, b) => String(a).localeCompare(String(b)))) {
    const other = `S_${sanitizeId(k)}[${q(allCross.get(k))}]`;
    lines.push(outKeys.has(k) ? `  ${thisNode} --> ${other}` : `  ${other} --> ${thisNode}`);
  }
  const mermaid = lines.join('\n') + '\n';

  const relatedKeys = [...outKeys.keys()].sort((a, b) => String(a).localeCompare(String(b)));
  const tags = topExtensions(files);

  const bulletLines = files.slice(0, 5).map(f => `- \`${f.path}\``);
  const proseMd = `The **${title}** area spans ${files.length} files.\n\nKey entry points:\n${bulletLines.join('\n')}`;

  // glmps-20: fold a digest of the section's own file BODIES into
  // contentHash, not just the structural {files, godNodes, mermaid} triple --
  // the same class of fix as mc-17 (wiki-topics.js: hash the gathered source
  // TEXT, not just paths). Without this, a pure in-body edit that moves none
  // of the file list / god-node degree ranking / mermaid diagram never busts
  // the cache and the LLM narrative silently goes stale. Not stored on the
  // returned section (would otherwise bloat the on-disk LLM cache with full
  // file bodies) -- it only feeds the hash.
  const contentHash = crypto.createHash('sha1')
    .update(JSON.stringify({ files, godNodes, mermaid, s: sourceDigest(files, readFile) }))
    .digest('hex');

  // Slug from the raw key when the title is an override (SUBSYSTEM_LABELS), so a
  // relabel never changes the page's URL/slug; otherwise from the title as before.
  // code- keeps subsystem pages out of the concept pages' namespace
  // (governance, kernel, memory exist in both).
  const base = 'code-' + (SUBSYSTEM_SLUGS[group.key]
    ?? (kebab(SUBSYSTEM_LABELS[group.key] ? group.key : title) || 'section'));
  let slug = base, i = 2;
  while (usedSlugs.has(slug)) { slug = `${base}-${i}`; i++; }
  usedSlugs.add(slug);

  return {
    slug, title, community: group.key, keys: group.keys, godNodes, files, proseMd, mermaid, contentHash, relatedKeys, tags,
    group: 'code', groupTitle: 'Code reference', subgroup: null, kind: 'code',
  };
}

// Digest of a section's own file BODIES: first 6 files (same slice the CLI
// feeds the LLM prompt via sourceContext()), first 40 lines each, budgeted --
// mirrors gatherTopic()'s shape in wiki-topics.js. Read failures degrade to ''
// per-file (a file that no longer exists, or the default no-op reader) rather
// than throwing, so a bad read never breaks the whole build.
function sourceDigest(files, readFile) {
  const parts = [];
  let budget = 12000;
  for (const f of files.slice(0, 6)) {
    if (budget < 500) break;
    let txt = '';
    try { txt = readFile(f.path) ?? ''; } catch { txt = ''; }
    const body = String(txt).split(/\r?\n/).slice(0, 40).join('\n');
    const chunk = `// ${f.path}\n${body}\n`;
    if (chunk.length > budget) continue;
    parts.push(chunk); budget -= chunk.length;
  }
  return parts.join('\n');
}

function topExtensions(files) {
  const counts = new Map();
  for (const f of files) {
    const b = basename(f.path); const i = b.lastIndexOf('.');
    const ext = i > 0 ? b.slice(i + 1).toLowerCase() : '';
    if (ext && ext.length <= 5) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3).map(([e]) => e);
}

function topByDegree(nodes, degree, n) {
  return [...nodes]
    .sort((a, b) => {
      const da = degree.get(a.id) ?? 0, db = degree.get(b.id) ?? 0;
      if (db !== da) return db - da;
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, n);
}

function basename(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || String(p);
}

function titleCase(s) {
  if (s === '(root)') return 'Root';
  return String(s)
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ') || 'Untitled';
}

function kebab(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function sanitizeId(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_');
}
