// server/test/memory-consolidate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  consolidateCandidates,
  memoryEntriesFromDir,
  guardEntriesFromClaudeMd,
  DEFAULT_MIN_CLUSTER_SIZE,
} from '../lib/evaluation/memory-consolidate.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-consolidate-')); tmpDirs.push(d); return d; }

// consolidateCandidates - clustering -> proposals

test('consolidateCandidates: two near-duplicate entries cluster into one proposal', () => {
  const entries = [
    { id: 'a.md', text: 'Never poll with sleep N then cat - use run_in_background or Monitor.' },
    { id: 'b.md', text: 'Never poll using sleep N then cat, use run_in_background or Monitor instead.' },
  ];
  const out = consolidateCandidates(entries);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].members.sort(), ['a.md', 'b.md']);
  assert.ok(['a.md', 'b.md'].includes(out[0].canonicalId));
  assert.match(out[0].reason, /near-duplicate/);
});

test('consolidateCandidates: unrelated entries produce no proposals', () => {
  const entries = [
    { id: 'a.md', text: 'Never poll with sleep N then cat - use run_in_background or Monitor.' },
    { id: 'b.md', text: 'Quantower strategies must set Name in the constructor or they silently fail to load.' },
  ];
  assert.deepEqual(consolidateCandidates(entries), []);
});

test('consolidateCandidates: empty or single-entry input -> [] without throwing', () => {
  assert.deepEqual(consolidateCandidates([]), []);
  assert.deepEqual(consolidateCandidates(undefined), []);
  assert.deepEqual(consolidateCandidates([{ id: 'a', text: 'solo entry, nothing to dedup against' }]), []);
});

test('consolidateCandidates: malformed entries are skipped, not thrown', () => {
  const entries = [
    null,
    { id: 'a.md', text: 'Never poll with sleep N then cat - use run_in_background or Monitor.' },
    { id: 'b.md', text: 'Never poll using sleep N then cat, use run_in_background or Monitor instead.' },
    { id: 123, text: 'bad id type' },
    { id: 'no-text.md' },
    { id: '', text: 'empty id' },
  ];
  const out = consolidateCandidates(entries);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].members.sort(), ['a.md', 'b.md']);
});

test('consolidateCandidates: minClusterSize filters out clusters smaller than the floor', () => {
  // Three mutual near-duplicates plus one pair that only dup each other - 
  // clusterNearDups is transitive, so all near-dup text below forms one
  // cluster of 3; a separate two-entry cluster of unrelated-but-duplicated
  // text should be dropped when minClusterSize is raised above 2.
  const entries = [
    { id: 'a.md', text: 'Never poll with sleep N then cat - use run_in_background or Monitor.' },
    { id: 'b.md', text: 'Never poll using sleep N then cat, use run_in_background or Monitor instead.' },
    { id: 'c.md', text: 'Do not poll with a sleep then cat loop - use run_in_background or Monitor.' },
    { id: 'd.md', text: 'Quantower plugin Name is required in the constructor.' },
    { id: 'e.md', text: 'Quantower plugin Name is required in the constructor.' },
  ];
  const atFloor2 = consolidateCandidates(entries, { minClusterSize: 2 });
  assert.equal(atFloor2.length, 2);
  const bigCluster = atFloor2.find((c) => c.members.length === 3);
  assert.ok(bigCluster);
  assert.deepEqual(bigCluster.members.sort(), ['a.md', 'b.md', 'c.md']);

  const atFloor4 = consolidateCandidates(entries, { minClusterSize: 4 });
  assert.deepEqual(atFloor4, []);
});

test('consolidateCandidates: default minClusterSize constant is 2', () => {
  assert.equal(DEFAULT_MIN_CLUSTER_SIZE, 2);
});

// canonical pick heuristic

test('canonical pick: longest text wins', () => {
  const short = 'Never poll with sleep then cat.';
  const long = 'Never poll with sleep N then cat - use run_in_background or Monitor instead of a sleep loop.';
  const entries = [
    { id: 'short.md', text: short },
    { id: 'long.md', text: long },
  ];
  const out = consolidateCandidates(entries, { threshold: 0.3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].canonicalId, 'long.md');
});

test('canonical pick: tie on length breaks on inbound wikilink count', () => {
  const textA = 'Never poll with sleep N then use run_in_background.';
  const textB = 'Do not poll with sleep N and use run_in_background.'; // same length as A
  assert.equal(textA.length, textB.length);
  const entries = [
    { id: 'a.md', text: textA },
    { id: 'b.md', text: textB },
    { id: 'referrer.md', text: 'See also [[a]] for the polling rule.' },
  ];
  const out = consolidateCandidates(entries, { threshold: 0.4 });
  const cluster = out.find((c) => c.members.includes('a.md') && c.members.includes('b.md'));
  assert.ok(cluster);
  assert.equal(cluster.canonicalId, 'a.md');
});

