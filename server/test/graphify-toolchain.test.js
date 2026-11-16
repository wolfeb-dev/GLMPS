// server/test/graphify-toolchain.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGraphifyTasklist, listGraphifyProcesses, waitForNoGraphifyProcess, provisionGraphify,
} from '../lib/observability/graphify-toolchain.js';

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"graphify.exe","4120","Console","1","1,204 K"',
  '"python.exe","4188","Console","1","90,112 K"',
  '"graphify-mcp.exe","5032","Console","1","1,180 K"',
  '"notgraphify.exe","6000","Console","1","1,000 K"',
].join('\r\n');

test('parseGraphifyTasklist keeps only the graphify launchers', () => {
  assert.deepEqual(parseGraphifyTasklist(TASKLIST), [
    { image: 'graphify.exe', pid: 4120 },
    { image: 'graphify-mcp.exe', pid: 5032 },
  ]);
  assert.deepEqual(parseGraphifyTasklist('INFO: No tasks are running which match the specified criteria.'), []);
  assert.deepEqual(parseGraphifyTasklist(''), []);
});

test('listGraphifyProcesses runs tasklist on Windows only, and fails open', async () => {
  const calls = [];
  const runCmd = async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: TASKLIST, stderr: '' }; };
  assert.equal((await listGraphifyProcesses({ runCmd, platform: 'win32' })).length, 2);
  assert.deepEqual(calls, [['tasklist', '/FO', 'CSV', '/NH']]);
  assert.deepEqual(await listGraphifyProcesses({ runCmd, platform: 'linux' }), []);
  assert.equal(calls.length, 1, 'no tasklist call off Windows');
  assert.deepEqual(await listGraphifyProcesses({ runCmd: async () => ({ code: 1, stdout: '', stderr: 'x' }), platform: 'win32' }), []);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('waitForNoGraphifyProcess returns once the launchers exit', async () => {
  const clock = fakeClock();
  const seq = [[{ image: 'graphify.exe', pid: 1 }], [{ image: 'graphify.exe', pid: 1 }], []];
  let i = 0;
  const r = await waitForNoGraphifyProcess({ list: async () => seq[i++], maxWaitMs: 60_000, pollMs: 10_000, ...clock });
  assert.equal(r.idle, true);
  assert.equal(i, 3);
  assert.equal(clock.now(), 20_000);
});

test('waitForNoGraphifyProcess gives up at maxWaitMs and names what is still running', async () => {
  const clock = fakeClock();
  const busy = [{ image: 'graphify-mcp.exe', pid: 7 }];
  const r = await waitForNoGraphifyProcess({ list: async () => busy, maxWaitMs: 30_000, pollMs: 10_000, ...clock });
  assert.equal(r.idle, false);
  assert.deepEqual(r.processes, busy);
  assert.ok(clock.now() <= 30_000);
});

test('waitForNoGraphifyProcess with maxWaitMs 0 checks once and never sleeps', async () => {
  let slept = false;
  const r = await waitForNoGraphifyProcess({ list: async () => [{ image: 'graphify.exe', pid: 1 }], maxWaitMs: 0, sleep: async () => { slept = true; } });
  assert.equal(r.idle, false);
  assert.equal(slept, false);
});

// A scripted synchronous runner: each key is the joined command line.
function scriptedRun(script) {
  const calls = [];
  const run = (cmd) => {
    const key = cmd.join(' ');
    calls.push(key);
    const r = script[key];
    if (Array.isArray(r)) return r.length > 1 ? r.shift() : r[0];
    return r ?? { status: 127, stdout: '' };
  };
  return { run, calls };
}

test('provisionGraphify leaves an installed graphify alone', () => {
  const { run, calls } = scriptedRun({ 'graphify --version': { status: 0, stdout: 'graphify 0.9.95' } });
  assert.deepEqual(provisionGraphify({ run, pinned: '0.9.95' }), { action: 'present', version: '0.9.95' });
  assert.deepEqual(calls, ['graphify --version']);
});

test('provisionGraphify installs the pinned version via uv when graphify is missing', () => {
  const { run, calls } = scriptedRun({
    'graphify --version': [{ status: 127, stdout: '' }, { status: 0, stdout: 'graphify 0.9.95' }],
    'uv --version': { status: 0, stdout: 'uv 0.9.2' },
    'uv tool install graphifyy==0.9.95': { status: 0, stdout: '' },
  });
  assert.deepEqual(provisionGraphify({ run, pinned: '0.9.95' }), { action: 'installed', version: '0.9.95' });
  assert.deepEqual(calls, ['graphify --version', 'uv --version', 'uv tool install graphifyy==0.9.95', 'graphify --version']);
});

test('provisionGraphify with no pin installs the latest graphifyy', () => {
  const { run, calls } = scriptedRun({
    'graphify --version': [{ status: 127, stdout: '' }, { status: 0, stdout: 'graphify 1.0.0' }],
    'uv --version': { status: 0, stdout: 'uv 0.9.2' },
    'uv tool install graphifyy': { status: 0, stdout: '' },
  });
  assert.equal(provisionGraphify({ run }).action, 'installed');
  assert.ok(calls.includes('uv tool install graphifyy'));
});

test('provisionGraphify reports uv missing without trying to install', () => {
  const { run, calls } = scriptedRun({});
  const r = provisionGraphify({ run, pinned: '0.9.95' });
  assert.equal(r.action, 'uv-missing');
  assert.match(r.detail, /uv tool install graphifyy==0\.9\.95/);
  assert.equal(calls.some(c => c.startsWith('uv tool')), false);
});

test('provisionGraphify reports a failed install and a launcher not on PATH', () => {
  const failed = scriptedRun({
    'uv --version': { status: 0, stdout: 'uv' },
    'uv tool install graphifyy==0.9.95': { status: 2, stdout: '', stderr: 'error: no network' },
  });
  const f = provisionGraphify({ run: failed.run, pinned: '0.9.95' });
  assert.equal(f.action, 'failed');
  assert.match(f.detail, /exited 2: error: no network/);

  const offPath = scriptedRun({
    'uv --version': { status: 0, stdout: 'uv' },
    'uv tool install graphifyy==0.9.95': { status: 0, stdout: '' },
  });
  const o = provisionGraphify({ run: offPath.run, pinned: '0.9.95' });
  assert.equal(o.action, 'installed-not-on-path');
  assert.match(o.detail, /uv tool update-shell/);
});

test('provisionGraphify never throws when the runner does', () => {
  const r = provisionGraphify({ run: () => { throw new Error('ENOENT'); }, pinned: '0.9.95' });
  assert.equal(r.action, 'uv-missing');
});
