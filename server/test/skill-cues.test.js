import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillCues, pickSkills, loadSkillCues, wakeSkills, withWakeSkills } from '../lib/orchestration/skill-cues.js';
import { configDefaults } from '../lib/config-defaults.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED = fs.readFileSync(path.join(REPO, 'docs', 'agents', 'skill-cues.md'), 'utf8');

const MD = [
  '# Skill cues', '',
  '## Cue phrases', '',
  '| Skill | Phrases | Means |', '|---|---|---|',
  '| tdd | tdd, test first, red green | write the test first |',
  '| prototype | prototype, spike | throwaway |',
  '| to-spec | spec it | spec |',
  '| diagnosing-bugs | diagnose | debug |', '',
  '## Default by card class', '',
  '| Card class | Skill |', '|---|---|',
  '| debug | diagnosing-bugs |', '| other | to-spec |', '',
].join('\n');

const SEVENTEEN = [
  'grill-me', 'grill-with-docs', 'to-spec', 'to-tickets', 'implement', 'implement-spec', 'tdd',
  'diagnosing-bugs', 'code-review', 'domain-modeling', 'codebase-design', 'improve-codebase-architecture',
  'prototype', 'research', 'triage', 'wayfinder', 'handoff',
];

test('parseSkillCues reads both tables', () => {
  const v = parseSkillCues(MD);
  assert.deepEqual(v.cues[0], { skill: 'tdd', phrases: ['tdd', 'test first', 'red green'] });
  assert.equal(v.cues.length, 4);
  assert.deepEqual(v.defaults, { debug: 'diagnosing-bugs', other: 'to-spec' });
});

test('parseSkillCues returns an empty vocabulary for junk', () => {
  assert.deepEqual(parseSkillCues('nothing here'), { cues: [], operatorCues: [], defaults: {} });
  assert.deepEqual(parseSkillCues(null), { cues: [], operatorCues: [], defaults: {} });
});

// The parser skips a pipe row above the first header, so stray table text there
// would pass every other test while the glossary renders broken.
test('the shipped vocabulary starts with its title and has no row before the first table header', () => {
  assert.ok(SHIPPED.startsWith('# Skill cues\n') || SHIPPED.startsWith('# Skill cues\r\n'));
  const lines = SHIPPED.split(/\r?\n/);
  const header = lines.findIndex((l) => /^\|\s*Skill\s*\|\s*Phrases\s*\|/i.test(l));
  assert.ok(header > 0);
  assert.equal(lines.slice(0, header).filter((l) => l.trim().startsWith('|')).length, 0);
});

test('the shipped vocabulary covers exactly the 17 skills and every route class plus other', () => {
  const v = parseSkillCues(SHIPPED);
  assert.deepEqual(v.cues.map((c) => c.skill).sort(), [...SEVENTEEN].sort());
  for (const c of v.cues) assert.ok(c.phrases.length > 0, `${c.skill} has phrases`);
  for (const cls of [...Object.keys(configDefaults().agentRoutes), 'other']) {
    assert.ok(v.defaults[cls] === '-' || SEVENTEEN.includes(v.defaults[cls]), `default for class ${cls}`);
  }
});

test('an explicit cue is picked and hyphen equals space', () => {
  const v = parseSkillCues(MD);
  assert.deepEqual(pickSkills('please do this test-first', v, { taskClass: 'debug' }), { skills: ['tdd'], via: 'cue' });
  assert.deepEqual(pickSkills('Test First please', v, {}).skills, ['tdd']);
  assert.deepEqual(pickSkills('red-green it', v, {}).skills, ['tdd']);
});

test('phrases match on word boundaries only', () => {
  const v = parseSkillCues(MD);
  assert.equal(pickSkills('we spiked on this yesterday', v, { taskClass: 'unknown' }).via, 'none');
  assert.equal(pickSkills('a prototypeless idea', v, { taskClass: 'unknown' }).via, 'none');
  assert.deepEqual(pickSkills('quick spike, then stop', v, {}).skills, ['prototype']);
});

test('cues beat the class default, ordered by first appearance and capped at 3', () => {
  const v = parseSkillCues(MD);
  assert.deepEqual(pickSkills('diagnose it, spec it, then prototype', v, { taskClass: 'debug' }).skills,
    ['diagnosing-bugs', 'to-spec', 'prototype']);
  assert.deepEqual(pickSkills('spike first, then tdd, then diagnose, then spec it', v, {}).skills,
    ['prototype', 'tdd', 'diagnosing-bugs']);
  assert.deepEqual(pickSkills('spec it and spec it again', v, {}).skills, ['to-spec']);
});

test('no cue falls back to the class default, then to none', () => {
  const v = parseSkillCues(MD);
  assert.deepEqual(pickSkills('the thing is broken', v, { taskClass: 'debug' }), { skills: ['diagnosing-bugs'], via: 'class' });
  assert.deepEqual(pickSkills('hello', v, { taskClass: 'unknown' }), { skills: [], via: 'none' });
  assert.deepEqual(pickSkills('hello', v, {}), { skills: ['to-spec'], via: 'class' });
  assert.deepEqual(pickSkills('hello', { cues: [], defaults: {} }, { taskClass: 'debug' }), { skills: [], via: 'none' });
  assert.deepEqual(pickSkills(undefined, v, {}).via, 'class');
});

