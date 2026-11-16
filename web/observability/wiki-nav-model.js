// web/observability/wiki-nav-model.js
// Pure view model for the wiki sidebar and empty state. No DOM.
import { relTime } from './wiki-loop-model.js';

export const WIKI_GROUPS = [
  { key: 'documentation', label: 'Documentation' },
  { key: 'concepts', label: 'Concepts' },
  { key: 'code', label: 'Code reference' },
];

const byOrderThenTitle = (a, b) =>
  (Number.isFinite(a.order) ? a.order : 1e9) - (Number.isFinite(b.order) ? b.order : 1e9)
  || String(a.title || a.slug).localeCompare(String(b.title || b.slug));

/** Sidebar structure: headed groups in a fixed order (Documentation split by subgroup),
 *  or null when the build predates groups so the caller keeps the flat list. */
export function groupSections(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const known = new Set(WIKI_GROUPS.map((g) => g.key));
  if (!list.some((s) => known.has(s.group))) return null;
  const groups = WIKI_GROUPS.map((g) => ({ key: g.key, label: g.label, parts: [] }));
  const other = { key: 'other', label: 'Other', parts: [] };
  for (const s of [...list].sort(byOrderThenTitle)) {
    const g = groups.find((x) => x.key === s.group) || other;
    const sub = g.key === 'documentation' && s.subgroup ? String(s.subgroup) : null;
    let part = g.parts.find((x) => x.label === sub);
    if (!part) { part = { label: sub, items: [] }; g.parts.push(part); }
    part.items.push(s);
  }
  return [...groups, other].filter((g) => g.parts.length);
}

/** The page a fresh load opens on: first Documentation page, else the first section. */
export function firstWikiSlug(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const docs = list.filter((s) => s.group === 'documentation').sort(byOrderThenTitle);
  return (docs[0] || list[0] || {}).slug ?? null;
}

/** A project picked for the operator (not chosen by them) that has no build is a dead end;
 *  fall back once to the server default. An explicit choice shows its own empty state. */
export function shouldFallBackToDefault({ chosen, requested, data }) {
  return !chosen && !!requested && !!data && !data.manifest;
}

function relUntil(ts, now) {
  const s = Math.floor((ts - now) / 1000);
  if (!(s > 60)) return 'due now';
  const m = Math.floor(s / 60); if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

/** Why a project shows no wiki and what happens next, from GET /api/wiki. */
export function emptyStateCopy(data, now = Date.now()) {
  const loop = data && data.loop;
  if (!loop) {
    return {
      title: 'This project has no wiki',
      lines: ['Automatic builds cover the GLMPS runtime only. Generate builds one now.'],
    };
  }
  const lines = [];
  if (typeof loop.lastOutcome === 'string' && loop.lastOutcome.startsWith('failed')) {
    lines.push(`Last build failed: ${loop.lastReason || loop.lastOutcome}`);
  }
  if (typeof loop.nextRunTs === 'number') lines.push(`Next automatic build: ${relUntil(loop.nextRunTs, now)}`);
  if (!lines.length) lines.push('No automatic build is scheduled yet.');
  return { title: 'The wiki has not been built yet', lines };
}

/** "N pages, built 2h ago at c79872a" */
export function wikiMetaLine(data, count, now = Date.now()) {
  const m = (data && data.manifest) || {};
  const ts = typeof m.generatedAt === 'number' ? m.generatedAt : Date.parse(m.generatedAt);
  const sha = typeof m.builtAtCommit === 'string' ? m.builtAtCommit.slice(0, 7) : '';
  let line = `${count} ${count === 1 ? 'page' : 'pages'}`;
  if (Number.isFinite(ts)) line += `, built ${relTime(ts, now)}`;
  if (sha) line += ` at ${sha}`;
  return line;
}

/** The theme the dashboard is showing: the Settings pin if set, else the OS preference. */
export function effectiveTheme(doc = globalThis.document, mm = globalThis.matchMedia) {
  if (!doc || !doc.documentElement) return null;
  const pinned = doc.documentElement.dataset && doc.documentElement.dataset.theme;
  if (pinned === 'light' || pinned === 'dark') return pinned;
  try { return mm && mm.call(globalThis, '(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
  catch { return 'dark'; }
}
