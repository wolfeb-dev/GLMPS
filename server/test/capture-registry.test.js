// server/test/capture-registry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_REGISTRY, withAdapters, REFERENCE_TOOL } from '../lib/observability/capture-registry.js';

const SURFACES = new Set(['local-artifact', 'hook']);

test('registry is well-formed', () => {
  assert.ok(Array.isArray(TOOL_REGISTRY) && TOOL_REGISTRY.length >= 10);
  for (const t of TOOL_REGISTRY) {
    assert.equal(typeof t.id, 'string'); assert.ok(t.id.length);
    assert.equal(typeof t.displayName, 'string');
    assert.ok(Number.isInteger(t.popularityWeight) && t.popularityWeight >= 1 && t.popularityWeight <= 5);
    assert.ok(SURFACES.has(t.captureSurface), `surface ${t.captureSurface}`);
    assert.ok(t.adapter === null || typeof t.adapter === 'string');
    assert.ok(t.fixture === null || typeof t.fixture === 'string');
  }
});

test('adapters built on inferred record shapes are marked speculative (glmps-2-0-runtime-132)', () => {
  const speculative = TOOL_REGISTRY.filter(t => t.speculative).map(t => t.id).sort();
  assert.deepEqual(speculative, ['cursor-cli', 'droid', 'openclaw']);
  for (const t of TOOL_REGISTRY) assert.ok(t.speculative === undefined || t.speculative === true, `${t.id} speculative must be true or absent`);
});

test('unique ids', () => {
  const ids = TOOL_REGISTRY.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('reference tool is claude-code and is in the registry', () => {
  assert.equal(REFERENCE_TOOL, 'claude-code');
  assert.ok(TOOL_REGISTRY.some(t => t.id === 'claude-code' && t.adapter));
});

test('Copilot is on the list (chat + CLI both covered) + Cursor-native still a gap', () => {
  const byId = Object.fromEntries(TOOL_REGISTRY.map(t => [t.id, t]));
  assert.ok(byId['copilot-chat'] && byId['copilot-chat'].adapter, 'copilot-chat covered');
  assert.ok(byId['copilot-cli'] && byId['copilot-cli'].adapter === 'copilot-cli', 'copilot-cli now covered');
  assert.ok(byId['cursor-native'] && byId['cursor-native'].adapter === null, 'cursor-native present, not built');
  assert.ok(byId['gemini-cli'], 'gemini-cli present');
});

test('withAdapters returns only entries with both an adapter and a fixture', () => {
  const list = withAdapters();
  assert.ok(Array.isArray(list));
  for (const t of list) { assert.ok(t.adapter); assert.ok(t.fixture); }
});

test('every built adapter has a committed golden fixture (glmps-46)', () => {
  for (const t of TOOL_REGISTRY.filter(x => x.adapter)) {
    assert.equal(typeof t.fixture, 'string', `${t.id} adapter lacks a golden fixture`);
  }
});
