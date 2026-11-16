// server/lib/observability/wiki-llm.js
// The model-written half of a wiki page (the documentation creator and the code reference). The network call is fully
// injectable (callModel / fetchImpl) so this stays pure + testable offline: nothing here ever
// makes a real network call by itself. On any model failure (throw or empty output) callers get
// a Tier-1 fallback (the original section, unmutated, with llm:false) so enrichment degrades
// gracefully rather than blocking the wiki build.

const FENCE_RE = /```([a-zA-Z0-9-]*)\n([\s\S]*?)```/g;

/**
 * Pull mermaid + vega-lite fenced blocks out of Markdown into structured artifacts.
 * GFM tables and any other fenced code (js, sql, etc.) are left inline in the prose.
 * @param {string} md
 * @returns {{ proseMd: string, artifacts: Array<{type:'mermaid', spec:string}|{type:'vega-lite', spec:object}> }}
 */
export function extractArtifacts(md) {
  const artifacts = [];
  const proseMd = String(md ?? '').replace(FENCE_RE, (whole, lang, body) => {
    const tag = String(lang || '').toLowerCase().trim();
    if (tag === 'mermaid') {
      artifacts.push({ type: 'mermaid', spec: body });
      return '';
    }
    if (tag === 'vega-lite') {
      try {
        const spec = JSON.parse(body);
        artifacts.push({ type: 'vega-lite', spec });
      } catch {
        // malformed vega-lite JSON: drop the block silently, push nothing
      }
      return '';
    }
    return whole;
  }).replace(/\n{3,}/g, '\n\n').trim();

  return { proseMd, artifacts };
}

const KIND_BRIEF = {
  guide: 'This page is in the USER GUIDE. The reader wants to get something done in the GLMPS UI today. Be task first.',
  admin: 'This page is in the ADMIN GUIDE. The reader installs, configures, runs or recovers GLMPS. Give exact commands and config keys, state defaults, and mark every destructive step with a Warning callout.',
  concept: 'This page is a CONCEPT page. The reader wants to understand why GLMPS behaves as it does. Explain the model in prose; link to the guide pages that use it.',
  code: 'This page is in the CODE REFERENCE. The reader is an engineer or an agent about to change this code. Be factual and terse.',
};

/**
 * The prompt for one page: the voice (style file and glossary, verbatim), the
 * template's required headings in order, what the page must cover, the facts
 * the renderer will append as tables, and the source excerpts.
 * @param {object} section
 * @param {string} sourceCtx
 * @param {string[]} siblings page titles the page may link with [[Title]]
 * @param {{ style:string, glossary:object, templates:object }} voice
 */
export const PROMPT = (section, sourceCtx, siblings = [], voice = null) => {
  const kind = section?.kind ?? 'code';
  const tpl = voice?.templates?.[kind] ?? {};
  const headings = Array.isArray(section?.required) && section.required.length ? section.required : (tpl.headings ?? []);
  const files = Array.isArray(section?.files) ? section.files.map(f => (typeof f === 'string' ? f : f.path)) : [];
  const sibs = Array.isArray(siblings) ? siblings.filter(Boolean) : [];
  const terms = (voice?.glossary?.terms ?? []).map(t => `- ${t.term}: ${t.definition}${t.avoid?.length ? ` (never: ${t.avoid.join(', ')})` : ''}`);
  const tables = (section?.reference ?? []).map(t => `- ${t.title}: ${t.rows.length} rows (${t.columns.join(', ')})`);
  const [minW, maxW] = Array.isArray(tpl.lengthWords) ? tpl.lengthWords : [300, 800];
  const diagrams = Number.isInteger(tpl.diagrams) ? tpl.diagrams : 0;
  return [
    `Write the wiki page "${section?.title ?? ''}" for GLMPS 2.0.`,
    KIND_BRIEF[kind] ?? '',
    section?.angle ? `What this page must cover: ${section.angle}` : '',
    '',
    '=== THE VOICE (follow it exactly) ===',
    voice?.style ?? '',
    '',
    terms.length ? '=== GLOSSARY (use these terms, never the alternatives) ===' : '',
    ...terms,
    '',
    '=== OUTPUT FORMAT ===',
    '- First line: "Summary: " followed by ONE sentence that says what the page is for or what the reader gets. Nothing before it.',
    `- Then these level-2 headings, in this order, each written exactly: ${headings.map(h => `"## ${h}"`).join(', ')}.`,
    '- You may add level-3 headings under them. Do not add other level-2 headings. Do not write a level-1 heading.',
    `- Length: ${minW} to ${maxW} words.`,
    tables.length
      ? `- The renderer appends these reference tables after your text, generated from the code. Refer to them ("see the table below") and do not reproduce them:\n${tables.join('\n')}`
      : '',
    diagrams > 0
      ? '- At most one Mermaid diagram, in a ```mermaid fence, only if it explains something prose cannot. Wrap every node label in double quotes; no parentheses, commas or colons inside labels; at most 10 nodes.'
      : '- No diagrams.',
    sibs.length ? `- Link another page inline as [[Title]], using exactly one of: ${sibs.map(s => `[[${s}]]`).join(', ')}. Do not invent links.` : '',
    '- Markdown only. No HTML. Do not wrap the answer in a code fence.',
    '- Ground every claim in the sources below. If the sources do not say it, leave it out. Never invent commands, flags, keys or paths.',
    '',
    '=== SOURCES ===',
    files.length ? `Files: ${files.join(', ')}` : '',
    sourceCtx ?? '',
  ].filter(l => l !== '').join('\n');
};

