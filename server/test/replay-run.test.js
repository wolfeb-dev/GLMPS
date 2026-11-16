import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReplay } from '../lib/evaluation/replay-run.js';

test('runs the injected launch and builds an outcome', async () => {
  const task = { id: 'replay-x', promptFile: '/p/x.txt' };
  const launch = async (t) => ({ sessionId: 'sx', events: [{ kind: 'prompt', ts: 1 }], usage: null, firstPrompt: 'do x', filesTouched: [] });
  const buildOutcome = (input) => ({ id: `session-${input.sessionId}`, unit: 'session', firstPrompt: input.firstPrompt });
  const { produced } = await runReplay('/state', task, { launch, buildOutcome });
  assert.equal(produced.id, 'session-sx');
});

test('failed launch yields produced null (no throw)', async () => {
  const launch = async () => { throw new Error('runner died'); };
  const { produced } = await runReplay('/state', { id: 'r' }, { launch, buildOutcome: () => ({}) });
  assert.equal(produced, null);
});

test('opts.model and opts.unit stamp the produced row for a model-swap cohort', async () => {
  const task = { id: 'replay-y', promptFile: '/p/y.txt' };
  const launch = async () => ({ sessionId: 'sy' });
  const buildOutcome = (input) => ({ id: `session-${input.sessionId}`, unit: 'session', model: null });
  const { produced } = await runReplay('/state', task, {
    launch, buildOutcome, model: 'claude-sonnet-5', unit: 'model-claude-sonnet-5',
  });
  assert.equal(produced.model, 'claude-sonnet-5');
  assert.equal(produced.unit, 'model-claude-sonnet-5');
});

test('omitting opts.model/opts.unit leaves the row from buildOutcome untouched', async () => {
  const launch = async () => ({ sessionId: 'sz' });
  const buildOutcome = (input) => ({ id: `session-${input.sessionId}`, unit: 'session', model: 'claude-opus-4.6' });
  const { produced } = await runReplay('/state', { id: 'r2' }, { launch, buildOutcome });
  assert.equal(produced.unit, 'session');
  assert.equal(produced.model, 'claude-opus-4.6');
});
