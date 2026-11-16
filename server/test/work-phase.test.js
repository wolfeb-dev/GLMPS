import test from 'node:test';
import assert from 'node:assert/strict';
import { workPhase } from '../lib/observability/work-phase.js';

test('empty events -> idle with empty doing', () => {
  const r = workPhase([]);
  assert.equal(r.phase, 'idle');
  assert.equal(r.label, 'Idle');
  assert.equal(r.doing, '');
});

test('non-array input -> idle', () => {
  const r = workPhase(undefined);
  assert.equal(r.phase, 'idle');
});

test('skill label -> brainstorm', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:brainstorming', ts: 1 },
  ]);
  assert.equal(r.phase, 'brainstorm');
  assert.equal(r.label, 'Brainstorm');
  assert.equal(r.doing, 'brainstorming');
});

test('skill label -> spec (writing-plans)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:writing-plans', ts: 1 },
  ]);
  assert.equal(r.phase, 'spec');
  assert.equal(r.label, 'Spec');
});

test('skill label -> spec (executing-plans)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:executing-plans', ts: 1 },
  ]);
  assert.equal(r.phase, 'spec');
});

test('skill label -> coding (test-driven-development)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:test-driven-development', ts: 1 },
  ]);
  assert.equal(r.phase, 'coding');
  assert.equal(r.label, 'Coding');
});

test('skill label -> coding (subagent-driven-development)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:subagent-driven-development', ts: 1 },
  ]);
  assert.equal(r.phase, 'coding');
});

test('skill label -> coding (dispatching-parallel-agents)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:dispatching-parallel-agents', ts: 1 },
  ]);
  assert.equal(r.phase, 'coding');
});

test('skill label -> debug (systematic-debugging)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:systematic-debugging', ts: 1 },
  ]);
  assert.equal(r.phase, 'debug');
  assert.equal(r.label, 'Debug');
});

test('skill label -> debug (diagnose)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'diagnose', ts: 1 },
  ]);
  assert.equal(r.phase, 'debug');
});

test('skill label -> verify (verification-before-completion)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:verification-before-completion', ts: 1 },
  ]);
  assert.equal(r.phase, 'verify');
  assert.equal(r.label, 'Verify');
});

test('skill label -> review (requesting-code-review)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:requesting-code-review', ts: 1 },
  ]);
  assert.equal(r.phase, 'review');
  assert.equal(r.label, 'Review');
});

test('skill label -> review (receiving-code-review)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:receiving-code-review', ts: 1 },
  ]);
  assert.equal(r.phase, 'review');
});

test('skill label -> review (code-review)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'code-review', ts: 1 },
  ]);
  assert.equal(r.phase, 'review');
});

test('skill label -> review (bare "review")', () => {
  const r = workPhase([
    { kind: 'skill', label: 'review', ts: 1 },
  ]);
  assert.equal(r.phase, 'review');
});

test('skill label -> research (graphify)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'graphify', ts: 1 },
  ]);
  assert.equal(r.phase, 'research');
  assert.equal(r.label, 'Research');
});

test('skill label -> research (deep-research)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'deep-research', ts: 1 },
  ]);
  assert.equal(r.phase, 'research');
});

test('skill label -> research (storm-research)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'storm-research', ts: 1 },
  ]);
  assert.equal(r.phase, 'research');
});

test('skill label -> research (web-researcher)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'web-researcher', ts: 1 },
  ]);
  assert.equal(r.phase, 'research');
});

test('doing strips leading namespace prefix', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:verification-before-completion', ts: 1 },
  ]);
  assert.equal(r.doing, 'verification-before-completion');
});

test('most-recent-wins across multiple skill events (numeric ts)', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:brainstorming', ts: 1 },
    { kind: 'skill', label: 'superpowers:test-driven-development', ts: 5 },
    { kind: 'skill', label: 'superpowers:writing-plans', ts: 3 },
  ]);
  assert.equal(r.phase, 'coding');
});

test('ISO-string ts and numeric ts compare correctly, later wins', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:brainstorming', ts: '2026-07-01T10:00:00Z' },
    { kind: 'skill', label: 'superpowers:systematic-debugging', ts: '2026-07-01T10:05:00Z' },
  ]);
  assert.equal(r.phase, 'debug');
});

test('mixed ISO-string and numeric ts, numeric later wins', () => {
  const isoEarly = new Date('2026-07-01T10:00:00Z').getTime();
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:brainstorming', ts: '2026-07-01T10:00:00Z' },
    { kind: 'file-edit', label: 'a.js', path: '/proj/a.js', ts: isoEarly + 60000 },
  ]);
  assert.equal(r.phase, 'coding');
  assert.equal(r.doing, 'editing a.js');
});

