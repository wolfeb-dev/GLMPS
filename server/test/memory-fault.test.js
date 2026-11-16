import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  indexFooter, lookupFacts, faultIn, faultedTargets, faultedFile,
} from '../lib/evaluation/memory-fault.js';
import { evictedFile } from '../lib/evaluation/memory-evict-runner.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fault-'));
  const memoryDir = path.join(root, 'memory');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'memory'), { recursive: true });
  return { memoryDir, stateDir };
}

function writeFact(memoryDir, slug, body) {
  fs.writeFileSync(path.join(memoryDir, `${slug}.md`), `---\nname: ${slug}\ndescription: d\n---\n\n${body}\n`);
}

// Without this line the model does not know a miss is possible, so nothing
// else in this module is reachable. It is the load-bearing piece.
test('no footer when nothing is hidden', () => {
  assert.equal(indexFooter(0), '');
});

test('footer states the count and how to search', () => {
  const f = indexFooter(7);
  assert.match(f, /7 older/, 'the hidden count must be stated');
  assert.match(indexFooter(1), /1 older memory is/, 'singular reads correctly');
  assert.match(f, /memory-lookup/, 'must name the tool, or the signal is unactionable');
});

test('footer is a single line so it cannot disturb index parsing', () => {
  assert.ok(!indexFooter(3).includes('\n'));
});

test('finds a fact by body content', () => {
  const { memoryDir } = tmpDirs();
  writeFact(memoryDir, 'quantower-name', 'Quantower strategies must set Name in the constructor or they fail to load');
  writeFact(memoryDir, 'unrelated', 'the northwind dashboard regenerates a news overlay daily');
  const hits = lookupFacts(memoryDir, 'why does my Quantower indicator not load');
  assert.equal(hits[0].target, 'quantower-name.md');
});

// The whole point: an evicted fact has no index line, and must still be findable.
test('finds a fact whose index line has been evicted', () => {
  const { memoryDir } = tmpDirs();
  writeFact(memoryDir, 'evicted-one', 'the ln -s command copies instead of symlinking under MSYS');
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n');
  const hits = lookupFacts(memoryDir, 'symlink copies instead of linking');
  assert.equal(hits[0].target, 'evicted-one.md');
});

test('returns [] for a query matching nothing rather than a random fact', () => {
  const { memoryDir } = tmpDirs();
  writeFact(memoryDir, 'a', 'quantower strategies must set Name');
  assert.deepEqual(lookupFacts(memoryDir, 'zzzz qqqq vvvv'), []);
});

test('MEMORY.md is excluded from lookup results', () => {
  const { memoryDir } = tmpDirs();
  writeFact(memoryDir, 'a', 'quantower strategies must set Name in the constructor');
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- [a](a.md) - quantower strategies must set Name');
  assert.ok(!lookupFacts(memoryDir, 'quantower Name constructor').some((h) => h.target === 'MEMORY.md'));
});

test('results carry an excerpt so a hit is useful without a second read', () => {
  const { memoryDir } = tmpDirs();
  writeFact(memoryDir, 'a', 'Quantower strategies must set Name in the constructor');
  const [hit] = lookupFacts(memoryDir, 'Quantower Name constructor');
  assert.match(hit.excerpt, /Quantower/);
});

test('a missing memory dir yields [] rather than throwing', () => {
  assert.deepEqual(lookupFacts(path.join(os.tmpdir(), 'mc-does-not-exist-xyz'), 'anything'), []);
});

test('tier: "curated" still works (the recall gate\'s explicit call)', () => {
  const { memoryDir } = tmpDirs();
  writeFact(memoryDir, 'a', 'quantower strategies must set Name');
  const hits = lookupFacts(memoryDir, 'quantower Name', { tier: 'curated' });
  assert.ok(hits.length && hits.every((h) => h.tier === 'curated'));
});

// D23/D24 cutover (task 6): the L3 distilled pool this used to also scan is
// retired, so 'distilled' is no longer a recognized tier value.
test('tier: "distilled" now throws -- that pool is retired', () => {
  const { memoryDir } = tmpDirs();
  writeFact(memoryDir, 'a', 'anything');
  assert.throws(() => lookupFacts(memoryDir, 'anything', { tier: 'distilled' }), /unknown tier/);
});

test('restores the evicted index line verbatim', () => {
  const { memoryDir, stateDir } = tmpDirs();
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n\n- [Kept](kept.md) - still here\n');
  fs.writeFileSync(evictedFile(stateDir), JSON.stringify([
    { target: 'gone.md', line: '- [Gone](gone.md) - the exact original hook', reads: 0, evictedAt: 1 },
  ]));
  const res = faultIn({ memoryDir, stateDir, target: 'gone.md' });
  assert.equal(res.restored, true);
  const idx = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.ok(idx.includes('- [Gone](gone.md) - the exact original hook'));
  assert.ok(idx.includes('- [Kept](kept.md) - still here'), 'existing entries preserved');
});

// A resolved fault is evidence the eviction was WRONG. Never repeat it.
test('a faulted-in fact is recorded so it is pinned against re-eviction', () => {
  const { memoryDir, stateDir } = tmpDirs();
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n');
  fs.writeFileSync(evictedFile(stateDir), JSON.stringify([
    { target: 'gone.md', line: '- [Gone](gone.md) - hook', reads: 0, evictedAt: 1 },
  ]));
  faultIn({ memoryDir, stateDir, target: 'gone.md' });
  assert.ok(faultedTargets(stateDir).has('gone.md'));
});

test('faulting in a fact that was never evicted is a safe no-op', () => {
  const { memoryDir, stateDir } = tmpDirs();
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n\n- [A](a.md) - hook\n');
  const before = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  const res = faultIn({ memoryDir, stateDir, target: 'never-evicted.md' });
  assert.equal(res.restored, false);
  assert.equal(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'), before);
});

test('faulting in twice does not duplicate the index line', () => {
  const { memoryDir, stateDir } = tmpDirs();
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n');
  fs.writeFileSync(evictedFile(stateDir), JSON.stringify([
    { target: 'gone.md', line: '- [Gone](gone.md) - hook', reads: 0, evictedAt: 1 },
  ]));
  faultIn({ memoryDir, stateDir, target: 'gone.md' });
  faultIn({ memoryDir, stateDir, target: 'gone.md' });
  const idx = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.equal(idx.split('(gone.md)').length - 1, 1);
});

test('faultedTargets is empty and does not throw on a fresh state dir', () => {
  const { stateDir } = tmpDirs();
  assert.equal(faultedTargets(stateDir).size, 0);
  assert.ok(!fs.existsSync(faultedFile(stateDir)) || true);
});
