import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSubstantive, seatPrompt, parseSeatReply, createAgySeat, SEAT_AGY_TIMEOUT_MS } from '../lib/huddle/agy-seat.js';
import { retiredModelError, resolveRetiredModel } from '../lib/huddle/agy-models.js';

const HOMER = Object.freeze({
  id: 'homer', role: 'researcher', display: 'Researcher', icon: ':mag:', aliases: ['homer'], lead: false,
  engine: 'agy', model: 'Gemini 3.8 Flash (Medium)', seat: 'agy', personality: 'Warm researcher.',
});

test('isSubstantive: a real question is; chatter is not', () => {
  assert.equal(isSubstantive('What breaks first when the transcript gets long?'), true);
  assert.equal(isSubstantive('Should the dock slide in from the right'), true);
  assert.equal(isSubstantive('ok thanks'), false);
  assert.equal(isSubstantive('why?'), false, 'too short to dissent on');
  assert.equal(isSubstantive(''), false);
});

test('seatPrompt opens with the persona, personality and model, and asks for a second view or PASS', () => {
  const p = seatPrompt({ persona: HOMER, transcriptText: 'Operator: q\nBuilder: a', mode: 'second', target: 'Builder: a' });
  assert.ok(p.startsWith('You are Researcher, the researcher in a live engineering huddle. Your personality: Warm researcher. You run on Gemini 3.8 Flash (Medium); the others run on other models, and you are here so the team hears a different view.'));
  assert.match(p, /Give your own view on the answer quoted at the end/);
  assert.match(p, /reply with exactly: PASS/);
  assert.match(p, /at most two sentences/);
  assert.match(p, /Operator: q\nBuilder: a/);
  assert.doesNotMatch(seatPrompt({ persona: HOMER, transcriptText: 'x', mode: 'addressed' }), /PASS/);
});

test('seatPrompt names the brainstorm seat role when there is one', () => {
  assert.match(seatPrompt({ persona: { ...HOMER, seatRole: 'architect' }, transcriptText: 'x', mode: 'addressed' }), /^You are Researcher, the architect in a live engineering huddle\./);
});

test('seatPrompt carries the team charter and the seat brief, ahead of the transcript', () => {
  const p = seatPrompt({ persona: { ...HOMER, charter: 'CHARTER: one deliverable.', definition: 'BRIEF: boundaries.' }, transcriptText: 'Operator: q', mode: 'addressed' });
  assert.ok(p.includes('CHARTER: one deliverable.'));
  assert.ok(p.includes('BRIEF: boundaries.'));
  assert.ok(p.indexOf('CHARTER') < p.indexOf('Transcript'));
  assert.ok(p.indexOf('BRIEF') < p.indexOf('Transcript'));
  assert.doesNotMatch(seatPrompt({ persona: HOMER, transcriptText: 'x', mode: 'addressed' }), /standing brief|charter/i);
});

test('parseSeatReply: PASS is a pass; text is cut to two sentences and 400 characters', () => {
  assert.deepEqual(parseSeatReply('PASS'), { text: 'pass', pass: true });
  assert.deepEqual(parseSeatReply('  pass.  '), { text: 'pass', pass: true });
  assert.deepEqual(parseSeatReply('I disagree. The right side is noisier. Also a third thing.'), { text: 'I disagree. The right side is noisier.', pass: false });
  assert.equal(parseSeatReply('x'.repeat(900)).text.length, 400);
});

test('respond runs agy in its own throwaway cwd, removes it, and passes the persona model', async () => {
  const seen = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seat-'));
  const seat = createAgySeat({ persona: HOMER, tmpDir, generate: async (prompt, opts) => { seen.push(opts); assert.ok(fs.existsSync(opts.cwd)); return 'PASS'; } });
  const r = await seat.respond({ transcriptText: 'Operator: q', mode: 'second' });
  assert.deepEqual(r, { text: 'pass', pass: true });
  assert.equal(seat.model, 'Gemini 3.8 Flash (Medium)');
  assert.equal(seat.persona, HOMER);
  assert.equal(seen[0].model, HOMER.model);
  assert.ok(seen[0].cwd.startsWith(tmpDir));
  assert.equal(fs.existsSync(seen[0].cwd), false, 'the cwd is removed after the call');
});

