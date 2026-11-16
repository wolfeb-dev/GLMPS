// scripts/wiki-build-lib.mjs
// The codebase-wiki builder body, callable without argv or process.exit.
// scripts/wiki-build-cli.mjs is a thin wrapper around runWikiBuild(). The
// kernel's wiki loop (server/lib/observability/wiki-loop.js) runs that CLI as a
// CHILD process: this module uses execFileSync for git, which is fine in the
// child and must never run on the server's event loop.
//
// A build has three groups (spec 2.A): Documentation and Concepts come from
// the page manifest (docs/wiki/pages.json, the runtime only), Code reference
// from the graph. Every written page goes through the voice (docs/wiki) and
// its lint; the build directory carries facts.json and voice.json so the
// checker can verify it without reading anything else.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSections } from '../server/lib/observability/wiki-build.js';
import { buildingAccountNames } from '../server/lib/governance/private-text-scan.js';
import { graphFingerprint } from '../server/lib/observability/graph-fingerprint.js';
import { enrichSection } from '../server/lib/observability/wiki-llm.js';
import { renderDoc, renderManifest } from '../server/lib/observability/wiki-render.js';
import { sectionGitDates } from '../server/lib/observability/wiki-git-dates.js';
import { shouldPreserveNarrative } from '../server/lib/observability/wiki-preserve.js';
import { writeJsonAtomic } from '../server/lib/observability/wiki-publish.js';
import { loadVoice, lintRules, lintPage, partsFromMarkdown } from '../server/lib/observability/wiki-voice.js';
import { extractFacts } from '../server/lib/observability/wiki-facts.js';
import {
  readPagesManifest, buildDocSections, glossarySection, codeMapSection, linkSections, PAGES_FILE,
} from '../server/lib/observability/wiki-docs.js';

/**
 * @param {'head-moved'|'ceiling:model-calls'|'duplicate-slug'|'prior-unreadable'|'cache-unreadable'} code
 * @param {string} message
 */
export class WikiBuildError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

// Default output when no --out is given: graphify-out/wiki for every repo
// (gitignored). The kernel's own wiki is built by the wiki loop into
// <stateDir>/wiki; nothing writes generated pages into a working tree.
export function defaultOutDir(root) {
  return path.join(root, 'graphify-out', 'wiki');
}

// a shared recorder for every degrade below.
// Each catch names its OWN expected cause and classifies accordingly
// (`expected: true/false`) rather than presenting every cause the same way;
// the real reason (code + message) is always console.error'd AND pushed
// onto `degraded`, which runWikiBuild returns in its summary so the loop /
// GET /api/wiki can surface it instead of it vanishing into a log file.
function recordDegrade(degraded, site, detail, e, expected) {
  const code = e?.code ?? null;
  const message = String(e?.message ?? e).slice(0, 300);
  console.error(`wiki-build: ${site} degraded (${String(detail).slice(0, 200)})${expected ? '' : ' [unexpected]'}: ${code ?? ''} ${message}`.replace(/\s+/g, ' ').trim());
  degraded.push({ site, detail: String(detail).slice(0, 200), code, error: message, expected: !!expected });
}
// Shared "is this the documented not-a-git-checkout case" classifier for
// listFiles / head / gitLog below: ENOENT means the git binary itself is
// missing, and a non-zero exit (not a git repository) carries its message
// on stderr, not e.code -- neither is a maxBuffer overflow or anything else.
const notAGitCheckout = (e) => e?.code === 'ENOENT' || /not a git repository/i.test(String(e?.stderr ?? e?.message ?? ''));

function sourceContext(rootDir, s, degraded) {
  const parts = [];
  let budget = 12000;
  for (const f of (s.files || []).slice(0, 6)) {
    let txt;
    try { txt = fs.readFileSync(path.join(rootDir, f.path), 'utf8'); }
    catch (e) {
      // a file in the graph but gone from disk is the expected, documented
      // cause (the section is grounded on what remains); anything else
      // (EACCES, EISDIR, a bad encoding) is recorded the same way, flagged
      // unexpected, instead of presenting identically with no trace.
      recordDegrade(degraded, 'sourceContext', f.path, e, e?.code === 'ENOENT');
      continue;
    }
    const chunk = `// ${f.path}\n${txt.split('\n').slice(0, 40).join('\n')}\n`;
    if (chunk.length <= budget) { parts.push(chunk); budget -= chunk.length; }
  }
  return parts.join('\n');
}

