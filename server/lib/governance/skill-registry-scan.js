// server/lib/governance/skill-registry-scan.js
//
// Discovery, NOT arbitrary-repo crawling. The guardrail against "arbitrary
// GitHub repos" is structural: this module only ever fetches from entries in
// an operator-curated allowlist (config.json's skillDiscovery.registries - 
// { name, baseUrl, format }), and it only parses two already-understood
// shapes: the Claude Code plugin-marketplace layout, and a bare SKILL.md
// frontmatter file. There is no code path anywhere in this module that
// derives a fetch URL from gap text, candidate text, or any other untrusted
// input - every URL passed to fetchImpl is baseUrl itself, or baseUrl joined
// with a relative path that came from a PRIOR fetch of that SAME baseUrl
// (i.e. still rooted in the allowlisted registry, never in arbitrary text).
//
// Fail-open per registry: one broken/unreachable source contributes zero
// rows, it never aborts the whole scan (same discipline as system-changes.js
// and guard-retire.js).
import crypto from 'node:crypto';
import { findNearest } from '../evaluation/semantic-dedup.js';

// Frontmatter parsing logic duplicated verbatim from inventory.js's private
// frontmatter(file) - same regexes, same field extraction - but adapted to
// operate on already-fetched TEXT rather than reading a local file path,
// since this module's only input is network content, never the filesystem.
// (Not imported from inventory.js: that function reads via fs.readFileSync,
// which this module has no business doing.)
function parseFrontmatter(text) {
  const head = String(text ?? '').slice(0, 4000);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!m) return { fm: {}, body: String(text ?? '') };
  const fm = {};
  for (const lineText of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.+?)\s*$/.exec(lineText);
    if (kv) fm[kv[1]] = kv[2];
  }
  const body = String(text ?? '').slice(m.index + m[0].length).replace(/^\r?\n/, '');
  return { fm, body };
}

function sha1(s) { return crypto.createHash('sha1').update(s, 'utf8').digest('hex'); }

// a registry index is network data. Never follow a redirect (a 3xx is a
// refusal), so a fetch can only ever reach the URL the origin check approved.
export async function registryFetch(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { redirect: 'manual' });
  if (!res) throw new Error(`registry fetch failed: ${url}`);
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new Error(`registry fetch refused a redirect: ${url}`);
  if (!res.ok) throw new Error(`registry fetch failed: ${url}`);
  return res.text();
}
function defaultOnSkip({ registry, url, reason }) {
  console.warn(`skill-registry: skipped ${url} (registry ${registry}): ${reason}`);
}
async function defaultFetch(url) { return registryFetch(url); }

function candidateFromFrontmatter({ registryName, format, sourceRepo, sourceRef, fallbackName, text }) {
  const { fm, body } = parseFrontmatter(text);
  const name = fm.name ?? fallbackName;
  return {
    id: sha1(`${registryName}|${sourceRepo}|${name}`),
    name,
    description: fm.description ?? '',
    sourceRepo,
    sourceRef: sourceRef ?? fm.ref ?? null,
    version: fm.version ?? null,
    registryName,
    format,
    rawFrontmatter: fm,
    instructionsBody: body,
  };
}

// format: 'skill-md' - baseUrl points directly at one raw SKILL.md file.
// One fetch, one candidate.
async function scanSkillMd(reg, fetchImpl) {
  const text = await fetchImpl(reg.baseUrl);
  return [candidateFromFrontmatter({
    registryName: reg.name, format: reg.format, sourceRepo: reg.baseUrl,
    sourceRef: null, fallbackName: reg.name, text,
  })];
}

