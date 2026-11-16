import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/evaluation/memory-distill-core.js';

const base = {
  name: 'agy-arg-order', description: '--model before -p', type: 'reference',
  body: 'agy needs --model before -p', wikilinks: [], confidence: 0.95,
};

test('renderMemoryFile has frontmatter + body', () => {
  const md = core.renderMemoryFile(base, { sessionId: 's1' });
  assert.match(md, /^---\n/);
  assert.match(md, /name: agy-arg-order/);
  assert.match(md, /type: reference/);
  assert.match(md, /originSessionId: s1/);
  assert.match(md, /--model before -p|agy needs/);
});

test('renderIndexLine format', () => {
  assert.equal(
    core.renderIndexLine(base),
    `- [agy-arg-order](agy-arg-order.md)${core.SEPARATOR}--model before -p`,
  );
});

// Index lines are content the user reads, so the global no-em-dash policy
// applies to them. The glyph is built via fromCharCode because that same
// policy blocks the literal character from being written into source.
test('renderIndexLine separator honors the no-em-dash policy', () => {
  assert.ok(!core.renderIndexLine(base).includes(String.fromCharCode(0x2014)));
});

// MEMORY.md is inlined into every session's context, so each line is a
// pointer, not a summary. The full description always survives in the body
// file's frontmatter, so capping here loses nothing corpus-wide.

const longDesc = 'DECLINED 2026-07-22 as a dependency because it installs a second Stop hook '
  + 'and auto-appends every turn, which collides with our propose-only gate; three zero-dep '
  + 'borrows were identified instead, none of them worth building yet.';

test('renderIndexLine caps a long line to the budget', () => {
  const line = core.renderIndexLine({ ...base, name: 'memsearch-eval', description: longDesc });
  assert.ok(line.length <= core.INDEX_LINE_MAX, `line was ${line.length} chars: ${line}`);
});

test('renderIndexLine leaves a short description untouched', () => {
  assert.ok(core.renderIndexLine(base).endsWith('--model before -p'));
});

test('renderIndexLine never splits a word', () => {
  const line = core.renderIndexLine({ ...base, name: 'memsearch-eval', description: longDesc });
  const tail = line.replace(/\.\.\.$/, '').split(' ').pop();
  assert.ok(longDesc.split(/\s+/).includes(tail), `truncated mid-word: "${tail}"`);
});

test('renderIndexLine prefers a sentence boundary over a hard cut', () => {
  const d = `A complete first clause that comfortably clears the floor. ${'x'.repeat(200)}`;
  const line = core.renderIndexLine({ ...base, name: 'bnd', description: d });
  assert.ok(line.endsWith('A complete first clause that comfortably clears the floor'), line);
  assert.ok(!line.endsWith('...'), 'a clean clause cut should not be marked truncated');
});

test('renderIndexLine marks a hard cut as truncated', () => {
  const line = core.renderIndexLine({ ...base, name: 'memsearch-eval', description: longDesc });
  assert.ok(line.endsWith('...'), line);
});

// The floor wins over the line cap on purpose: the link prefix is
// structural, so a descriptive title must not starve its own punchline.
test('renderIndexLine keeps a usable description floor even for a very long slug', () => {
  const name = 'evolution-pillar-and-capability-lifecycle-with-an-absurdly-long-slug';
  const line = core.renderIndexLine({ ...base, name, description: longDesc });
  const desc = line.slice(line.indexOf('.md)') + core.SEPARATOR.length + 4);
  // The floor bounds the BUDGET; a word-boundary cut lands a few chars under
  // it rather than splitting a word, so assert the useful range.
  assert.ok(desc.length > 55 && desc.length <= 70, `floor not honored, got ${desc.length}: ${desc}`);
});

// Regression: the real "Parallel agents: uncommitted work loss" entry has an
// 87-char prefix. Under a strict line cap its hook collapsed to 32 chars and
// lost the rule it exists to state.
test('renderIndexLine keeps the punchline when the title is long', () => {
  const line = core.renderIndexLine({
    ...base,
    name: 'parallel-agents-uncommitted-work-loss',
    description: 'never "don\'t commit" in a shared worktree; a sibling\'s git checkout destroys it',
  });
  assert.ok(line.includes('shared worktree'), line);
});

test('renderIndexLine collapses whitespace so a line stays one line', () => {
  const line = core.renderIndexLine({ ...base, description: 'has\na newline   and  gaps' });
  assert.ok(!line.includes('\n'));
  assert.ok(line.endsWith('has a newline and gaps'));
});

test('capping the index line does not touch the body frontmatter', () => {
  const md = core.renderMemoryFile({ ...base, name: 'memsearch-eval', description: longDesc });
  assert.ok(md.includes(longDesc), 'full description must survive in the body file');
});

test('condense drops tool noise, keeps text', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hello world' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'HUGE' }] } }),
  ];
  const out = core.condenseTranscript(lines, { maxBytes: 60000 });
  assert.match(out, /hello world/);
  assert.match(out, /answer/);
  assert.doesNotMatch(out, /HUGE/);
});

test('condense skips malformed lines without throwing', () => {
  const lines = ['not json', JSON.stringify({ type: 'user', message: { content: 'ok' } }), ''];
  const out = core.condenseTranscript(lines);
  assert.match(out, /ok/);
});

test('condense truncates to maxBytes keeping the tail', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'AAAAAAAAAA' } }),
    JSON.stringify({ type: 'user', message: { content: 'BBBBBBBBBB' } }),
  ];
  const out = core.condenseTranscript(lines, { maxBytes: 5 });
  assert.equal(out.length, 5);
  assert.match(out, /B+$/);
  assert.doesNotMatch(out, /A/);
});

// glmps-159 (task 6): condenseTranscript's output feeds Mem0's conversational
// admission (memory-plugin.js's condensedToMessages), which needs to tell
// user turns from assistant turns to build a real messages[] array. Every
// consumer above matches on substring, not exact equality, so this role
// prefix is additive and does not disturb them.
test('condense labels each turn with its role (USER:/ASSISTANT:)', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hello there' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi back' }] } }),
  ];
  const out = core.condenseTranscript(lines, { maxBytes: 60000 });
  assert.equal(out, 'USER: hello there\nASSISTANT: hi back');
});

test('condense never labels a line that produced no text', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'noise' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'real content' }] } }),
  ];
  const out = core.condenseTranscript(lines);
  assert.equal(out, 'ASSISTANT: real content');
});

test('slugify lowercases, collapses non-alnum runs, trims edges', () => {
  assert.equal(core.slugify('Agy Arg Order!!'), 'agy-arg-order');
  assert.equal(core.slugify('--leading and trailing--'), 'leading-and-trailing');
});