test('respond rejects when agy fails, so the session can show the seat error line', async () => {
  const seat = createAgySeat({ persona: HOMER, generate: async () => { throw new Error('wiki-agy: no new conversation DB after agy returned'); } });
  await assert.rejects(seat.respond({ transcriptText: 'x', mode: 'second' }), /no new conversation DB/);
});

test('an AGY_NOT_SIGNED_IN error from generate propagates unchanged', async () => {
  const err = Object.assign(new Error('wiki-agy: agy is not signed in for this account'), { code: 'AGY_NOT_SIGNED_IN' });
  const seat = createAgySeat({ persona: HOMER, generate: async () => { throw err; } });
  await assert.rejects(seat.respond({ transcriptText: 'x', mode: 'second' }), (e) => e === err && e.code === 'AGY_NOT_SIGNED_IN');
});

test('respond forwards the server-chosen convDir (P.agyCliDir/conversations) to generate', async () => {
  let seen = null;
  const seat = createAgySeat({ persona: HOMER, convDir: '/state/agy/conversations', generate: async (p, opts) => { seen = opts; return 'PASS'; } });
  await seat.respond({ transcriptText: 'x', mode: 'second' });
  assert.equal(seen.convDir, '/state/agy/conversations');
});

test('with no generate injected, a test process is refused before any temp dir or agy call', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seat-guard-'));
  const seat = createAgySeat({ persona: HOMER, tmpDir });
  // test.env sets GLMPS_MODEL_RUNNER=off, which would win; unset it to reach the test-process branch.
  const saved = process.env.GLMPS_MODEL_RUNNER;
  delete process.env.GLMPS_MODEL_RUNNER;
  try {
    await assert.rejects(seat.respond({ transcriptText: 'x', mode: 'second' }), /agy seat refused: test process/);
  } finally {
    if (saved !== undefined) process.env.GLMPS_MODEL_RUNNER = saved;
  }
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'no temp dir was created');
});

test('with no generate injected, GLMPS_MODEL_RUNNER=off refuses before any temp dir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seat-off-'));
  const seat = createAgySeat({ persona: HOMER, tmpDir, env: { GLMPS_MODEL_RUNNER: 'off' } });
  await assert.rejects(seat.respond({ transcriptText: 'x', mode: 'second' }), /GLMPS_MODEL_RUNNER=off/);
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'no temp dir was created');
});

test('seatPrompt names the answer to weigh instead of "the last answer", and marks the seat\'s own lines by display name', () => {
  const p = seatPrompt({ persona: HOMER, transcriptText: 'Operator: q\nCritic: a\nResearcher: late', mode: 'second', target: 'Critic: a' });
  assert.doesNotMatch(p, /the last answer/);
  assert.match(p, /Answer to weigh:\nCritic: a$/);
  assert.match(p, /lines from Researcher are your own earlier replies/);
  const q = seatPrompt({ persona: HOMER, transcriptText: 'Operator: q', mode: 'addressed', target: 'Operator: Homer, agree?' });
  assert.match(q, /Question to answer:\nOperator: Homer, agree\?$/);
});

test('respond forwards the target and the abort signal to generate', async () => {
  let seen = null;
  const ac = new AbortController();
  const seat = createAgySeat({ persona: HOMER, generate: async (p, opts) => { seen = { p, opts }; return 'PASS'; } });
  await seat.respond({ transcriptText: 'x', mode: 'second', target: 'Critic: a', signal: ac.signal });
  assert.equal(seen.opts.signal, ac.signal);
  assert.match(seen.p, /Answer to weigh:\nCritic: a$/);
});

test('the seat gives agy SEAT_AGY_TIMEOUT_MS (30 s), not the wiki timeouts', async () => {
  assert.equal(SEAT_AGY_TIMEOUT_MS, 30_000);
  let seen = null;
  const seat = createAgySeat({ persona: HOMER, generate: async (p, opts) => { seen = opts; return 'PASS'; } });
  await seat.respond({ transcriptText: 'x', mode: 'second' });
  assert.equal(seen.timeout, SEAT_AGY_TIMEOUT_MS);
});

