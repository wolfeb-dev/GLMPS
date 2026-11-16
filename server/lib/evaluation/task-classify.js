// server/lib/evaluation/task-classify.js
// Heuristic task classifier - zero deps, ESM.

// The trailing entries in each list were added 2026-08-12 (roster re-cut). The
// shipped lists were written against generic software vocabulary, so 37 of 79
// real glmps cards scored zero on every class and fell to `other`,
// which no router can act on. These are the words that actually recur in this
// backlog: adapters and capture, hooks and worktrees, flakes and drift.
//
// They were chosen against a random half of the card corpus and validated on
// the half they never saw (55.3% vs 56.1% routed), so the gain is not a tuning
// artifact. Word-boundary matching already shipped, so none of these carry the
// substring hazard that forced the earlier `ci`-inside-`specific` fix.
const KEYWORDS = {
  debug:    ['fix', 'bug', 'broken', 'failing', 'error', 'crash', 'regression', 'flaky', 'flake', 'hang', 'leak', 'silently', 'stale', 'incorrect', 'drift'],
  feature:  ['add', 'build', 'implement', 'create', 'new feature', 'support', 'ship', 'wire', 'surface', 'expose', 'endpoint', 'extension', 'adapter', 'capture'],
  refactor: ['refactor', 'clean up', 'cleanup', 'simplify', 'rename', 'restructure', 'extract', 'consolidate', 'dedupe', 'reorganize', 'split', 'unify'],
  research: ['research', 'investigate', 'compare', 'evaluate', 'explore', 'find out', 'what is', 'summarize', 'summary', 'worth', 'value', 'options', 'landscape', 'why'],
  docs:     ['docs', 'readme', 'document', 'changelog', 'spec', 'adr', 'writeup', 'wiki', 'narrative'],
  ops:      ['deploy', 'release', 'ci', 'pipeline', 'install', 'config', 'env', 'hook', 'restart', 'settings', 'permissions', 'worktree'],
  review:   ['review', 'audit', 'check', 'assess', 'verify', 'validate', 'coverage', 'harden', 'guard'],
  // No generic UI nouns here (panel, tab, chip, row, badge were tried and
  // removed). They tie against `feature` on the commonest phrasing in this
  // backlog, "implement a new <thing> panel", and a tie routes nowhere. They
  // were worth about 1 point of holdout coverage and cost a real
  // misclassification, so the trade was not close.
  ui:       ['ui', 'css', 'layout', 'styling', 'style', 'component', 'dashboard', 'view', 'responsive'],
};

const isTestFile   = (p) => p.includes('.test.') || p.includes('/test');
const isMdFile     = (p) => p.endsWith('.md');
const isSourceFile = (p) => !isTestFile(p) && !isMdFile(p);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = new Map();
function hasWord(text, word) {
  let re = wordRe.get(word);
  if (!re) { re = new RegExp(`\\b${escapeRe(word)}\\b`, 'i'); wordRe.set(word, re); }
  return re.test(text);
}

/**
 * @param {{ firstPrompt?: string, filesTouched?: string[] }} opts
 * @returns {{ taskClass: string, confidence: number, score: number }}
 */
export function classifyTask({ firstPrompt = '', filesTouched = [] } = {}) {
  const prompt = firstPrompt.toLowerCase();

  const scores = {};
  for (const [cls, words] of Object.entries(KEYWORDS)) {
    scores[cls] = words.reduce((n, w) => n + (hasWord(prompt, w) ? 1 : 0), 0);
  }


  // debug: amplify when a test file is in scope
  if (filesTouched.some(isTestFile)) {
    scores.debug *= 1.5;
  }

  // feature: amplify when non-test source files are touched
  if (filesTouched.some(isSourceFile)) {
    scores.feature *= 1.5;
  }

  // research: amplify when nothing was touched (pure exploration), only if signal exists
  if (filesTouched.length === 0 && scores.research > 0) {
    scores.research *= 1.5;
  }

  // docs: strong amplify when every touched file is markdown
  if (filesTouched.length > 0 && filesTouched.every(isMdFile)) {
    scores.docs *= 2;
  }

  // ui: amplify when a web asset or stylesheet is in scope.
  // Separators are normalised because filesTouched carries native paths and
  // this must behave identically on the Linux and Windows CI legs.
  const isWebFile = (p) => {
    const s = String(p).replace(/\\/g, '/');
    return s.startsWith('web/') || s.includes('/web/') || s.endsWith('.css');
  };
  if (filesTouched.some(isWebFile)) {
    scores.ui *= 1.5;
  }

  const sum = Object.values(scores).reduce((a, b) => a + b, 0);
  if (sum === 0) return { taskClass: 'other', confidence: 0, score: 0 };

  const maxScore = Math.max(...Object.values(scores));
  const winners  = Object.entries(scores).filter(([, s]) => s === maxScore);

  // ties -> 'other'
  if (winners.length !== 1) {
    return { taskClass: 'other', confidence: maxScore / sum, score: maxScore };
  }

  return { taskClass: winners[0][0], confidence: maxScore / sum, score: maxScore };
}
