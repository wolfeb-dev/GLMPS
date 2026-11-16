#!/usr/bin/env node
// Headless codebase-wiki generator (body: scripts/wiki-build-lib.mjs).
//   node scripts/wiki-build-cli.mjs <projectRoot> [--llm] [--out <dir>] [--cache <file>] [--prior <dir>]
//        [--backend claude|agy|gemini] [--model <claude model>] [--max-model-calls <n>|auto]
//        [--expect-head <sha>] [--no-cache-read] [--state-dir <dir>] [--protocol]
// --protocol prints `WIKI_MODEL_CALL <n> <slug>` before each model call and a
// final `WIKI_RESULT <json>` line; the kernel's wiki loop reads both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWikiBuild, pickWikiBackend } from './wiki-build-lib.mjs';
import { defaultCallModel } from '../server/lib/observability/wiki-llm.js';
import { agyGenerate, agyAvailable } from '../server/lib/observability/wiki-agy.js';
import { runClaude } from '../server/lib/plugins/claude-model.js';

// A build failure is one clean stderr line plus a non-zero exit (the wiki loop
// and POST /api/wiki/rebuild both report it), never a raw stack dump.
process.on('uncaughtException', (e) => { console.error(`wiki: build failed: ${e?.message ?? e}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`wiki: build failed: ${e?.message ?? e}`); process.exit(1); });

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (flag(name) ? args[args.indexOf(name) + 1] : null);
const VALUE_FLAGS = new Set(['--out', '--cache', '--prior', '--backend', '--model', '--max-model-calls', '--expect-head', '--state-dir']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
const root = path.resolve(positional[0] || '.');
const protocol = flag('--protocol');
const useLlm = flag('--llm');

const WIKI_SYSTEM_PROMPT = 'You write one page of the GLMPS wiki in the house voice the prompt gives you. Answer only with the requested Markdown. Never use em or en dashes.';
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const agyReady = agyAvailable();
const requestedBackend = value('--backend');
let backend = pickWikiBackend({ requested: requestedBackend, agyReady, apiKey });
// an EXPLICITLY requested backend that falls
// back used to be diagnosed only by a console.log gated on the non-protocol
// branch below -- the wiki loop's own spawnWikiBuild always passes
// --protocol, so in the one invocation path that matters in production this
// was completely silent. stderr (never stdout: --protocol reserves stdout
// for the WIKI_MODEL_CALL/WIKI_RESULT line protocol), unconditional on
// --protocol, so it survives in the stderr tail wiki-loop.js already
// captures and reports on failure.
if (useLlm && requestedBackend && backend !== requestedBackend) {
  process.stderr.write(`wiki: requested backend '${requestedBackend}' unavailable, falling back to '${backend}'\n`);
}

let callModel = null;
let throttle = async () => {};
if (backend === 'claude') {
  const model = value('--model') || 'haiku';
  callModel = (prompt) => runClaude({ model, system: WIKI_SYSTEM_PROMPT, prompt, timeoutMs: 180000 });
} else if (backend === 'agy') {
  const agyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wiki-run-'));
  callModel = (prompt) => agyGenerate(prompt, { cwd: agyCwd });
} else if (backend === 'gemini') {
  callModel = (prompt) => defaultCallModel(prompt, { apiKey });
  let last = 0; // the direct Gemini free tier allows about 10 rpm
  throttle = async () => { const wait = 6500 - (Date.now() - last); if (wait > 0) await new Promise(r => setTimeout(r, wait)); last = Date.now(); };
}

const cap = value('--max-model-calls');
const summary = await runWikiBuild({
  root, useLlm, callModel, throttle,
  outDir: value('--out'), cacheFile: value('--cache'), priorDir: value('--prior'), stateDir: value('--state-dir'),
  maxModelCalls: cap === 'auto' ? 'auto' : (cap ? Number(cap) : Infinity),
  expectHead: value('--expect-head'), readCache: !flag('--no-cache-read'),
  onModelCall: protocol ? ({ n, slug }) => process.stdout.write(`WIKI_MODEL_CALL ${n} ${slug}\n`) : () => {},
  progress: protocol ? () => {} : (c) => process.stdout.write(c),
});

if (summary.skipped) {
  if (protocol) process.stdout.write(`WIKI_RESULT ${JSON.stringify(summary)}\n`);
  else console.log(`wiki: no graph at ${summary.graphPath} - nothing to build`);
  process.exit(0);
}
if (protocol) {
  process.stdout.write(`WIKI_RESULT ${JSON.stringify({ ...summary, backend })}\n`);
} else {
  process.stdout.write('\n');
  if (useLlm && backend === 'none') console.log('wiki: --llm requested but no backend available; structural only');
  else if (useLlm) console.log(`wiki: llm backend = ${backend}`);
  console.log(`wiki: ${summary.sections} sections (llm: ${summary.llmSections}) -> ${summary.outDir}`);
}
