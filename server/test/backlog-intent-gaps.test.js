import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../lib/orchestration/backlog-store.js';

const withAC = (n) => {
  const ac = Array.from({ length: n }, (_, i) => `criterion ${i + 1}`);
  const { state, item } = store.addItem(store.emptyState(), { title: 'A', acceptanceCriteria: ac });
  return { state, id: item.id };
};
const gate = (state, id, g) => store.setGate(state, id, g);

test('uncitedAC lists criteria not cited by number', () => {
  const ac = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  assert.deepEqual(store.uncitedAC(ac, ['AC-1 ok', 'ac 3: passed']), ['AC-2']);
  assert.deepEqual(store.uncitedAC([{ text: 'a' }], ['AC-10 passed']), ['AC-1'], 'AC-10 does not cite AC-1');
  assert.deepEqual(store.uncitedAC([], ['anything']), []);
  assert.deepEqual(store.uncitedAC([{ text: 'a' }], undefined), ['AC-1']);
});

test('PASS with an uncited AC is recorded CONCERNS', () => {
  const { state, id } = withAC(2);
  const { item } = gate(state, id, { status: 'PASS', evidence: ['AC-1 test green'] });
  assert.equal(item.gate.status, 'CONCERNS');
  assert.equal(item.gate.requested, 'PASS');
  assert.deepEqual(item.gate.missingAC, ['AC-2']);
});

test('PASS with every AC cited stays PASS; no ACs stays PASS', () => {
  const { state, id } = withAC(2);
  const r = gate(state, id, { status: 'PASS', evidence: ['AC-1 green', 'AC-2 green'] });
  assert.equal(r.item.gate.status, 'PASS');
  assert.equal(r.item.gate.requested, undefined);
  const bare = store.addItem(store.emptyState(), { title: 'B' });
  assert.equal(gate(bare.state, bare.item.id, { status: 'PASS', evidence: ['tests ok'] }).item.gate.status, 'PASS');
});

test('an AC already marked done must still be cited', () => {
  const { state, item } = store.addItem(store.emptyState(), { title: 'A', acceptanceCriteria: [{ text: 'x', done: true }] });
  assert.equal(gate(state, item.id, { status: 'PASS', evidence: ['ok'] }).item.gate.status, 'CONCERNS');
});

test('two non-pass gates in a row set reintent', () => {
  const { state, id } = withAC(1);
  const first = gate(state, id, { status: 'FAIL', evidence: ['AC-1 red'] });
  assert.equal(first.item.gate.failStreak, 1);
  assert.equal(first.item.gate.reintent, false);
  const second = gate(first.state, id, { status: 'PASS', evidence: ['tests ok'] });
  assert.equal(second.item.gate.status, 'CONCERNS', 'a downgraded PASS counts as a failure');
  assert.equal(second.item.gate.failStreak, 2);
  assert.equal(second.item.gate.reintent, true);
});

test('PASS or WAIVED resets the streak; WAIVED is never downgraded', () => {
  const { state, id } = withAC(1);
  let s = gate(state, id, { status: 'FAIL', evidence: [] }).state;
  s = gate(s, id, { status: 'FAIL', evidence: [] }).state;
  const waived = gate(s, id, { status: 'WAIVED', evidence: ['operator waived'] });
  assert.equal(waived.item.gate.status, 'WAIVED');
  assert.equal(waived.item.gate.failStreak, 0);
  assert.equal(waived.item.gate.reintent, false);
  const passed = gate(gate(waived.state, id, { status: 'FAIL' }).state, id, { status: 'PASS', evidence: ['AC-1 ok'] });
  assert.equal(passed.item.gate.status, 'PASS');
  assert.equal(passed.item.gate.failStreak, 0);
});

test('patching acceptanceCriteria clears reintent and restarts the streak', () => {
  const { state, id } = withAC(1);
  let s = gate(state, id, { status: 'FAIL' }).state;
  s = gate(s, id, { status: 'FAIL' }).state;
  const { item } = store.updateItem(s, id, { acceptanceCriteria: ['restated criterion'] });
  assert.equal(item.gate.reintent, false);
  assert.equal(item.gate.failStreak, 0);
  assert.equal(item.gate.status, 'FAIL', 'the recorded verdict itself is untouched');
  const untouched = store.updateItem(s, id, { title: 'renamed' }).item;
  assert.equal(untouched.gate.reintent, true);
});

test('gateRelayText names a downgrade and a reintent', () => {
  assert.equal(store.gateRelayText({ status: 'PASS' }, 'P3'), 'gate PASS (risk P3)');
  assert.equal(store.gateRelayText({ status: 'CONCERNS', requested: 'PASS', missingAC: ['AC-2', 'AC-3'] }),
    'gate CONCERNS (PASS recorded as CONCERNS: AC-2, AC-3 not cited in the evidence)');
  assert.match(store.gateRelayText({ status: 'FAIL', reintent: true, failStreak: 2 }),
    /^gate FAIL\. 2 failed gates in a row: retries stop until you restate what done means/);
});
