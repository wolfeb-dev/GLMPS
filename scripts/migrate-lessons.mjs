#!/usr/bin/env node
// scripts/migrate-lessons.mjs
//
// Seed the A0 lesson ledger from the legacy learning store.
//
//   node scripts/migrate-lessons.mjs            dry run: report, write nothing
//   node scripts/migrate-lessons.mjs --apply    actually write
//
// Dry-run by default because this touches real state. The mapping and its
// policy (applied migrates, pending and discarded do not) live in the pure,
// unit-tested planner at server/lib/evaluation/lesson-migrate.js - read that
// header before changing anything here.
//
// ADDITIVE AND IDEMPOTENT, deliberately. It never reads-repoints, rewrites or
// deletes learning/store.json: the legacy loop keeps working exactly as it does
// today, untouched. Re-running plans zero writes, because existing ledger ids
// are read back and skipped.
//
// Writes go through writeLesson, not createLesson, so provenance enforcement,
// the learning-write freeze and the reflex gate all apply to the migration
// itself. actor is 'operator' rather than 'nightly-runner' because the freeze
// rejects the latter by default - and correctly so: this IS an operator
// action, run by hand, not something the autonomous runner may do for itself.
import fs from 'node:fs';
import path from 'node:path';
import { getPaths } from '../server/lib/paths.js';
import { planMigration } from '../server/lib/evaluation/lesson-migrate.js';
import { writeLesson } from '../server/lib/evaluation/lesson-write.js';
import { readLessonRows, lessonsCurrent } from '../server/lib/evaluation/lesson-ledger.js';

const apply = process.argv.includes('--apply');
const P = getPaths(process.env);
const stateDir = P.stateDir;
const storeFile = path.join(stateDir, 'learning', 'store.json');

let items = [];
try {
  items = JSON.parse(fs.readFileSync(storeFile, 'utf8')).items ?? [];
} catch (e) {
  console.error(`cannot read the legacy store at ${storeFile}: ${e?.message ?? e}`);
  process.exit(1);
}

const existingIds = new Set(lessonsCurrent(readLessonRows(stateDir, {})).keys());
const { plan, skipped } = planMigration({ items, existingIds });

const byReason = skipped.reduce((a, s) => { a[s.reason] = (a[s.reason] ?? 0) + 1; return a; }, {});
const inReflexLayer = plan.filter((p) => p.landedInReflexLayer).length;

console.log(`legacy store:      ${items.length} items (${storeFile})`);
console.log(`already in ledger: ${existingIds.size}`);
console.log(`to migrate:        ${plan.length}`);
console.log(`skipped:           ${skipped.length} ${JSON.stringify(byReason)}`);
console.log(`  of those to migrate, ${inReflexLayer} are guards that are LIVE in`);
console.log('  CLAUDE.global.md right now and carry no promotion.approved.');
console.log('  They migrate as reflex:false, which is the truthful record: the');
console.log('  ledger says what passed the gate, and none of these did.');

if (!apply) {
  console.log('\nDRY RUN. Nothing written. Re-run with --apply to write.');
  process.exit(0);
}

let ok = 0;
const failures = [];
for (const row of plan) {
  try {
    writeLesson(stateDir, {
      lessonId: row.lessonId,
      kind: row.kind,
      title: row.title,
      provenance: row.provenance,
      actor: 'operator',
      reflex: row.reflex,
    });
    ok++;
  } catch (e) {
    // Recorded, not swallowed, and never fatal: one unmappable item must not
    // strand the other 51 half-migrated.
    failures.push({ lessonId: row.lessonId, error: e?.message ?? String(e) });
  }
}

console.log(`\nwrote ${ok} lesson(s).`);
if (failures.length) {
  console.log(`${failures.length} failed:`);
  for (const f of failures) console.log(`  ${f.lessonId}: ${f.error}`);
}
console.log('The legacy store was not modified.');
process.exit(0);
