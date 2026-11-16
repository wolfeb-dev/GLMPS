// server/lib/scut/altitude.js
// Is this update written for the operator, or for the engineer who wrote it?
//
// The operator is an engineering manager and a former engineer, and he asked
// (glmps-78) not to get "intricate low level engineering terminology"
// in the CLI or in Slack. Scoring the 253 agent devlogs on the live board at
// the time showed the defect is ORDERING, not volume: 36% named two or more
// internal identifiers in their FIRST line, so he had to walk through mechanism
// before reaching the point. Median length was about 1,400 characters, and 1% carried a fold.
//
// So this scores two things and only two things:
//   1. does the LEAD open with mechanism, and
//   2. is the post long with no `Details:` fold to stop at.
//
// Both are fully under the writer's control and a post written to
// docs/comms-altitude.md trips neither.
//
// WHY ONLY TWO. Three quarters of the existing corpus trips at least one
// plausible altitude heuristic. An advisory that fires on three quarters of
// messages is not an advisory, it is noise the agent learns to ignore - the
// same failure as a saturated alarm. These are the two sharpest and most
// avoidable signals; the rest of the contract is prose, enforced by being read.
//
// ADVISORY ONLY. This never blocks a post and never rewrites one. The text
// stored on the card and relayed into Slack is byte-identical to what the agent
// wrote; the score comes back in the HTTP response, for the agent's own eyes.
//
// Pure. No I/O, no clock, zero runtime dependencies.

/** Distinct internal identifiers in the first line before it reads like a diff. */
export const LEAD_IDENTIFIER_LIMIT = 2;
/** Characters a post may run to with no `Details:` fold before it is a wall. */
export const UNFOLDED_CHAR_LIMIT = 1200;
/** How many offenders the hint names, so the hint itself stays at altitude. */
const HINT_SAMPLE = 3;

// Shared vocabulary, stripped before anything else is matched. The operator
// reads ticket ids, endpoints and links every day and has never called them
// jargon; counting them would flag exactly the posts that are doing it right.
const SHARED = [
  /https?:\/\/\S+/g,              // links
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+\b/g, // ticket ids: glmps-78, glmps-161, mc-9
  /\/api\/[\w/:-]+/g,             // our own endpoints
];

// The shapes that make a sentence read like a diff rather than a report.
const IDENTIFIER_PATTERNS = [
  /`[^`\n]+`/g,                                                              // backticked span
  /\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|json|md|py|cs|html|css|yml|yaml|sh|ps1)\b/g, // file name
  /\b[a-z][\w-]*(?:\/[\w.-]+){2,}/g,                                         // a real path, 3+ segments
  /\b[a-z][\w-]*\/[\w-]*\.[a-z]{1,5}\b/g,                                    // dir/file.ext
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,                                            // camelCase
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g,                                          // snake_case
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g,                                          // CONST_CASE
  /\b\w+\(\)/g,                                                              // func()
  /(?:^|\s)--?[a-zA-Z][\w-]+/g,                                              // --flag
];

// A short SHA needs BOTH a digit and an a-f letter. Without the digit rule a
// bare Slack thread timestamp (1787371384) scores as a commit; without the
// letter rule nothing does. Neither half is optional.
const SHA_RE = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;

// The fold marker. Matched wherever it appears rather than only at the start of
// a line: a writer who folded inline still folded, and flagging them for it
// would be exactly the false positive that teaches agents to ignore this.
const FOLD_RE = /\b(?:details|mechanism)\s*:/i;

const stripShared = (s) => SHARED.reduce((acc, re) => acc.replace(re, ' '), s);

/**
 * The distinct internal identifiers in `text`, in the order they appear.
 * Shared vocabulary (ticket ids, endpoints, links) is excluded by design.
 * @param {string} text
 * @returns {string[]}
 */
export function internalIdentifiers(text) {
  if (typeof text !== 'string' || !text) return [];
  const body = stripShared(text);
  const found = new Map(); // token -> first index, so the order is the reader's order
  for (const re of [...IDENTIFIER_PATTERNS, SHA_RE]) {
    for (const m of body.matchAll(re)) {
      const token = m[0].trim();
      if (!token) continue;
      if (!found.has(token)) found.set(token, m.index ?? 0);
    }
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
}

// The lead is the first non-empty line, cut at the fold marker when the writer
// put one on that same line. Anything after the marker is by definition already
// below the fold and must not be scored as though it were the lead.
function leadLine(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const fold = line.search(FOLD_RE);
    return fold === -1 ? line : line.slice(0, fold);
  }
  return '';
}

function buildHint({ leadIds, chars, hasFold }) {
  const parts = [];
  if (leadIds.length >= LEAD_IDENTIFIER_LIMIT) {
    const sample = leadIds.slice(0, HINT_SAMPLE).join(', ');
    const more = leadIds.length > HINT_SAMPLE ? `, +${leadIds.length - HINT_SAMPLE} more` : '';
    parts.push(
      `the first line names ${leadIds.length} internal identifiers (${sample}${more}) - ` +
      'lead with the outcome and what it means for the operator, and move those below a `Details:` line',
    );
  }
  if (chars > UNFOLDED_CHAR_LIMIT && !hasFold) {
    parts.push(
      `${chars} characters with no \`Details:\` fold - the operator reads this at a glance, ` +
      'so give them somewhere to stop',
    );
  }
  return parts.length ? parts.join('; ') : null;
}

