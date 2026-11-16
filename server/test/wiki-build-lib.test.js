// server/test/wiki-build-lib.test.js
// the builder writes pages, manifest and cache only where it is told,
// counts and caps model calls, refuses a HEAD that moved, and the CLI speaks a
// line protocol the kernel's wiki loop reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWikiBuild, WikiBuildError, pickWikiBackend, unknownWikilinks } from '../../scripts/wiki-build-lib.mjs';
import { verifyWikiBuild } from '../lib/observability/wiki-verify.js';
import { graphFingerprint } from '../lib/observability/graph-fingerprint.js';
import { loadVoice, lintRules } from '../lib/observability/wiki-voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', '..', 'scripts', 'wiki-build-cli.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Five files in each of two directories (the default minFiles for a page) ->
// buildSections yields exactly two subsystem sections, slugs 'code-gadgets' and
// 'code-widgets', plus the deterministic 'code-map' page.
const DIRS = ['widgets', 'gadgets'];
function graph() {
  return {
    built_at_commit: 'g0',
    nodes: DIRS.flatMap((d, di) => [1, 2, 3, 4, 5].map(i => (
      { id: `${d}${i}`, label: `${d} ${i}`, community: di, source_file: `src/${d}/f${i}.js`, source_location: 'L1' }))),
    links: [],
  };
}

function fixtureRoot({ git = false } = {}) {
  const root = tmp('mc-wbl-');
  fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(graph()));
  for (const d of DIRS) {
    fs.mkdirSync(path.join(root, 'src', d), { recursive: true });
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(root, 'src', d, `f${i}.js`), `export const ${d}${i} = ${i};\n`);
  }
  if (!git) return { root, head: null };
  fs.writeFileSync(path.join(root, '.gitignore'), 'graphify-out/\n');
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return { root, head: g('rev-parse', 'HEAD') };
}

// A page the lint accepts for any kind: the model is asked for the template's
// headings, so the stub reads them back out of the prompt.
const headingsIn = (prompt) => [...(prompt.match(/each written exactly: (.*)\./)?.[1] ?? '').matchAll(/"## ([^"]+)"/g)].map(m => m[1]);
const pageFor = (prompt, word = 'plain') => `Summary: A ${word} summary of this area.\n\n${headingsIn(prompt).map(h => `## ${h}\n\nIt is ${word} and short.`).join('\n\n')}\n`;
const okModel = (calls) => async (prompt) => { calls.push(prompt); return pageFor(prompt); };

test('writes pages and manifest to outDir and the cache to cacheFile, nothing else', async () => {
  const { root } = fixtureRoot();
  const outDir = tmp('mc-wbl-out-');
  const cacheFile = path.join(tmp('mc-wbl-cache-'), 'cache.json');
  const calls = [];
  const s = await runWikiBuild({ root, outDir, cacheFile, useLlm: true, callModel: okModel(calls) });
  assert.equal(s.sections, 3, 'two code pages and the code map');
  assert.equal(s.llmSections, 3, 'the deterministic code map counts as written');
  assert.equal(s.modelCalls, 2, 'the code map takes no model call');
  assert.deepEqual(fs.readdirSync(outDir).sort(),
    ['code-gadgets.html', 'code-map.html', 'code-widgets.html', 'facts.json', 'manifest.json', 'voice.json']);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).length, 2);
  assert.equal(fs.existsSync(path.join(root, 'web')), false, 'nothing written into the repo');
});

test('a second build reuses the cache: zero model calls, still all narrative', async () => {
  const { root } = fixtureRoot();
  const cacheFile = path.join(tmp('mc-wbl-cache-'), 'cache.json');
  await runWikiBuild({ root, outDir: tmp('mc-wbl-a-'), cacheFile, useLlm: true, callModel: okModel([]) });
  const calls = [];
  const s = await runWikiBuild({ root, outDir: tmp('mc-wbl-b-'), cacheFile, useLlm: true, callModel: okModel(calls) });
  assert.equal(s.modelCalls, 0);
  assert.equal(calls.length, 0);
  assert.equal(s.llmSections, 3);
});

