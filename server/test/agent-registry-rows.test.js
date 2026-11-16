// server/test/agent-registry-rows.test.js
// Task 10 (glmps-138 agent-routing plan): pure /api/agents rows + agent-retire
// measurables -> Capability Registry rows. web/evaluation/agent-rows.js has no
// DOM/I/O so it is importable verbatim under node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRows } from '../../web/evaluation/agent-rows.js';

test('a dispatched agent is active', () => {
  const [row] = agentRows([{ name: 'ui-designer', source: 'assets', dispatchCount: 23, lastUsed: 99, modelSplit: { sonnet: 18, haiku: 0, opus: 0, none: 5 } }], []);
  assert.equal(row.kind, 'agent');
  assert.equal(row.state, 'active');
  assert.equal(row.lastUsedTs, 99);
  assert.equal(row.detail, '23 dispatches');
});

test('an unused agent inside the observation window is proposed', () => {
  const [row] = agentRows([{ name: 'ninjascript-coder', source: 'assets', dispatchCount: 0, lastUsed: null, modelSplit: {} }], []);
  assert.equal(row.state, 'proposed');
});

test('an agent with a retire measurable is deprecated', () => {
  const [row] = agentRows(
    [{ name: 'ninjascript-coder', source: 'assets', dispatchCount: 0, lastUsed: null, modelSplit: {} }],
    [{ kind: 'agent-retire', evidence: { ref: 'ninjascript-coder' }, labels: [] }],
  );
  assert.equal(row.state, 'deprecated');
});

test('an approved retire measurable is retired', () => {
  const [row] = agentRows(
    [{ name: 'ninjascript-coder', source: 'assets', dispatchCount: 0, lastUsed: null, modelSplit: {} }],
    [{ kind: 'agent-retire', evidence: { ref: 'ninjascript-coder' }, labels: [{ decision: 'approve' }] }],
  );
  assert.equal(row.state, 'retired');
});

test('the model split becomes the subLabel', () => {
  const [row] = agentRows([{ name: 'x', source: 'plugin', dispatchCount: 3, lastUsed: 1, modelSplit: { sonnet: 2, haiku: 1, opus: 0, none: 0 } }], []);
  assert.equal(row.subLabel, 'sonnet 2, haiku 1');
});

// glmps-138 review fix (code review Important finding): every sibling row
// builder in registry.js (buildGuardRows/buildSkillRows/buildMemoryRows/
// buildCrossAgentRows) guards a malformed array entry before reading its
// fields; agentRows() must do the same, fail-open per registry-state.js's
// documented contract, since rows[] is assembled in renderRegistry() with no
// surrounding try/catch, an unguarded throw here would take down every kind,
// not just agent's.
test('malformed entries (null, undefined, non-object, no name) are skipped, not thrown on, and valid entries still map correctly', () => {
  const agents = [
    null,
    undefined,
    'not-an-object',
    { source: 'assets', dispatchCount: 1 }, // no name
    { name: 'ui-designer', source: 'assets', dispatchCount: 23, lastUsed: 99, modelSplit: { sonnet: 18, haiku: 0, opus: 0, none: 5 } },
  ];
  const rows = agentRows(agents, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'ui-designer');
  assert.equal(rows[0].state, 'active');
});

test('an explicitly null modelSplit does not throw and yields an empty subLabel', () => {
  const [row] = agentRows([{ name: 'x', source: 'plugin', dispatchCount: 1, lastUsed: 1, modelSplit: null }], []);
  assert.equal(row.subLabel, '');
});

// the retire-candidate-wins-over-active
// combination was verified by inspection but had no regression guard.
test('a dispatched agent with an unapproved retire measurable is deprecated, not active', () => {
  const [row] = agentRows(
    [{ name: 'ui-designer', source: 'assets', dispatchCount: 23, lastUsed: 99, modelSplit: {} }],
    [{ kind: 'agent-retire', evidence: { ref: 'ui-designer' }, labels: [] }],
  );
  assert.equal(row.state, 'deprecated');
});

test('a dispatched agent with an approved retire measurable is retired, not active', () => {
  const [row] = agentRows(
    [{ name: 'ui-designer', source: 'assets', dispatchCount: 23, lastUsed: 99, modelSplit: {} }],
    [{ kind: 'agent-retire', evidence: { ref: 'ui-designer' }, labels: [{ decision: 'approve' }] }],
  );
  assert.equal(row.state, 'retired');
});

// `lastUsed ?? null` did not catch 0, and capability-row.js's staleInfo()
// accepts any finite number as a real timestamp, so a 0 rendered as 1970 plus
// the "stale" class. That is what the whole roster looked like while the
// IndexStore counter was leaving every lastTs at 0. A non-positive epoch is the
// ABSENCE of an observation, not an observation of the epoch.
test('a zero lastUsed is "never observed" (null), not 1970', () => {
  const [row] = agentRows([{ name: 'x', source: 'assets', dispatchCount: 0, lastUsed: 0, modelSplit: {} }], []);
  assert.equal(row.lastUsedTs, null);
});

test('a non-numeric lastUsed is null, and a real epoch is passed through', () => {
  assert.equal(agentRows([{ name: 'a', lastUsed: 'yesterday' }], [])[0].lastUsedTs, null);
  assert.equal(agentRows([{ name: 'b', lastUsed: NaN }], [])[0].lastUsedTs, null);
  assert.equal(agentRows([{ name: 'c', lastUsed: 1780000000000 }], [])[0].lastUsedTs, 1780000000000);
});

// `observedSince` was a production-dead parameter: registry.js always passed
// {}, and no renderer read the emitted field. It is gone; `retireCandidate`
// stays because registry.js's buildAgentRows now wires it into the retire
// actions (Important 5).
test('rows carry retireCandidate for the action wiring and no dead observedSince field', () => {
  const cand = { kind: 'agent-retire', id: 'agent-retire:x', evidence: { ref: 'x' }, labels: [] };
  const [row] = agentRows([{ name: 'x', source: 'assets', dispatchCount: 0, lastUsed: null, modelSplit: {} }], [cand]);
  assert.equal(row.retireCandidate, cand);
  assert.equal('observedSince' in row, false);
});

test('a row with no retire candidate carries retireCandidate null', () => {
  const [row] = agentRows([{ name: 'x', source: 'assets', dispatchCount: 2, lastUsed: 1780000000000, modelSplit: {} }], []);
  assert.equal(row.retireCandidate, null);
});
