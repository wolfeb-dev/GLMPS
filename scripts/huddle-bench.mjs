// scripts/huddle-bench.mjs
// Measures the huddle's text latency against the bar in the glmps-2.0 corpus,
// document 7, section 9 (spike 1), written before this ran:
//   median time-to-first-sentence < 1500 ms name-addressed, < 2500 ms via the
//   Lead (floor + first sentence), on warm turns; floor choice correct on >= 8
//   of the 10 unaddressed turns.
// Two arms (D28): `plan` = claude -p on the operator's Claude Code plan (the
// product path; always runs); `api` = the paid Messages API (a measurement
// only; runs only when ANTHROPIC_API_KEY is set).
//
// LIVE: the plan arm starts real `claude -p` processes on the operator's plan.
// Run it in a plain shell, never from a test (the pool refuses in a test process).
// Usage: node scripts/huddle-bench.mjs [--arms plan,api] [--plan-models opus,sonnet,haiku]
//        [--api-models claude-opus-5,claude-sonnet-5,claude-haiku-4-5] [--out docs/huddle-bench-YYYY-MM-DD.md]
//        [--agents-dir <dir of <name>.md specialist definitions>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeStreamPool } from '../server/lib/plugins/claude-stream.js';
import { streamMessage as apiStream } from './lib/messages-api-stream.mjs';
import { loadPersonas, mindSystemPrompt, leadSystemPrompt } from '../server/lib/huddle/roster.js';
import { addressedPersona, parseFloorReply } from '../server/lib/huddle/floor.js';
import { firstSentenceReached } from '../server/lib/huddle/session.js';
import { resolveTheme } from '../server/lib/scut/bobiverse.js';
import { getPaths } from '../server/lib/paths.js';
import { BAR, classifyCall, scrub, isColdRow, latencyCell, summarizeModel, verdictLines } from './lib/huddle-bench-stats.mjs';

const CALL_TIMEOUT_MS = 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const apiKey = process.env.ANTHROPIC_API_KEY || '';
const ARMS = argOf('--arms', apiKey ? 'plan,api' : 'plan').split(',');
const MODELS = { plan: argOf('--plan-models', 'opus,sonnet,haiku').split(','), api: argOf('--api-models', 'claude-opus-5,claude-sonnet-5,claude-haiku-4-5').split(',') };
const FLOOR = { plan: 'haiku', api: 'claude-haiku-4-5' };
const today = new Date().toISOString().slice(0, 10);
const OUT = argOf('--out', path.join(here, '..', 'docs', `huddle-bench-${today}.md`));

const turns = JSON.parse(fs.readFileSync(path.join(here, '..', 'server', 'test', 'fixtures', 'huddle-floor-turns.json'), 'utf8'));
// Read-only: the same directory the server reads (P.agentsDir = <assetsDir>/agents).
const agentsDir = argOf('--agents-dir', getPaths(process.env).agentsDir);
const personas = loadPersonas({ agentsDir, theme: resolveTheme(false) });
const byId = Object.fromEntries(personas.map((p) => [p.id, p]));
const fmt = (x) => (Number.isFinite(x) ? String(x) : (Number.isNaN(x) ? 'n/a' : 'FAIL'));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

// Every open pool, so Ctrl-C or a kill closes them and orphans no claude process.
const openClosers = new Set();
function closeAll() { for (const c of [...openClosers]) { try { c(); } catch { /* best effort */ } } openClosers.clear(); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { closeAll(); process.exit(sig === 'SIGINT' ? 130 : 143); });

function streamFor(arm) {
  let close;
  let stream;
  if (arm === 'plan') { const pool = createClaudeStreamPool(); stream = pool.streamMessage; close = pool.close; }
  else { stream = (o) => apiStream({ ...o, apiKey, fallbacks: o.body.model === 'claude-opus-5' }); close = () => {}; }
  openClosers.add(close);
  return { stream, close: () => { openClosers.delete(close); close(); } };
}

// One call, never throws: a rejection or a timeout becomes a failed result.
async function safeCall(stream, opts) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await stream({ ...opts, signal: ac.signal });
    return { res, ...classifyCall(res) };
  } catch (e) {
    return { res: null, ...classifyCall(null, new Error(scrub(e?.message ?? e, apiKey))) };
  } finally { clearTimeout(timer); }
}

