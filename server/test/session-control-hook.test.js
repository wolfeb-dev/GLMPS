// Tests for the session-control branches of the PreToolUse hook
// (glmps-28 stop, glmps-29 gate). The hook file keeps its
// historical name because the user's global settings.json references that exact
// path; renaming it would silently unregister the hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { stopDecision, awaitGate } from '../../hooks/workspace-steer.js';
import { gateConfig, gateDeadlineMs, describeWait } from '../lib/orchestration/gate-config.js';
import { setStop, clearStop } from '../lib/orchestration/control-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ctl-hook-'));


test('no stop record -> no decision (the fast path stays fast)', () => {
  assert.equal(stopDecision(tmp(), 's1'), null);
});

test('a stop record denies the call and carries the operator reason', () => {
  const sd = tmp();
  setStop(sd, 's1', { reason: 'wrong branch', from: 'slack:U1', ts: 1 });
  const d = stopDecision(sd, 's1');
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /wrong branch/);
  assert.match(d.permissionDecisionReason, /summar/i, 'must tell the agent to report before halting');
});

test('the stop is standing state, not a one-shot note', () => {
  // A steer note is consumed on read. A stop must NOT be: the whole point is
  // that the agent cannot act again until an operator lifts it, so every
  // subsequent tool call has to see it too.
  const sd = tmp();
  setStop(sd, 's1', { reason: 'halt', from: 'op', ts: 1 });
  assert.ok(stopDecision(sd, 's1'));
  assert.ok(stopDecision(sd, 's1'));
  assert.ok(stopDecision(sd, 's1'));
});

test('clearStop releases the session', () => {
  const sd = tmp();
  setStop(sd, 's1', { reason: 'halt', from: 'op', ts: 1 });
  clearStop(sd, 's1');
  assert.equal(stopDecision(sd, 's1'), null);
});

test('a missing session id never throws', () => {
  assert.equal(stopDecision(tmp(), null), null);
});

//
// Every side effect is injected (fetch, clock, sleep) so these run with no
// server and no real waiting.

function fakeFetch(script) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method ?? 'GET' });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => next };
  };
  return { impl, calls };
}

test('an approval mid-poll allows the call', async () => {
  const { impl, calls } = fakeFetch([
    { id: 'g1' },                       // POST open
    { decision: 'pending' },            // first poll
    { decision: 'approved', by: 'U1' }, // second poll
  ]);
  const d = await awaitGate({
    port: 8123, sessionId: 's1', tool: 'Bash', summary: 'deploy',
    deadlineMs: 10_000, now: () => 0, sleep: async () => {}, fetchImpl: impl,
  });
  assert.equal(d.permissionDecision, 'allow');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls.length, 3);
});

test('a denial blocks the call and relays the operator reason', async () => {
  const { impl } = fakeFetch([
    { id: 'g1' },
    { decision: 'denied', by: 'U1', reason: 'not on main' },
  ]);
  const d = await awaitGate({
    port: 8123, sessionId: 's1', tool: 'Bash', summary: 'deploy',
    deadlineMs: 10_000, now: () => 0, sleep: async () => {}, fetchImpl: impl,
  });
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /not on main/);
});

test('reaching the deadline denies and tells the agent to retry the identical call', async () => {
  // The gate record survives on the server, so once the operator does approve,
  // the retry passes immediately. That is what makes this a real suspend/resume
  // rather than a hard failure, without needing an unbounded block.
  let t = 0;
  const { impl } = fakeFetch([{ id: 'g1' }, { decision: 'pending' }, { decision: 'pending' }, { decision: 'pending' }]);
  const d = await awaitGate({
    port: 8123, sessionId: 's1', tool: 'Bash', summary: 'deploy',
    deadlineMs: 100, now: () => (t += 60), sleep: async () => {}, fetchImpl: impl,
  });
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /retry/i);
  assert.match(d.permissionDecisionReason, /g1/, 'names the gate so a later approval is actionable');
});

