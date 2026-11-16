import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseIndex, pinnedTargets, runEviction, evictedFile,
} from '../lib/evaluation/memory-evict-runner.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-evictrun-'));
  const memoryDir = path.join(root, 'memory');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'memory'), { recursive: true });
  return { memoryDir, stateDir };
}

// Budgets are derived from the real index size rather than hardcoded, so a
// change to the fixture hooks cannot silently make a test vacuous.
function indexBytes(memoryDir) {
  const content = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  return parseIndex(content).reduce((n, e) => n + e.bytes, 0);
}

function seed(memoryDir, facts) {
  const lines = ['# Memory index', ''];
  for (const [slug, { body = 'body text', hook = 'a hook' }] of Object.entries(facts)) {
    fs.writeFileSync(path.join(memoryDir, `${slug}.md`), `---\nname: ${slug}\n---\n\n${body}\n`);
    lines.push(`- [${slug}](${slug}.md) - ${hook}`);
  }
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `${lines.join('\n')}\n`);
}

// glmps-158: runEviction now opens on a passing probe set (task 4). These
// tests exercise real demotion, so each seeds a probe set the real
// lookupFacts resolves with full confidence against that test's own fixture
// facts, matching what demotionAllowed requires (>=20 probes, recall 1.0
// here). Padded to MIN_PROBES by cycling the given q/expect pairs.
const MIN_PROBES = 20;
function seedProbes(stateDir, pairs) {
  const probes = Array.from({ length: MIN_PROBES }, (_, i) => pairs[i % pairs.length]);
  fs.mkdirSync(path.join(stateDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'memory', 'probes.json'), JSON.stringify(probes));
}

test('parseIndex extracts target, verbatim line, and byte size', () => {
  const entries = parseIndex('# Memory index\n\n- [Title](a.md) - hook here\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'a.md');
  assert.equal(entries[0].line, '- [Title](a.md) - hook here');
  assert.equal(entries[0].bytes, Buffer.byteLength('- [Title](a.md) - hook here\n', 'utf8'));
});

test('parseIndex tolerates an em-dash separator from legacy lines', () => {
  const entries = parseIndex(`- [T](a.md) ${String.fromCharCode(0x2014)} hook\n`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'a.md');
});

test('parseIndex ignores headings and blank lines', () => {
  const entries = parseIndex('# Memory index\n\n## Imported\n\n- [T](a.md) - hook\n');
  assert.equal(entries.length, 1);
});

test('a fact is pinned when its BODY carries a warning', () => {
  const { memoryDir } = tmpDirs();
  seed(memoryDir, {
    warned: { body: 'the line is closed, do not resume', hook: 'closed' },
    plain: { body: 'ordinary notes', hook: 'ordinary' },
  });
  const entries = parseIndex(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'));
  const pinned = pinnedTargets(memoryDir, entries);
  assert.ok(pinned.has('warned.md'));
  assert.ok(!pinned.has('plain.md'));
});

test('a fact is pinned when only its INDEX LINE carries the warning', () => {
  const { memoryDir } = tmpDirs();
  seed(memoryDir, { x: { body: 'nothing notable', hook: "don't re-propose" } });
  const entries = parseIndex(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'));
  assert.ok(pinnedTargets(memoryDir, entries).has('x.md'));
});

test('a missing body file does not throw and is treated as unpinned', () => {
  const { memoryDir } = tmpDirs();
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- [Gone](gone.md) - hook\n');
  const entries = parseIndex(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'));
  assert.doesNotThrow(() => pinnedTargets(memoryDir, entries));
});

test('under budget changes nothing at all', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { a: {}, b: {} });
  const before = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  const res = runEviction({ memoryDir, stateDir, budgetBytes: 10000 });
  assert.deepEqual(res.evicted, []);
  assert.equal(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'), before);
  assert.ok(!fs.existsSync(evictedFile(stateDir)), 'no eviction record when nothing was evicted');
});

test('over budget drops the coldest index line and leaves body files intact', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { cold: {}, warm: {} });
  seedProbes(stateDir, [{ q: 'cold', expect: 'cold.md' }, { q: 'warm', expect: 'warm.md' }]);
  const usage = { 'cold.md': { reads: 0, exposureSessions: 50 }, 'warm.md': { reads: 9, exposureSessions: 50 } };
  const res = runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });

  assert.deepEqual(res.evicted.map((e) => e.target), ['cold.md']);
  const idx = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.ok(!idx.includes('(cold.md)'), 'index line removed');
  assert.ok(idx.includes('(warm.md)'), 'other entries preserved');
  assert.ok(fs.existsSync(path.join(memoryDir, 'cold.md')), 'BODY FILE MUST SURVIVE');
});

