// Secondary (machine) graph scan (server/lib/observability/graph-machine.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseGraphScope, normalizeMachineState, loadMachineState, saveMachineState, effectiveGraphConfig,
  applyOptIn, machineGraphPaths, machineGraphStale, buildMachineGraph, graphLabel,
} from '../lib/observability/graph-machine.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'graph-machine-'));
const writeGraph = (root, nodes) => {
  fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
  const p = path.join(root, 'graphify-out', 'graph.json');
  fs.writeFileSync(p, JSON.stringify({ nodes: nodes.map((id) => ({ id })), links: [] }));
  return p;
};

test('parseGraphScope: ship by default, machine accepted, anything else refused', () => {
  assert.deepEqual(parseGraphScope(null), { ok: true, scope: 'ship' });
  assert.deepEqual(parseGraphScope(''), { ok: true, scope: 'ship' });
  assert.deepEqual(parseGraphScope('Machine'), { ok: true, scope: 'machine' });
  assert.equal(parseGraphScope('global').ok, false);
});

test('state round-trips and drops junk', () => {
  const d = tmp();
  const f = path.join(d, 'state', 'graph-machine.json');
  assert.deepEqual(loadMachineState(f), { enabled: null, optIn: [], optOut: [] });
  saveMachineState(f, { enabled: true, optIn: ['D:\\a\\', 3, ''], optOut: 'x' });
  assert.deepEqual(loadMachineState(f), { enabled: true, optIn: ['D:/a'], optOut: [] });
  assert.deepEqual(normalizeMachineState({ enabled: 'yes' }).enabled, null);
});

test('effectiveGraphConfig: state enabled wins, include is config + optIn - optOut', () => {
  const graph = { machine: { enabled: false, include: ['D:/a', 'D:/b'], exclude: ['nq'] } };
  const g = effectiveGraphConfig(graph, { enabled: true, optIn: ['d:\\C', 'D:/a'], optOut: ['D:\\B'] });
  assert.equal(g.machine.enabled, true);
  assert.deepEqual(g.machine.include, ['D:/a', 'd:/C']);
  assert.deepEqual(g.machine.exclude, ['nq']);
  assert.equal(effectiveGraphConfig(graph, null).machine.enabled, false);
  assert.deepEqual(graph.machine.include, ['D:/a', 'D:/b'], 'config not mutated');
});

test('applyOptIn moves a root between the lists', () => {
  let s = applyOptIn(null, 'D:\\x', true);
  assert.deepEqual(s.optIn, ['D:/x']);
  s = applyOptIn(s, 'd:/X', false);
  assert.deepEqual(s, { enabled: null, optIn: [], optOut: ['d:/X'] });
});

test('buildMachineGraph copies one input, merges several, and tracks staleness', async () => {
  const d = tmp();
  const stateDir = path.join(d, 'state');
  const a = writeGraph(path.join(d, 'a'), ['1', '2']);
  const b = writeGraph(path.join(d, 'b'), ['3']);
  const one = [{ root: path.join(d, 'a'), graphPath: a }];
  assert.equal(machineGraphStale(stateDir, one), true);
  let merges = 0;
  const merge = async (files, out) => {
    merges++;
    const nodes = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf-8')).nodes);
    fs.writeFileSync(out, JSON.stringify({ nodes, links: [] }));
    return { code: 0, stderr: '' };
  };
  const m1 = await buildMachineGraph({ stateDir, inputs: one, merge });
  assert.equal(merges, 0);
  assert.equal(m1.nodes, 2);
  assert.equal(machineGraphStale(stateDir, one), false);

  const two = [...one, { root: path.join(d, 'b'), graphPath: b }];
  assert.equal(machineGraphStale(stateDir, two), true, 'root set changed');
  const m2 = await buildMachineGraph({ stateDir, inputs: two, merge });
  assert.equal(merges, 1);
  assert.equal(m2.nodes, 3);
  assert.deepEqual(m2.roots.map((r) => r.nodes), [2, 1]);
  assert.equal(machineGraphStale(stateDir, two), false);
  fs.utimesSync(b, new Date(), new Date(Date.now() + 5000));
  assert.equal(machineGraphStale(stateDir, two), true, 'input rewritten');
  const left = fs.readdirSync(machineGraphPaths(stateDir).dir).sort();
  assert.deepEqual(left, ['graph.json', 'machine-manifest.json']);
});

test('a failed merge publishes nothing and keeps the previous graph', async () => {
  const d = tmp();
  const stateDir = path.join(d, 'state');
  const a = writeGraph(path.join(d, 'a'), ['1']);
  const b = writeGraph(path.join(d, 'b'), ['2']);
  await buildMachineGraph({ stateDir, inputs: [{ root: 'a', graphPath: a }], merge: async () => ({ code: 0 }) });
  const before = fs.readFileSync(machineGraphPaths(stateDir).graph, 'utf-8');
  await assert.rejects(
    buildMachineGraph({ stateDir, inputs: [{ root: 'a', graphPath: a }, { root: 'b', graphPath: b }], merge: async () => ({ code: 2, stderr: 'boom' }) }),
    /merge-graphs failed \(exit 2\): boom/,
  );
  assert.equal(fs.readFileSync(machineGraphPaths(stateDir).graph, 'utf-8'), before);
  await assert.rejects(buildMachineGraph({ stateDir, inputs: [], merge: async () => ({ code: 0 }) }), /no opted-in repo/);
});

test('graphLabel names the graph the Map shows', () => {
  assert.equal(graphLabel({ scope: 'machine', repoCount: 1 }), 'Machine graph (1 repo)');
  assert.equal(graphLabel({ scope: 'machine', repoCount: 3 }), 'Machine graph (3 repos)');
  assert.equal(graphLabel({ scope: 'ship', merged: true }), 'Ship graph (kernel + corpus)');
  assert.equal(graphLabel({ scope: 'ship', project: 'D:\\glmps-2.0-runtime', rootScope: 'ship' }), 'Ship graph: glmps-2.0-runtime');
  assert.equal(graphLabel({ scope: 'ship', project: 'D:/foo', rootScope: 'machine' }), 'Machine repo graph: foo');
  assert.equal(graphLabel({ scope: 'ship', project: 'D:/foo/', rootScope: 'excluded' }), 'Repo graph: foo (outside ship scope)');
  assert.equal(graphLabel({ scope: 'ship', project: 'D:/foo' }), 'Repo graph: foo', 'unclassified root claims no scope');
  assert.equal(graphLabel({ scope: 'ship' }), 'Ship graph');
});