// glmps-2-0-185: 81 of 204 questions agents put to the operator were calls an
// engineer should own (permission for routine work, PR shape, test edits,
// proceeding with what was already asked). These are the recurring shapes from
// that hand-labelled sample. A heuristic for trend lines, not a verdict on one
// post: filing approvals ("File it?") are the operator's and never match.
const ENGINEER_ASK_RES = [
  /\b(?:may|can|shall|should) I\b[^?\n]{0,160}\?/i,
  /\b(?:ok(?:ay)?|fine|alright) (?:to|if I)\b[^?\n]{0,160}\?/i,
  /\b(?:do you )?want me to\b[^?\n]{0,160}\?/i,
  /\b(?:proceed|go ahead|carry on|continue)\s*\?/i,
  /\b(?:one|single|separate) PRs?\b[^?\n]{0,80}\?/i,
  /\b(?:tick|edit|update|rename|delete|remove)\b[^?\n]{0,80}\btests?\b[^?\n]{0,60}\?/i,
  // Method and deliverable form put to the operator as a question.
  /^\W*(?:Q?\d+[.)]?\s+)?(?:Deliver(?:able)?|Non-goal|Baseline|Compare|Count|Write-up|Mockups?|Read|Port|Rebuild)\b[^?\n]*\?/i,
  /\b(?:as|in|via) (?:one|a|this|the same) PR\b[^?\n]*\?/i,
];

/** Questions in `text` shaped like an engineer-owned call pushed to the operator. */
export function engineerAsks(text) {
  if (typeof text !== 'string' || !text.includes('?')) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (/\bfile\b/i.test(line)) continue;
    for (const re of ENGINEER_ASK_RES) {
      const m = re.exec(line);
      if (m) { out.push(m[0].trim()); break; }
    }
  }
  return out;
}

/**
 * Score one agent-authored update for reporting altitude.
 *
 * @param {string} text
 * @param {{leadLimit?:number, charLimit?:number}} [opts]
 * @returns {{
 *   level: 'ok'|'deep',
 *   signals: { chars:number, identifiers:number, leadIdentifiers:number, hasFold:boolean },
 *   hint: string|null,
 * }}
 */
export function scoreAltitude(text, { leadLimit = LEAD_IDENTIFIER_LIMIT, charLimit = UNFOLDED_CHAR_LIMIT } = {}) {
  const inert = {
    level: 'ok',
    signals: { chars: 0, identifiers: 0, leadIdentifiers: 0, hasFold: false },
    hint: null,
  };
  if (typeof text !== 'string' || !text.trim()) return inert;

  const leadIds = internalIdentifiers(leadLine(text));
  const allIds = internalIdentifiers(text);
  const chars = text.length;
  const hasFold = FOLD_RE.test(text);

  const deep = leadIds.length >= leadLimit || (chars > charLimit && !hasFold);
  return {
    level: deep ? 'deep' : 'ok',
    signals: { chars, identifiers: allIds.length, leadIdentifiers: leadIds.length, hasFold },
    hint: deep ? buildHint({ leadIds, chars, hasFold }) : null,
  };
}
