// server/lib/plugins/claude-model.js
// The one model every plugin uses: Claude via `claude -p` on the operator's
// Claude Code plan, in the shape of an OpenAI chat.completions call.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isTestProcess } from '../test-process.js';

export class ModelError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export function getModelConfig(configJson) {
  const o = configJson?.plugins?.model && typeof configJson.plugins.model === 'object' ? configJson.plugins.model : {};
  return {
    models: { fast: 'haiku', strong: 'sonnet', ...(o.models && typeof o.models === 'object' ? o.models : {}) },
    maxConcurrent: Number.isInteger(o.maxConcurrent) && o.maxConcurrent > 0 ? o.maxConcurrent : 2,
    // how many callers may wait behind
    // maxConcurrent before a further one is rejected outright (503) rather
    // than queued indefinitely.
    maxQueueDepth: Number.isInteger(o.maxQueueDepth) && o.maxQueueDepth > 0 ? o.maxQueueDepth : 20,
  };
}

// the shared model route (POST /api/plugins/
// model/v1/chat/completions) is reachable from any local process, not just
// the plugins that call chatCompletion() directly in-process - an HTTP
// caller may only ever request haiku or sonnet through it. opus and any
// other claude-* name are downgraded to models.fast (toClaudeCall's own
// fallback, triggered by omitting body.model here) instead of honored, even
// though CLAUDE_NAME already treats them as safe-to-spawn names elsewhere.
// This is an HTTP-boundary policy, so it is applied only at the route
// handler (server.js), never inside chatCompletion/toClaudeCall itself.
const HTTP_ALLOWED_MODELS = new Set(['haiku', 'sonnet']);
// the fixed haiku/sonnet allowlist
// silently downgraded a plugin's own CONFIGURED strong model the moment a
// caller asked for it by name over HTTP (e.g. GEPA configured with
// plugins.model.models.strong set to a real opus id) - the exact model the
// operator configured got replaced with a different, weaker one with no
// error. configuredModels (getModelConfig(cfg).models: { fast, strong }) is
// an additional, explicit allowlist on top of haiku/sonnet - anything else
// (an arbitrary claude-* name, or any other string) still downgrades.
export function restrictModelForHttp(body, configuredModels = null) {
  const allowed = configuredModels && typeof configuredModels === 'object'
    ? new Set([...HTTP_ALLOWED_MODELS, configuredModels.fast, configuredModels.strong].filter((m) => typeof m === 'string'))
    : HTTP_ALLOWED_MODELS;
  if (body && typeof body.model === 'string' && !allowed.has(body.model)) {
    const { model, ...rest } = body;
    return rest;
  }
  return body;
}

// the previous `^claude-` prefix-only match
// let anything after the prefix through unchecked, including shell
// metacharacters - on win32, runClaude's shell:true spawn hands that
// straight to cmd.exe. A model name is now a claude short name or
// `claude-` followed ONLY by lowercase letters, digits, dots and hyphens
// (i.e. exactly the character set a real model id ever needs).
const CLAUDE_NAME = /^(haiku|sonnet|opus|claude-[a-z0-9.-]+)$/;
// Shared with claude-stream.js (the huddle's long-lived client): one model-name
// rule and one kill-tree for every place GLMPS spawns `claude`.
export function isClaudeModelName(name) { return CLAUDE_NAME.test(String(name ?? '')); }
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
  return c == null ? '' : JSON.stringify(c);
}
function structuredOf(body) {
  const rf = body.response_format;
  if (rf?.type === 'json_object') return { kind: 'json_object', schema: null, toolName: null };
  if (rf?.type === 'json_schema') return { kind: 'json_schema', schema: rf.json_schema?.schema || null, toolName: null };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const tc = body.tool_choice;
  const name = tc && typeof tc === 'object' ? tc.function?.name : (tc === 'required' && tools.length === 1 ? tools[0].function?.name : null);
  if (!name) return null;
  const tool = tools.find((t) => t.function?.name === name);
  if (!tool) throw new ModelError(`tool_choice names unknown tool ${name}`);
  return { kind: 'tool', schema: tool.function.parameters || null, toolName: name };
}
export function toClaudeCall(body, { models }) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  if (!msgs.length) throw new ModelError('messages is required');
  const sys = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).filter(Boolean);
  const turns = msgs.filter((m) => m.role !== 'system' && m.role !== 'developer');
  const prompt = turns.length === 1 && turns[0].role === 'user' ? textOf(turns[0].content)
    : turns.map((m) => `${String(m.role).toUpperCase()}:\n${textOf(m.content)}`).join('\n\n');
  const structured = structuredOf(body);
  if (structured) sys.push('Respond with a single JSON object and nothing else: no prose, no code fences.' + (structured.schema ? ` It must match this JSON Schema:\n${JSON.stringify(structured.schema)}` : ''));
  return { model: typeof body.model === 'string' && CLAUDE_NAME.test(body.model) ? body.model : models.fast, system: sys.join('\n\n'), prompt, structured };
}
function stripFences(t) { const s = String(t).trim(); const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/); return m ? m[1].trim() : s; }
export function toOpenAIResponse(call, text, { id, created }) {
  let message = { role: 'assistant', content: String(text ?? '') }; let finish = 'stop';
  if (call.structured) {
    const content = stripFences(message.content);
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new ModelError('model returned non-JSON for a structured request', 502); }
    // valid JSON that is not a plain object
    // (null, a bare number, an array) is just as unusable as non-JSON here.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ModelError('model returned non-object JSON for a structured request', 502);
    if (call.structured.kind === 'tool') { message = { role: 'assistant', content: null, tool_calls: [{ id: `call_${id}`, type: 'function', function: { name: call.structured.toolName, arguments: content } }] }; finish = 'tool_calls'; }
    else message = { role: 'assistant', content };
  }
  return { id: `chatcmpl-${id}`, object: 'chat.completion', created, model: call.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}
