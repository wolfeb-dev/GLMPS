// server/test/otel-bridge.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otelToEvents } from '../lib/observability/otel-bridge.js';

const otlp = {
  resourceSpans: [{
    resource: { attributes: [{ key: 'session.id', value: { stringValue: 'sess-1' } }] },
    scopeSpans: [{
      spans: [
        { name: 'chat', traceId: 'abc', startTimeUnixNano: '1700000000000000000', attributes: [
          { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
          { key: 'gen_ai.request.model', value: { stringValue: 'claude-opus-4-8' } },
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '45' } },
        ] },
        { name: 'execute_tool', startTimeUnixNano: '1700000001000000000', attributes: [
          { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
          { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
        ] },
      ],
    }],
  }],
};

test('otelToEvents: maps model + tokens + tool spans to events with a session id', () => {
  const evs = otelToEvents(otlp);
  const meta = evs.find(e => e.kind === 'meta' && e.label === 'model');
  assert.ok(meta && meta.model === 'claude-opus-4-8');
  assert.ok(evs.every(e => e.sessionId === 'otel:sess-1'), 'session id derived from resource attr');
  assert.ok(evs.every(e => e.via === 'otel'), 'events tagged via otel');
  const tok = evs.find(e => e.kind === 'tokens');
  assert.ok(tok && tok.change.input === 120 && tok.change.output === 45);
  const tool = evs.find(e => e.kind === 'tool-use');
  assert.ok(tool && tool.tool === 'Bash');
});

test('otelToEvents: falls back to traceId for session id when no session attr', () => {
  const p = { resourceSpans: [{ scopeSpans: [{ spans: [
    { name: 'chat', traceId: 'trace-xyz', attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } }] },
  ] }] }] };
  const evs = otelToEvents(p);
  assert.ok(evs.some(e => e.sessionId === 'otel:trace-xyz' && e.model === 'gpt-5'));
});

test('otelToEvents: malformed / empty -> []', () => {
  assert.deepEqual(otelToEvents(null), []);
  assert.deepEqual(otelToEvents({}), []);
  assert.deepEqual(otelToEvents({ resourceSpans: 'nope' }), []);
});

test('otelToEvents: a clientId namespaces session ids, and the payload cannot choose it', () => {
  const evs = otelToEvents(otlp, { clientId: 'cl-1' });
  assert.ok(evs.length > 0);
  assert.ok(evs.every(e => e.sessionId === 'cl-1:otel:sess-1'));
  assert.ok(otelToEvents(otlp, {}).every(e => e.sessionId === 'otel:sess-1'));
  assert.ok(otelToEvents(otlp).every(e => e.sessionId === 'otel:sess-1'));
});

const str = (key, v) => ({ key, value: { stringValue: v } });
const int = (key, v) => ({ key, value: { intValue: String(v) } });
const wrap = (...spans) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });

test('otelToEvents: reads Claude Code native llm_request attributes', () => {
  const evs = otelToEvents(wrap({ name: 'claude_code.llm_request', startTimeUnixNano: '1700000000000000000', attributes: [
    str('session.id', 's1'), str('model', 'claude-opus-4-8'), int('input_tokens', 10), int('output_tokens', 5),
    int('cache_read_tokens', 100), int('cache_creation_tokens', 7),
  ] }));
  assert.equal(evs.find(e => e.kind === 'meta').model, 'claude-opus-4-8');
  const tok = evs.find(e => e.kind === 'tokens');
  assert.deepEqual(tok.change, { input: 10, output: 5, cacheRead: 100, cacheCreation: 7 });
});

test('otelToEvents: native cache fields are omitted when absent; span.type names the span', () => {
  const evs = otelToEvents(wrap({ attributes: [
    str('span.type', 'claude_code.llm_request'), str('session.id', 's1'), int('input_tokens', 3), int('output_tokens', 4),
  ] }));
  assert.deepEqual(evs.find(e => e.kind === 'tokens').change, { input: 3, output: 4 });
});

test('otelToEvents: native tool_name only on claude_code.tool, not its child spans', () => {
  const evs = otelToEvents(wrap(
    { name: 'claude_code.tool', attributes: [str('session.id', 's1'), str('tool_name', 'Bash')] },
    { name: 'claude_code.tool.execution', attributes: [str('session.id', 's1'), str('tool_name', 'Bash')] },
    { name: 'claude_code.tool.blocked_on_user', attributes: [str('session.id', 's1'), str('tool_name', 'Bash')] },
  ));
  const tools = evs.filter(e => e.kind === 'tool-use');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool, 'Bash');
});

test('otelToEvents: gen_ai attributes win over native ones, native ones ignored on other spans', () => {
  const evs = otelToEvents(wrap(
    { name: 'claude_code.llm_request', attributes: [str('session.id', 's1'), str('gen_ai.request.model', 'gen-model'), str('model', 'native-model'),
      int('gen_ai.usage.input_tokens', 1), int('gen_ai.usage.output_tokens', 2), int('input_tokens', 90), int('output_tokens', 90)] },
    { name: 'other', attributes: [str('session.id', 's1'), str('model', 'x'), int('input_tokens', 5)] },
  ));
  assert.deepEqual(evs.filter(e => e.kind === 'meta').map(e => e.model), ['gen-model']);
  const toks = evs.filter(e => e.kind === 'tokens');
  assert.equal(toks.length, 1);
  assert.deepEqual(toks[0].change, { input: 1, output: 2 });
});