export function unknownWikilinks(md, titles) {
  const known = new Set([...titles].map(t => String(t).toLowerCase()));
  const out = [];
  for (const m of String(md ?? '').matchAll(/\[\[([^\][]+)\]\]/g)) {
    const t = m[1].split('|')[0].trim();
    if (!known.has(t.toLowerCase())) out.push(t);
  }
  return out;
}

const sha1 = (...xs) => { const h = crypto.createHash('sha1'); for (const x of xs) h.update(String(x)); return h.digest('hex'); };

export async function runWikiBuild({
  root, outDir = null, cacheFile = null, priorDir = null, stateDir = null,
  useLlm = false, callModel = null, throttle = async () => {},
  maxModelCalls = Infinity, expectHead = null, readCache = true,
  onModelCall = () => {}, progress = () => {}, voice = loadVoice(),
  privateNames = null,
} = {}) {
  // Neither the building account's name nor the profile the state dir sits in
  // may appear in a page; a built-in account (the service runs as SYSTEM) is
  // not a name.
  privateNames = privateNames ?? buildingAccountNames(stateDir);
  root = path.resolve(root);
  const graphPath = path.join(root, 'graphify-out', 'graph.json');
  if (!fs.existsSync(graphPath)) return { skipped: 'no-graph', graphPath };

  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  // the identity of THIS read, not of whatever the caller saw before spawning
  // the build: a graph that moves mid-build is the next tick's drift
  const builtFromGraph = graphFingerprint(graph);
  // every degrade (sourceContext, listFiles, head, gitLog below)
  // lands here, named and visible in the returned summary, instead of
  // vanishing into a swallowed catch.
  const degraded = [];
  const rules = lintRules(voice, { privateNames });
  const pagesManifest = readPagesManifest(root);
  const facts = pagesManifest ? await extractFacts({ repoRoot: root, stateDir }) : {};
  const docSections = pagesManifest ? buildDocSections({ repoRoot: root, manifest: pagesManifest, voice, facts }) : [];
  const glossary = pagesManifest ? [glossarySection(voice)] : [];

  const reservedSlugs = [...docSections.map(s => s.slug), 'glossary', 'code-map'];
  const built = buildSections(graph, {
    reservedSlugs,
    readFile: (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8'),
  });
  const codeTpl = voice.templates.code ?? {};
  const codeSections = built.sections.map((s, i) => ({
    ...s, order: i + 1, audience: codeTpl.audience ?? '', required: codeTpl.headings ?? [],
    contentHash: sha1(voice.hash, s.contentHash),
  }));

  const listFiles = (r) => {
    try {
      return execFileSync('git', ['-C', r, 'ls-files'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch (e) {
      // not a git checkout is the expected, documented cause (no file index);
      // a maxBuffer overflow or anything else is recorded the same way
      // instead of presenting as the identical, misleading excuse.
      recordDegrade(degraded, 'listFiles', r, e, notAGitCheckout(e));
      return [];
    }
  };
  const codeMap = codeMapSection({ codeSections, trackedFiles: listFiles(root), privateNames });
  const sections = linkSections([...docSections, ...glossary, codeMap, ...codeSections]);

  outDir = path.resolve(outDir ?? defaultOutDir(root));
  cacheFile = path.resolve(cacheFile ?? path.join(outDir, '.cache.json'));
  priorDir = path.resolve(priorDir ?? outDir);

  let head = null;
  try { head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch (e) {
    // not a git checkout is the expected, documented cause (builtAtCommit
    // null, which wiki-status reports as 'unknown'); anything else is
    // recorded the same way instead of presenting as the same excuse.
    recordDegrade(degraded, 'head', root, e, notAGitCheckout(e));
    head = null;
  }
  if (expectHead && head !== expectHead) {
    throw new WikiBuildError('head-moved', `asked to build ${expectHead}, HEAD is ${head ?? 'unknown'}`);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const priorManifestBySlug = new Map();
  try {
    const prior = JSON.parse(fs.readFileSync(path.join(priorDir, 'manifest.json'), 'utf8'));
    for (const s of (prior.sections || [])) priorManifestBySlug.set(s.slug, s);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new WikiBuildError('prior-unreadable', `${priorDir}: ${e.message}`);
  }

  const cacheMap = new Map();
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))) cacheMap.set(k, v);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new WikiBuildError('cache-unreadable', `${cacheFile}: ${e.message}`);
  }
  const cache = { get: (k) => (readCache ? cacheMap.get(k) : undefined), set: (k, v) => cacheMap.set(k, v) };

  // 'auto': one call per written page plus room for a repair turn on most of
  // them. 46 written pages give 115, inside the loop's own 120-call ceiling.
  const written = sections.filter(s => !s.deterministic).length;
  const cap = maxModelCalls === 'auto' ? Math.ceil(written * 2.5) : maxModelCalls;
  const realLlmAttempt = useLlm && typeof callModel === 'function';
  const modelErrors = [];
  let modelCalls = 0;
  const finalSections = [];

  // enrichSection calls cache.set() the moment a section is cleanly written,
  // so cacheMap already holds every section's work as the loop goes.
  // persistCache() runs in a finally so a ceiling:model-calls throw mid-loop
  // keeps every page already written instead of re-spending those calls.
  // writeJsonAtomic, so a kill mid-write
  // cannot leave a truncated cache that fails every later run.
  const persistCache = () => { writeJsonAtomic(cacheFile, Object.fromEntries(cacheMap)); };

  try {
    for (const s of sections) {
      if (s.deterministic) { finalSections.push(s); progress('d'); continue; }
      const cached = cache.get(s.contentHash);
      if (cached) {
        finalSections.push({ ...s, summary: cached.summary ?? '', proseMd: cached.proseMd, artifacts: cached.artifacts, llm: cached.llm });
        progress('c');
      } else if (realLlmAttempt) {
        await throttle();
        const ctx = s.group === 'code' ? sourceContext(root, s, degraded) : s.sourceText;
        const siblings = sections.map(x => x.title).filter(t => t && t !== s.title);
        const pageTitles = [...sections.map(x => x.title), ...sections.map(x => x.slug)];
        // Every call counts against the ceiling, repair turns included.
        // enrichSection treats any callModel throw as a model failure and
        // degrades to a stub, so the ceiling is remembered here and rethrown
        // once enrichSection returns.
        let ceilingHit = null;
        const counted = async (prompt) => {
          if (ceilingHit) throw ceilingHit;
          if (modelCalls + 1 > cap) {
            ceilingHit = new WikiBuildError('ceiling:model-calls', `cap ${cap} reached at section ${s.slug}`);
            throw ceilingHit;
          }
          modelCalls += 1;
          onModelCall({ n: modelCalls, slug: s.slug });
          try { return await callModel(prompt); }
          catch (e) { modelErrors.push({ slug: s.slug, error: String(e?.message ?? e).slice(0, 300) }); throw e; }
        };
        // A [[link]] to a page that does not exist fails the checker's links
        // rule; catching it here lets the repair turn fix it.
        const lint = (md) => [
          ...lintPage(partsFromMarkdown(md), { kind: s.kind, required: s.required, rules }),
          ...unknownWikilinks(md, pageTitles).map(t => ['links', `[[${t}]] is not a page; link one of the listed titles or drop the brackets`]),
        ];
        let enriched;
        try { enriched = await enrichSection(s, ctx, { callModel: counted, cache, siblings, voice, lint }); }
        catch (e) {
          if (e instanceof WikiBuildError) throw e;
          modelErrors.push({ slug: s.slug, error: String(e?.message ?? e).slice(0, 300) });
          enriched = { ...s, llm: false };
        }
        if (ceilingHit) throw ceilingHit;
        if (enriched.lintViolations?.length) {
          modelErrors.push({ slug: s.slug, error: `style lint after repair: ${enriched.lintViolations.map(v => v.join(': ')).join('; ').slice(0, 280)}` });
        }
        finalSections.push(enriched);
        progress(enriched.llm ? '.' : 'x');
      } else {
        const prior = priorManifestBySlug.get(s.slug);
        let frozenHtml = null;
        if (shouldPreserveNarrative(s, realLlmAttempt, prior)) {
          try { frozenHtml = fs.readFileSync(path.join(priorDir, `${s.slug}.html`), 'utf8'); }
          catch (e) { if (e.code !== 'ENOENT') throw new WikiBuildError('prior-unreadable', `${s.slug}.html: ${e.message}`); }
        }
        if (frozenHtml != null) { finalSections.push({ ...s, llm: true, __frozenHtml: frozenHtml, __frozenManifestEntry: prior }); progress('p'); }
        else { finalSections.push(s); progress('-'); }
      }
    }
  } finally {
    persistCache();
  }

  const generatedAt = new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const gitLog = (files) => {
    try {
      return execFileSync('git', ['-C', root, 'log', '--format=%ct', '--', ...files], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      // not a git checkout is the expected, documented cause (dates fall
      // back to build time); anything else (a maxBuffer overflow included)
      // is recorded the same way instead of presenting as the same excuse.
      recordDegrade(degraded, 'gitLog', files.slice(0, 5).join(',').slice(0, 200), e, notAGitCheckout(e));
      return '';
    }
  };
  for (const s of finalSections) {
    const d = s.kind === 'index'
      ? sectionGitDates({ files: [] }, gitLog, nowMs, ['.'])
      : sectionGitDates(s, gitLog, nowMs, s.group === 'code' ? [] : [PAGES_FILE.replace(/\\/g, '/')]);
    s.createdTs = d.createdTs;
    s.updatedTs = d.updatedTs;
  }

  const seen = new Set();
  for (const s of finalSections) {
    if (seen.has(s.slug)) throw new WikiBuildError('duplicate-slug', `two sections would overwrite ${s.slug}.html`);
    seen.add(s.slug);
  }

  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.html')) fs.rmSync(path.join(outDir, f));
  for (const s of finalSections) {
    const html = typeof s.__frozenHtml === 'string' ? s.__frozenHtml : renderDoc(s, { builtAtCommit: head });
    fs.writeFileSync(path.join(outDir, `${s.slug}.html`), html);
  }
  const manifest = renderManifest(finalSections, { builtAtCommit: head, graphFingerprint: builtFromGraph, generatedAt, voiceHash: voice.hash });
  for (const s of finalSections) {
    if (!s.__frozenManifestEntry) continue;
    const i = manifest.sections.findIndex(m => m.slug === s.slug);
    if (i >= 0) manifest.sections[i] = s.__frozenManifestEntry;
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'facts.json'), JSON.stringify(facts, null, 2));
  // The names stay out of the build: the stage scans every file of it, this one
  // included, and the loop hands them to the checker instead.
  const { privateNames: _names, ...shippedRules } = rules;
  fs.writeFileSync(path.join(outDir, 'voice.json'), JSON.stringify(shippedRules, null, 2));

  return {
    outDir, sections: finalSections.length, llmSections: finalSections.filter(s => s.llm).length,
    builtAtCommit: head, graphFingerprint: builtFromGraph, generatedAt, modelCalls, maxModelCalls: cap === Infinity ? null : cap, modelErrors, degraded,
  };
}

/**
 * which backend a wiki build uses. Default: claude (claude -p --tools=,
 * no tools) unless a Gemini key is set. agy (auto-approved tools) only when
 * explicitly requested, and nothing ever falls back INTO agy.
 */
export function pickWikiBackend({ requested = null, agyReady = false, apiKey = null } = {}) {
  let backend = requested || (apiKey ? 'gemini' : 'claude');
  if (backend === 'agy' && !agyReady) backend = apiKey ? 'gemini' : 'none';
  if (backend === 'gemini' && !apiKey) backend = 'none';
  return backend;
}