async function runArm(arm) {
  if (arm === 'api' && !apiKey) return { arm, skipped: 'ANTHROPIC_API_KEY is not set' };
  const rows = [];
  const floorResults = [];
  for (const model of MODELS[arm]) {
    const { stream, close } = streamFor(arm);
    // One growing transcript per model sweep, as in a real huddle, so the
    // plan arm's long-lived processes are fed only what is new.
    const transcript = [];
    try {
      for (const turn of turns) {
        transcript.push({ speaker: 'operator', name: 'Operator', text: turn.text });
        const pathName = turn.addressed ? 'name' : 'lead';
        const named = turn.addressed ? addressedPersona(turn.text, personas) : null;
        let floor = null;
        if (!turn.addressed) {
          const t0 = Date.now();
          const call = await safeCall(stream, { body: { model: FLOOR[arm], max_tokens: 200, system: leadSystemPrompt(personas), messages: [{ role: 'user', content: `Transcript so far:\nOperator: ${turn.text}\n\nSpeak your next line now.` }], transcript: [...transcript], speakerId: 'riker' } });
          const ms = Date.now() - t0;
          if (call.failed) {
            floorResults.push({ model, text: turn.text, picked: [], expected: turn.expected, ok: false, failed: true, error: call.error, ms });
            rows.push({ arm, model, path: pathName, cold: false, failed: true, error: `floor: ${call.error}`, floorMs: ms, floorCold: false, ttftMs: null, firstSentenceMs: Infinity, totalMs: Infinity, total: Infinity, words: 0 });
            process.stdout.write(`${arm} ${model} ${pathName} FAILED (floor): ${call.error}\n`);
            continue;
          }
          floor = { ms, choice: parseFloorReply(call.res.text, personas), cold: Boolean(call.res.cold) };
          const picked = floor.choice.speakers;
          const ok = turn.expected.length === 0 ? picked.length === 0 : picked.some((id) => turn.expected.includes(id));
          floorResults.push({ model, text: turn.text, picked, expected: turn.expected, ok, failed: false, ms, cold: floor.cold });
        }
        const speakerId = named?.id ?? floor?.choice.speakers[0] ?? turn.expected[0] ?? 'bill';
        const t0 = Date.now();
        let firstSentenceMs = null;
        const body = { model, max_tokens: 160, system: mindSystemPrompt(byId[speakerId]), messages: [{ role: 'user', content: `Transcript so far:\nOperator: ${turn.text}\n\nSpeak your next line now.` }], transcript: [...transcript], speakerId };
        if (!/haiku/.test(model)) body.output_config = { effort: 'low' };
        const call = await safeCall(stream, { body, onText: (d, t) => { if (firstSentenceMs === null && firstSentenceReached(t)) firstSentenceMs = Date.now() - t0; } });
        if (call.failed) {
          rows.push({ arm, model, path: pathName, cold: false, failed: true, error: call.error, floorMs: floor?.ms ?? 0, floorCold: Boolean(floor?.cold), ttftMs: null, firstSentenceMs: Infinity, totalMs: Infinity, total: Infinity, words: 0 });
          process.stdout.write(`${arm} ${model} ${pathName} FAILED: ${call.error}\n`);
          continue;
        }
        const res = call.res;
        transcript.push({ speaker: speakerId, name: byId[speakerId].display, text: res.text });
        const fsMs = firstSentenceMs ?? res.totalMs;
        const cold = isColdRow({ floorCold: floor?.cold, mindCold: res.cold });
        rows.push({ arm, model, path: pathName, cold, failed: false, floorMs: floor?.ms ?? 0, floorCold: Boolean(floor?.cold), ttftMs: res.ttftMs, firstSentenceMs: fsMs, totalMs: res.totalMs, total: (floor?.ms ?? 0) + fsMs, words: res.text.split(/\s+/).filter(Boolean).length });
        process.stdout.write(`${arm} ${model} ${pathName}${cold ? ' cold' : ''} ttft=${res.ttftMs}ms first-sentence=${fsMs}ms floor=${floor?.ms ?? 0}ms\n`);
      }
    } finally { close(); }
  }
  return { arm, rows, floorResults };
}

const results = [];
for (const arm of ARMS) results.push(await runArm(arm));