test('readCache:false regenerates every section but keeps the cache file entries', async () => {
  const { root } = fixtureRoot();
  const cacheFile = path.join(tmp('mc-wbl-cache-'), 'cache.json');
  await runWikiBuild({ root, outDir: tmp('mc-wbl-a-'), cacheFile, useLlm: true, callModel: okModel([]) });
  const before = Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).sort();
  const failing = async () => { throw new Error('model down'); };
  const s = await runWikiBuild({ root, outDir: tmp('mc-wbl-b-'), cacheFile, useLlm: true, callModel: failing, readCache: false });
  assert.equal(s.modelCalls, 2);
  assert.equal(s.llmSections, 1, 'only the code map survives a dead model');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).sort(), before);
});

test('maxModelCalls "auto" is ceil(written pages * 2.5); an explicit cap below the need throws ceiling:model-calls', async () => {
  const { root } = fixtureRoot();
  const auto = await runWikiBuild({ root, outDir: tmp('mc-wbl-a-'), cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json'),
    useLlm: true, callModel: okModel([]), maxModelCalls: 'auto' });
  assert.equal(auto.maxModelCalls, 5);
  await assert.rejects(
    runWikiBuild({ root, outDir: tmp('mc-wbl-b-'), cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json'),
      useLlm: true, callModel: okModel([]), maxModelCalls: 1 }),
    (e) => e instanceof WikiBuildError && e.code === 'ceiling:model-calls');
});

test('a ceiling hit persists what was already enriched, so a retry with the same cache only redoes what is left', async () => {
  const { root } = fixtureRoot();
  const cacheFile = path.join(tmp('mc-wbl-cache-'), 'cache.json');
  const calls1 = [];
  await assert.rejects(
    runWikiBuild({ root, outDir: tmp('mc-wbl-a-'), cacheFile, useLlm: true, callModel: okModel(calls1), maxModelCalls: 1 }),
    (e) => e instanceof WikiBuildError && e.code === 'ceiling:model-calls');
  assert.equal(calls1.length, 1, 'the one section under the cap was actually enriched before the throw');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).length, 1,
    'the cache file reflects the one section enriched before the ceiling threw, not zero');

  const calls2 = [];
  const s = await runWikiBuild({ root, outDir: tmp('mc-wbl-b-'), cacheFile, useLlm: true, callModel: okModel(calls2) });
  assert.equal(calls2.length, 1, 'only the section left over from the capped run needed a fresh call');
  assert.equal(s.modelCalls, 1);
  assert.equal(s.llmSections, 3);
});

test('onModelCall fires once per real call, before the call, with the slug', async () => {
  const { root } = fixtureRoot();
  const seen = [];
  await runWikiBuild({ root, outDir: tmp('mc-wbl-a-'), cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json'),
    useLlm: true, callModel: okModel([]), onModelCall: (e) => seen.push(e) });
  assert.deepEqual(seen.map(e => e.n), [1, 2]);
  assert.deepEqual(seen.map(e => e.slug).sort(), ['code-gadgets', 'code-widgets']);
});

test('a page carrying private text fails the style lint after repair, and voice.json carries no private names (the stage scans it)', async () => {
  const { root } = fixtureRoot();
  const outDir = tmp('mc-wbl-priv-');
  // The repair turn's prompt does not restate the headings, so remember them.
  let heads = [];
  const leaky = async (prompt) => {
    if (headingsIn(prompt).length) heads = headingsIn(prompt);
    return `Summary: A plain summary.\n\n${heads.map(h => `## ${h}\n\nIt is stored at C:\\Users\\zed\\wiki and short.`).join('\n\n')}\n`;
  };
  const s = await runWikiBuild({ root, outDir, cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json'),
    useLlm: true, callModel: leaky, privateNames: ['zed'] });
  assert.ok(s.modelErrors.length > 0);
  assert.ok(s.modelErrors.every(e => /private-text/.test(e.error)), JSON.stringify(s.modelErrors));
  const written = fs.readFileSync(path.join(outDir, 'voice.json'), 'utf8');
  assert.equal(JSON.parse(written).privateNames, undefined);
  assert.doesNotMatch(written, /zed/);
});

test('a model error is recorded per section and that section falls back to a stub', async () => {
  const { root } = fixtureRoot();
  const s = await runWikiBuild({ root, outDir: tmp('mc-wbl-a-'), cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json'),
    useLlm: true, callModel: async () => { throw new Error('boom'); } });
  assert.equal(s.llmSections, 1);
  assert.deepEqual(s.modelErrors.map(e => e.error), ['boom', 'boom']);
});

