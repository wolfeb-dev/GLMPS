// server/lib/evaluation/memory-contradiction.js
//
// Catches the one contradiction that matters for promotion: a distilled fact
// re-opening a matter a pinned curated VERDICT already closed (RushDB REJECTED,
// a strategy line ABANDONED, a result a TRUSTWORTHY NULL). Deliberately
// conservative and lexical: a false negative just lets a fact promote normally,
// a false positive routes it to human review, so it errs toward review.
//
// Subject matching is scoped to the frontmatter name/description fields, NOT
// full body prose. Full-body capitalized-token matching used to treat any
// sentence-initial word ("This", "Given", "Note", ...) as a subject, so two
// unrelated facts that merely opened sentences with the same common word were
// flagged as a false conflict. The name/description pair is the canonical
// subject a fact is about; prose is not.

import { isPinned, VERDICT_PATTERNS } from './memory-evict.js';

// Sentence-initial / generic words that must never count as a subject token,
// even when they land in a name or description field. Includes the verdict
// vocabulary itself: every pinned verdict's description carries its verdict
// word (e.g. "RushDB REJECTED", "TRUSTWORTHY NULL"), so lowercase "rejected"/
// "null"/... would otherwise become curated subject tokens and false-match any
// distilled fact that happens to use those common words. A verdict word
// describes the DECISION, not the SUBJECT, so it is never a subject token.
const STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'the', 'then', 'when', 'where', 'while',
  'given', 'note', 'after', 'before', 'since', 'because', 'however', 'here',
  'there', 'also', 'thus', 'with', 'from', 'into', 'about', 'what', 'which',
  'your', 'their', 'would', 'could', 'should', 'will', 'have', 'has', 'was',
  'were', 'are', 'and', 'but', 'for', 'not', 'api', 'cli',
  // verdict vocabulary (lowercased) - the decision, not the subject
  'rejected', 'declined', 'abandoned', 'superseded', 'retired', 'discard',
  'discarded', 'cancelled', 'null',
  // meta words for the ACT of evaluating a document, not its subject. This
  // corpus names eval-verdict facts by convention ("rushdb-vs-graphify-eval",
  // "bmad-method-eval", "maf-orchestration-eval", ... - 6+ real pinned facts),
  // so the hyphen-split token "eval" is shared across all of them; without
  // this exclusion any future fact mentioning "eval"/"evaluation" would
  // systematically false-conflict with every one of them.
  'eval', 'evals', 'evaluation', 'evaluations', 'evaluate', 'evaluated',
]);

// KNOWN RESIDUAL (accepted by design): subject matching is single-token, so a
// single generic noun shared with one or a few pinned facts' name/description
// (e.g. both mention "cache") can still false-conflict. Unlike the "eval"
// convention above this is occasional rather than systematic, and a false
// positive only routes a fact to human review (it stays searchable in L3, is
// never lost), which is the conservative direction this guard is built for.

function hasVerdictVocab(text) {
  const s = String(text ?? '');
  return VERDICT_PATTERNS.some((re) => re.test(s));
}

// Subject tokens for a fact: only its frontmatter name/description, split on
// non-alphanumerics (so hyphenated slugs like "rushdb-vs-graphify-eval"
// yield rushdb/graphify/eval), lowercased, and filtered to distinctive
// tokens (length >= 4, not a stopword). A body with neither field yields an
// empty set so the caller can fall back to no-conflict.
function subjectTokens(text) {
  const s = String(text ?? '');
  const nameMatch = /^---[\s\S]*?\bname:\s*(.+)$/m.exec(s);
  const descMatch = /^---[\s\S]*?\bdescription:\s*(.+)$/m.exec(s);
  if (!nameMatch && !descMatch) return new Set();
  const combined = `${nameMatch ? nameMatch[1] : ''} ${descMatch ? descMatch[1] : ''}`;
  const words = combined.toLowerCase().match(/[a-z0-9]+/g) || [];
  return new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

export function contradictsPinnedVerdict(distilledBody, curatedBodies) {
  const distilled = String(distilledBody ?? '');
  if (hasVerdictVocab(distilled)) return { conflict: false }; // it shares the verdict, not re-opening it
  const distSubj = subjectTokens(distilled);
  if (distSubj.size === 0) return { conflict: false }; // no name/description to key a subject off: conservative fallback
  for (const [slug, body] of Object.entries(curatedBodies || {})) {
    if (!isPinned(body) || !hasVerdictVocab(body)) continue;
    const curatedSubj = subjectTokens(body);
    if ([...curatedSubj].some((t) => distSubj.has(t))) return { conflict: true, against: slug };
  }
  return { conflict: false };
}
