#!/usr/bin/env node
// Copy this repo's CLAUDE.md project rules into GEMINI.md and AGENTS.md (card
// glmps-2-0-162), so Gemini, GPT and Grok work under the same rules as Claude.
//
//   node scripts/sync-agent-rules.mjs          rewrite the generated blocks
//   node scripts/sync-agent-rules.mjs --check  exit 1 if either file is stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_TARGETS, renderRulesBlock, applyRulesBlock, extractRulesBlock } from '../server/lib/governance/agent-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const claudeMd = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
let stale = 0;
for (const t of RULES_TARGETS) {
  const file = path.join(root, t.file);
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = renderRulesBlock(claudeMd, t);
  if (extractRulesBlock(cur) === block) { console.log(`${t.file}: up to date`); continue; }
  stale += 1;
  if (check) { console.log(`${t.file}: stale, run node scripts/sync-agent-rules.mjs`); continue; }
  fs.writeFileSync(file, applyRulesBlock(cur, block));
  console.log(`${t.file}: rules block written`);
}
process.exit(check && stale ? 1 : 0);