test('expectHead mismatch throws head-moved before any model call; a match stamps builtAtCommit', async () => {
  const { root, head } = fixtureRoot({ git: true });
  const calls = [];
  await assert.rejects(
    runWikiBuild({ root, outDir: tmp('mc-wbl-a-'), cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json'),
      useLlm: true, callModel: okModel(calls), expectHead: 'deadbeef' }),
    (e) => e instanceof WikiBuildError && e.code === 'head-moved');
  assert.equal(calls.length, 0);
  const s = await runWikiBuild({ root, outDir: tmp('mc-wbl-b-'), cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json'),
    useLlm: true, callModel: okModel([]), expectHead: head });
  assert.equal(s.builtAtCommit, head);
});

test('priorDir feeds the no-downgrade guard when there is no real model attempt', async () => {
  const { root } = fixtureRoot();
  const priorDir = tmp('mc-wbl-prior-');
  fs.writeFileSync(path.join(priorDir, 'manifest.json'), JSON.stringify({ builtAtCommit: 'old', sections: [
    { slug: 'code-widgets', title: 'Widgets', llm: true, contentHash: 'STALE', related: [], backlinks: [], tags: [] },
  ] }));
  fs.writeFileSync(path.join(priorDir, 'code-widgets.html'), '<article class="wiki-doc"><p>PRIOR_MARKER</p></article>');
  const outDir = tmp('mc-wbl-out-');
  await runWikiBuild({ root, outDir, priorDir, cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json') });
  assert.match(fs.readFileSync(path.join(outDir, 'code-widgets.html'), 'utf8'), /PRIOR_MARKER/);
});

// persistCache used to write cache.json IN
// PLACE (fs.writeFileSync(cacheFile, ...)); a kill mid-write leaves a
// truncated file, and every later run fails cache-unreadable forever
// (wiki-build-lib.mjs's own JSON.parse there throws anything but ENOENT).
// Fix: tmp + rename, the writeJsonAtomic shape.
test('the cache is persisted via a temp file + rename, not written in place (R-M2)', async () => {
  const { root } = fixtureRoot();
  const cacheFile = path.join(tmp('mc-wbl-atomic-'), 'cache.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ old: { llm: true } }));

  const realRenameSync = fs.renameSync;
  let renamedTo = null;
  fs.renameSync = (from, to) => { renamedTo = to; return realRenameSync(from, to); };
  const realWriteFileSync = fs.writeFileSync;
  const writtenPaths = [];
  fs.writeFileSync = (file, ...rest) => { writtenPaths.push(String(file)); return realWriteFileSync(file, ...rest); };
  try {
    await runWikiBuild({ root, outDir: tmp('mc-wbl-atomic-out-'), cacheFile, useLlm: true, callModel: okModel([]) });
  } finally {
    fs.renameSync = realRenameSync;
    fs.writeFileSync = realWriteFileSync;
  }
  assert.ok(
    writtenPaths.some((p) => p !== cacheFile && p.startsWith(cacheFile)),
    `the cache content must land in a TEMP file first, never written in place: ${JSON.stringify(writtenPaths)}`,
  );
  assert.equal(renamedTo, cacheFile, 'the temp file is renamed over the real cache file as the final, atomic step');
  const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.ok(Object.hasOwn(after, 'old'), 'the pre-existing entry survives (the cache accumulates, it is not replaced)');
  assert.equal(Object.keys(after).length, 3, 'the pre-existing entry plus the two new sections enriched this run');
});

test('a crash before the cache rename leaves the prior cache file untouched, never truncated (R-M2)', async () => {
  const { root } = fixtureRoot();
  const cacheFile = path.join(tmp('mc-wbl-atomic2-'), 'cache.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const before = JSON.stringify({ old: { llm: true } });
  fs.writeFileSync(cacheFile, before);

  const realRenameSync = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === cacheFile) throw new Error('EBUSY: simulated crash before rename'); return realRenameSync(from, to); };
  try {
    await assert.rejects(
      runWikiBuild({ root, outDir: tmp('mc-wbl-atomic2-out-'), cacheFile, useLlm: true, callModel: okModel([]) }),
      /EBUSY/,
    );
  } finally { fs.renameSync = realRenameSync; }
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), before, 'the original cache file survives a failed persist untouched, not truncated');
});