test('an unreachable server fails OPEN, it does not brick the session', async () => {
  // Stated plainly in the spec: this is an operator-convenience gate, not a
  // security boundary. The real boundaries (live-install-guard, zones,
  // poison-scan) are local and static and do not depend on the server running.
  // Failing closed here would mean a stopped server halts every agent.
  const { impl } = fakeFetch([new Error('ECONNREFUSED')]);
  const d = await awaitGate({
    port: 8123, sessionId: 's1', tool: 'Bash', summary: 'deploy',
    deadlineMs: 10_000, now: () => 0, sleep: async () => {}, fetchImpl: impl,
  });
  assert.equal(d.permissionDecision, 'allow');
});

test('a poll error mid-wait does not abort the gate, it keeps waiting', async () => {
  const { impl } = fakeFetch([
    { id: 'g1' },
    new Error('transient'),
    { decision: 'approved', by: 'U1' },
  ]);
  let t = 0;
  const d = await awaitGate({
    port: 8123, sessionId: 's1', tool: 'Bash', summary: 'deploy',
    deadlineMs: 10_000, now: () => (t += 10), sleep: async () => {}, fetchImpl: impl,
  });
  assert.equal(d.permissionDecision, 'allow');
});

//
// Caught while writing the operator setup instructions: gateConfig originally
// read <stateDir>/config.json, but the SERVER reads the repo-root config.json
// (server.js CLI entry). Two config files for one product is a trap - the
// operator edits the documented one and the feature stays silently off. The
// repo-root file is gitignored, so there is no public-mirror leak reason to
// keep gate paths out of it. Repo root is now the documented home; the state
// dir remains an override, which is how GLMPS_* isolation works everywhere else.

test('gateConfig reads control.gates from the repo-root config.json', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'),
    JSON.stringify({ control: { gates: { enabled: true, paths: ['D:/live'] } } }));
  const c = gateConfig({ repoRoot: root, stateDir: tmp() });
  assert.equal(c.enabled, true);
  assert.deepEqual(c.paths, ['D:/live']);
});

test('gateConfig: a state-dir config overrides the repo-root one', () => {
  const root = tmp(); const sd = tmp();
  fs.writeFileSync(path.join(root, 'config.json'),
    JSON.stringify({ control: { gates: { enabled: false, paths: [] } } }));
  fs.writeFileSync(path.join(sd, 'config.json'),
    JSON.stringify({ control: { gates: { enabled: true, paths: ['D:/override'] } } }));
  const c = gateConfig({ repoRoot: root, stateDir: sd });
  assert.equal(c.enabled, true, 'the state dir wins, which is what test isolation relies on');
  assert.deepEqual(c.paths, ['D:/override']);
});

test('gateConfig: no config anywhere means gates OFF, not a crash', () => {
  const c = gateConfig({ repoRoot: tmp(), stateDir: tmp() });
  assert.equal(c.enabled, false);
  assert.deepEqual(c.paths, []);
});

test('gateConfig: malformed JSON means gates OFF, not a crash', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), '{ this is not json');
  assert.equal(gateConfig({ repoRoot: root, stateDir: tmp() }).enabled, false);
});

test('gateConfig: a config with no control block means gates OFF', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ port: 8123 }));
  assert.equal(gateConfig({ repoRoot: root, stateDir: tmp() }).enabled, false);
});

//
// config.json already carries `prodRoots` (the live NinjaTrader install and
// glmps_prod), read by hooks/done-gate.js readProdRoots from that same file.
// Requiring the operator to re-list those under control.gates.paths would be a
// second copy of the same fact in the SAME file, which is the drift bug that
// just bit this feature over the config's location. Enabling gates therefore
// gates the declared prod roots automatically; `paths` only ADDS to them.

test('gates default to the config prodRoots when no paths are listed', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    prodRoots: ['D:/UserData/op/Documents/NinjaTrader 8/bin/Custom', 'D:/glmps_prod'],
    control: { gates: { enabled: true } },
  }));
  const c = gateConfig({ repoRoot: root });
  assert.equal(c.enabled, true);
  assert.deepEqual(c.paths, ['D:/UserData/op/Documents/NinjaTrader 8/bin/Custom', 'D:/glmps_prod']);
});