test('file-edit fallback -> coding with doing="editing <basename>"', () => {
  const r = workPhase([
    { kind: 'file-edit', label: 'D:\\proj\\lib\\parser.js', path: 'D:\\proj\\lib\\parser.js', ts: 1 },
  ]);
  assert.equal(r.phase, 'coding');
  assert.equal(r.label, 'Coding');
  assert.equal(r.doing, 'editing parser.js');
});

test('file-edit with no path -> doing="editing files"', () => {
  const r = workPhase([
    { kind: 'file-edit', label: null, path: null, ts: 1 },
  ]);
  assert.equal(r.phase, 'coding');
  assert.equal(r.doing, 'editing files');
});

test('command test-runner -> verify (npm test)', () => {
  const r = workPhase([
    { kind: 'command', label: 'npm test', ts: 1 },
  ]);
  assert.equal(r.phase, 'verify');
  assert.equal(r.label, 'Verify');
  assert.equal(r.doing, 'npm test');
});

test('command test-runner -> verify (node --test)', () => {
  const r = workPhase([
    { kind: 'command', label: 'node --test server/test/work-phase.test.js', ts: 1 },
  ]);
  assert.equal(r.phase, 'verify');
});

test('command test-runner -> verify (pytest)', () => {
  const r = workPhase([
    { kind: 'command', label: 'pytest -q', ts: 1 },
  ]);
  assert.equal(r.phase, 'verify');
});

test('command test-runner -> verify (jest, vitest, go test, cargo test)', () => {
  for (const cmd of ['jest --ci', 'vitest run', 'go test ./...', 'cargo test --release']) {
    const r = workPhase([{ kind: 'command', label: cmd, ts: 1 }]);
    assert.equal(r.phase, 'verify', `expected verify for "${cmd}"`);
  }
});

test('command test-runner doing is truncated to ~40 chars', () => {
  const long = 'npm test -- --reporter=spec --very-long-flag-that-goes-on-and-on';
  const r = workPhase([{ kind: 'command', label: long, ts: 1 }]);
  assert.equal(r.phase, 'verify');
  assert.ok(r.doing.length <= 40, `doing too long: "${r.doing}" (${r.doing.length})`);
});

test('non-matching command is ignored -> idle', () => {
  const r = workPhase([
    { kind: 'command', label: 'ls -la', ts: 1 },
  ]);
  assert.equal(r.phase, 'idle');
  assert.equal(r.doing, '');
});

test('non-matching command ignored while an earlier skill signal still applies', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:brainstorming', ts: 1 },
    { kind: 'command', label: 'ls -la', ts: 5 },
  ]);
  assert.equal(r.phase, 'brainstorm');
});

test('unrecognized skill label is ignored', () => {
  const r = workPhase([
    { kind: 'skill', label: 'some-unrelated-skill', ts: 1 },
  ]);
  assert.equal(r.phase, 'idle');
});

test('later file-edit overrides earlier skill signal', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:brainstorming', ts: 1 },
    { kind: 'file-edit', label: 'x.js', path: '/proj/x.js', ts: 2 },
  ]);
  assert.equal(r.phase, 'coding');
  assert.equal(r.doing, 'editing x.js');
});

test('later skill signal overrides earlier file-edit', () => {
  const r = workPhase([
    { kind: 'file-edit', label: 'x.js', path: '/proj/x.js', ts: 1 },
    { kind: 'skill', label: 'superpowers:requesting-code-review', ts: 2 },
  ]);
  assert.equal(r.phase, 'review');
});

test('events out of chronological order still resolve by max ts', () => {
  const r = workPhase([
    { kind: 'skill', label: 'superpowers:verification-before-completion', ts: 10 },
    { kind: 'skill', label: 'superpowers:brainstorming', ts: 1 },
  ]);
  assert.equal(r.phase, 'verify');
});

// The Pocock skill names (card glmps-2-0-33): same phases as the superpowers ones they replace.
for (const [label, phase] of [
  ['grilling', 'brainstorm'], ['grill-with-docs', 'brainstorm'],
  ['to-spec', 'spec'], ['to-tickets', 'spec'],
  ['implement', 'coding'], ['implement-spec', 'coding'], ['mattpocock-skills:tdd', 'coding'],
  ['mattpocock-skills:diagnosing-bugs', 'debug'], ['mattpocock-skills:code-review', 'review'],
]) {
  test(`skill label -> ${phase} (${label})`, () => {
    assert.equal(workPhase([{ kind: 'skill', label, ts: 1 }]).phase, phase);
  });
}