// The exact text agy 1.4.7 prints for a retired --model (live, 2026-10-24),
// as it reaches the seat after the error tail cut its head off.
const RETIRED_TAIL = [
  'i 4 Argon (High)', '  Gemini 4 Argon (Low)', '  Gemini 3.8 Flash (High)', '  Gemini 3.8 Flash (Medium)',
  '  Gemini 3.8 Flash (Low)', '  Claude Opus 5.5 (Low)', '  Claude Opus 5.5 (Medium)', '  Claude Opus 5.5 (High)',
  '  Claude Sonnet 5.5 (Low)', '  Claude Sonnet 5.5 (Medium)', '  Claude Sonnet 5.5 (High)', '  GPT-OSS 120B (Medium)',
].join('\n');

test('retiredModelError reads the listed models from agy\'s unknown-model error, even with its head cut off', () => {
  const r = retiredModelError(`wiki-agy: agy reported an error: ${RETIRED_TAIL}`, 'Claude Sonnet 4.6 (Thinking)');
  assert.ok(r);
  assert.ok(r.available.includes('Claude Sonnet 5.5 (Medium)'));
  assert.ok(!r.available.includes('Gemini 4 Argon (Medium)'), 'the truncated line is not a name');
  assert.equal(retiredModelError('wiki-agy: agy timed out after 30000 ms', 'Gemini 3.8 Flash (Medium)'), null);
  assert.equal(retiredModelError(RETIRED_TAIL, 'Gemini 3.8 Flash (Medium)'), null, 'a listed model is not retired');
  assert.ok(retiredModelError('Error: model X is not recognized as a known model or custom model in settings', 'X'));
});

test('resolveRetiredModel stays in the family, prefers Medium then Low, and never takes a sibling seat\'s model', () => {
  const avail = retiredModelError(RETIRED_TAIL, 'old').available;
  assert.equal(resolveRetiredModel('Claude Sonnet 4.6 (Thinking)', avail, []), 'Claude Sonnet 5.5 (Medium)');
  assert.equal(resolveRetiredModel('Claude Sonnet 4.6 (Thinking)', avail, ['Claude Sonnet 5.5 (Medium)']), 'Claude Sonnet 5.5 (Low)');
  assert.equal(resolveRetiredModel('Gemini 3.5 Flash (High)', ['Gemini 3.8 Flash (Low)', 'GPT-OSS 120B (Medium)'], []), 'Gemini 3.8 Flash (Low)');
  assert.equal(resolveRetiredModel('Mystery 1 (High)', ['GPT-OSS 120B (Medium)'], []), 'GPT-OSS 120B (Medium)');
  assert.equal(resolveRetiredModel('Mystery 1 (High)', ['GPT-OSS 120B (Medium)'], ['GPT-OSS 120B (Medium)']), null);
  assert.equal(resolveRetiredModel('x', ['Not Allowlisted (Medium)'], []), null);
});

test('respond: a retired model moves the seat to a free listed model, answers on it, and says so once', async () => {
  const calls = [];
  const generate = async (prompt, opts) => {
    calls.push(opts.model);
    if (opts.model === 'Claude Sonnet 4.6 (Thinking)') throw new Error(`wiki-agy: agy reported an error: ${RETIRED_TAIL}`);
    return 'A plain second view.';
  };
  const persona = { ...HOMER, id: 'guppy', display: 'Docs', model: 'Claude Sonnet 4.6 (Thinking)' };
  const seat = createAgySeat({ persona, generate, avoidModels: () => ['Claude Opus 5.5 (Medium)'] });
  const r = await seat.respond({ transcriptText: 'Operator: q', mode: 'second' });
  assert.deepEqual(calls, ['Claude Sonnet 4.6 (Thinking)', 'Claude Sonnet 5.5 (Medium)']);
  assert.equal(r.text, 'A plain second view.');
  assert.equal(r.note, "Docs's model Claude Sonnet 4.6 (Thinking) is no longer offered by agy; moved to Claude Sonnet 5.5 (Medium).");
  assert.equal(seat.model, 'Claude Sonnet 5.5 (Medium)');
  const again = await seat.respond({ transcriptText: 'Operator: q', mode: 'second' });
  assert.equal(again.note, undefined, 'the move is announced once');
  assert.deepEqual(calls.slice(2), ['Claude Sonnet 5.5 (Medium)']);
});

test('respond: any other agy failure propagates unchanged', async () => {
  const seat = createAgySeat({ persona: HOMER, generate: async () => { throw new Error('wiki-agy: agy timed out after 30000 ms'); } });
  await assert.rejects(seat.respond({ transcriptText: 'x' }), /timed out after 30000 ms/);
  assert.equal(seat.model, HOMER.model);
});