// format: 'claude-plugin-marketplace' - baseUrl points at a marketplace
// index (JSON: a bare array of plugin entries, or { plugins: [...] }). Each
// plugin entry may list `skills: [{ name, description, path?, version? }]`.
// When a skill entry names a relative `path`, this fetches that skill's own
// SKILL.md too - the URL is baseUrl joined with that relative path, i.e.
// still rooted in the SAME allowlisted registry, never in arbitrary text. A
// skill entry with no `path` (fully self-described in the index already)
// contributes a metadata-only candidate with no second fetch.
async function scanMarketplace(reg, fetchImpl, onSkip) {
  const indexText = await fetchImpl(reg.baseUrl);
  let index;
  try { index = JSON.parse(indexText); } catch {
    onSkip({ registry: reg.name, url: reg.baseUrl, reason: 'index is not valid JSON' });
    return [];
  }
  const plugins = Array.isArray(index) ? index : (Array.isArray(index?.plugins) ? index.plugins : []);
  const out = [];
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object') continue;
    const sourceRepo = plugin.source ?? plugin.repo ?? reg.baseUrl;
    const skills = Array.isArray(plugin.skills) ? plugin.skills : [];
    for (const sk of skills) {
      if (!sk || typeof sk !== 'object') continue;
      if (typeof sk.path === 'string' && sk.path) {
        // Standard relative-URL resolution against the index file's own URL
        // (not the registry's bare origin) - e.g. a marketplace.json at
        // .../registry/marketplace.json referencing 'plugins/x/SKILL.md'
        // resolves to .../registry/plugins/x/SKILL.md. Still always rooted
        // in the SAME allowlisted registry: same origin is enforced, not assumed.
        let url;
        try { url = new URL(sk.path, reg.baseUrl).href; } catch { continue; }
        // an absolute (or protocol-relative) path resolves to itself, so
        // the origin has to be checked explicitly.
        let sameOrigin = false;
        try { sameOrigin = new URL(url).origin === new URL(reg.baseUrl).origin; } catch { sameOrigin = false; }
        if (!sameOrigin) onSkip({ registry: reg.name, url, reason: 'off-origin: path resolves outside the registry origin' });
        else {
          try {
            const text = await fetchImpl(url);
            out.push(candidateFromFrontmatter({
              registryName: reg.name, format: reg.format, sourceRepo,
              sourceRef: plugin.ref ?? null, fallbackName: sk.name ?? plugin.name, text,
            }));
            continue;
          } catch (e) {
            // fall through to the metadata-only row below, fail-open per skill
            onSkip({ registry: reg.name, url, reason: String(e?.message ?? e) });
          }
        }
      }
      out.push({
        id: sha1(`${reg.name}|${sourceRepo}|${sk.name ?? ''}`),
        name: sk.name ?? plugin.name ?? reg.name,
        description: sk.description ?? plugin.description ?? '',
        sourceRepo,
        sourceRef: plugin.ref ?? null,
        version: sk.version ?? plugin.version ?? null,
        registryName: reg.name,
        format: reg.format,
        rawFrontmatter: null,
        instructionsBody: null,
      });
    }
  }
  return out;
}

/**
 * @param {{ name, baseUrl, format: 'claude-plugin-marketplace'|'skill-md' }[]} registries
 *   operator-curated allowlist from config.json - the ONLY sources ever fetched.
 * @param {(url:string) => Promise<string>} [fetchImpl]  injectable, default
 *   registryFetch (node fetch with redirect: 'manual'; a 3xx is refused, never
 *   followed). Tests inject a stub - no real network in test.
 * @param {(rec:{registry:string,url:string,reason:string}) => void} [onSkip]
 *   called for every refusal or failure (redirect, off-origin path, fetch error);
 *   default logs a warning. Never changes the returned rows.
 * @returns {Promise<object[]>} CandidateSkill[]
 */
export async function listRegistrySkills(registries, { fetchImpl = defaultFetch, onSkip = defaultOnSkip } = {}) {
  const out = [];
  for (const reg of Array.isArray(registries) ? registries : []) {
    if (!reg || typeof reg !== 'object' || typeof reg.baseUrl !== 'string' || !reg.baseUrl) continue;
    try {
      if (reg.format === 'skill-md') out.push(...await scanSkillMd(reg, fetchImpl));
      else if (reg.format === 'claude-plugin-marketplace') out.push(...await scanMarketplace(reg, fetchImpl, onSkip));
      // unrecognized format -> contribute nothing, fail-open
    } catch (e) {
      // one broken registry never aborts the whole scan, but it is never silent
      onSkip({ registry: reg.name, url: reg.baseUrl, reason: String(e?.message ?? e) });
    }
  }
  return out;
}

// Empirically tuned against the semantic-dedup.js char-trigram cosine metric
// using representative gap-description / skill-description pairs (see
// skill-registry-scan.test.js) - deliberately NOT semantic-dedup.js's own
// DEFAULT_SIM_THRESHOLD (0.5), which was tuned for near-duplicate GUARD
// rewordings (long shared sentence skeletons), a much higher-overlap task
// than matching a short gap phrase against an independently-written skill
// description.
export const DEFAULT_GAP_MATCH_THRESHOLD = 0.2;

/**
 * Match a recurring gap against the fetched registry index using the SAME
 * character-trigram cosine similarity semantic-dedup.js already built for
 * guard-paraphrase dedup - no new NLP, reuse findNearest().
 * @param {{code:string, message?:string}} gap
 * @param {object[]} registrySkills  CandidateSkill[]
 * @param {number} [threshold]
 * @returns {{ candidate: object, score: number } | null}
 */
export function matchGapToCandidate(gap, registrySkills, threshold = DEFAULT_GAP_MATCH_THRESHOLD) {
  if (!gap || typeof gap !== 'object') return null;
  const list = Array.isArray(registrySkills) ? registrySkills : [];
  const gapText = [gap.code, gap.message].filter(Boolean).join(' ').trim();
  if (!gapText || !list.length) return null;

  const texts = list.map((c) => [c?.name, c?.description].filter(Boolean).join(' '));
  const found = findNearest(gapText, texts, threshold);
  if (!found) return null;
  const idx = texts.indexOf(found.item);
  if (idx === -1) return null;
  return { candidate: list[idx], score: found.score };
}
