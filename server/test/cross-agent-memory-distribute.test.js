import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distributeMemory } from '../lib/governance/cross-agent-memory.js';
import { MEMORY_MANAGED_BEGIN } from '../lib/governance/vendor-writers.js';

test('distributeMemory: creates the memory managed section in a fresh file', () => {
  const entries = [{ name: 'shared-fact', description: 'd', body: 'b' }];
  const results = distributeMemory({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    entries,
    readFile: () => '', exists: () => false, guard: () => ({ allowed: true }),
  });
  assert.equal(results[0].action, 'created');
  assert.ok(results[0].content.includes(MEMORY_MANAGED_BEGIN));
  assert.ok(results[0].content.includes('shared-fact'));
});

test('distributeMemory: unchanged when the section already matches', () => {
  const entries = [{ name: 'shared-fact', description: 'd', body: 'b' }];
  const first = distributeMemory({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    entries, readFile: () => '', exists: () => false, guard: () => ({ allowed: true }),
  });
  const second = distributeMemory({
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    entries, readFile: () => first[0].content, exists: () => true, guard: () => ({ allowed: true }),
  });
  assert.equal(second[0].action, 'unchanged');
});

test('distributeMemory: a guard refusal skips the target', () => {
  const results = distributeMemory({
    targets: [{ vendor: 'claude-code', path: '../escape.md' }],
    entries: [], readFile: () => '', exists: () => false,
    guard: () => ({ allowed: false, reason: 'Path escapes REPO_ROOT' }),
  });
  assert.equal(results[0].action, 'skipped');
});