// maxQueue bounds how many callers may wait
// behind `max` already-live ones. Unset (the default) is unbounded,
// matching every existing caller of this function before this fix.
export function createSemaphore(max, maxQueue = Infinity) {
  let live = 0; const q = [];
  const next = () => { if (live < max && q.length) { live++; q.shift()(); } };
  return {
    async run(fn) {
      if (q.length >= maxQueue) throw new ModelError('model route is at capacity; try again shortly', 503);
      await new Promise((r) => { q.push(r); next(); });
      try { return await fn(); } finally { live--; next(); }
    },
  };
}
// the controller ruling keeps shell:true on
// win32 (a house constraint: `claude` there is often a .cmd shim), which
// means the direct child of spawn is cmd.exe, not claude.exe. child.kill()
// only kills that shell, leaving the real claude.exe (its grandchild)
// running past the timeout, and the temp-dir cleanup that follows then
// fails EBUSY (the orphan still holds the cwd/system-prompt-file open).
// killTree is injectable so tests never actually invoke taskkill. On win32 it
// returns a promise that settles once taskkill has exited, so the temp-dir
// cleanup below can wait for the tree to be gone without blocking the loop.
function defaultKillTree(child, platform, { spawnImpl = nodeSpawn } = {}) {
  if (platform === 'win32' && child.pid) {
    return new Promise((resolve) => {
      const fail = (e) => { console.error(`claude-model: taskkill /T failed for pid ${child.pid}: ${e.message}`); resolve(); };
      try {
        const k = spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('error', fail);
        k.on('close', () => resolve());
      } catch (e) { fail(e); }
    });
  }
  try { child.kill('SIGKILL'); } catch { /* already exited before we could kill it */ }
}
export { defaultKillTree as killProcessTree };
// D28: every `claude` GLMPS spawns bills the operator's Claude Code plan. An
// API key or auth token left in the shell would make the CLI bill the API
// instead, so both are dropped from the child env (case-insensitively, for
// win32's env); everything else, PATH included, is kept.
const API_BILLING_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
export function claudeChildEnv(base) {
  const out = {};
  for (const [k, v] of Object.entries(base ?? {})) if (!API_BILLING_KEYS.has(k.toUpperCase())) out[k] = v;
  out.GLMPS_MEMORY_DISTILL = '1';
  return out;
}
export function runClaude({ model, system, prompt, timeoutMs = 120000, spawnImpl = nodeSpawn, tmpDir = os.tmpdir(), platform = process.platform, killTree = defaultKillTree, env = process.env, processEnv = process.env, argv = process.argv }) {
  return new Promise((resolve, reject) => {
    // Final fix wave A1 (BLOCKING) + residual fix (structural, A1 re-review):
    // every finalize/admission path that ends up here must be stoppable
    // without ever spawning a real `claude -p`, so no test (or a stray boot
    // in a throwaway environment) can reach the operator's real plan.
    // Checked before the model-name check below too: a disabled runner must
    // win even over an otherwise valid model name, and this must never
    // create the temp dir either.
    //
    // The original guard only checked env.GLMPS_MODEL_RUNNER === 'off', which
    // depended on every startServer caller building its own `env` by
    // spreading process.env (so test.env's suite-wide default reached this
    // far) and on npm test's --env-file=test.env actually having run (so
    // process.env carried it at all). Neither held everywhere: roughly 20
    // tests build startServer's env object by hand without spreading
    // process.env (e.g. server/test/plugins-model-route.test.js's mkEnv()),
    // and running a single test file directly via `node --test
    // some.test.js` never loads test.env in the first place. Node's own
    // test runner sets process.env.NODE_TEST_CONTEXT in every child process
    // it runs regardless of how it was invoked or how any one test built its
    // env object (confirmed for this repo's Node 24.3 floor by
    // server/test/claude-model.test.js's own assertion below), so checking
    // that directly closes the gap unconditionally. GLMPS_MODEL_RUNNER=on is
    // the one explicit escape hatch (checked first, honoured from either the
    // passed env or process.env), for the handful of tests in this file that
    // deliberately drive a FAKE spawnImpl through this real guard logic.
    const explicitlyOn = env.GLMPS_MODEL_RUNNER === 'on' || process.env.GLMPS_MODEL_RUNNER === 'on';
    if (!explicitlyOn) {
      if (env.GLMPS_MODEL_RUNNER === 'off' || process.env.GLMPS_MODEL_RUNNER === 'off') {
        return reject(new ModelError('model runner disabled (GLMPS_MODEL_RUNNER=off)', 503));
      }
      // Phase K final review, SHARED HELPER ruling: the one shared test-process
      // predicate (NODE_TEST_CONTEXT or GLMPS_TEST=1 in either env, or argv[1] a
      // test file), not NODE_TEST_CONTEXT alone. `processEnv`/`argv` are
      // injectable for tests only; production passes neither.
      if (isTestProcess({ env, processEnv, argv })) {
        return reject(new ModelError('model runner disabled under node --test (test process detected)', 503));
      }
    }
    // the last line of defense before
    // spawn. Covers not just a hostile body.model (toClaudeCall already
    // filters that) but a misconfigured plugins.model.models.fast/strong in
    // config.json, which reaches here unchecked.
    if (!CLAUDE_NAME.test(model)) return reject(new ModelError(`refusing to spawn an unsafe model name: ${model}`, 400));
    const work = fs.mkdtempSync(path.join(tmpDir, 'mc-model-')); const sysFile = path.join(work, 'system.txt');
    fs.writeFileSync(sysFile, system || 'You are a text generator. Answer only with the requested text.');
    const win = platform === 'win32';
    const args = ['-p', '--output-format', 'json', '--model', model, '--no-session-persistence', '--tools=', '--system-prompt-file', win ? `"${sysFile}"` : sysFile, '--setting-sources=', '--strict-mcp-config'];
    // Fix round 1, item 2 (cleanup half): best-effort stays best-effort (it
    // never rejects), but a failure to remove the temp dir must be visible,
    // not silently swallowed.
    const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { console.error(`claude-model: temp-dir cleanup failed for ${work}: ${e.message}`); } };
    let out = ''; let err = ''; let done = false;
    const child = spawnImpl('claude', args, { cwd: work, shell: win, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeChildEnv(process.env) });
    const timer = setTimeout(() => {
      if (done) return; done = true;
      Promise.resolve().then(() => killTree(child, platform))
        .catch((e) => { console.error(`claude-model: killTree failed: ${e.message}`); })
        .then(() => { cleanup(); reject(new ModelError('claude -p timed out', 504)); });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; }); child.stderr?.on('data', (d) => { err += d; });
    // a child that exits before we finish
    // writing a large prompt closes its end of the pipe; Node then emits
    // 'error' (EPIPE) on child.stdin, not on the child. Unhandled, that
    // crashes the whole server. It is intentionally a no-op: the 'close'
    // event (or, failing that, the timeout above) still settles this promise.
    child.stdin.on('error', () => { /* early-exiting child; close/timeout settles this */ });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); cleanup(); reject(new ModelError(`spawn failed: ${e.message}`, 502)); });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer); cleanup();
      let j; try { j = JSON.parse(out); } catch { return reject(new ModelError(`unparseable claude output (exit ${code}): ${(err || out).slice(0, 200)}`, 502)); }
      // valid JSON that isn't an object (e.g.
      // the bare literal `null`) would otherwise throw reading `j.is_error`
      // below, crashing this handler uncaught.
      if (!j || typeof j !== 'object') return reject(new ModelError(`unexpected claude output shape (exit ${code}): ${(err || out).slice(0, 200)}`, 502));
      if (code !== 0 || j.is_error) return reject(new ModelError(`claude error (exit ${code}): ${String(j.result || err).slice(0, 200)}`, 502));
      resolve(String(j.result ?? ''));
    });
    child.stdin.end(prompt);
  });
}
// `env` is forwarded to runImpl (runClaude by default) on every call, not
// read once at construction time: server.js builds this from its own `env`
// param (never real process.env directly), which is what lets a test's
// per-server env override (not just the suite-wide test.env default) reach
// the GLMPS_MODEL_RUNNER=off guard inside runClaude.
export function createChatCompletion({
  models, maxConcurrent = 2, maxQueueDepth = 20, runImpl = runClaude, now = Date.now, env = process.env,
}) {
  const sem = createSemaphore(maxConcurrent, maxQueueDepth);
  return async (body) => { const call = toClaudeCall(body, { models }); const text = await sem.run(() => runImpl({ ...call, env })); return toOpenAIResponse(call, text, { id: crypto.randomUUID().slice(0, 12), created: Math.floor(now() / 1000) }); };
}
