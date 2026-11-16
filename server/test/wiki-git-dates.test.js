import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesFromGitLog, sectionGitDates } from '../lib/observability/wiki-git-dates.js';

const NOW = Date.UTC(2026, 6, 12);           // fallback sentinel
const S_JAN = Math.floor(Date.UTC(2026, 0, 4) / 1000);   // Jan 4 2026 (secs)
const S_JUL = Math.floor(Date.UTC(2026, 6, 10) / 1000);  // Jul 10 2026 (secs)

test('datesFromGitLog: min = created, max = updated (ms), from unix-second lines', () => {
  const out = `${S_JUL}\n${S_JAN}\n`;   // newest-first, as git emits
  assert.deepEqual(datesFromGitLog(out), { createdTs: S_JAN * 1000, updatedTs: S_JUL * 1000 });
});

test('datesFromGitLog: tolerates blank lines / whitespace', () => {
  const out = `\n  ${S_JUL}  \n\n${S_JAN}\n \n`;
  assert.deepEqual(datesFromGitLog(out), { createdTs: S_JAN * 1000, updatedTs: S_JUL * 1000 });
});

test('datesFromGitLog: no commits -> null/null', () => {
  assert.deepEqual(datesFromGitLog(''), { createdTs: null, updatedTs: null });
  assert.deepEqual(datesFromGitLog('   \n  '), { createdTs: null, updatedTs: null });
});

test('sectionGitDates: uses git history when files have commits', () => {
  const section = { files: [{ path: 'a.js' }, { path: 'b.js' }] };
  const runGitLog = (files) => { assert.deepEqual(files, ['a.js', 'b.js']); return `${S_JUL}\n${S_JAN}\n`; };
  assert.deepEqual(sectionGitDates(section, runGitLog, NOW),
    { createdTs: S_JAN * 1000, updatedTs: S_JUL * 1000 });
});

test('sectionGitDates: extraFiles fold into the date window without joining section.files', () => {
  const section = { files: [{ path: 'CLAUDE.md' }] };
  // section's own file last changed Jan; the topic-definition file changed Jul
  // (an angle rewrite) -> updated must reflect the later commit.
  const runGitLog = (files) => {
    assert.deepEqual(files, ['CLAUDE.md', 'server/lib/observability/wiki-topics.js']);
    return `${S_JUL}\n${S_JAN}\n`;
  };
  const d = sectionGitDates(section, runGitLog, NOW, ['server/lib/observability/wiki-topics.js']);
  assert.equal(d.updatedTs, S_JUL * 1000);
  assert.equal(d.createdTs, S_JAN * 1000);
});

test('sectionGitDates: no files -> now fallback (topic/edge sections)', () => {
  assert.deepEqual(sectionGitDates({ files: [] }, () => '', NOW), { createdTs: NOW, updatedTs: NOW });
  assert.deepEqual(sectionGitDates({}, () => '', NOW), { createdTs: NOW, updatedTs: NOW });
});

test('sectionGitDates: brand-new uncommitted files (no history) -> now, which is correct', () => {
  const section = { files: [{ path: 'brand-new.js' }] };
  assert.deepEqual(sectionGitDates(section, () => '', NOW), { createdTs: NOW, updatedTs: NOW });
});

test('sectionGitDates: a throwing git runner degrades to now, never throws', () => {
  const section = { files: [{ path: 'a.js' }] };
  assert.deepEqual(sectionGitDates(section, () => { throw new Error('git boom'); }, NOW),
    { createdTs: NOW, updatedTs: NOW });
});