const lines = [`# Huddle bench ${today}`, '',
  `**The bar (written before this run, spec section 9):** median first sentence < ${BAR.nameMs} ms name-addressed and < ${BAR.leadMs} ms through the Lead, warm turns; floor correct on >= ${BAR.floorOk} of ${BAR.floorOf} unaddressed turns, judged per model sweep. A failed, timed-out or empty call counts as a miss in the denominator; a row is cold if the floor call or the mind call was cold.`, '',
  `Measured on this machine on ${today}; one run per cell, not an average of runs. Arms: ${ARMS.join(', ')}.`, ''];
const summaries = { plan: null, api: null };
for (const r of results) {
  lines.push(`## Arm: ${r.arm}`, '');
  if (r.skipped) { lines.push(`Skipped: ${r.skipped}.`, ''); continue; }
  const perModel = MODELS[r.arm].map((model) => summarizeModel({ rows: r.rows, floorResults: r.floorResults, model }));
  summaries[r.arm] = perModel;
  lines.push('| model | path | counted n | failed | median first sentence incl. floor (ms) | p90 (ms) | median floor (ms) | cold first-sentence (ms) | cold floor (ms) | median words | bar | verdict |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const model of MODELS[r.arm]) {
    for (const p of ['name', 'lead']) {
      const all = r.rows.filter((x) => x.model === model && x.path === p);
      const warm = all.filter((x) => !x.cold && !x.failed);
      const coldRows = all.filter((x) => x.cold && !x.failed);
      const bar = p === 'name' ? BAR.nameMs : BAR.leadMs;
      const c = latencyCell(r.rows, model, p, bar);
      lines.push(`| ${model} | ${p} | ${c.n} | ${c.failed} | ${fmt(c.med)} | ${fmt(c.p90)} | ${fmt(median(warm.map((x) => x.floorMs)))} | ${coldRows.map((x) => x.firstSentenceMs).join(', ') || '-'} | ${coldRows.filter((x) => x.floorCold).map((x) => x.floorMs).join(', ') || '-'} | ${fmt(median(all.filter((x) => !x.failed).map((x) => x.words)))} | < ${bar} | ${c.pass ? 'PASS' : 'MISS'} |`);
    }
  }
  lines.push('', '| model | latency (name and lead) | floor | overall |', '|---|---|---|---|');
  for (const m of perModel) lines.push(`| ${m.model} | ${m.latencyPass ? 'PASS' : 'MISS'} | ${m.floor.ok} of ${BAR.floorOf} ${m.floor.pass ? 'PASS' : 'MISS'} | ${m.pass ? 'PASS' : 'MISS'} |`);
  lines.push('');
  for (const model of MODELS[r.arm]) {
    const fr = r.floorResults.filter((f) => f.model === model);
    lines.push(`Floor sweep with mind model ${model} (floor model ${FLOOR[r.arm]}): ${fr.filter((x) => x.ok).length} of ${fr.length} unaddressed turns picked an expected speaker (bar: at least ${BAR.floorOk} of ${BAR.floorOf}).`, '');
    lines.push('| turn | picked | expected | ok | ms | error |', '|---|---|---|---|---|---|');
    for (const f of fr) lines.push(`| ${f.text} | ${f.picked.join(', ') || '(nobody)'} | ${f.expected.join(', ') || '(nobody)'} | ${f.ok ? 'yes' : 'no'} | ${f.ms} | ${f.error ?? ''} |`);
    lines.push('');
  }
}
const verdict = verdictLines({ plan: summaries.plan, api: summaries.api });
lines.push('## Verdict for the product path (D28)', '', ...verdict);
lines.push('', '## Raw rows', '', '| arm | model | path | cold | failed | floor ms | ttft ms | first-sentence ms | total ms | words | error |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) for (const x of r.rows ?? []) lines.push(`| ${x.arm} | ${x.model} | ${x.path} | ${x.cold ? 'yes' : 'no'} | ${x.failed ? 'yes' : 'no'} | ${x.floorMs} | ${x.ttftMs ?? '-'} | ${fmt(x.firstSentenceMs)} | ${fmt(x.totalMs)} | ${x.words} | ${x.error ?? ''} |`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${OUT}`);
for (const v of verdict) console.log(v);
