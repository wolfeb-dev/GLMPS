// server/test/wiki-llm.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArtifacts, PROMPT, defaultCallModel, enrichSection, splitSummary } from '../lib/observability/wiki-llm.js';
import { loadVoice } from '../lib/observability/wiki-voice.js';

function makeSection(overrides = {}) {
  return {
    slug: 'core-loop',
    title: 'Core Loop',
    community: 0,
    godNodes: ['server/server.js'],
    files: ['server/server.js', 'server/lib/paths.js'],
    proseMd: 'original prose',
    mermaid: null,
    contentHash: 'hash-1',
    ...overrides,
  };
}

function makeCache() {
  return {
    _m: new Map(),
    get(k) { return this._m.get(k); },
    set(k, v) { this._m.set(k, v); },
  };
}

test('extractArtifacts: pulls a mermaid block out of prose', () => {
  const md = "Intro prose.\n\n```mermaid\ngraph TD\nA-->B\n```\n";
  const { proseMd, artifacts } = extractArtifacts(md);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].type, 'mermaid');
  assert.ok(artifacts[0].spec.includes('graph TD'));
  assert.ok(proseMd.includes('Intro prose'));
  assert.ok(!proseMd.includes('graph TD'));
});

test('extractArtifacts: valid vega-lite JSON becomes one artifact', () => {
  const md = 'Some prose.\n\n```vega-lite\n{"mark":"bar"}\n```\n\nMore prose.';
  const { proseMd, artifacts } = extractArtifacts(md);
  assert.equal(artifacts.length, 1);
  assert.deepEqual(artifacts[0], { type: 'vega-lite', spec: { mark: 'bar' } });
  assert.ok(!proseMd.includes('```'));
});

test('extractArtifacts: invalid vega-lite JSON is dropped entirely', () => {
  const md = 'Some prose.\n\n```vega-lite\n{bad\n```\n\nMore prose.';
  const { proseMd, artifacts } = extractArtifacts(md);
  assert.equal(artifacts.length, 0);
  assert.ok(!proseMd.includes('```'));
  assert.ok(proseMd.includes('Some prose'));
  assert.ok(proseMd.includes('More prose'));
});

test('extractArtifacts: GFM tables and other fences stay inline', () => {
  const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n';
  const { proseMd, artifacts } = extractArtifacts(md);
  assert.equal(artifacts.length, 0);
  assert.ok(proseMd.includes('| a | b |'));
  assert.ok(proseMd.includes('const x = 1;'));
});

const voice = loadVoice();

test('PROMPT: includes title, file list, and sourceCtx', () => {
  const section = makeSection();
  const prompt = PROMPT(section, 'source context text here');
  assert.ok(prompt.includes('Core Loop'));
  assert.ok(prompt.includes('server/server.js'));
  assert.ok(prompt.includes('server/lib/paths.js'));
  assert.ok(prompt.includes('source context text here'));
});

test('PROMPT: carries the style text verbatim and every glossary term', () => {
  const prompt = PROMPT(makeSection({ kind: 'guide' }), 'ctx', [], voice);
  assert.ok(prompt.includes(voice.style), 'the style file must appear verbatim');
  assert.ok(voice.glossary.terms.length > 0);
  for (const t of voice.glossary.terms) assert.ok(prompt.includes(`- ${t.term}: ${t.definition}`), `glossary term ${t.term}`);
  assert.ok(prompt.includes('(never: ticket, backlog item, kanban item)'));
});

test('PROMPT: lists the required headings in order as "## X"', () => {
  for (const kind of ['guide', 'admin', 'concept', 'code']) {
    const headings = voice.templates[kind].headings;
    const prompt = PROMPT(makeSection({ kind }), 'ctx', [], voice);
    const line = headings.map(h => `"## ${h}"`).join(', ');
    assert.ok(prompt.includes(line), `${kind} headings in order`);
  }
  const custom = PROMPT(makeSection({ kind: 'guide', required: ['Alpha', 'Beta'] }), 'ctx', [], voice);
  assert.ok(custom.includes('"## Alpha", "## Beta"'), 'section.required overrides the template');
});

test('PROMPT: names the reference tables only when section.reference is set', () => {
  const ref = [{ title: 'Routes', columns: ['Path', 'Method'], rows: [['/a', 'GET'], ['/b', 'POST']] }];
  const withRef = PROMPT(makeSection({ kind: 'admin', reference: ref }), 'ctx', [], voice);
  assert.match(withRef, /renderer appends these reference tables/);
  assert.ok(withRef.includes('- Routes: 2 rows (Path, Method)'));
  const without = PROMPT(makeSection({ kind: 'admin' }), 'ctx', [], voice);
  assert.doesNotMatch(without, /reference tables/);
});

