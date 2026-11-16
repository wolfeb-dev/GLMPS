#!/usr/bin/env node
// scripts/memory-probe-gen.mjs
// One retrieval probe per CURATED fact. The question comes from the SITUATION
// the fact applies to, not its wording (a self-quoting probe proves nothing).
// Serial: agy correlates responses by newest-DB-by-mtime.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPaths } from '../server/lib/paths.js';
import { agyGenerate, DEFAULT_AGY_MODEL } from '../server/lib/observability/wiki-agy.js';

const MODEL = DEFAULT_AGY_MODEL;
function prompt(title, body) {
  return [
    'You are a text generator. Do NOT use tools. Do NOT read or write files.', '',
    'Below is a note an engineer wrote to their future self.',
    'Write ONE question that engineer would type into a search box MONTHS LATER,',
    'when they hit the situation this note warns about but have forgotten it exists.', '',
    'Rules:',
    '- Describe the SITUATION, not the note. Do not reuse the note\'s distinctive wording.',
    '- One line, under 15 words, no quotes, no preamble. Output the question only.', '',
    `TITLE: ${title}`, 'NOTE:', body.slice(0, 2000),
  ].join('\n');
}

async function main() {
  const P = getPaths();
  const outFile = path.join(P.stateDir, 'memory', 'probes.json');
  const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'probegen-'));
  const names = fs.readdirSync(P.memoryDir).filter((n) => n.toLowerCase().endsWith('.md') && n !== 'MEMORY.md');
  const probes = [];
  for (const name of names) {
    const raw = fs.readFileSync(path.join(P.memoryDir, name), 'utf8');
    const desc = /^---[\s\S]*?\bdescription:\s*(.+)$/m.exec(raw);
    const title = desc ? desc[1].trim() : name.replace(/\.md$/, '').replace(/-/g, ' ');
    const body = raw.replace(/^---[\s\S]*?\n---\s*/, '');
    let q = '';
    try { q = String(await agyGenerate(prompt(title, body), { model: MODEL, cwd: throwaway }) || '').trim(); }
    catch (err) { console.error(`skip ${name}: ${err.message}`); continue; }
    q = q.split('\n')[0].replace(/^["'`]|["'`]$/g, '').trim();
    if (!q || q.length < 8) { console.error(`skip ${name}: unusable`); continue; }
    probes.push({ q, expect: name });
    console.error(`${probes.length}/${names.length} ${name}`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(probes, null, 2));
  console.log(`wrote ${probes.length} probes to ${outFile}`);
  if (probes.length === 0 && names.length > 0) {
    console.error(`ERROR: wrote 0 probes from ${names.length} curated fact(s). The recall gate ` +
      `(MIN_PROBES=20) will stay permanently closed until probes.json has entries. ` +
      `Check that agy is available and retry.`);
    process.exit(1);
  }
  if (probes.length > 0 && probes.length < 20) {
    console.error(`WARNING: only ${probes.length} probe(s) written (need >= 20). The recall gate ` +
      `will stay closed until probes.json reaches 20 entries.`);
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
