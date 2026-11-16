#!/usr/bin/env node
// PostToolUse hook (matcher: Bash): "option C" LOCAL full-suite test capture
// (docs/superpowers/specs/2026-07-14-qa-trends-design.md). The CI sampler
// (server/lib/observability/qa-trends-store.js's sampleLatestRun) only ever
// sees pushed-and-CI'd GitHub Actions runs; this hook closes the gap for local
// development by recording a qa-trends point every time the FULL `npm test`
// suite is run locally via the Bash tool, so the QA Trends chart also
// reflects "ran the whole suite on my machine just now", not only commits
// that made it to CI.
//
// Fires ONLY for a genuine FULL-SUITE run (isFullSuiteTestCommand, below):
// `npm test` / `npm run test`, optionally with flags (e.g.
// `-- --test-concurrency=4`). A partial run -- `node --test some.test.js`,
// `npm test -- some.test.js` -- is deliberately rejected: recording a partial
// testCount into the same trend line as the full suite would make the "is
// the QA surface growing" chart lie (a 1-file run would read as a
// catastrophic test-count crash).
//
// Fast + fail-open: the full-suite command check runs BEFORE any dynamic
// import of the (heavier) server/lib modules or the git subprocess, so the
// overwhelming majority of Bash calls -- anything that isn't `npm test` --
// pay only a JSON parse + one regex pass. Mirrors hooks/ci-status-surface.js's
// pure-core-vs-CLI-glue split; this hook ALWAYS exits 0 -- a bug here, a
// missing git binary, or a locked state dir must never fail a Bash call.
//
// Stdin: Claude Code PostToolUse JSON
//   { tool_name, tool_input: { command }, tool_response: { stdout, stderr }, cwd }.
// (tool_response has no exit_code for the Bash tool -- only stdout/stderr/
// interrupted -- so pass/fail is read from the test-runner summary itself,
// not from a process exit code.)


// True only for a command that runs the FULL `npm test` script -- possibly
// chained with other commands (`cd repo && npm test`, `npm test && echo ok`),
// possibly with flags forwarded (with or without a `--` separator) -- and
// false for anything that targets a subset (a bare positional token after the
// npm-test prefix, e.g. a file/pattern) or that isn't an npm "test" script
// invocation at all (`node --test foo.test.js`, `npm run lint`,
// `npm run test:watch`, `yarn test`, ...).
export function isFullSuiteTestCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  return command.split(/&&|\|\||;/).map(s => s.trim()).filter(Boolean).some(isFullSuiteSegment);
}

function isFullSuiteSegment(segment) {
  const m = segment.match(/^npm\s+(?:test|run\s+test)\b(.*)$/);
  if (!m) return false;
  const rest = m[1].trim();
  if (!rest) return true; // bare "npm test" / "npm run test"
  // Anything left over must be flags only (a bare "--" separator, or tokens
  // starting with "-"). A positional token (a file path/pattern) means the
  // run targets a subset, not the full suite.
  return rest.split(/\s+/).filter(Boolean).every(tok => tok === '--' || tok.startsWith('-'));
}

// A narrowed run (card glmps-2-0-155): `node --test` naming test files, or the
// affected-tests script that runs one. Runner sessions are denied the full
// suite, so without this the hook recorded nothing from them at all. These
// points carry scope:'affected' and stay out of the full-suite chart series.
export function isAffectedTestCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  return command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean).some(isAffectedSegment);
}