test('PROMPT: guide and admin pages get "No diagrams."; concept pages may have one Mermaid diagram', () => {
  for (const kind of ['guide', 'admin', 'code']) assert.ok(PROMPT(makeSection({ kind }), 'ctx', [], voice).includes('No diagrams.'), kind);
  const concept = PROMPT(makeSection({ kind: 'concept' }), 'ctx', [], voice);
  assert.ok(!concept.includes('No diagrams.'));
  assert.match(concept, /At most one Mermaid diagram/);
});

test('PROMPT: sibling links are offered as [[Title]] only when siblings are given', () => {
  assert.ok(PROMPT(makeSection(), 'ctx', ['Alpha', 'Beta'], voice).includes('[[Alpha]], [[Beta]]'));
  assert.doesNotMatch(PROMPT(makeSection(), 'ctx', [], voice), /\[\[/);
});

test('splitSummary: a Summary line becomes the summary and leaves the body', () => {
  const r = splitSummary('Summary: Run the build.\n\n## Purpose\nText.');
  assert.equal(r.summary, 'Run the build.');
  assert.equal(r.body, '## Purpose\nText.');
});

test('splitSummary: without a Summary line the first sentence of the first paragraph stands in', () => {
  const r = splitSummary('## Purpose\n\nThe loop runs hourly. It then stops.\n\nMore.');
  assert.equal(r.summary, 'The loop runs hourly.');
  assert.ok(r.body.startsWith('## Purpose'));
});

test('enrichSection: success path sets llm=true, extracts artifacts, does not mutate input', async () => {
  const section = makeSection();
  const callModel = async () => "Intro prose.\n\n```mermaid\ngraph TD\nA-->B\n```\n";
  const result = await enrichSection(section, 'ctx', { callModel });
  assert.equal(result.llm, true);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].type, 'mermaid');
  assert.ok(result.proseMd.includes('Intro prose'));
  assert.ok(!result.proseMd.includes('graph TD'));
  assert.equal(section.proseMd, 'original prose', 'input section must not be mutated');
  assert.equal(section.llm, undefined);
});

test('enrichSection: callModel throws -> Tier-1 fallback with llm=false and original prose', async () => {
  const section = makeSection();
  const callModel = async () => { throw new Error('network down'); };
  const result = await enrichSection(section, 'ctx', { callModel });
  assert.equal(result.llm, false);
  assert.equal(result.proseMd, section.proseMd);
});

test('enrichSection: callModel returns empty string -> Tier-1 fallback', async () => {
  const section = makeSection();
  const callModel = async () => '';
  const result = await enrichSection(section, 'ctx', { callModel });
  assert.equal(result.llm, false);
  assert.equal(result.proseMd, section.proseMd);
});

test('enrichSection: cache hit returns cached section without calling callModel', async () => {
  const section = makeSection();
  const cache = makeCache();
  const cached = { ...section, proseMd: 'cached prose', artifacts: [], llm: true };
  cache.set(section.contentHash, cached);

  let calls = 0;
  const callModel = async () => { calls += 1; return 'should not be used'; };

  const result = await enrichSection(section, 'ctx', { callModel, cache });
  assert.equal(calls, 0);
  assert.deepEqual(result, cached);
});

test('enrichSection: cache miss calls callModel and populates the cache', async () => {
  const section = makeSection();
  const cache = makeCache();
  let calls = 0;
  const callModel = async () => { calls += 1; return 'Some narrative prose.'; };

  const result = await enrichSection(section, 'ctx', { callModel, cache });
  assert.equal(calls, 1);
  assert.equal(result.llm, true);
  assert.equal(cache.get(section.contentHash), result);
});

test('defaultCallModel: posts to generateContent endpoint and returns joined text', async () => {
  let capturedUrl, capturedOpts;
  const fetchImpl = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }) };
  };
  const result = await defaultCallModel('a prompt', { apiKey: 'dummy-key-123', fetchImpl });
  assert.equal(result, 'hello');
  assert.ok(capturedUrl.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'));
  assert.equal(capturedUrl.includes('dummy-key-123'), false, 'the key never travels in the URL');
  assert.equal(capturedUrl.includes('key='), false);
  assert.equal(capturedOpts.headers['x-goog-api-key'], 'dummy-key-123');
  assert.ok(capturedOpts.signal instanceof AbortSignal, 'every call carries a timeout signal');
  assert.equal(capturedOpts.method, 'POST');
  assert.equal(capturedOpts.headers['content-type'], 'application/json');
  const body = JSON.parse(capturedOpts.body);
  assert.deepEqual(body.contents, [{ parts: [{ text: 'a prompt' }] }]);
  assert.ok(body.generationConfig.maxOutputTokens >= 4096,
    'a generous output budget is sent so thinking does not starve the answer');
});

// AbortSignal.timeout is unref'd, so on Node 22 the runner would end the
// file while this fetch hangs; a ref'd timer keeps it open until the abort.
test('defaultCallModel: a hung request is aborted by the timeout instead of waiting forever', async () => {
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    const keepalive = setTimeout(() => {}, 10_000);
    opts.signal.addEventListener('abort', () => { clearTimeout(keepalive); reject(opts.signal.reason); }, { once: true });
  });
  await assert.rejects(defaultCallModel('p', { apiKey: 'k', fetchImpl, timeoutMs: 30 }), (e) => e?.name === 'TimeoutError');
});

