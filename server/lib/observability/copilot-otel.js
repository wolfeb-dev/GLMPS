// server/lib/observability/copilot-otel.js
// Parses GitHub Copilot CLI's OTel file-exporter output (a FLAT JSONL where each
// line is a span or a metric - NOT the OTLP {resourceSpans:[...]} envelope, so
// otel-bridge.js does not apply). Token/credit/latency live on `chat` spans
// (gen_ai.operation.name === 'chat'), keyed by gen_ai.conversation.id. The
// invoke_agent twin duplicates usage and is skipped; metric histograms lack a
// session id and are skipped. Pure + zero-dep.
import { reportMiss } from '../adapters/health.js';

const ID = 'copilot-otel';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** text (JSONL) -> Map<conversationId, acc>. Only chat spans contribute. */
export function extractUsage(text) {
  const map = new Map();
  if (typeof text !== 'string' || !text) return map;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; } // transient partial line
    if (!o || o.type !== 'span') continue;
    const a = o.attributes;
    if (!a || a['gen_ai.operation.name'] !== 'chat') continue; // dedup invoke_agent; skip metrics
    const conv = a['gen_ai.conversation.id'];
    const hasTokens = a['gen_ai.usage.input_tokens'] != null || a['gen_ai.usage.output_tokens'] != null;
    if (typeof conv !== 'string' || !conv || !hasTokens) {
      reportMiss(ID, 'chat span missing conversation.id or usage tokens');
      continue;
    }
    let acc = map.get(conv);
    if (!acc) {
      acc = { model: null, inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0, credits: 0, latencyMs: null, calls: 0, lastTs: null };
      map.set(conv, acc);
    }
    acc.inputTokens += num(a['gen_ai.usage.input_tokens']);
    acc.outputTokens += num(a['gen_ai.usage.output_tokens']);
    acc.cacheCreateTokens += num(a['gen_ai.usage.cache_creation.input_tokens']);
    acc.reasoningTokens += num(a['gen_ai.usage.reasoning.output_tokens']);
    acc.credits += num(a['github.copilot.cost']);
    acc.calls += 1;
    const model = a['gen_ai.response.model'] ?? a['gen_ai.request.model'];
    if (typeof model === 'string' && model) acc.model = model;
    if (a['github.copilot.server_duration'] != null) acc.latencyMs = num(a['github.copilot.server_duration']);
  }
  return map;
}

/** Map -> usage-store snapshot records (cumulative per session). */
export function toSnapshots(map, opts = {}) {
  const capturedAt = typeof opts.capturedAt === 'number' ? opts.capturedAt : null;
  const out = [];
  for (const [conv, a] of map) {
    out.push({
      sid: `copilot-cli:${conv}`, tool: 'copilot-cli', model: a.model,
      input: a.inputTokens, output: a.outputTokens,
      cacheCreate: a.cacheCreateTokens, cacheRead: 0,
      credits: a.credits, costUsd: null, latencyMs: a.latencyMs, cwd: null, capturedAt,
    });
  }
  return out;
}

/** Map -> kind:'tokens' feed events (one per session). */
export function toFeedEvents(map) {
  const out = [];
  for (const [conv, a] of map) {
    out.push({
      kind: 'tokens', lane: 'feed', tool: 'tokens', sessionId: `copilot-cli:${conv}`,
      label: `tokens ${a.inputTokens} in / ${a.outputTokens} out`,
      change: { input: a.inputTokens, output: a.outputTokens },
    });
  }
  return out;
}