test('the eviction record stores the verbatim line so restoring is mechanical', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { cold: { hook: 'the exact hook text' }, warm: {} });
  seedProbes(stateDir, [{ q: 'cold', expect: 'cold.md' }, { q: 'warm', expect: 'warm.md' }]);
  const usage = { 'cold.md': { reads: 0, exposureSessions: 50 }, 'warm.md': { reads: 9, exposureSessions: 50 } };
  runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });

  const rec = JSON.parse(fs.readFileSync(evictedFile(stateDir), 'utf8'));
  assert.equal(rec.length, 1);
  assert.equal(rec[0].target, 'cold.md');
  assert.equal(rec[0].line, '- [cold](cold.md) - the exact hook text');
  assert.equal(rec[0].reads, 0);
  assert.ok(rec[0].evictedAt > 0);
});

test('a pinned fact survives eviction even when it is the coldest', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, {
    warned: { body: 'do not resume this line', hook: 'closed' },
    plain: { body: 'ordinary', hook: 'ordinary' },
  });
  seedProbes(stateDir, [{ q: 'warned', expect: 'warned.md' }, { q: 'plain', expect: 'plain.md' }]);
  const usage = { 'warned.md': { reads: 0, exposureSessions: 99 }, 'plain.md': { reads: 5, exposureSessions: 99 } };
  const res = runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });
  assert.deepEqual(res.evicted.map((e) => e.target), ['plain.md']);
  assert.ok(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8').includes('(warned.md)'));
});

test('the header and non-entry lines are preserved', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { cold: {}, warm: {} });
  seedProbes(stateDir, [{ q: 'cold', expect: 'cold.md' }, { q: 'warm', expect: 'warm.md' }]);
  const usage = { 'cold.md': { reads: 0, exposureSessions: 50 }, 'warm.md': { reads: 9, exposureSessions: 50 } };
  const res = runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });
  assert.equal(res.evicted.length, 1, 'guard: this test is only meaningful if something was evicted');
  assert.ok(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8').startsWith('# Memory index'));
});

test('a missing MEMORY.md is a no-op rather than a throw', () => {
  const { memoryDir, stateDir } = tmpDirs();
  assert.doesNotThrow(() => {
    const res = runEviction({ memoryDir, stateDir, budgetBytes: 10 });
    assert.deepEqual(res.evicted, []);
  });
});

// Eviction without a fault signal is silent permanent loss: the model cannot
// ask for a fact it does not know exists.
test('eviction writes a footer stating how many facts are hidden', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { cold: {}, warm: {} });
  seedProbes(stateDir, [{ q: 'cold', expect: 'cold.md' }, { q: 'warm', expect: 'warm.md' }]);
  const usage = { 'cold.md': { reads: 0, exposureSessions: 50 }, 'warm.md': { reads: 9, exposureSessions: 50 } };
  runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });
  const idx = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.match(idx, /1 older memory is not listed/);
  assert.match(idx, /memory-lookup/, 'the signal must name the tool');
});

