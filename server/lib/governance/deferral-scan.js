// server/lib/governance/deferral-scan.js
//
// Flags follow-up-deferral language in a plan so an in-scope follow-up cannot be
// filed as a ticket and forgotten (see the fold-followups-into-plan memory). A
// line may opt out only with an explicit OUT-OF-SCOPE justification, which
// forces the author to name why something is genuinely separable.

// Markers target IMPERATIVE deferral (a decision to punt work elsewhere), not
// any mention of the word. The defer marker matches "defer(red)" followed by a
// destination bucket (ticket/later/...), which catches the real colloquial
// forms ("deferred for later", "deferred; see the backlog ticket", "deferred,
// ticket to follow"). NEGATED below exempts the sentences that only look like
// deferral because they NEGATE it ("nothing is deferred", "deferred but no
// ticket exists, do not file one"), which is the real discriminator, not the
// preposition. Residual lexical false positives (e.g. graphics "deferred
// rendering ... later pass") are escapable with lint-ok:.
const MARKERS = [
  /follow[- ]?up ticket/i,
  /file a (?:backlog )?ticket/i,
  /future ticket/i,
  /\bdefer(?:red|ring|s)?\b[^.\n]{0,40}\b(?:ticket|backlog|later|future|separate|epic|PR|next session|sprint|for now)\b/i,
  /out of scope for now/i,
  /\bin a (?:later|future|separate) PR\b/i,
  /TODO\(later\)/i,
];

// A line whose deferral is NEGATED is not an authored punt and is exempt even
// without an annotation: the author is saying the OPPOSITE of "punt this".
// The negation must sit IMMEDIATELY on the defer verb (or be the deferral's
// subject), not merely somewhere nearby: "Not urgent; defer to next sprint" is
// a REAL punt (the negation modifies "urgent", not "defer"), so a proximity
// window would wrongly exempt it. That relocation of the v1 proximity bug is
// exactly what this shape avoids.
// Both subject- and verb-negation forms bind the negator to the defer verb
// through auxiliary/copula words only (be/been/is/was/has/will/...), NOT an
// arbitrary character window. That is the difference between "Nothing IS
// deferred" (exempt) and "Nothing major, but defer this to X" (a real punt:
// "major"/"but" are not auxiliaries, so the chain breaks and it flags). A
// character-window match here is the v1 proximity bug relocated, and silently
// exempts real punts, which is the dangerous direction.
const AUX = String.raw`(?:(?:be|been|being|is|was|are|were|has|have|had|will|would|can|could|should|must|do|does|to|going|get|gets|yet)\s+){0,3}`;
const NEGATED = [
  // the defer verb itself is directly negated, incl. modal/passive:
  // "not deferred", "do not defer", "isn't deferred", "must not be deferred",
  // "can't be deferred", "has not been deferred", "not yet deferred".
  new RegExp(String.raw`\b(?:not|never|cannot|ca ?n['\u2019]?t|do ?n['\u2019]?t|do not|does ?n['\u2019]?t|does not|is ?n['\u2019]?t|is not|are ?n['\u2019]?t|are not|was ?n['\u2019]?t|were ?n['\u2019]?t|wo ?n['\u2019]?t|will not|should ?n['\u2019]?t|should not|must ?n['\u2019]?t|must not)\s+${AUX}defer(?:red|ring|s)?\b`, 'i'),
  // "nothing / nobody is deferred": the SUBJECT of deferral is negated, bound
  // through auxiliaries so an unrelated adjective ("nothing major but defer")
  // does not exempt a real punt.
  new RegExp(String.raw`\b(?:nothing|nobody|no one)\b\s+${AUX}defer(?:red|ring|s)?\b`, 'i'),
  // explicitly says NOT to create the follow-up ticket.
  /\bdefer(?:red|ring|s)?\b[^.\n]{0,25}\bno\b\s+(?:ticket|follow)/i,
  /\b(?:do ?n['\u2019]?t|do not)\s+file\b/i,
];
// Two explicit, auditable exemptions, both requiring a reason after the colon:
//   OUT-OF-SCOPE:  this work is genuinely separable (name why).
//   lint-ok:       this line DESCRIBES the deferral mechanism, it is not a
//                  deferral (a plan about deferral prevention must name it).
// Same trust model: a reviewer sees the token and checks the reason. A silent
// broadening of the markers would instead hide real deferrals.
const JUSTIFIED = /(?:OUT-OF-SCOPE|lint-ok):/;
// Fenced code blocks are examples, not authored deferrals (this plan quotes the
// markers themselves). Lines inside ``` fences are skipped.
export function scanDeferrals(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence || JUSTIFIED.test(line) || NEGATED.some((re) => re.test(line))) continue;
    for (const re of MARKERS) {
      const m = re.exec(line);
      if (m) { out.push({ line: i + 1, marker: m[0], text: line.trim() }); break; }
    }
  }
  return out;
}
