// server/lib/observability/wiki-voice.js
// The wiki's voice (docs/wiki: style.md, templates.json, glossary.json) and the
// style lint that holds every page to it. The maker lints each generated page
// and asks the model for a repair; the checker (wiki-verify.js) runs the same
// lint over the finished HTML, so a page cannot pass one and fail the other.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicScanHits, publicScanPatterns, HISTORY_PATTERNS } from '../governance/private-text-scan.js';

// The voice is global: every project's wiki is written in the runtime's voice,
// so it is read from this checkout, not from the repo being documented.
export const VOICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'wiki');

export const BANNED_WORDS = Object.freeze([
  'powerful', 'seamless', 'seamlessly', 'simply', 'just', 'robust', 'leverage', 'leverages', 'leveraging',
  'delve', 'unlock', 'unlocks', 'empower', 'empowers', 'crucial', 'pivotal', 'showcase', 'showcases',
  'effortless', 'effortlessly', 'cutting-edge', 'might possibly',
]);
export const MAX_AVG_SENTENCE_WORDS = 22;
const GUIDE_KINDS = new Set(['guide', 'admin']);
// Bump when a lint rule is added or changed: it folds into the voice hash, so
// every page rebuilds once under the new rule.
const LINT_RULES_VERSION = 'lint-rules:2:private-text';
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014, 0x2015) + ']');

export function loadVoice(dir = VOICE_DIR) {
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const style = read('style.md');
  const templatesRaw = read('templates.json');
  const glossaryRaw = read('glossary.json');
  // Folded into every page's content hash: editing the voice rewrites every
  // page on the next build instead of leaving old and new tones mixed.
  const hash = crypto.createHash('sha1').update(style).update(templatesRaw).update(glossaryRaw).update(LINT_RULES_VERSION).digest('hex');
  return { style, templates: JSON.parse(templatesRaw), glossary: JSON.parse(glossaryRaw), hash };
}

// The part of the voice the checker needs, written into each build so the
// checker reads only the build directory.
export function lintRules(voice, { privateNames = [] } = {}) {
  return {
    privateNames: privateNames.filter((n) => typeof n === 'string' && n.length >= 3),
    bannedWords: [...BANNED_WORDS],
    maxAvgSentenceWords: MAX_AVG_SENTENCE_WORDS,
    properNouns: voice.glossary.properNouns ?? [],
    terms: (voice.glossary.terms ?? []).map(t => ({ term: t.term, avoid: t.avoid ?? [], allow: t.allow ?? [] })),
  };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(^|[^A-Za-z0-9-])${escRe(w)}(?=$|[^A-Za-z0-9-])`, 'i');
const stripInlineCode = (s) => String(s).replace(/`[^`]*`/g, ' ');

// Markdown to the parts the lint reads: headings, paragraph text (sentence
// length) and all prose (words). Fenced blocks, inline code and table rows
// are not prose.
export function partsFromMarkdown(md) {
  const headings = []; const paragraphs = []; const prose = [];
  let inFence = false; let para = [];
  const flush = () => { if (para.length) { paragraphs.push(para.join(' ')); para = []; } };
  for (const raw of String(md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; flush(); continue; }
    if (inFence) continue;
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); headings.push({ level: h[1].length, text: stripInlineCode(h[2]).replace(/[*_]/g, '').trim() }); continue; }
    if (line.startsWith('|')) { flush(); continue; }
    const isItem = /^([-*+]|\d+\.)\s+/.test(line) || line.startsWith('>');
    const text = stripInlineCode(line.replace(/^>\s*/, '').replace(/^([-*+]|\d+\.)\s+/, ''));
    prose.push(text);
    if (isItem) { flush(); continue; }
    para.push(text);
  }
  flush();
  return { headings, paragraphs, prose: prose.join('\n'), all: String(md ?? '') };
}

