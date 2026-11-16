// server/test/copilot-otel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractUsage, toSnapshots, toFeedEvents } from '../lib/observability/copilot-otel.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'copilot-otel', 'otel.jsonl');
const text = fs.readFileSync(FIX, 'utf-8');
const S1 = '0561da40-d145-4c8f-b438-3ed8bcb89ce4';
const S2 = 'a5962e0a-dbe2-4fe5-a7ab-ff1893a3aee6';

test('extractUsage: one acc per conversation, chat spans only (invoke_agent + metric ignored)', () => {
  const m = extractUsage(text);
  assert.deepEqual([...m.keys()].sort(), [S1, S2]);
  const a = m.get(S1);
  assert.equal(a.calls, 1);                 // NOT 2 -> invoke_agent twin excluded
  assert.equal(a.inputTokens, 19719);
  assert.equal(a.outputTokens, 43);
  assert.equal(a.cacheCreateTokens, 19710);
  assert.equal(a.credits, 0.33);
  assert.equal(a.latencyMs, 2330);
  assert.equal(a.model, 'claude-haiku-4.5');
});

test('toSnapshots: usage records with copilot-cli sid + null costUsd + credits', () => {
  const snaps = toSnapshots(extractUsage(text), { capturedAt: 1000 });
  const s = snaps.find(x => x.sid === `copilot-cli:${S2}`);
  assert.ok(s);
  assert.equal(s.tool, 'copilot-cli');
  assert.equal(s.input, 19725);
  assert.equal(s.output, 44);
  assert.equal(s.credits, 0.33);
  assert.equal(s.costUsd, null);
  assert.equal(s.latencyMs, 1967);
  assert.equal(s.capturedAt, 1000);
});

test('toFeedEvents: one kind:tokens event per session', () => {
  const evs = toFeedEvents(extractUsage(text));
  assert.equal(evs.length, 2);
  for (const e of evs) {
    assert.equal(e.kind, 'tokens');
    assert.equal(e.lane, 'feed');
    assert.ok(e.sessionId.startsWith('copilot-cli:'));
    assert.equal(typeof e.change.input, 'number');
  }
});

test('extractUsage: multiple chat spans in a session accumulate', () => {
  const firstChat = text.trim().split('\n')[0];
  const m = extractUsage(firstChat + '\n' + firstChat); // same chat span twice
  const a = [...m.values()][0];
  assert.equal(a.calls, 2);
  assert.equal(a.inputTokens, 19719 * 2);
});

test('extractUsage: unparseable line skipped silently (not drift)', () => {
  resetAdapterHealth();
  const m = extractUsage('{oops\n' + text);
  assert.equal(m.size, 2);
  assert.equal(adapterHealth()['copilot-otel']?.degraded, undefined);
});

test('extractUsage: chat span missing conversation.id -> reportMiss, skipped', () => {
  resetAdapterHealth();
  const bad = JSON.stringify({ type: 'span', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 5 } });
  const m = extractUsage(bad);
  assert.equal(m.size, 0);
  assert.equal(adapterHealth()['copilot-otel']?.degraded, true);
});
