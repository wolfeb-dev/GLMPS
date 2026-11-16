// Tests for the per-session control record (glmps-28 / -29).
// Isolated via a tmp stateDir: never touches the real state directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  readControl, setStop, clearStop, openGate, decideGate, findGate,
} from '../lib/orchestration/control-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-control-'));

test('no record for an unknown session', () => {
  assert.equal(readControl(tmp(), 'nope'), null);
});

test('setStop then readControl returns the reason and origin', () => {
  const sd = tmp();
  setStop(sd, 's1', { reason: 'wrong branch', from: 'slack:U1', ts: 5 });
  const r = readControl(sd, 's1');
  assert.equal(r.stop.reason, 'wrong branch');
  assert.equal(r.stop.from, 'slack:U1');
  assert.equal(r.gate, null);
});

test('clearStop leaves the record but drops the stop', () => {
  const sd = tmp();
  setStop(sd, 's1', { reason: 'x', from: 'op', ts: 1 });
  clearStop(sd, 's1');
  assert.equal(readControl(sd, 's1').stop, null);
});

test('openGate records a pending decision', () => {
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'deploy', ts: 2 });
  const g = readControl(sd, 's1').gate;
  assert.equal(g.decision, 'pending');
  assert.equal(g.tool, 'Bash');
  assert.equal(g.summary, 'deploy');
});

test('decideGate resolves the matching gate', () => {
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'deploy', ts: 2 });
  const r = decideGate(sd, 's1', 'g1', { decision: 'approved', by: 'U1', ts: 3 });
  assert.equal(r.gate.decision, 'approved');
  assert.equal(r.gate.decidedBy, 'U1');
  assert.equal(r.gate.decidedTs, 3);
});

test('decideGate refuses an id that is not the open gate (a stale approval must not release a newer gate)', () => {
  // The operator can be slow, and a session can reach a SECOND gate before the
  // first answer arrives. Keying the release on the gate id (not just "the
  // session has a pending gate") is what stops an approval of the harmless
  // first action from silently releasing a different, riskier second one.
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'a', ts: 1 });
  openGate(sd, 's1', { id: 'g2', tool: 'Bash', summary: 'b', ts: 2 });
  assert.equal(decideGate(sd, 's1', 'g1', { decision: 'approved', by: 'U1', ts: 3 }), null);
  assert.equal(readControl(sd, 's1').gate.decision, 'pending');
});

test('decideGate refuses to re-decide an already-decided gate', () => {
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'a', ts: 1 });
  decideGate(sd, 's1', 'g1', { decision: 'denied', by: 'U1', ts: 2 });
  assert.equal(decideGate(sd, 's1', 'g1', { decision: 'approved', by: 'U2', ts: 3 }), null);
  assert.equal(readControl(sd, 's1').gate.decision, 'denied');
});

test('findGate locates the session holding a gate id', () => {
  const sd = tmp();
  openGate(sd, 's2', { id: 'g9', tool: 'Write', summary: 'w', ts: 1 });
  assert.equal(findGate(sd, ['s1', 's2'], 'g9').sessionId, 's2');
  assert.equal(findGate(sd, ['s1'], 'g9'), null);
});

test('stop and gate coexist independently', () => {
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'x', ts: 1 });
  setStop(sd, 's1', { reason: 'halt', from: 'op', ts: 2 });
  const r = readControl(sd, 's1');
  assert.equal(r.gate.decision, 'pending');
  assert.equal(r.stop.reason, 'halt');
});

test('a session id with path separators cannot escape the control dir', () => {
  const sd = tmp();
  setStop(sd, '../../evil', { reason: 'x', from: 'op', ts: 1 });
  const written = fs.readdirSync(path.join(sd, 'control'));
  assert.equal(written.length, 1);
  assert.ok(!written[0].includes('..') || !written[0].includes('/'), 'separators are flattened');
});

//
// A job blocked on a gate is not a runaway job, but the queue runner's
// maxRuntimeMs cannot tell the difference: it only sees wall-clock since launch.
// Once gates can wait for hours, every gated job would trip the 30-minute
// overrun and be requeued while its agent is still alive and still blocked.
// The control record therefore banks how long this session has spent WAITING,
// so the runner can subtract it.

test('a decided gate banks its wait time', () => {
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'x', ts: 1000 });
  decideGate(sd, 's1', 'g1', { decision: 'approved', by: 'U1', ts: 4000 });
  assert.equal(readControl(sd, 's1').gateWaitMs, 3000);
});

test('wait time accumulates across several gates', () => {
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'a', ts: 0 });
  decideGate(sd, 's1', 'g1', { decision: 'approved', by: 'U1', ts: 1000 });
  openGate(sd, 's1', { id: 'g2', tool: 'Bash', summary: 'b', ts: 2000 });
  decideGate(sd, 's1', 'g2', { decision: 'denied', by: 'U1', ts: 5000 });
  assert.equal(readControl(sd, 's1').gateWaitMs, 4000, 'a denial cost the job time too');
});

test('a still-pending gate has not banked anything yet', () => {
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'x', ts: 1000 });
  assert.equal(readControl(sd, 's1').gateWaitMs ?? 0, 0);
});

test('a refused decision banks nothing', () => {
  const sd = tmp();
  openGate(sd, 's1', { id: 'g1', tool: 'Bash', summary: 'a', ts: 0 });
  decideGate(sd, 's1', 'g1', { decision: 'approved', by: 'U1', ts: 1000 });
  decideGate(sd, 's1', 'g1', { decision: 'denied', by: 'U2', ts: 9000 });  // refused
  assert.equal(readControl(sd, 's1').gateWaitMs, 1000, 'the refused second decision adds nothing');
});