function isAffectedSegment(segment) {
  // Windows agent sessions often quote paths: node --test "server/test/a.test.js".
  const toks = segment.split(/\s+/).map(t => t.replace(/^(["'])(.*)\1$/, '$2'));
  if (toks[0] !== 'node') return false;
  if (toks[1] === 'scripts/affected-tests.mjs') return !toks.includes('--print');
  if (!toks.includes('--test')) return false;
  return toks.some(t => /\.test\.[cm]?js$/.test(t) && !t.includes('*'));
}

// Node's built-in test runner ('node --test', run via `npm test`) prints a
// summary block at the end -- either the default 'spec' reporter's
// `i tests N` / `i pass N` / `i fail N` lines, or (piped/non-TTY output, as
// captured through the Bash tool) TAP-style `# tests N` / `# pass N` /
// `# fail N` -- see qa-trends-store.js's own parseTestSummary, which parses
// the same TAP shape out of `gh run view --log`. Both prefixes are matched
// anywhere in the text. A single local run has one summary block, but this
// takes the first tests/pass match and the MAX fail match defensively (same
// posture as qa-trends-store.js's parseTestSummary) in case the captured
// output somehow contains more than one. Never throws; no parseable summary
// -> null (e.g. the command errored before npm test ever printed one).
export function parseLocalTestSummary(output) {
  if (typeof output !== 'string' || !output) return null;
  const tests = [...output.matchAll(/[\u2139#]\s*tests\s+(\d+)/g)].map(m => Number(m[1]));
  const pass = [...output.matchAll(/[\u2139#]\s*pass\s+(\d+)/g)].map(m => Number(m[1]));
  const fail = [...output.matchAll(/[\u2139#]\s*fail\s+(\d+)/g)].map(m => Number(m[1]));
  if (!tests.length || !pass.length || !fail.length) return null;
  return { testCount: tests[0], pass: pass[0], fail: Math.max(...fail) };
}

// { summary, sha, ts } -> the qa-trends-store point shape for a LOCAL run:
// source:'local', runId:null (there's no CI run id locally, and per
// qa-trends-store.js's appendPoint/readQaTrends, runId:null is a valid, never
// -deduped point -- not a malformed one), openIssues:null (a local run has no
// GitHub-issues signal; the frontend must treat null distinctly from 0, not
// coerce it to 0). Returns null (never throws) if summary/ts aren't usable.
export function buildLocalPoint({ summary, sha, ts, scope } = {}) {
  if (!summary || typeof summary !== 'object') return null;
  const { testCount, pass, fail } = summary;
  if (!Number.isFinite(testCount) || !Number.isFinite(pass) || !Number.isFinite(fail)) return null;
  if (!Number.isFinite(ts)) return null;
  return {
    ts,
    runId: null,
    sha: typeof sha === 'string' && sha ? sha : null,
    testCount,
    pass,
    fail,
    conclusion: fail > 0 ? 'failure' : 'success',
    openIssues: null,
    source: 'local',
    ...(scope === 'affected' ? { scope } : {}),
  };
}


import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GIT_TIMEOUT_MS = 3000; // local `git rev-parse` is near-instant; bounded per this repo's convention (ci-status-surface.js's GIT_TIMEOUT_MS)

function getShortSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // no git / not a repo / detached weirdness -> fail-open, point still records with sha:null
  }
}

async function main(raw) {
  if ((process.env.GLMPS_QA_TRENDS_LOCAL || '').toLowerCase() === 'off') { process.exit(0); }
  const inp = JSON.parse(raw || '{}');
  if (inp.tool_name !== 'Bash') { process.exit(0); } // belt-and-suspenders; the matcher already scopes this to Bash

  const command = inp.tool_input?.command;
  // Cheapest gate FIRST: reject the overwhelming majority of Bash calls
  // (anything that isn't a full-suite `npm test`) before any dynamic import,
  // fs access, or git subprocess.
  const full = isFullSuiteTestCommand(command);
  if (!full && !isAffectedTestCommand(command)) { process.exit(0); }

  const tr = (inp.tool_response && typeof inp.tool_response === 'object') ? inp.tool_response : {};
  const output = String(tr.stdout || '') + '\n' + String(tr.stderr || '');
  const summary = parseLocalTestSummary(output);
  if (!summary) { process.exit(0); } // ran, but no parseable summary (e.g. crashed before npm test started) -> nothing to record

  const cwd = inp.cwd || process.cwd();
  const sha = getShortSha(cwd);
  const point = buildLocalPoint({ summary, sha, ts: Date.now(), scope: full ? undefined : 'affected' });
  if (!point) { process.exit(0); }

  // Only the genuine full-suite path pays for these -- same lazy-import
  // rationale as hooks/capability-feed.js for the heavier server/lib modules.
  // The store lives on the server, so the point goes there (on a client, through
  // the tap relay on this same port). Only a connection that never opened falls
  // back to the direct append, so a single box with the server down still records.
  const { postIngest } = await import('../server/lib/ingest-post.js');
  const sent = await postIngest('/api/ingest/qa-trends', { point });
  if (!sent.sent) {
    const { getPaths } = await import('../server/lib/paths.js');
    const { appendPoint } = await import('../server/lib/observability/qa-trends-store.js');
    try { appendPoint(getPaths().stateDir, point); } catch { /* fail-open: appendPoint is already fail-open, this is belt-and-suspenders */ }
  }

  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => { main(raw).catch(() => process.exit(0)); });
  process.stdin.on('error', () => process.exit(0));
}