// four catch-alls (sourceContext, listFiles, the
// HEAD rev-parse, gitLog) each swallowed EVERY error behind one named,
// documented cause (ENOENT / not-a-git-checkout), with no logging and no
// trace when the real cause was something else (EACCES, a maxBuffer
// overflow, ...) -- four different root causes all presenting as the same
// one hard-coded excuse. Every degrade is now a named entry in the
// summary's degraded[] array (flagged expected when it matches the
// documented cause), regardless of which it is.
test('a source file missing from disk degrades gracefully, named and visible in the summary (S2)', async () => {
  const { root } = fixtureRoot();
  fs.rmSync(path.join(root, 'src', 'widgets', 'f1.js'));
  const outDir = tmp('mc-wbl-deg-');
  const cacheFile = path.join(tmp('mc-wbl-deg-c-'), 'c.json');
  const s = await runWikiBuild({ root, outDir, cacheFile, useLlm: true, callModel: okModel([]) });
  assert.ok(Array.isArray(s.degraded));
  const entry = s.degraded.find((d) => d.site === 'sourceContext');
  assert.ok(entry, `expected a sourceContext degrade entry, got: ${JSON.stringify(s.degraded)}`);
  assert.equal(entry.expected, true, 'a missing file is the documented, expected cause');
  assert.match(entry.error, /ENOENT|no such file/i);
  // The build itself still succeeds: one missing source file degrades the
  // context for that section, it does not fail the whole wiki build.
  assert.equal(s.sections, 3);
});

test('a non-git root degrades listFiles, head and gitLog, all named, visible and marked expected (S2)', async () => {
  const { root } = fixtureRoot({ git: false });
  const outDir = tmp('mc-wbl-deg2-');
  const cacheFile = path.join(tmp('mc-wbl-deg2-c-'), 'c.json');
  const s = await runWikiBuild({ root, outDir, cacheFile, useLlm: true, callModel: okModel([]) });
  const sites = new Set(s.degraded.map((d) => d.site));
  assert.ok(sites.has('listFiles'), `expected a listFiles degrade, got: ${JSON.stringify(s.degraded)}`);
  assert.ok(sites.has('head'), `expected a head degrade, got: ${JSON.stringify(s.degraded)}`);
  assert.ok(sites.has('gitLog'), `expected a gitLog degrade, got: ${JSON.stringify(s.degraded)}`);
  assert.ok(s.degraded.every((d) => d.expected === true), 'a non-git root is the documented, expected cause for all three');
  assert.equal(s.builtAtCommit, null);
});

test('a source file that is actually a directory (EISDIR) is recorded as unexpected, not presented as the same missing-file excuse (S2)', async () => {
  const { root } = fixtureRoot();
  // Replace the source file the graph points at with a DIRECTORY of the same
  // name: fs.readFileSync throws EISDIR, a genuinely different, unexpected
  // cause from the documented ENOENT (a file in the graph but gone from disk).
  fs.rmSync(path.join(root, 'src', 'widgets', 'f1.js'));
  fs.mkdirSync(path.join(root, 'src', 'widgets', 'f1.js'));
  const outDir = tmp('mc-wbl-deg3-');
  const cacheFile = path.join(tmp('mc-wbl-deg3-c-'), 'c.json');
  const s = await runWikiBuild({ root, outDir, cacheFile, useLlm: true, callModel: okModel([]) });
  const entry = s.degraded.find((d) => d.site === 'sourceContext');
  assert.ok(entry, `expected a sourceContext degrade, got: ${JSON.stringify(s.degraded)}`);
  assert.equal(entry.expected, false, 'EISDIR is NOT the documented "gone from disk" (ENOENT) cause');
  assert.equal(entry.code, 'EISDIR');
});

test('no graph: returns { skipped: "no-graph" } and writes nothing', async () => {
  const root = tmp('mc-wbl-empty-');
  const outDir = path.join(tmp('mc-wbl-out-'), 'x');
  const s = await runWikiBuild({ root, outDir });
  assert.equal(s.skipped, 'no-graph');
  assert.equal(fs.existsSync(outDir), false);
});