test('defaultCallModel: joins multiple parts', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'foo' }, { text: 'bar' }] } }] }) });
  const result = await defaultCallModel('p', { apiKey: 'k', fetchImpl });
  assert.equal(result, 'foobar');
});

test('defaultCallModel: non-ok (500) response throws without leaking apiKey', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'server error' });
  await assert.rejects(
    () => defaultCallModel('a prompt', { apiKey: 'super-secret-key', fetchImpl, sleep: async () => {} }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes('super-secret-key'));
      return true;
    }
  );
});

test('defaultCallModel: retries on 429 then succeeds, honoring the suggested delay', async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { status: 429, ok: false, json: async () => ({ error: { message: 'Please retry in 0.4s' } }) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'recovered' }] } }] }) };
  };
  const result = await defaultCallModel('p', { apiKey: 'k', fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(result, 'recovered');
  assert.equal(n, 2, 'called twice: 429 then 200');
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 400, 'honored the ~0.4s server-suggested backoff');
});

test('defaultCallModel: persistent 429 throws after maxRetries without leaking apiKey', async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; return { status: 429, ok: false, json: async () => ({ error: { message: 'quota' } }) }; };
  await assert.rejects(
    () => defaultCallModel('p', { apiKey: 'super-secret-key', fetchImpl, maxRetries: 2, sleep: async () => {} }),
    (err) => { assert.ok(!err.message.includes('super-secret-key')); assert.match(err.message, /429/); return true; },
  );
  assert.equal(n, 3, 'initial try + 2 retries');
});

test('defaultCallModel: missing candidate throws without leaking apiKey', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ candidates: [] }) });
  await assert.rejects(
    () => defaultCallModel('a prompt', { apiKey: 'super-secret-key', fetchImpl }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes('super-secret-key'));
      return true;
    }
  );
});

test('defaultCallModel: uses default model in URL when none given', async () => {
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) };
  };
  await defaultCallModel('p', { apiKey: 'k', fetchImpl });
  assert.ok(capturedUrl.includes('gemini-2.5-flash'));
});

const clean = 'Summary: A clean page.\n\n## Purpose\nIt does one thing.';
const dirty = 'Summary: A dirty page.\n\n## Purpose\nIt is robust.';

test('enrichSection: a failing lint triggers up to 2 repair calls, then returns lintViolations and does not cache', async () => {
  const cache = makeCache();
  let calls = 0; const prompts = [];
  const callModel = async (p) => { calls++; prompts.push(p); return dirty; };
  const lint = (md) => (md.includes('robust') ? [['banned-word', '"robust"']] : []);
  const r = await enrichSection(makeSection(), 'ctx', { callModel, cache, lint });
  assert.equal(calls, 3, 'one write plus two repairs');
  assert.match(prompts[1], /banned-word: "robust"/);
  assert.equal(r.llm, true);
  assert.deepEqual(r.lintViolations, [['banned-word', '"robust"']]);
  assert.equal(cache._m.size, 0, 'a failing page is never cached');
});

test('enrichSection: a repair that fixes the page stops the loop and the clean page is cached', async () => {
  const cache = makeCache();
  const outputs = [dirty, clean];
  let calls = 0;
  const callModel = async () => outputs[calls++];
  const lint = (md) => (md.includes('robust') ? [['banned-word', '"robust"']] : []);
  const r = await enrichSection(makeSection(), 'ctx', { callModel, cache, lint });
  assert.equal(calls, 2);
  assert.deepEqual(r.lintViolations, []);
  assert.equal(r.summary, 'A clean page.');
  assert.ok(r.proseMd.startsWith('## Purpose'));
  assert.equal(cache.get('hash-1'), r);
});

test('enrichSection: a clean first draft makes exactly one call and is cached', async () => {
  const cache = makeCache();
  let calls = 0;
  const r = await enrichSection(makeSection(), 'ctx', { callModel: async () => { calls++; return clean; }, cache, lint: () => [] });
  assert.equal(calls, 1);
  assert.equal(cache.get('hash-1'), r);
});

test('enrichSection: a repair call that throws keeps the last draft and its violations', async () => {
  let calls = 0;
  const callModel = async () => { if (calls++ === 0) return dirty; throw new Error('down'); };
  const r = await enrichSection(makeSection(), 'ctx', { callModel, lint: () => [['banned-word', 'x']] });
  assert.equal(calls, 2);
  assert.equal(r.llm, true);
  assert.equal(r.lintViolations.length, 1);
});

test('enrichSection: repairs option bounds the repair turns', async () => {
  let calls = 0;
  await enrichSection(makeSection(), 'ctx', { callModel: async () => { calls++; return dirty; }, lint: () => [['r', 'd']], repairs: 0 });
  assert.equal(calls, 1);
});
