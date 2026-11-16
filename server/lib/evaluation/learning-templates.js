// server/lib/evaluation/learning-templates.js
// The pure idempotent section-insert helper for governed instruction files
// (CLAUDE.global.md's '## Learned guards' section and similar).
// Zero dependencies, no fs/os usage - pure functions only.
//
// Guard proposer cutover: the static gap-code -> guard TEMPLATES
// map and its guardForGap(code) lookup are DELETED. They were the pre-D23
// auto-proposer - upsertGapInto used to seed a new gap item's proposedGuard
// straight from this map, and gap-pipeline.js's autoApplyGaps branch landed
// it with no operator in the loop but a promotion gate. Gap detection stays
// (it is GEPA's input, via learning-store.js's buildGepaInput reading pending
// 'gap' items); proposing the RULE TEXT for a gap is now the GEPA plugin's
// job (server/lib/plugins/gepa-plugin.js), and every guard, gap-derived,
// idea-derived, or GEPA-derived, lands only through the operator's approval
// click (server.js's /api/learning/item/:id/approve) calling landGuard.

import { findNearest } from './semantic-dedup.js';

// insertGuard(fileContent, section, rule, simThreshold?) -> { content, changed }
//
// Pure + idempotent:
//   - If the exact `rule` line already exists anywhere in the content,
//     return { content, changed: false } unchanged.
//   - If `simThreshold` (a 0..1 number) is supplied AND the section already
//     exists, also treat `rule` as already-present when it is a near-dup
//     (lexical similarity >= simThreshold, see semantic-dedup.js) of any
//     existing non-blank line already inside that section. This is what
//     catches paraphrased rewordings of a guard that already exists - the
//     exact-match check above only catches verbatim repeats. Omitting
//     simThreshold (the default) preserves the old exact-match-only
//     behavior for every existing caller.
//   - If `## <section>` heading is absent, append "\n## <section>\n" + rule.
//   - If present, append rule as a new line at the end of that section
//     (before the next ## heading or EOF).

export function insertGuard(fileContent, section, rule, simThreshold) {
  // Idempotency guard: if the exact rule text already exists anywhere, do nothing.
  // We check line-by-line so partial substring matches inside other lines don't trip it.
  const existingLines = fileContent.split('\n');
  if (existingLines.some((line) => line === rule)) {
    return { content: fileContent, changed: false };
  }

  const headingPattern = new RegExp(`^## ${escapeRegExp(section)}$`, 'm');

  if (typeof simThreshold === 'number' && headingPattern.test(fileContent)) {
    const near = findNearest(rule, sectionBodyLines(fileContent, section), simThreshold);
    if (near) {
      return { content: fileContent, changed: false };
    }
  }

  if (!headingPattern.test(fileContent)) {
    // Section absent: append the heading + rule at the end.
    // Ensure we start on a new line; trim trailing whitespace from existing content first.
    const base = fileContent.trimEnd();
    const separator = base.length > 0 ? '\n' : '';
    const appended = `${base}${separator}\n## ${section}\n${rule}\n`;
    return { content: appended, changed: true };
  }

  // Section present: find the heading and locate the end of that section
  // (the next ## heading, or EOF).
  const lines = fileContent.split('\n');
  const headingRe = new RegExp(`^## ${escapeRegExp(section)}$`);
  const nextHeadingRe = /^## /;

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }

  // Find the end of the section: the line just before the next ## heading,
  // or the last non-empty line of the file if there is no next heading.
  let insertIdx = lines.length; // default: insert after last line
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (nextHeadingRe.test(lines[i])) {
      // Insert before the blank line(s) that precede the next heading, or right before it.
      // Walk back past trailing blank lines to keep spacing clean.
      let insertBefore = i;
      while (insertBefore > headingIdx + 1 && lines[insertBefore - 1].trim() === '') {
        insertBefore--;
      }
      insertIdx = insertBefore;
      break;
    }
  }

  // If inserting at EOF, walk back past trailing blank lines.
  if (insertIdx === lines.length) {
    while (insertIdx > headingIdx + 1 && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }
  }

  const result = [
    ...lines.slice(0, insertIdx),
    rule,
    ...lines.slice(insertIdx),
  ].join('\n');

  return { content: result, changed: true };
}

// removeGuardLine(fileContent, section, rule) -> { content, changed }
//
// The inverse of insertGuard, for reverting a guard (card glmps-2-0-201).
// Removes the exact rule line only from inside `## <section>`, so the same
// text quoted elsewhere in the file is never touched.
export function removeGuardLine(fileContent, section, rule) {
  const lines = fileContent.split('\n');
  const headingRe = new RegExp(`^## ${escapeRegExp(section)}\\r?$`);
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return { content: fileContent, changed: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  const at = lines.findIndex((l, i) => i > start && i < end && l.replace(/\r$/, '') === rule);
  if (at === -1) return { content: fileContent, changed: false };
  return { content: [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n'), changed: true };
}

// helpers

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// sectionBodyLines(fileContent, section) -> string[]
// Non-blank lines strictly between "## <section>" and the next "## " heading
// (or EOF). Used for insertGuard's optional near-dup check above, and
// exported so callers (e.g. server.js, feeding the GEPA plugin's
// `seedGuards` input with the CURRENT guard lines) can read them without
// duplicating this section-scanning logic.
export function sectionBodyLines(fileContent, section) {
  const lines = fileContent.split('\n');
  const headingRe = new RegExp(`^## ${escapeRegExp(section)}$`);
  const nextHeadingRe = /^## /;

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return [];

  const body = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (nextHeadingRe.test(lines[i])) break;
    if (lines[i].trim() !== '') body.push(lines[i]);
  }
  return body;
}