test('canonical pick: tie on length and wikilinks breaks lexicographically on id', () => {
  const textA = 'Never poll with sleep N then use run_in_background.';
  const textB = 'Do not poll with sleep N and use run_in_background.';
  assert.equal(textA.length, textB.length);
  const entries = [
    { id: 'z-guard.md', text: textA },
    { id: 'a-guard.md', text: textB },
  ];
  const out = consolidateCandidates(entries, { threshold: 0.4 });
  assert.equal(out.length, 1);
  assert.equal(out[0].canonicalId, 'a-guard.md');
});

test('canonical pick: wikilink resolution strips the .md extension', () => {
  const textA = 'Never poll with sleep N then use run_in_background.';
  const textB = 'Do not poll with sleep N and use run_in_background.';
  const entries = [
    { id: 'a.md', text: textA },
    { id: 'b.md', text: textB },
    { id: 'referrer.md', text: 'See [[b]] for details.' }, // links to b, not a
  ];
  const out = consolidateCandidates(entries, { threshold: 0.4 });
  const cluster = out.find((c) => c.members.includes('a.md') && c.members.includes('b.md'));
  assert.equal(cluster.canonicalId, 'b.md');
});

// memoryEntriesFromDir - reads temp dirs only, never the real ~/.claude

test('memoryEntriesFromDir: reads .md files, strips frontmatter, excludes MEMORY.md', () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory index\n\n- [foo](foo.md) \u2014 a fact\n');
  fs.writeFileSync(
    path.join(dir, 'foo.md'),
    '---\nname: foo\ndescription: a fact\nmetadata:\n  node_type: memory\n  type: project\n---\n\nThe actual fact body.\n',
  );
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored, not markdown');

  const entries = memoryEntriesFromDir(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'foo.md');
  assert.equal(entries[0].text, 'The actual fact body.');
});

test('memoryEntriesFromDir: missing directory -> [] without throwing', () => {
  assert.deepEqual(memoryEntriesFromDir(path.join(os.tmpdir(), 'mc-consolidate-does-not-exist')), []);
});

test('memoryEntriesFromDir: file with no frontmatter is passed through as-is (trimmed)', () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 'bare.md'), '  plain body, no frontmatter  \n');
  const entries = memoryEntriesFromDir(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'plain body, no frontmatter');
});

// guardEntriesFromClaudeMd - parses '## Learned guards' bullets

test('guardEntriesFromClaudeMd: parses bullet lines under Learned guards into id/text entries', () => {
  const content = [
    '# CLAUDE.md',
    '',
    '## Some other section',
    '- unrelated line',
    '',
    '## Learned guards',
    '- Never poll with sleep N then cat - use run_in_background or Monitor.',
    '- Do not re-read an unchanged file; query graphify instead.',
    '',
    '## Another section',
    '- not a guard',
  ].join('\n');

  const entries = guardEntriesFromClaudeMd(content);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'guard-0');
  assert.match(entries[0].text, /sleep N/);
  assert.equal(entries[1].id, 'guard-1');
  assert.match(entries[1].text, /re-read/);
});

test('guardEntriesFromClaudeMd: absent section or empty content -> [] without throwing', () => {
  assert.deepEqual(guardEntriesFromClaudeMd('# CLAUDE.md\n\nno guards section here'), []);
  assert.deepEqual(guardEntriesFromClaudeMd(''), []);
  assert.deepEqual(guardEntriesFromClaudeMd(undefined), []);
  assert.deepEqual(guardEntriesFromClaudeMd(null), []);
});

// end-to-end: guard-line near-duplicates from a CLAUDE.md-style string

test('end-to-end: near-duplicate guard lines parsed from CLAUDE.md content cluster into a proposal', () => {
  const content = [
    '## Learned guards',
    '- Never poll with sleep N then cat - use run_in_background or Monitor.',
    '- Never poll using sleep N then cat, use run_in_background or Monitor instead.',
    '- Use the Grep/Read tools instead of Bash grep/cat for searching and reading files.',
  ].join('\n');
  const entries = guardEntriesFromClaudeMd(content);
  const out = consolidateCandidates(entries);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].members.sort(), ['guard-0', 'guard-1']);
});
