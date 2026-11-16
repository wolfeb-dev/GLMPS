#!/usr/bin/env node
// scripts/dedupe-lessons.mjs
//
//   node scripts/dedupe-lessons.mjs            dry run: report, write nothing
//   node scripts/dedupe-lessons.mjs --apply    retire the duplicates
//   node scripts/dedupe-lessons.mjs --apply --approve   ...and promote the keepers
//                                                       whose rule is genuinely
//                                                       live in CLAUDE.global.md
//
// Collapses the duplicate lesson records the 2026-08-21 migration carried over
// from the legacy store: 47 guard lessons that are really only ten distinct
// rules. See server/lib/evaluation/lesson-dedupe.js for why duplicates are a
// correctness problem here and not just untidiness.
//
// The dedupe KEY is the legacy store's rule `code`, joined back by lesson id
// (`legacy:<storeId>`). The migration did not record it, so this re-derives it
// rather than re-running the migration over live state.
//
// --approve promotes ONLY keepers whose rule text is actually present in
// CLAUDE.global.md right now. A promotion asserts that a guard is live in the
// reflex layer; asserting it for text that is not there would be a lie the
// ungated_reflex check is specifically meant to catch.
//
// Dry-run by default because this writes to real state.
import fs from 'node:fs';
import path from 'node:path';
import { getPaths } from '../server/lib/paths.js';
import { readLessonRows, lessonsCurrent } from '../server/lib/evaluation/lesson-ledger.js';
import { planDedupe } from '../server/lib/evaluation/lesson-dedupe.js';
import { invalidateLessons } from '../server/lib/evaluation/lesson-invalidate.js';
import { requestPromotion, approvePromotion, isPromoted } from '../server/lib/evaluation/reflex-gate.js';

const apply = process.argv.includes('--apply');
const approve = process.argv.includes('--approve');
const P = getPaths(process.env);
const stateDir = P.stateDir;

const guardFileArg = process.argv.find((a) => a.startsWith('--guard-file='));
const guardFile = guardFileArg ? guardFileArg.split('=')[1] : path.join(P.assetsDir, 'CLAUDE.global.md');

let legacy = [];
try {
  legacy = JSON.parse(fs.readFileSync(path.join(stateDir, 'learning', 'store.json'), 'utf8')).items ?? [];
} catch (e) {
  console.error(`cannot read the legacy store: ${e?.message ?? e}`);
  process.exit(1);
}
const codeById = new Map(legacy.map((i) => [String(i.id), i.code ?? null]));
const ruleById = new Map(legacy.map((i) => [String(i.id), i.proposedGuard?.rule ?? null]));

const current = [...lessonsCurrent(readLessonRows(stateDir, {})).values()].map((l) => {
  const storeId = String(l.lessonId).startsWith('legacy:') ? String(l.lessonId).slice('legacy:'.length) : null;
  return { ...l, dedupeKey: storeId ? codeById.get(storeId) ?? null : null, rule: storeId ? ruleById.get(storeId) ?? null : null };
});

const { keep, retire } = planDedupe(current);

const norm = (t) => String(t ?? '').replace(/^[-*]\s*/, '').replace(/[\u2014\u2013]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
let guardText = '';
try { guardText = norm(fs.readFileSync(guardFile, 'utf8')); } catch { /* reported below */ }
const isLive = (l) => !!(guardText && l.rule && guardText.includes(norm(l.rule).slice(0, 45)));

const liveKeepers = keep.filter(isLive);
// Three different states, and collapsing them would misreport. A lesson with
// NO recorded rule text is not superseded - its guard simply landed by another
// route, so there is nothing to match and nothing to assert.
const noRuleText = keep.filter((l) => l.dedupeKey && !l.rule);
const supersededKeepers = keep.filter((l) => l.dedupeKey && l.rule && !isLive(l));

console.log(`ledger lessons:      ${current.length}`);
console.log(`distinct rules:      ${keep.filter((l) => l.dedupeKey).length} (plus ${keep.filter((l) => !l.dedupeKey).length} with no rule code, left alone)`);
console.log(`duplicates to retire ${retire.length}`);
console.log(`guard file:          ${guardFile}${guardText ? '' : '  [UNREADABLE - nothing will be approved]'}`);
console.log(`  keepers live in it:      ${liveKeepers.length}  ${liveKeepers.map((l) => l.dedupeKey).join(', ')}`);
console.log(`  superseded (rule text not in it): ${supersededKeepers.length}  ${supersededKeepers.map((l) => l.dedupeKey).join(', ')}`);
console.log(`  no rule text recorded:            ${noRuleText.length}  ${noRuleText.map((l) => l.dedupeKey).join(', ')}`);
console.log('  Neither of those two groups is approved: the first is covered by wording already');
console.log('  in the file, and the second has nothing to match, so asserting reflex status');
console.log('  would be a claim we cannot support.');

if (!apply) {
  console.log('\nDRY RUN. Nothing written. Re-run with --apply (and optionally --approve).');
  process.exit(0);
}

const out = invalidateLessons(stateDir, { lessonIds: retire.map((r) => r.lessonId), reason: 'duplicate', actor: 'operator' });
console.log(`\nretired ${out.invalidated.length} duplicate(s).`);

if (approve) {
  let promoted = 0;
  for (const l of liveKeepers) {
    if (isPromoted(stateDir, l.lessonId)) continue;
    try {
      requestPromotion(stateDir, {
        lessonId: l.lessonId,
        evidence: { reason: 'rule is present verbatim in the reflex layer file', guardFile },
        actor: 'operator',
      });
      approvePromotion(stateDir, { lessonId: l.lessonId, actor: 'operator', humanApproved: true });
      promoted++;
    } catch (e) {
      console.log(`  could not promote ${l.lessonId}: ${e?.message ?? e}`);
    }
  }
  console.log(`promoted ${promoted} keeper(s) whose rule is live in the file.`);
}

console.log('The legacy store was NOT modified.');
process.exit(0);
