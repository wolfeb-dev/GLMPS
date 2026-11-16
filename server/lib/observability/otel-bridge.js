// server/lib/observability/otel-bridge.js
// OpenTelemetry GenAI -> GLMPS event bridge. Maps OTLP/HTTP trace payloads (the gen_ai.*
// semantic conventions) into the shared event shape so GLMPS is a HYBRID capturer: ingest
// OTel where a harness emits it (Claude Code beta, Datadog-style OTLP), tail on-disk where it
// doesn't. The mapped events are fed through the server's normal pushEvents() pipeline, so
// model chips, tokens, and the governance detectors all work identically to adapter capture.
// Pure + zero-dep (OTLP is plain JSON over HTTP).

function attrsToMap(attrs) {
  const m = {};
  if (!Array.isArray(attrs)) return m;
  for (const a of attrs) {
    if (!a || !a.key) continue;
    const v = a.value || {};
    m[a.key] = v.stringValue ?? (v.intValue != null ? Number(v.intValue)
      : (v.doubleValue != null ? v.doubleValue : (v.boolValue != null ? v.boolValue : undefined)));
  }
  return m;
}

/**
 * @param otlp  an OTLP/HTTP traces payload: { resourceSpans: [{ resource, scopeSpans:[{ spans:[...] }] }] }
 * @param opts.clientId  the authenticated client the payload came from; session ids become
 *   `<clientId>:otel:<sid>`. Only the caller sets it, never the payload.
 * @returns shared-shape events tagged { via:'otel' } (kind:'meta' model, tool-use, tokens)
 */
export function otelToEvents(otlp, { clientId = null } = {}) {
  const out = [];
  const resourceSpans = otlp?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return out;

  for (const rs of resourceSpans) {
    const resAttrs = attrsToMap(rs?.resource?.attributes);
    for (const ss of (Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : [])) {
      for (const span of (Array.isArray(ss?.spans) ? ss.spans : [])) {
        const a = attrsToMap(span?.attributes);
        const sid = a['session.id'] ?? a['gen_ai.conversation.id'] ?? resAttrs['session.id'] ?? span?.traceId ?? 'unknown';
        const sessionId = (clientId ? `${clientId}:` : '') + 'otel:' + sid;
        const ts = span?.startTimeUnixNano ? Math.floor(Number(span.startTimeUnixNano) / 1e6) : null;
        const op = a['gen_ai.operation.name'] ?? span?.name ?? '';
        // Claude Code's own spans (code.claude.com/docs/en/monitoring-usage): the name may arrive as span.type.
        const spanName = span?.name || a['span.type'];
        const isLlm = spanName === 'claude_code.llm_request';
        const model = a['gen_ai.request.model'] ?? a['gen_ai.response.model'] ?? (isLlm ? a.model : undefined);

        if (model) out.push({ kind: 'meta', lane: 'feed', label: 'model', model, sessionId, ts, via: 'otel' });

        const toolName = a['gen_ai.tool.name'] ?? a['mcp.tool.name'] ?? (spanName === 'claude_code.tool' ? a.tool_name : undefined);
        if (op === 'execute_tool' || toolName) {
          out.push({ kind: 'tool-use', lane: 'feed', tool: toolName ?? 'tool',
            label: toolName ?? op, path: a['file.path'] ?? a['code.filepath'] ?? null, ts, sessionId, via: 'otel' });
        }

        const inTok = a['gen_ai.usage.input_tokens'] ?? (isLlm ? a.input_tokens : undefined);
        const outTok = a['gen_ai.usage.output_tokens'] ?? (isLlm ? a.output_tokens : undefined);
        const nativeUsage = isLlm && a['gen_ai.usage.input_tokens'] == null && a['gen_ai.usage.output_tokens'] == null;
        if (inTok != null || outTok != null) {
          out.push({ kind: 'tokens', lane: 'feed', tool: 'tokens', ts, sessionId, via: 'otel',
            label: `tokens ${inTok ?? 0} in / ${outTok ?? 0} out`,
            change: {
              input: Number(inTok) || 0,
              output: Number(outTok) || 0,
              ...(nativeUsage && a.cache_read_tokens != null ? { cacheRead: Number(a.cache_read_tokens) || 0 } : {}),
              ...(nativeUsage && a.cache_creation_tokens != null ? { cacheCreation: Number(a.cache_creation_tokens) || 0 } : {}),
            } });
        }
      }
    }
  }
  return out;
}

/** Group mapped events by sessionId (for feeding pushEvents once per session). */
export function groupBySession(events) {
  const g = new Map();
  for (const e of events) {
    const arr = g.get(e.sessionId) ?? [];
    arr.push(e);
    g.set(e.sessionId, arr);
  }
  return g;
}
