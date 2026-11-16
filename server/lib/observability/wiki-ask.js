// server/lib/observability/wiki-ask.js - DeepWiki-style "ask the wiki" (glmps-44).
// Pure lexical retrieval over the generated wiki sections (NO embeddings, zero
// deps), a grounding prompt that forces excerpt-only answers with inline [slug]
// citations, and citation parsing. The LLM call and the section-HTML reader are
// both injected, so everything here is testable offline and never touches the
// network by itself.

const STOPWORDS = new Set([
  'the', 'and', 'are', 'was', 'were', 'been', 'being', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'how', 'what', 'when', 'where', 'which',
  'who', 'whom', 'why', 'can', 'could', 'should', 'would', 'will', 'shall',
  'may', 'might', 'must', 'but', 'not', 'nor', 'for', 'from', 'with',
  'without', 'into', 'onto', 'over', 'under', 'about', 'this', 'that',
  'these', 'those', 'its', 'they', 'them', 'their', 'there', 'here', 'you',
  'your', 'yours', 'our', 'ours', 'any', 'all', 'each', 'both', 'more',
  'most', 'other', 'some', 'such', 'than', 'then', 'too', 'very', 'just',
  'also', 'out', 'off', 'own', 'same', 'per', 'via', 'get', 'gets', 'use',
  'used', 'uses', 'using', 'work', 'works', 'working',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords + tokens < 3 chars. */
function tokenize(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// Scan 2026-10-15 F3: the manifest text and section HTML are repo-supplied,
// so the input is capped and tags are removed in one indexOf pass. The old
// '<[^>]*>' regex rescanned to the end from every '<' with no '>' after it,
// which is quadratic on a long run of '<' and blocks the event loop.
export const STRIP_HTML_MAX_CHARS = 512 * 1024;

function stripTags(s) {
  const lower = s.toLowerCase();
  const closeAt = { script: 0, style: 0 };   // -1 once known absent from that point on
  let noGt = false;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0 || noGt) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    let skipped = false;
    for (const name of ['script', 'style']) {
      if (!lower.startsWith(name, lt + 1) || /[A-Za-z0-9_]/.test(s[lt + 1 + name.length] ?? '')) continue;
      if (closeAt[name] === -1) break;
      const close = lower.indexOf(`</${name}>`, lt);
      if (close < 0) { closeAt[name] = -1; break; }
      out += ' ';
      i = close + name.length + 3;
      skipped = true;
      break;
    }
    if (skipped) continue;
    const gt = s.indexOf('>', lt);
    if (gt < 0) { noGt = true; out += s.slice(lt); break; }
    out += ' ';
    i = gt + 1;
  }
  return out;
}

/** Strip HTML to visible text: drop script/style bodies + tags, decode common entities, collapse whitespace. */
export function stripHtml(html) {
  return stripTags(String(html ?? '').slice(0, STRIP_HTML_MAX_CHARS))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countHits(fieldTokens, token) {
  let n = 0;
  for (const t of fieldTokens) if (t === token) n++;
  return n;
}

/**
 * Pure lexical retrieval: score each section by weighted question-term hits
 * over its title (x3), slug (x2), and body text (x1, HTML stripped). Sections
 * scoring zero are dropped; ties break by slug ascending (deterministic).
 * @param {string} question
 * @param {Array<{slug:string,title?:string,body?:string}>} sections
 * @param {{k?:number}} [opts]
 * @returns {Array<{slug:string,title:string,score:number}>} top-k by score desc
 */
export function retrieveSections(question, sections, { k = 4 } = {}) {
  const qTokens = [...new Set(tokenize(question))];
  if (!qTokens.length) return [];
  const scored = [];
  for (const s of Array.isArray(sections) ? sections : []) {
    const titleTokens = tokenize(s.title);
    const slugTokens = tokenize(s.slug);
    const bodyTokens = tokenize(stripHtml(s.body));
    let score = 0;
    for (const t of qTokens) {
      score += 3 * countHits(titleTokens, t)
        + 2 * countHits(slugTokens, t)
        + countHits(bodyTokens, t);
    }
    if (score > 0) scored.push({ slug: s.slug, title: s.title ?? s.slug, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return scored.slice(0, k);
}

const EXCERPT_CAP = 4000;   // ~4k chars per section excerpt
const TOTAL_CAP = 16000;    // ~16k chars across all excerpts

/**
 * Grounding prompt: answer ONLY from the excerpts, cite sections inline as
 * [slug] after each claim, and fall back to "the wiki does not cover this".
 * @param {string} question
 * @param {Array<{slug:string,title?:string,text:string}>} excerpts
 * @returns {string}
 */
export function buildAskPrompt(question, excerpts) {
  const blocks = [];
  let budget = TOTAL_CAP;
  for (const ex of excerpts) {
    if (budget <= 0) break;
    const text = String(ex.text ?? '').slice(0, Math.min(EXCERPT_CAP, budget));
    if (!text) continue;
    budget -= text.length;
    blocks.push(`=== Section [${ex.slug}] ${ex.title ?? ''}\n${text}`);
  }
  return [
    'You are answering a question about a codebase using its generated wiki.',
    '',
    'Rules:',
    '- Answer ONLY from the wiki section excerpts provided below. Do not use any',
    '  outside knowledge and do not invent files, APIs, or behavior.',
    '- After each claim, cite the section it came from inline as [slug], using the',
    '  slug shown in that excerpt\'s header (e.g. [server]).',
    '- If the excerpts do not contain the answer, reply exactly:',
    '  the wiki does not cover this',
    '- Reply in plain text (no Markdown headings, no code fences).',
    '',
    `Question: ${question}`,
    '',
    'Wiki section excerpts:',
    ...blocks,
  ].join('\n');
}

/**
 * Extract [slug] citations matching known slugs (deduped, in order of first
 * appearance). The answer text is returned unchanged, markers intact.
 * @param {string} answerText
 * @param {string[]} knownSlugs
 * @returns {{answer:string, citations:string[]}}
 */
export function parseCitations(answerText, knownSlugs) {
  const known = new Set(Array.isArray(knownSlugs) ? knownSlugs : []);
  const citations = [];
  const seen = new Set();
  const re = /\[([A-Za-z0-9._-]+)\]/g;
  const text = String(answerText ?? '');
  for (let m; (m = re.exec(text));) {
    const slug = m[1];
    if (known.has(slug) && !seen.has(slug)) { seen.add(slug); citations.push(slug); }
  }
  return { answer: text, citations };
}

const NOT_COVERED = 'The wiki does not cover this.';

/**
 * Orchestrate one question: retrieve top sections, read their HTML via the
 * injected reader, strip to text, prompt the injected model, parse citations.
 * Never calls the model when there is nothing to ground on.
 * @param {{
 *   question: string,
 *   sections: Array<{slug:string,title?:string,body?:string}>,
 *   readSectionHtml: (slug:string) => Promise<string|null>,
 *   callModel: (prompt:string) => Promise<string>,
 *   k?: number,
 * }} opts
 * @returns {Promise<{answer:string, citations:string[], retrieved:string[]}>}
 */
export async function askWiki({ question, sections, readSectionHtml, callModel, k = 4 }) {
  const retrieved = retrieveSections(question, sections, { k });
  if (!retrieved.length) return { answer: NOT_COVERED, citations: [], retrieved: [] };

  const excerpts = [];
  for (const r of retrieved) {
    let html = null;
    try { html = await readSectionHtml(r.slug); } catch { /* unreadable -> skip */ }
    const text = html ? stripHtml(html) : '';
    if (text) excerpts.push({ slug: r.slug, title: r.title, text });
  }
  if (!excerpts.length) return { answer: NOT_COVERED, citations: [], retrieved: retrieved.map(r => r.slug) };

  const answerText = await callModel(buildAskPrompt(question, excerpts));
  const { answer, citations } = parseCitations(answerText, excerpts.map(e => e.slug));
  return { answer, citations, retrieved: retrieved.map(r => r.slug) };
}
