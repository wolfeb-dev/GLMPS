import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_TARGETS, RULES_BEGIN, RULES_END, projectRules, renderRulesBlock, applyRulesBlock, extractRulesBlock } from '../lib/governance/agent-rules.js';
import { MEMORY_MANAGED_BEGIN, MEMORY_MANAGED_END, mergeManagedSection } from '../lib/governance/vendor-writers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test.skip('AC-4: GEMINI.md and AGENTS.md carry the CLAUDE.md rules exactly (run node scripts/sync-agent-rules.mjs when this fails)', () => {
  const claudeMd = read('CLAUDE.md');
  for (const t of RULES_TARGETS) {
    assert.equal(extractRulesBlock(read(t.file)), renderRulesBlock(claudeMd, t), `${t.file} is stale`);
  }
});

test('the rules drop every managed block from the source, keep its own text, and name who they are for', () => {
  const src = `# Rules\n\nDo X.\n${MEMORY_MANAGED_BEGIN}\nmemory\n${MEMORY_MANAGED_END}\nAfter.\n`;
  assert.equal(projectRules(src), '# Rules\n\nDo X.\nAfter.');
  const block = renderRulesBlock(src, { agents: 'Gemini' });
  assert.ok(block.startsWith(RULES_BEGIN) && block.endsWith(RULES_END));
  assert.match(block, /Project rules for Gemini/);
  assert.doesNotMatch(block, /memory\n/);
});

test('the block is replaced in place, prepended when absent, and survives a memory sync', () => {
  const memory = `${MEMORY_MANAGED_BEGIN}\nfacts\n${MEMORY_MANAGED_END}\n`;
  const b1 = renderRulesBlock('# v1', { agents: 'Gemini' });
  const b2 = renderRulesBlock('# v2', { agents: 'Gemini' });
  const once = applyRulesBlock(memory, b1);
  assert.ok(once.startsWith(RULES_BEGIN));
  const twice = applyRulesBlock(once, b2);
  assert.equal(extractRulesBlock(twice), b2);
  assert.equal(twice.split(RULES_BEGIN).length, 2);
  assert.ok(twice.includes('facts'));
  const resynced = mergeManagedSection(twice, 'new facts', { begin: MEMORY_MANAGED_BEGIN, end: MEMORY_MANAGED_END });
  assert.equal(extractRulesBlock(resynced), b2, 'a memory push leaves the rules block alone');
  assert.ok(resynced.includes('new facts'));
});