test('CLI --out/--cache/--protocol: output only in the out dir, repo git status clean, WIKI_RESULT last', () => {
  const { root, head } = fixtureRoot({ git: true });
  const outDir = tmp('mc-wbl-cli-out-');
  const cacheFile = path.join(tmp('mc-wbl-cli-cache-'), 'cache.json');
  const r = spawnSync(process.execPath, [CLI, root, '--out', outDir, '--cache', cacheFile, '--expect-head', head, '--protocol'],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  const last = lines[lines.length - 1];
  assert.ok(last.startsWith('WIKI_RESULT '), last);
  const summary = JSON.parse(last.slice('WIKI_RESULT '.length));
  assert.equal(summary.builtAtCommit, head);
  assert.ok(summary.sections >= 2);
  assert.ok(fs.existsSync(path.join(outDir, 'manifest.json')));
  assert.equal(fs.existsSync(path.join(root, 'web', 'wiki')), false);
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

// a requested --backend that falls back
// (agyReady false, no API key -> 'none') used to be diagnosed only by a
// console.log gated on the NON-protocol branch -- the wiki loop's own
// spawnWikiBuild always passes --protocol, so in the one invocation path
// that matters in production, the downgrade was completely silent (no
// stdout line, no stderr line, nothing but the backend field inside
// WIKI_RESULT, which nothing downstream compares against what was
// requested). The warning must reach stderr UNCONDITIONALLY (protocol or
// not) so it survives in the stderr tail wiki-loop.js already captures.
test('CLI: a requested backend that falls back is warned on stderr even with --protocol (S4)', () => {
  const { root, head } = fixtureRoot({ git: true });
  const outDir = tmp('mc-wbl-cli-backend-out-');
  const cacheFile = path.join(tmp('mc-wbl-cli-backend-cache-'), 'cache.json');
  const env = { ...process.env };
  delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY; // force the agy->gemini->none fallback chain
  const r = spawnSync(process.execPath, [CLI, root, '--llm', '--out', outDir, '--cache', cacheFile,
    '--expect-head', head, '--backend', 'agy', '--protocol'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /requested backend 'agy' unavailable, falling back to 'none'/);
  const lines = r.stdout.trim().split(/\r?\n/);
  const last = lines[lines.length - 1];
  assert.ok(last.startsWith('WIKI_RESULT '), `the stderr warning must not corrupt the stdout protocol stream: ${last}`);
  assert.equal(JSON.parse(last.slice('WIKI_RESULT '.length)).backend, 'none');
});

test('CLI --expect-head mismatch: non-zero exit, one clean stderr line naming head-moved, no stack trace', () => {
  const { root } = fixtureRoot({ git: true });
  const outDir = tmp('mc-wbl-cli-hm-out-');
  const cacheFile = path.join(tmp('mc-wbl-cli-hm-cache-'), 'cache.json');
  const r = spawnSync(process.execPath, [CLI, root, '--out', outDir, '--cache', cacheFile, '--expect-head', 'deadbeef'],
    { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  const stderrLines = r.stderr.trim().split(/\r?\n/);
  assert.equal(stderrLines.length, 1, r.stderr);
  assert.match(stderrLines[0], /head-moved/);
  assert.ok(!/\bat\s/.test(r.stderr), `stderr must not contain a stack trace: ${r.stderr}`);
});

test('F8: the CLI backend defaults to claude (no tools) or gemini, never to agy, and never falls back INTO agy', () => {
  assert.equal(pickWikiBackend({ agyReady: true }), 'claude');
  assert.equal(pickWikiBackend({ agyReady: true, apiKey: 'k' }), 'gemini');
  assert.equal(pickWikiBackend({ requested: 'gemini', agyReady: true }), 'none', 'no key: no silent agy fallback');
  assert.equal(pickWikiBackend({ requested: 'agy', agyReady: true }), 'agy', 'an explicit operator choice still works');
  assert.equal(pickWikiBackend({ requested: 'agy', agyReady: false }), 'none');
  assert.equal(pickWikiBackend({ requested: 'agy', agyReady: false, apiKey: 'k' }), 'gemini');
});

const PAGES = {
  groups: [{ id: 'documentation', title: 'Documentation' }, { id: 'concepts', title: 'Concepts' }, { id: 'code', title: 'Code reference' }],
  pages: [
    { slug: 'start-here', title: 'Start here', group: 'documentation', subgroup: 'User guide', kind: 'guide', order: 1,
      angle: 'How to begin.', sources: [{ glob: 'README.md' }], related: ['run-it'] },
    { slug: 'run-it', title: 'Run it', group: 'documentation', subgroup: 'Admin guide', kind: 'admin', order: 2,
      angle: 'How to run the service.', sources: [{ glob: 'server/server.js' }], facts: ['config', 'routes', 'env'], related: ['start-here'] },
  ],
};

function docsFixture() {
  const { root } = fixtureRoot({ git: true });
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('package.json', '{"type":"module"}\n');
  w('README.md', '# Fixture\n\nA small product.\n');
  w('server/server.js', "const port = process.env.FIX_PORT;\nif (u.pathname === '/api/ping' && req.method === 'GET') {}\n");
  w('server/lib/config-defaults.js', 'export function configDefaults() { return { port: 8123, loop: { everyMs: 60000 } }; }\n');
  w('docs/wiki/pages.json', JSON.stringify(PAGES, null, 2));
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'docs');
  return { root, head: g('rev-parse', 'HEAD') };
}

// The checker resolves absolute asset links under webDir.
function webDirFixture() {
  const web = tmp('mc-wbl-web-');
  for (const f of ['shared/tokens.css', 'observability/wiki-doc.css', 'wiki-assets/mermaid.min.js']) {
    fs.mkdirSync(path.dirname(path.join(web, f)), { recursive: true });
    fs.writeFileSync(path.join(web, f), '');
  }
  return web;
}

const cacheIn = () => path.join(tmp('mc-wbl-c-'), 'c.json');
const PAGE_MARK = '=== PAGE ===\n';
const pageOf = (repairPrompt) => repairPrompt.slice(repairPrompt.indexOf(PAGE_MARK) + PAGE_MARK.length);

test('a full run with a page manifest writes facts.json and voice.json, and the checker passes it', async () => {
  const { root, head } = docsFixture();
  const outDir = tmp('mc-wbl-docs-');
  const s = await runWikiBuild({ root, outDir, cacheFile: cacheIn(), useLlm: true, callModel: okModel([]), expectHead: head, privateNames: [] });
  assert.equal(s.sections, 6,'two documentation pages, glossary, code map, two code pages');
  assert.equal(s.modelCalls, 4, 'glossary and code map are deterministic');
  assert.deepEqual(s.modelErrors, []);

  const facts = JSON.parse(fs.readFileSync(path.join(outDir, 'facts.json'), 'utf8'));
  assert.deepEqual(facts.config.map(r => r.key), ['loop.everyMs', 'port']);
  assert.deepEqual(facts.routes, [{ method: 'GET', path: '/api/ping' }]);
  assert.deepEqual(facts.env.map(r => r.name), ['FIX_PORT']);
  const { privateNames: _n, ...shipped } = lintRules(loadVoice());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'voice.json'), 'utf8')), shipped);

  const html = fs.readFileSync(path.join(outDir, 'run-it.html'), 'utf8');
  for (const needle of ['loop.everyMs', '/api/ping', 'FIX_PORT']) assert.ok(html.includes(needle), `${needle} is in the admin reference tables`);

  const v = verifyWikiBuild({ buildDir: outDir, headSha: head, webDir: webDirFixture() });
  assert.deepEqual(v.failures, []);
  assert.equal(v.ok, true);
});

test('without a page manifest there are no documentation pages, no glossary and an empty facts.json', async () => {
  const { root } = fixtureRoot();
  const outDir = tmp('mc-wbl-nodocs-');
  await runWikiBuild({ root, outDir, cacheFile: cacheIn(), useLlm: true, callModel: okModel([]) });
  const m = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.sections.map(x => x.slug).sort(), ['code-gadgets', 'code-map', 'code-widgets']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'facts.json'), 'utf8')), {});
});