test('explicit paths are added to prodRoots, not substituted for them', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    prodRoots: ['D:/glmps_prod'],
    control: { gates: { enabled: true, paths: ['D:/extra'] } },
  }));
  const c = gateConfig({ repoRoot: root });
  assert.deepEqual(c.paths, ['D:/glmps_prod', 'D:/extra']);
});

test('a duplicate between prodRoots and paths appears once', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    prodRoots: ['D:/glmps_prod'],
    control: { gates: { enabled: true, paths: ['D:/glmps_prod'] } },
  }));
  assert.deepEqual(gateConfig({ repoRoot: root }).paths, ['D:/glmps_prod']);
});

test('prodRoots alone do NOT enable gates', () => {
  // prodRoots exist for other features (done-gate, zones). Gates staying off
  // until explicitly enabled is the whole default-off promise.
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ prodRoots: ['D:/glmps_prod'] }));
  const c = gateConfig({ repoRoot: root });
  assert.equal(c.enabled, false);
});

test('the state-dir override also inherits prodRoots from the repo-root config', () => {
  const root = tmp(); const sd = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ prodRoots: ['D:/glmps_prod'] }));
  fs.writeFileSync(path.join(sd, 'config.json'), JSON.stringify({ control: { gates: { enabled: true } } }));
  const c = gateConfig({ repoRoot: root, stateDir: sd });
  assert.equal(c.enabled, true);
  assert.deepEqual(c.paths, ['D:/glmps_prod'], 'prod roots are a property of the machine, not of which file enabled gates');
});


test('the gate wait defaults to 12 hours, not to whatever the hook timeout allowed', () => {
  assert.equal(gateDeadlineMs(null), 12 * 3600_000);
  assert.equal(gateDeadlineMs({}), 12 * 3600_000);
});

test('waitHours configures the wait', () => {
  assert.equal(gateDeadlineMs({ waitHours: 24 }), 24 * 3600_000);
  assert.equal(gateDeadlineMs({ waitHours: 0.5 }), 30 * 60_000);
});

test('a nonsense waitHours falls back to the default rather than to zero', () => {
  // A zero or negative deadline would deny instantly, silently turning every
  // gate into a refusal. Falling back is the only safe reading.
  for (const bad of [0, -5, 'soon', null, NaN]) {
    assert.equal(gateDeadlineMs({ waitHours: bad }), 12 * 3600_000, String(bad));
  }
});

test('gateConfig surfaces includeBash and waitHours', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    control: { gates: { enabled: true, includeBash: true, waitHours: 24 } },
  }));
  const c = gateConfig({ repoRoot: root });
  assert.equal(c.includeBash, true);
  assert.equal(c.waitHours, 24);
});

test('gateConfig defaults includeBash off', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ control: { gates: { enabled: true } } }));
  assert.equal(gateConfig({ repoRoot: root }).includeBash, false);
});

test('describeWait phrases the wait the same way everywhere it is shown', () => {
  assert.equal(describeWait(30 * 60_000), '30 minutes');
  assert.equal(describeWait(3600_000), '1 hour');
  assert.equal(describeWait(12 * 3600_000), '12 hours');
});

test('the timeout denial quotes the configured wait, not a hardcoded 9 minutes', async () => {
  const { impl } = fakeFetch([{ id: 'g1' }, { decision: 'pending' }, { decision: 'pending' }]);
  let t = 0;
  const d = await awaitGate({
    port: 8123, sessionId: 's1', tool: 'Bash', summary: 'x',
    deadlineMs: 2 * 3600_000, now: () => (t += 3600_000), sleep: async () => {}, fetchImpl: impl,
  });
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /2 hours/);
  assert.doesNotMatch(d.permissionDecisionReason, /9 minutes/);
});
