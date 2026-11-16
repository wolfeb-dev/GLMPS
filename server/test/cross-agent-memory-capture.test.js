import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryFile, captureCandidates } from '../lib/governance/cross-agent-memory.js';
import { renderMemoryFile } from '../lib/evaluation/memory-distill-core.js';

test('parseMemoryFile round-trips renderMemoryFile output', () => {
  const fact = { name: 'Foo Bar', description: 'A test fact.', type: 'project', body: 'This is the body.', wikilinks: [] };
  const content = renderMemoryFile(fact, { sessionId: 's1' });
  const parsed = parseMemoryFile(content);
  assert.equal(parsed.name, 'foo-bar'); // slugified in the rendered file
  assert.equal(parsed.description, 'A test fact.');
  assert.equal(parsed.type, 'project');
  assert.equal(parsed.body, 'This is the body.');
});

test('parseMemoryFile: no frontmatter -> null', () => {
  assert.equal(parseMemoryFile('just some text'), null);
  assert.equal(parseMemoryFile(''), null);
  assert.equal(parseMemoryFile(null), null);
});

test('captureCandidates: reads every .md file except MEMORY.md, skips unparseable', () => {
  const factA = renderMemoryFile({ name: 'a', description: 'desc a', type: 'user', body: 'body a', wikilinks: [] });
  const factB = renderMemoryFile({ name: 'b', description: 'desc b', type: 'feedback', body: 'body b', wikilinks: [] });
  const files = { 'a.md': factA, 'b.md': factB, 'MEMORY.md': '# Memory index\n', 'junk.md': 'no frontmatter here' };
  const facts = captureCandidates('/fake/memory', {
    readdirSync: () => Object.keys(files),
    readFileSync: (p) => files[p.replace(/^.*[\\/]/, '')],
  });
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map(f => f.name).sort(), ['a', 'b']);
});

test('captureCandidates: missing memory dir -> []', () => {
  const facts = captureCandidates('/does/not/exist', {
    readdirSync: () => { throw new Error('ENOENT'); },
  });
  assert.deepEqual(facts, []);
});

test('parseMemoryFile: strips trailing wikilinks block appended by renderMemoryFile', () => {
  const fact = {
    name: 'Foo',
    description: 'd',
    type: 'project',
    body: 'This is the body.',
    wikilinks: ['other-fact', 'another-fact'],
  };
  const content = renderMemoryFile(fact);
  const parsed = parseMemoryFile(content);
  assert.equal(parsed.body, fact.body);
});

test('parseMemoryFile: preserves an inline wikilink inside body prose', () => {
  const fact = {
    name: 'Bar',
    description: 'd',
    type: 'project',
    body: 'See [[other-fact]] for more context, this continues after.',
    wikilinks: ['trailing-fact'],
  };
  const content = renderMemoryFile(fact);
  const parsed = parseMemoryFile(content);
  assert.equal(parsed.body, fact.body);
  assert.match(parsed.body, /\[\[other-fact\]\]/);
});