test('an injected voice is the one written to voice.json and folded into the manifest', async () => {
  const { root } = fixtureRoot();
  const voice = loadVoice();
  voice.glossary = { ...voice.glossary, terms: [{ term: 'widget', definition: 'A thing.', avoid: ['gizmo'], allow: [] }] };
  const outDir = tmp('mc-wbl-voice-');
  await runWikiBuild({ root, outDir, cacheFile: cacheIn(), useLlm: true, callModel: okModel([]), voice });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'voice.json'), 'utf8')).terms,
    [{ term: 'widget', avoid: ['gizmo'], allow: [] }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).voiceHash, voice.hash);
});

// The first draft breaks the voice ("robust" is banned); the repair prompt gets it fixed.
function dirtyFirstModel(prompts) {
  return async (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith('The wiki page below')) return pageOf(prompt).replaceAll('robust', 'plain');
    return pageFor(prompt, 'robust');
  };
}

test('every model call, repair calls included, fires onModelCall', async () => {
  const { root } = docsFixture();
  const prompts = []; const events = [];
  const s = await runWikiBuild({ root, outDir: tmp('mc-wbl-rep-'), cacheFile: cacheIn(), useLlm: true,
    callModel: dirtyFirstModel(prompts), onModelCall: (e) => events.push(e) });
  assert.equal(prompts.length, 8, 'four written pages, each written once and repaired once');
  assert.equal(prompts.filter(p => p.startsWith('The wiki page below')).length, 4);
  assert.deepEqual(events.map(e => e.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(s.modelCalls, 8);
  assert.deepEqual(s.modelErrors, [], 'the repairs cleared every violation');
});

test('the "auto" cap leaves room for a repair turn on every page: 4 written pages allow 10 calls', async () => {
  const { root } = docsFixture();
  const repaired = await runWikiBuild({ root, outDir: tmp('mc-wbl-cap-'), cacheFile: cacheIn(), useLlm: true, callModel: dirtyFirstModel([]), maxModelCalls: 'auto' });
  assert.equal(repaired.maxModelCalls, 10);
  assert.equal(repaired.modelCalls, 8);
  const ok = await runWikiBuild({ root, outDir: tmp('mc-wbl-cap2-'), cacheFile: cacheIn(), useLlm: true, callModel: okModel([]), maxModelCalls: 'auto' });
  assert.equal(ok.maxModelCalls, 10);
  assert.equal(ok.modelCalls, 4);
});

test('the cap throws ceiling:model-calls even when it is hit inside a repair turn', async () => {
  const { root } = docsFixture();
  const calls = [];
  await assert.rejects(
    runWikiBuild({ root, outDir: tmp('mc-wbl-cap3-'), cacheFile: cacheIn(), useLlm: true, maxModelCalls: 2,
      callModel: async (p) => { calls.push(p); return p.startsWith('The wiki page below') ? pageOf(p) : pageFor(p, 'robust'); } }),
    (e) => e instanceof WikiBuildError && e.code === 'ceiling:model-calls');
  assert.equal(calls.length, 2, 'the third call (a second repair) is refused, not made');
});

test('a page still failing the lint after two repairs is not cached, is reported, and the checker rejects the build', async () => {
  const { root, head } = docsFixture();
  const outDir = tmp('mc-wbl-lint-');
  const cacheFile = cacheIn();
  let calls = 0;
  const s = await runWikiBuild({ root, outDir, cacheFile, useLlm: true, expectHead: head,
    callModel: async (p) => { calls++; return p.startsWith('The wiki page below') ? pageOf(p) : pageFor(p, 'robust'); } });
  assert.equal(calls, 12, 'four pages, each one draft and two repairs');
  assert.equal(s.modelErrors.length, 4);
  assert.match(s.modelErrors[0].error, /style lint after repair: banned-word: "robust"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), {}, 'a failing page never reaches the cache');
  const v = verifyWikiBuild({ buildDir: outDir, headSha: head, webDir: webDirFixture() });
  assert.equal(v.ok, false);
  assert.ok(v.failures.every(([rule]) => rule === 'style'), JSON.stringify(v.failures));
  assert.equal(v.offending.length, 4);
});

test('unknownWikilinks names links to pages that do not exist, by title or slug, case-insensitive, label ignored', () => {
  const titles = ['Read a session', 'loops'];
  assert.deepEqual(unknownWikilinks('See [[read a session|the session]] and [[Loops]].', titles), []);
  assert.deepEqual(unknownWikilinks('See [[If it goes wrong]] and [[wikilinks]].', titles), ['If it goes wrong', 'wikilinks']);
});

test('the manifest and the summary record the fingerprint of the graph the build read', async () => {
  const { root } = fixtureRoot();
  const outDir = tmp('mc-wbl-fp-');
  const s = await runWikiBuild({ root, outDir, cacheFile: path.join(tmp('mc-wbl-c-'), 'c.json') });
  const expected = graphFingerprint(graph());
  assert.equal(s.graphFingerprint, expected);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).graphFingerprint, expected);
});