/** One repair turn: the page as written plus every violation the lint found. */
export const REPAIR_PROMPT = (md, violations) => [
  'The wiki page below breaks the house style. Rewrite it so every listed problem is gone.',
  'Keep the "Summary: " first line, the level-2 headings, the facts, the links and the meaning. Return the whole page in Markdown, nothing else.',
  '',
  'Problems:',
  ...violations.map(([rule, detail]) => `- ${rule}: ${detail}`),
  '',
  '=== PAGE ===',
  md,
].join('\n');

// "Summary: ..." on the first line becomes the page summary; without it the
// first sentence of the first paragraph stands in.
export function splitSummary(md) {
  const text = String(md ?? '').replace(/^\s+/, '');
  const m = text.match(/^Summary:\s*(.+)\r?\n?/i);
  if (m) return { summary: m[1].trim(), body: text.slice(m[0].length).replace(/^\s+/, '') };
  const para = text.split(/\n\s*\n/).find(p => p.trim() && !/^\s*[#|>`-]/.test(p)) ?? '';
  return { summary: (para.replace(/\s+/g, ' ').match(/^.*?[.!?](\s|$)/)?.[0] ?? para).trim(), body: text };
}

/**
 * Default network implementation: calls the Gemini generateContent REST endpoint.
 * @param {string} prompt
 * @param {{ apiKey:string, model?:string, fetchImpl?:typeof fetch }} opts
 * @returns {Promise<string>}
 */
export async function defaultCallModel(prompt, { apiKey, model = 'gemini-2.5-flash', fetchImpl, maxRetries = 5, sleep, timeoutMs = 120000 } = {}) {
  const doFetch = fetchImpl ?? fetch;
  const doSleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  // maxOutputTokens must be generous: gemini-3-flash "thinks" before answering,
  // and that reasoning draws from the same budget - too small a cap yields a
  // MAX_TOKENS finish with no text part (empty output -> Tier-1 fallback).
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192, temperature: 0.4 },
  });

  for (let attempt = 0; ; attempt++) {
    // The key goes in a header so it never lands in a logged or echoed URL.
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Free-tier is a per-minute request cap; a 429 is recoverable. Honor the
    // server's suggested "retry in Ns" backoff when present, else exponential.
    if (res.status === 429) {
      if (attempt >= maxRetries) throw new Error('wiki-llm: rate limited (429) after retries');
      let waitMs = Math.min(60000, 3000 * 2 ** attempt);
      try {
        const j = await res.json();
        const m = /retry in ([\d.]+)s/i.exec(j?.error?.message ?? '');
        if (m) waitMs = Math.ceil(parseFloat(m[1]) * 1000) + 500;
      } catch {}
      await doSleep(waitMs);
      continue;
    }

    if (!res.ok) {
      throw new Error(`wiki-llm: model call failed (status ${res.status ?? 'unknown'})`);
    }

    const json = await res.json();
    const candidate = json?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!candidate || !Array.isArray(parts)) {
      throw new Error('wiki-llm: model response had no candidate content');
    }
    return parts.map((p) => p?.text ?? '').join('');
  }
}

/**
 * Write a section's prose with the model. Cached by contentHash. A page that
 * fails the style lint gets up to `repairs` repair turns; one still failing
 * after that is returned with its violations, and the checker rejects the
 * build, so the last good wiki stays live. A model failure falls back to the
 * unwritten section (llm:false), which the checker also rejects.
 */
export async function enrichSection(section, sourceCtx, { callModel, cache, siblings = [], voice = null, lint = null, repairs = 2 } = {}) {
  if (cache) {
    const cached = cache.get(section.contentHash);
    if (cached) return cached;
  }

  let md;
  try {
    md = await callModel(PROMPT(section, sourceCtx, siblings, voice));
  } catch {
    return { ...section, llm: false };
  }
  if (!md) return { ...section, llm: false };

  let violations = lint ? lint(md) : [];
  for (let i = 0; i < repairs && violations.length; i++) {
    let fixed;
    try { fixed = await callModel(REPAIR_PROMPT(md, violations)); } catch { break; }
    if (!fixed) break;
    md = fixed;
    violations = lint(md);
  }

  const { summary, body } = splitSummary(md);
  const { proseMd, artifacts } = extractArtifacts(body);
  const result = { ...section, summary, proseMd, artifacts, llm: true, lintViolations: violations };
  if (cache && !violations.length) cache.set(section.contentHash, result);
  return result;
}