test('loadSkillCues reads the file, caches by mtime, and fails to an empty vocabulary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-skillcues-'));
  try {
    assert.deepEqual(loadSkillCues(dir), { cues: [], operatorCues: [], defaults: {} }, 'missing file');
    fs.mkdirSync(path.join(dir, 'docs', 'agents'), { recursive: true });
    const f = path.join(dir, 'docs', 'agents', 'skill-cues.md');
    fs.writeFileSync(f, MD);
    const a = loadSkillCues(dir);
    assert.equal(a.cues.length, 4);
    assert.equal(loadSkillCues(dir), a, 'same object while mtime is unchanged');
    fs.writeFileSync(f, MD.replace('| to-spec | spec it | spec |\n', ''));
    fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    assert.equal(loadSkillCues(dir).cues.length, 3, 'reparsed after mtime change');
    assert.deepEqual(loadSkillCues(null), { cues: [], operatorCues: [], defaults: {} });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wakeSkills lists explicit cues only and never the class default', () => {
  const v = parseSkillCues(MD);
  assert.deepEqual(wakeSkills('please test first, then spec it', v), ['tdd', 'to-spec']);
  assert.deepEqual(wakeSkills('just carry on', v), [], 'class default is not a wake cue');
  assert.deepEqual(wakeSkills('spec it', null), []);
});

test('a hyphen or dot joined to a phrase is not a boundary; a sentence-ending dot is', () => {
  const v = { cues: [{ skill: 'research', phrases: ['research this'] }, { skill: 'to-spec', phrases: ['spec it'] }], defaults: {} };
  assert.equal(pickSkills('data-research this week', v, {}).via, 'none');
  assert.equal(pickSkills('re-spec it', v, {}).via, 'none');
  assert.equal(pickSkills('see research-this.js', v, {}).via, 'none');
  assert.equal(pickSkills('open research this.md', v, {}).via, 'none');
  assert.deepEqual(pickSkills('Please spec it.', v, {}).skills, ['to-spec']);
});

// Real board cards (2026-10-27) the first vocabulary made mandatory by accident.
test('the shipped vocabulary does not cue ordinary card text', () => {
  const v = parseSkillCues(SHIPPED);
  for (const text of [
    'Wire the data-research scan into the storm-research report',
    'orchestration research: compare the handoff and park paths',
    'Turn on scut wakeHandoff so the handoff reaches the session',
    'triage label vocabulary drifted from the board',
    'add a glossary page and fix the terminology in the tdd docs',
    'the prototype panel has a seam between the two spikes',
    'research-scan-tick.js runs twice',
  ]) assert.equal(pickSkills(text, v, { taskClass: 'unknown' }).via, 'none', text);
  assert.deepEqual(pickSkills('grill me on this, then spec it', v, {}).skills, ['grill-me', 'to-spec']);
  assert.deepEqual(pickSkills('hand this off to a fresh agent', v, {}).skills, ['handoff']);
  assert.deepEqual(pickSkills('do it test-first', v, {}).skills, ['tdd']);
  assert.deepEqual(pickSkills('/to-tickets', v, {}).skills, ['to-tickets']);
});

// Measured on the live board 2026-10-27: bare "research" was a request in 10 of
// 11 operator-written Slack cards and in 0 of 24 agent-written ones; "triage"
// in 2 of 2 and 0 of 28.
test('operator words cue only in text the operator wrote', () => {
  const v = parseSkillCues(SHIPPED);
  assert.ok(v.operatorCues.some((c) => c.skill === 'research' && c.phrases.includes('research')));
  assert.ok(v.operatorCues.some((c) => c.skill === 'triage' && c.phrases.includes('triage')));
  for (const [text, skill] of [
    ['can you research the Gemini session in antigravity', 'research'],
    ['do some deep research on base 44 app builder and compare', 'research'],
    ['can we triage our 646 learning proposals please.', 'triage'],
  ]) {
    assert.deepEqual(pickSkills(text, v, { operator: true }).skills, [skill], text);
    assert.notEqual(pickSkills(text, v, { taskClass: 'unknown' }).via, 'cue', `${text} (agent-written)`);
  }
  assert.equal(pickSkills('Wire the data-research scan in', v, { operator: true, taskClass: 'unknown' }).via, 'none');
  assert.equal(pickSkills('Triage this card. Do not apply this fix', v, { taskClass: 'unknown' }).via, 'none');
  assert.deepEqual(wakeSkills('research it and triage the rest', v), ['research', 'triage']);
});

test('withWakeSkills cues only a note the server confirmed is the operator\'s', () => {
  const v = parseSkillCues(MD);
  const ext = { action: 'wake', note: 'diagnose this', provenance: 'external' };
  assert.deepEqual(withWakeSkills(ext, v), ext);
});

test('withWakeSkills adds the field only when a cue is present', () => {
  const v = parseSkillCues(MD);
  const base = { action: 'wake', note: 'diagnose this', provenance: 'operator' };
  assert.deepEqual(withWakeSkills(base, v), { ...base, skills: ['diagnosing-bugs'] });
  const plain = { action: 'wake', note: 'carry on', provenance: 'operator' };
  assert.deepEqual(withWakeSkills(plain, v), plain);
  assert.equal('skills' in withWakeSkills(plain, v), false);
});

test('glmps-2-0-185: review cards get no class skill, the routed critic is the review', () => {
  const v = parseSkillCues(SHIPPED);
  assert.equal(v.defaults.review, '-');
  assert.deepEqual(pickSkills('look over the queue', v, { taskClass: 'review' }), { skills: [], via: 'none' });
  assert.deepEqual(pickSkills('review the diff please', v, { taskClass: 'review' }).skills, ['code-review']);
});