const decode = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = (html) => decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// The same parts from a rendered page. Only the generated body is linted: the
// reference tables, file lists and the at-a-glance strip are data, not prose.
export function partsFromHtml(html) {
  const m = String(html).match(/<div class="wd-body">([\s\S]*?)<\/div><!-- \/wd-body -->/);
  const body = (m ? m[1] : '')
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<section class="wd-reference">[\s\S]*?<\/section>/g, ' ')
    .replace(/<details[\s\S]*?<\/details>/g, ' ')
    .replace(/<table[\s\S]*?<\/table>/g, ' ').replace(/<figure[\s\S]*?<\/figure>/g, ' ');
  const headings = [...body.matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/g)].map(x => ({ level: Number(x[1]), text: textOf(x[2]) }));
  // Callout bodies are paragraphs too, but the lint treats them like list
  // items (no sentence-length weight), matching partsFromMarkdown.
  const plain = body.replace(/<aside[\s\S]*?<\/aside>/g, ' ');
  const paragraphs = [...plain.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(x => textOf(x[1]));
  const prose = [...body.matchAll(/<(p|li|h[1-6])(?: [^>]*)?>([\s\S]*?)<\/\1>/g)].map(x => textOf(x[2])).join('\n');
  return { headings, paragraphs, prose, all: textOf(m ? m[1] : '') };
}

function sentences(paragraphs) {
  return paragraphs.flatMap(p => p.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/)).map(s => s.trim()).filter(s => /[A-Za-z]/.test(s));
}

// A heading is Title Case when two or more of its later words start with a
// capital and are neither acronyms nor known proper nouns. One stray capital
// is let through: it is more often a product name than a style slip.
function titleCased(text, properNouns) {
  const proper = new Set(properNouns.flatMap(p => p.split(/\s+/)));
  const words = text.split(/\s+/).slice(1).map(w => w.replace(/^[^A-Za-z]+|[^A-Za-z0-9]+$/g, '')).filter(Boolean);
  return words.filter(w => /^[A-Z][a-z]/.test(w) && !proper.has(w)).length >= 2;
}

/**
 * Lint one page. `kind` picks the rules (sentence length applies to guide and
 * admin pages); `required` is the template's H2 list. Returns violations as
 * [rule, detail] pairs, empty when the page passes.
 */
export function lintPage(parts, { kind, required = [], rules }) {
  const out = [];
  const h2 = parts.headings.filter(h => h.level === 2).map(h => h.text.toLowerCase());
  for (const r of required) if (!h2.includes(r.toLowerCase())) out.push(['headings', `missing "## ${r}"`]);
  for (const h of parts.headings) {
    if (h.level >= 2 && titleCased(h.text, rules.properNouns)) out.push(['heading-case', `"${h.text}" is not sentence case`]);
  }
  // Private text is scanned over the whole page (code, tables and reference
  // blocks included): a path in a code fence leaks as surely as one in prose.
  const everything = parts.all ?? parts.prose;
  const privateHits = [
    ...publicScanHits(everything, publicScanPatterns(rules.privateNames ?? [])),
    ...publicScanHits(everything, HISTORY_PATTERNS.filter((p) => p.name === 'ticket id')),
  ];
  for (const h of privateHits) out.push(['private-text', `${h.pattern}: ${JSON.stringify(h.match)}`]);
  const text = parts.prose;
  if (DASHES.test(text) || parts.headings.some(h => DASHES.test(h.text))) out.push(['em-dash', 'an em or en dash in the prose']);
  for (const w of rules.bannedWords) if (wordRe(w).test(text)) out.push(['banned-word', `"${w}"`]);
  for (const t of rules.terms) {
    let scrubbed = text;
    for (const a of t.allow) scrubbed = scrubbed.replace(new RegExp(escRe(a), 'gi'), ' ');
    for (const a of t.avoid) if (wordRe(a).test(scrubbed)) out.push(['glossary', `"${a}" where the glossary term is "${t.term}"`]);
  }
  if (GUIDE_KINDS.has(kind)) {
    const ss = sentences(parts.paragraphs);
    if (ss.length >= 5) {
      const avg = ss.reduce((n, s) => n + s.split(/\s+/).length, 0) / ss.length;
      if (avg > rules.maxAvgSentenceWords) out.push(['sentence-length', `average ${avg.toFixed(1)} words per sentence (max ${rules.maxAvgSentenceWords})`]);
    }
  }
  return out;
}