test('a second eviction replaces the footer rather than stacking them', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { a: {}, b: {}, c: {} });
  // a/b/c are single-letter slugs (no lexical signal in title/slug), and all
  // three share the default body 'body text' verbatim, so any probe query
  // that matches that shared body retrieves all three, guaranteeing a hit
  // regardless of which one a given probe expects.
  seedProbes(stateDir, [
    { q: 'body text', expect: 'a.md' },
    { q: 'body text', expect: 'b.md' },
    { q: 'body text', expect: 'c.md' },
  ]);
  const usage = {
    'a.md': { reads: 0, exposureSessions: 50 },
    'b.md': { reads: 1, exposureSessions: 50 },
    'c.md': { reads: 9, exposureSessions: 50 },
  };
  runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });
  runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });
  const idx = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.equal(idx.split('memory-lookup').length - 1, 1, 'exactly one footer');
  assert.match(idx, /2 older memories are not listed/);
});

test('the footer is not parsed as an index entry', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { cold: {}, warm: {} });
  seedProbes(stateDir, [{ q: 'cold', expect: 'cold.md' }, { q: 'warm', expect: 'warm.md' }]);
  const usage = { 'cold.md': { reads: 0, exposureSessions: 50 }, 'warm.md': { reads: 9, exposureSessions: 50 } };
  runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });
  const entries = parseIndex(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'));
  assert.deepEqual(entries.map((e) => e.target), ['warm.md']);
});

// A resolved fault proves the eviction was wrong. Never repeat it.
test('a faulted-in fact is pinned against re-eviction', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { faulted: {}, other: {} });
  fs.writeFileSync(path.join(stateDir, 'memory', 'faulted.json'), JSON.stringify(['faulted.md']));
  const entries = parseIndex(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'));
  assert.ok(pinnedTargets(memoryDir, entries, stateDir).has('faulted.md'));
});

test('successive evictions append to the record rather than replacing it', () => {
  const { memoryDir, stateDir } = tmpDirs();
  seed(memoryDir, { a: {}, b: {}, c: {} });
  seedProbes(stateDir, [
    { q: 'body text', expect: 'a.md' },
    { q: 'body text', expect: 'b.md' },
    { q: 'body text', expect: 'c.md' },
  ]);
  const usage = {
    'a.md': { reads: 0, exposureSessions: 50 },
    'b.md': { reads: 1, exposureSessions: 50 },
    'c.md': { reads: 9, exposureSessions: 50 },
  };
  runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });
  runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage });
  const rec = JSON.parse(fs.readFileSync(evictedFile(stateDir), 'utf8'));
  assert.equal(rec.length, 2);
  assert.deepEqual(rec.map((r) => r.target), ['a.md', 'b.md']);
});

test('runEviction: salience protects a linked fact from eviction (actuation)', () => {
  const { memoryDir, stateDir } = tmpDirs();
  // aaa-keep is alphabetically FIRST, so under the old name-only tie-break it
  // would be evicted first among equally-cold facts. mmm-linker links to it, so
  // its inbound salience is highest and must flip the outcome: it survives.
  seed(memoryDir, {
    'aaa-keep': { body: 'keepsubject matters here', hook: 'k' },
    'mmm-linker': { body: '[[aaa-keep]] linkersubject here', hook: 'l' },
    'zzz-island': { body: 'islandsubject alone here', hook: 'i' },
  });
  seedProbes(stateDir, [
    { q: 'keepsubject', expect: 'aaa-keep.md' },
    { q: 'linkersubject', expect: 'mmm-linker.md' },
    { q: 'islandsubject', expect: 'zzz-island.md' },
  ]);
  // Empty usage: all three tie on reads(0) and exposure(0), so the inbound-link
  // salience term (with name as the final tie-break) alone decides.
  const r = runEviction({ memoryDir, stateDir, budgetBytes: indexBytes(memoryDir) - 1, usage: {} });
  const evicted = r.evicted.map((p) => p.target);
  assert.equal(evicted.length, 1);
  assert.ok(!evicted.includes('aaa-keep.md'),
    `salience should protect the most-linked fact from eviction, got ${JSON.stringify(evicted)}`);
});
