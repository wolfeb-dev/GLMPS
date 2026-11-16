// server/test/huddle-session.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHuddle, firstSentenceReached, clampSentences, SEAT_END_GRACE_MS } from '../lib/huddle/session.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';
import { AGENDA_SYSTEM } from '../lib/huddle/decisions.js';
import { createAgySeat } from '../lib/huddle/agy-seat.js';

const GEMINI_PERSONA = Object.freeze({
  id: 'gemini', role: 'dissent', display: 'Gemini', icon: ':gem:', aliases: ['gemini'],
  lead: false, seat: 'agy', engine: 'agy', model: 'Gemini 3.8 Flash (High)', definitionName: null, definition: null,
});

const P = [
  { id: 'riker', lead: true, display: 'Lead', role: 'orchestrator', icon: ':satellite:', aliases: ['riker', 'lead'], definition: null },
  { id: 'bill', lead: false, display: 'Builder', role: 'builder', icon: ':hammer:', aliases: ['bill', 'builder'], definition: 'Build things.' },
  { id: 'medeiros', lead: false, display: 'Critic', role: 'critic', icon: ':warning:', aliases: ['medeiros', 'critic'], definition: null },
];
const MODELS = { floor: 'haiku', mind: 'opus', effort: 'low', maxTokens: 160 };

// A fake stream: the Lead (system prompt mentions the floor) answers JSON; a
// mind answers two sentences in two deltas; the summary answers one line.
function fakeStream({ leadReply = '{"speakers":["medeiros"],"reason":"risk","ask":""}', hang = false, mindText = 'Two sentences. Done.' } = {}) {
  const calls = [];
  const stream = async ({ body, onText, signal }) => {
    calls.push(body);
    if (String(body.system).includes('hold the floor')) return { text: leadReply, stopReason: 'end_turn', ttftMs: 5, totalMs: 10 };
    if (String(body.system).startsWith('Summarise')) return { text: 'Decided: nothing yet.', stopReason: 'end_turn', ttftMs: 5, totalMs: 10 };
    if (hang) {
      await new Promise((resolve, reject) => {
        onText?.('First sentence. ', 'First sentence. ');
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    onText?.('Two sentences. ', 'Two sentences. ');
    onText?.('Done.', mindText);
    return { text: mindText, stopReason: 'end_turn', ttftMs: 40, totalMs: 90, cold: calls.length === 1 };
  };
  return { stream, calls };
}

function fakeSeat({ reply = 'I disagree. It is slower.', fail = false, delayMs = 0, persona = GEMINI_PERSONA } = {}) {
  const asked = [];
  return {
    asked,
    persona,
    model: persona.model,
    async respond(args) {
      asked.push(args);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new Error('wiki-agy: no new conversation DB after agy returned');
      return /^pass$/i.test(reply) ? { text: 'pass', pass: true } : { text: reply, pass: false };
    },
  };
}

function setup(opts = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const sent = [];
  const { stream, calls } = fakeStream(opts);
  const seats = opts.seats ?? [];
  const personas = [...(opts.personas ?? P), ...seats.map((x) => x.persona).filter((x) => !(opts.personas ?? P).includes(x))];
  const h = createHuddle({ personas, stateDir, models: MODELS, stream, broadcast: (p) => sent.push(p), seats, postSummary: opts.postSummary ?? null, id: 'h1', researcher: opts.researcher ?? null });
  return { h, stateDir, sent, calls };
}

test('firstSentenceReached detects a sentence end followed by space or end', () => {
  assert.equal(firstSentenceReached('Hello'), false);
  assert.equal(firstSentenceReached('Hello world. '), true);
  assert.equal(firstSentenceReached('Really?'), true);
  assert.equal(firstSentenceReached('v2.5 is'), false);
});

test('clampSentences keeps at most n sentences', () => {
  assert.equal(clampSentences('One. Two. Three.', 2), 'One. Two.');
  assert.equal(clampSentences('Just one', 2), 'Just one');
});

test('creating a huddle emits started on the spine and the bus', () => {
  const { stateDir, sent } = setup();
  assert.equal(sent[0].type, 'huddle');
  assert.equal(sent[0].event, 'started');
  assert.deepEqual(sent[0].personas.map((p) => p.id), ['riker', 'bill', 'medeiros']);
  assert.equal(readSpineEvents(stateDir, { kind: SPINE_KINDS.HUDDLE_STARTED }).length, 1);
});

test('say: name-addressed turn skips the Lead, streams partials, records both lines with their model', async () => {
  const { h, stateDir, sent, calls } = setup();
  const r = await h.say('Builder, estimate this');
  assert.deepEqual(r.speakers, ['bill']);
  assert.equal(r.via, 'name');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'opus');
  assert.equal(calls[0].max_tokens, 160);
  assert.deepEqual(calls[0].output_config, { effort: 'low' });
  assert.equal(calls[0].speakerId, 'bill');
  assert.deepEqual(calls[0].transcript, [{ speaker: 'operator', name: 'Operator', text: 'Builder, estimate this', truncated: false }]);
  assert.match(calls[0].system, /^You are Builder/);
  assert.deepEqual(sent.map((p) => p.event), ['started', 'utterance', 'speaker', 'partial', 'partial', 'utterance']);
  const snap = h.snapshot();
  assert.equal(snap.transcript[0].model, null);
  assert.equal(snap.transcript[1].speaker, 'bill');
  assert.equal(snap.transcript[1].model, 'opus');
  assert.equal(snap.transcript[1].text, 'Two sentences. Done.');
  assert.equal(typeof snap.transcript[1].firstSentenceMs, 'number');
  const rows = readSpineEvents(stateDir, { kind: SPINE_KINDS.HUDDLE_UTTERANCE });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].sessionId, 'huddle:h1');
  assert.equal(rows[1].actor, 'agent:bill');
  assert.equal(rows[1].payload.model, 'opus');
});

test('say: a mind that overruns two sentences is recorded with two', async () => {
  const { h } = setup({ mindText: 'One. Two. Three.' });
  await h.say('Builder, go');
  assert.equal(h.snapshot().transcript[1].text, 'One. Two.');
});

test('say: unaddressed turn goes through the Lead on the floor model without effort', async () => {
  const { h, calls } = setup();
  const r = await h.say('what breaks first?');
  assert.equal(r.via, 'lead');
  assert.deepEqual(r.speakers, ['medeiros']);
  assert.equal(calls[0].model, 'haiku');
  assert.equal('output_config' in calls[0], false);
  assert.equal(calls[0].speakerId, 'riker');
  assert.equal(calls[1].model, 'opus');
  assert.equal(typeof r.floorMs, 'number');
});

test('say: when the Lead picks nobody, the Lead speaks its question on the floor model', async () => {
  const { h } = setup({ leadReply: '{"speakers":[],"reason":"musing","ask":"Which part worries you?"}' });
  await h.say('I am just thinking aloud here');
  const t = h.snapshot().transcript;
  assert.equal(t[1].speaker, 'riker');
  assert.equal(t[1].text, 'Which part worries you?');
  assert.equal(t[1].model, 'haiku');
});

test('interrupt truncates the speaking mind and records what was heard', async () => {
  const { h, sent } = setup({ hang: true });
  const p = h.say('Builder, go on at length');
  await new Promise((r) => setTimeout(r, 10));
  h.interrupt();
  await p;
  const last = h.snapshot().transcript.at(-1);
  assert.equal(last.speaker, 'bill');
  assert.equal(last.truncated, true);
  assert.equal(last.text, 'First sentence.');
  assert.equal(sent.at(-1).truncated, true);
});

test('Gemini seat: after a Claude answer to a substantive question it dissents, tagged with its model, and say does not wait for it', async () => {
  const seat = fakeSeat({ delayMs: 30 });
  const { h, stateDir } = setup({ seats: [seat] });
  const r = await h.say('Builder, how long would the dock take to build?');
  assert.deepEqual(r.speakers, ['bill']);
  assert.equal(h.snapshot().transcript.length, 2, 'say resolved before the seat answered');
  await h.idle();
  const last = h.snapshot().transcript.at(-1);
  assert.equal(last.speaker, 'gemini');
  assert.equal(last.text, 'I disagree. It is slower.');
  assert.equal(last.model, 'Gemini 3.8 Flash (High)');
  assert.match(seat.asked[0].transcriptText, /Builder: Two sentences\. Done\./);
  assert.equal(seat.asked[0].mode, 'second');
  assert.equal(readSpineEvents(stateDir, { kind: SPINE_KINDS.HUDDLE_UTTERANCE }).at(-1).payload.model, 'Gemini 3.8 Flash (High)');
});

test('Gemini seat: it never takes the first turn, even when named first', async () => {
  const seat = fakeSeat();
  const { h } = setup({ seats: [seat] });
  await h.say('Gemini, what do you think about the dock placement?');
  await h.idle();
  const t = h.snapshot().transcript;
  assert.equal(t[0].speaker, 'operator');
  assert.notEqual(t[1].speaker, 'gemini', 'a Claude mind speaks before the seat');
  assert.equal(t.at(-1).speaker, 'gemini');
  assert.equal(seat.asked[0].mode, 'addressed');
});

test('Gemini seat: a PASS is shown as a pass; chatter gets no seat turn', async () => {
  const seat = fakeSeat({ reply: 'PASS' });
  const { h, sent } = setup({ seats: [seat] });
  await h.say('Builder, what is the riskiest part of the dock?');
  await h.idle();
  const last = h.snapshot().transcript.at(-1);
  assert.deepEqual([last.speaker, last.text, last.pass], ['gemini', 'pass', true]);
  assert.equal(sent.filter((p) => p.event === 'utterance').at(-1).pass, true);
  await h.say('Builder, ok thanks');
  await h.idle();
  assert.equal(seat.asked.length, 1);
});

test('Gemini seat: an agy failure is the seat error line and the Claude answer still stands', async () => {
  const seat = fakeSeat({ fail: true });
  const { h } = setup({ seats: [seat] });
  await h.say('Builder, what would you cut from spike 1?');
  await h.idle();
  const t = h.snapshot().transcript;
  assert.equal(t[1].speaker, 'bill');
  assert.equal(t[1].error, undefined);
  assert.equal(t.at(-1).speaker, 'gemini');
  assert.equal(t.at(-1).error, true);
  assert.match(t.at(-1).text, /^\(Gemini could not answer: wiki-agy: no new conversation DB/);
});

test('end summarises, posts the summary, reports the post, emits ended, and refuses further turns', async () => {
  const posted = [];
  const { h, stateDir, sent } = setup({ postSummary: async (text) => { posted.push(text); } });
  await h.say('Critic, what breaks?');
  const snap = await h.end();
  assert.equal(snap.ended, true);
  assert.deepEqual(snap.summaryPost, { ok: true, error: null });
  assert.deepEqual(posted, ['Decided: nothing yet.']);
  assert.equal(sent.at(-1).event, 'ended');
  assert.equal(sent.at(-1).summary, 'Decided: nothing yet.');
  assert.deepEqual(sent.at(-1).summaryPost, { ok: true, error: null });
  assert.equal(readSpineEvents(stateDir, { kind: SPINE_KINDS.HUDDLE_ENDED })[0].payload.summary, 'Decided: nothing yet.');
  await assert.rejects(() => h.say('more'), /ended/);
});

test('a failed summary post is reported on the ended payload, never dropped', async () => {
  const { h, sent } = setup({ postSummary: async () => { throw new Error('Slack is not connected'); } });
  await h.say('Builder, hello');
  await h.end();
  assert.deepEqual(sent.at(-1).summaryPost, { ok: false, error: 'Slack is not connected' });
  const none = setup();
  await none.h.say('Builder, hello');
  await none.h.end();
  assert.deepEqual(none.sent.at(-1).summaryPost, { ok: false, error: 'no Slack relay configured' });
});

test('a mind that fails records an error line instead of throwing', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const h = createHuddle({ personas: P, stateDir, models: MODELS, stream: async () => { throw new Error('claude error: overloaded'); }, broadcast: () => {}, id: 'h2' });
  await h.say('Builder, hello');
  const last = h.snapshot().transcript.at(-1);
  assert.equal(last.error, true);
  assert.match(last.text, /could not answer: claude error: overloaded/);
});

test('interrupt ends the whole turn: a second picked speaker does not start', async () => {
  const { h, calls } = setup({ hang: true, leadReply: '{"speakers":["bill","medeiros"],"reason":"both","ask":""}' });
  const p = h.say('what breaks first and how long to fix it?');
  await new Promise((r) => setTimeout(r, 30));
  h.interrupt();
  await p;
  assert.deepEqual(calls.map((b) => b.speakerId), ['riker', 'bill']);
  assert.equal(h.snapshot().transcript.at(-1).truncated, true);
});

test('Gemini seat: a dissent still queued when the operator moves on is dropped, never asked', async () => {
  const seat = fakeSeat({ delayMs: 40 });
  const { h } = setup({ seats: [seat] });
  await h.say('Builder, how long would the dock take to build?');
  await h.idle();
  // an addressed question is in flight (never aborted by a new line); the
  // next dissent queues behind it and is superseded before it starts
  await h.say('Gemini, do you agree with that estimate?');
  await h.say('Builder, what is the riskiest part of the dock?');
  await h.say('Builder, ok thanks');
  await h.idle();
  assert.deepEqual(seat.asked.map((a) => a.mode), ['second', 'addressed'], 'the queued dissent was never asked');
  assert.equal(h.snapshot().transcript.filter((u) => u.speaker === 'gemini').length, 2);
});

test('Gemini seat: an addressed question still queued when end() begins is never asked', async () => {
  const seat = fakeSeat({ delayMs: 40 });
  const { h } = setup({ seats: [seat] });
  await h.say('Builder, how long would the dock take to build?');
  // the dissent is now in flight; this addressed question queues behind it
  await h.say('Gemini, do you agree with that estimate?');
  assert.equal(seat.asked.length, 1, 'only the dissent has started');
  const snap = await h.end();
  assert.equal(snap.ended, true);
  assert.deepEqual(seat.asked.map((a) => a.mode), ['second'], 'the queued addressed question was dropped once ending began');
});

test('a speaker in flight when the huddle ends does not let a second speaker start', async () => {
  const { h, calls } = setup({ hang: true, leadReply: '{"speakers":["bill","medeiros"],"reason":"both","ask":""}' });
  const p = h.say('what breaks first and how long to fix it?');
  await new Promise((r) => setTimeout(r, 30));
  const snap = await h.end();
  await p;
  assert.equal(snap.ended, true);
  assert.equal(calls.filter((b) => b.speakerId === 'medeiros').length, 0);
});

test('clampSentences never drops leading text around a period that is not a sentence end', () => {
  assert.equal(clampSentences('It costs $2.50 now. Then this. Later that.', 2), 'It costs $2.50 now. Then this.');
  assert.equal(clampSentences('Use v2.5 here. Second. Third.', 2), 'Use v2.5 here. Second.');
  assert.equal(clampSentences('Try e.g. caching first. Then measure. Then ship.', 2), 'Try e.g. caching first. Then measure.');
});

test('end during a streaming turn waits for the truncated line: it is in the summary input and ended is the last broadcast', async () => {
  const { h, sent, calls } = setup({ hang: true });
  const p = h.say('Builder, go on at length');
  await new Promise((r) => setTimeout(r, 30));
  await h.end();
  await p;
  assert.equal(sent.at(-1).event, 'ended');
  const summaryCall = calls.find((b) => String(b.system).startsWith('Summarise'));
  assert.match(summaryCall.messages[0].content, /Builder: First sentence\. \[interrupted\]/);
});

test('Gemini seat: a throw on the record path (and again on its error line) still shows a seat error line, and idle() resolves', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const sent = [];
  let throws = 2; // the answer's record, then the inner catch's error record
  const broadcast = (p) => {
    if (p.event === 'utterance' && p.speaker === 'gemini' && throws > 0) { throws -= 1; throw new Error('bus write failed'); }
    sent.push(p);
  };
  const seat = fakeSeat();
  const { stream } = fakeStream();
  const h = createHuddle({ personas: [...P, GEMINI_PERSONA], stateDir, models: MODELS, stream, broadcast, seats: [seat], id: 'h3' });
  await h.say('Builder, how long would the dock take to build?');
  await h.idle();
  const line = sent.filter((p) => p.event === 'utterance' && p.speaker === 'gemini').at(-1);
  assert.ok(line, 'a seat utterance reached the bus');
  assert.equal(line.error, true);
  assert.match(line.text, /bus write failed/);
});

test('warmTargets: the Lead on the floor model plus every Claude persona on the mind model, keyed as their turns are; never the seat', async () => {
  const seat = fakeSeat();
  const { h, calls } = setup({ seats: [seat] });
  const targets = h.warmTargets();
  assert.equal(targets.length, P.length + 1, 'one per Claude persona plus the Lead');
  assert.equal(targets.filter((t) => t.model === MODELS.floor).length, 1);
  assert.equal(targets.some((t) => t.system.startsWith('You are Gemini')), false, 'the seat has no claude process');
  await h.say('Builder, estimate this');
  await h.say('what breaks first?');
  const lead = calls.find((b) => String(b.system).includes('hold the floor'));
  const mind = calls.find((b) => b.speakerId === 'bill');
  assert.ok(targets.some((t) => t.model === lead.model && t.system === lead.system && t.effort === (lead.output_config?.effort ?? null)), 'the Lead target matches the Lead call');
  assert.ok(targets.some((t) => t.model === mind.model && t.system === mind.system && t.effort === mind.output_config.effort), 'a mind target matches its turn');
});

test('a failed turn whose warm-up also failed shows the warm-up failure as a status line; a plain failure does not', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const sent = [];
  let warmFailed = true;
  const stream = async ({ body }) => {
    if (body.speakerId === 'bill') throw Object.assign(new Error('claude exited (code 1)'), warmFailed ? { prewarmError: 'claude exited during warm-up (code 1): not logged in' } : {});
    return { text: '{}' };
  };
  const h = createHuddle({ personas: P, stateDir, models: MODELS, stream, broadcast: (p) => sent.push(p), id: 'h4' });
  await h.say('Builder, estimate this');
  const status = sent.filter((p) => p.event === 'status');
  assert.equal(status.length, 1);
  assert.equal(status[0].level, 'error');
  assert.match(status[0].text, /Builder could not warm up earlier: claude exited during warm-up \(code 1\): not logged in/);
  warmFailed = false;
  await h.say('Builder, again');
  assert.equal(sent.filter((p) => p.event === 'status').length, 1, 'no status for a failure with no warm-up failure behind it');
});

test('hear records the operator line at once; a turn superseded before it runs makes no Lead call; say never double-records', async () => {
  const { h, calls } = setup();
  const l1 = h.hear('what breaks first?');
  const l2 = h.hear('and what breaks second?');
  assert.deepEqual(h.snapshot().transcript.map((u) => u.text), ['what breaks first?', 'and what breaks second?']);
  assert.deepEqual(await h.respond(l1), { speakers: [], via: 'superseded', floorMs: 0 });
  assert.equal(calls.length, 0, 'the superseded turn never reached the Lead');
  const r = await h.respond(l2);
  assert.deepEqual(r.speakers, ['medeiros']);
  await h.say('Builder, ok');
  assert.equal(h.snapshot().transcript.filter((u) => u.speaker === 'operator').length, 3);
});

// Live 2026-10-13: a dissent that lands after the next Claude answer leaves the
// seat's own line last in the transcript. Asked to critique "the last answer",
// agy 1.3.4 (Gemini 3.8 Flash) reasoned in circles about which answer that was
// and never finished, so the second seat call hit its 120 s timeout. A new
// line now aborts a running dissent, but an addressed answer is never
// aborted and can still land after the next Claude answer.
test('Gemini seat: a seat line that lands late never makes the next dissent target the seat\'s own line', async () => {
  const prompts = [];
  let gate = null;
  const seat = createAgySeat({
    persona: GEMINI_PERSONA,
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-seat-')),
    generate: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 2) await new Promise((r) => { gate = r; });
      return 'It misses the permits.';
    },
  });
  const { h } = setup({ seats: [seat] });
  await h.say('Builder, how long would a small dock take to build?');
  await h.idle();
  await h.say('Gemini, do you agree with that estimate?');
  await h.say('Critic, what is the strongest argument against a typed huddle?');
  gate();
  await h.idle();
  const t = h.snapshot().transcript.map((u) => u.speaker);
  assert.deepEqual(t, ['operator', 'bill', 'gemini', 'operator', 'operator', 'medeiros', 'gemini', 'gemini'], 'the addressed answer landed after the Critic, as live');
  assert.equal(prompts.length, 3);
  assert.match(prompts[2], /\nGemini: It misses the permits\.\n/, 'the late seat line is in the dissent\'s transcript');
  assert.doesNotMatch(prompts[2], /the last answer/, 'the instruction never points at whatever line happens to be last');
  assert.match(prompts[2], /Answer to weigh:\nCritic: Two sentences\. Done\.$/, 'the dissent names the Critic\'s answer');
  assert.match(prompts[0], /Answer to weigh:\nBuilder: Two sentences\. Done\.$/);
});

test('Gemini seat: an addressed question names the operator\'s question, not the last line', async () => {
  const seat = fakeSeat();
  const { h } = setup({ seats: [seat] });
  await h.say('Builder, how long would the dock take to build?');
  await h.idle();
  await h.say('Gemini, do you agree with that estimate?');
  await h.idle();
  assert.equal(seat.asked.at(-1).mode, 'addressed');
  assert.equal(seat.asked.at(-1).target, 'Operator: Gemini, do you agree with that estimate?');
});

// A seat that never answers until it is aborted (and then answers anyway, late).
function stuckSeat() {
  const asked = [];
  let aborts = 0;
  return {
    asked, get aborts() { return aborts; },
    persona: GEMINI_PERSONA,
    model: 'Gemini 3.8 Flash (High)',
    respond(args) {
      asked.push(args);
      return new Promise((resolve) => {
        args.signal?.addEventListener('abort', () => { aborts += 1; setTimeout(() => resolve({ text: 'LATE SEAT LINE.', pass: false }), 5); });
      });
    },
  };
}

test('end waits at most SEAT_END_GRACE_MS (10 s) for the seat', () => {
  assert.equal(SEAT_END_GRACE_MS, 10_000);
});

// No operator line between the seat call and end(): only the grace can end the wait.
test('end: a seat call still running after the grace is aborted, its late line dropped, and the summary written without it', { timeout: 5000 }, async () => {
  const GRACE = 200;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const sent = [];
  const { stream, calls } = fakeStream();
  const seat = stuckSeat();
  const h = createHuddle({ personas: [...P, GEMINI_PERSONA], stateDir, models: MODELS, stream, broadcast: (p) => sent.push(p), seats: [seat], id: 'h4', seatEndGraceMs: GRACE });
  await h.say('Builder, how long would the dock take to build?');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seat.asked.length, 1, 'the dissent is in flight');
  assert.equal(seat.aborts, 0);
  const t0 = Date.now();
  const snap = await h.end();
  const took = Date.now() - t0;
  assert.ok(took >= GRACE - 5, `end waited the grace (${took} ms)`);
  assert.ok(took < GRACE + 500, `end took ${took} ms`);
  assert.equal(seat.aborts, 1, 'the in-flight seat call was aborted');
  assert.ok(seat.asked[0].signal instanceof AbortSignal);
  await new Promise((r) => setTimeout(r, 30)); // the stuck seat now answers, late
  assert.equal(h.snapshot().transcript.some((u) => u.speaker === 'gemini'), false, 'the late seat line is dropped');
  assert.equal(sent.some((p) => p.event === 'utterance' && p.speaker === 'gemini'), false);
  const summaryIn = calls.find((b) => String(b.system).startsWith('Summarise')).messages[0].content;
  assert.doesNotMatch(summaryIn, /^Gemini:|LATE SEAT LINE/m);
  assert.equal(snap.ended, true);
  assert.equal(sent.at(-1).event, 'ended');
});

test('end: a seat call that answers inside the grace is kept and summarised', async () => {
  const seat = fakeSeat({ delayMs: 20 });
  const { h, calls } = setup({ seats: [seat] });
  await h.say('Builder, how long would the dock take to build?');
  await h.end();
  assert.equal(h.snapshot().transcript.at(-1).speaker, 'gemini');
  assert.match(calls.find((b) => String(b.system).startsWith('Summarise')).messages[0].content, /Gemini: I disagree\. It is slower\./);
});

// A seat whose call never settles, not even when aborted: the session must
// not let it hold the seat queue.
function neverSeat() {
  const asked = [];
  let aborts = 0;
  return {
    asked, get aborts() { return aborts; },
    persona: GEMINI_PERSONA,
    model: 'Gemini 3.8 Flash (High)',
    respond(args) {
      asked.push(args);
      args.signal?.addEventListener('abort', () => { aborts += 1; });
      return new Promise(() => {});
    },
  };
}

test('a new operator line aborts the running dissent, drops it, and the new turn\'s dissent runs', async () => {
  const seat = neverSeat();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const { stream } = fakeStream();
  const h = createHuddle({ personas: [...P, GEMINI_PERSONA], stateDir, models: MODELS, stream, broadcast: () => {}, seats: [seat], id: 'h5', seatEndGraceMs: 30 });
  await h.say('Builder, how long would a small dock take to build?');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seat.asked.length, 1, 'the first dissent is running');
  await h.say('Critic, what is the strongest argument against a typed huddle?');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seat.aborts, 1, 'the running dissent was aborted once');
  assert.equal(seat.asked.length, 2, 'the seat queue is free: the new turn\'s dissent started');
  assert.equal(seat.asked[1].target, 'Critic: Two sentences. Done.');
  assert.equal(seat.asked[1].signal.aborted, false);
  await h.end();
  assert.equal(h.snapshot().transcript.some((u) => u.speaker === 'gemini'), false);
});

test('abortSeat aborts the running seat call and end() then does not wait the grace', async () => {
  const seat = neverSeat();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const { stream } = fakeStream();
  const h = createHuddle({ personas: [...P, GEMINI_PERSONA], stateDir, models: MODELS, stream, broadcast: () => {}, seats: [seat], id: 'h6' });
  await h.say('Builder, how long would a small dock take to build?');
  await new Promise((r) => setTimeout(r, 10));
  h.abortSeat();
  const t0 = Date.now();
  await h.end();
  assert.ok(Date.now() - t0 < 1000, 'end did not wait SEAT_END_GRACE_MS');
  assert.equal(seat.aborts, 1);
});

test('an aborted dissent sends the seat chip back to idle (no stuck "thinking")', async () => {
  const seat = neverSeat();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const sent = [];
  const { stream } = fakeStream();
  const h = createHuddle({ personas: [...P, GEMINI_PERSONA], stateDir, models: MODELS, stream, broadcast: (p) => sent.push(p), seats: [seat], id: 'h7', seatEndGraceMs: 30 });
  await h.say('Builder, how long would a small dock take to build?');
  await new Promise((r) => setTimeout(r, 10));
  await h.say('Builder, ok thanks');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seat.aborts, 1);
  assert.equal(seat.asked.length, 1, 'a short line queues no new dissent');
  const states = sent.filter((p) => p.event === 'speaker' && p.speaker === 'gemini').map((p) => p.state);
  assert.deepEqual(states, ['thinking', 'idle']);
  await h.end();
});

const mk = (id, display, role, extra = {}) => ({ id, lead: false, display, role, icon: ':x:', aliases: [id, display.toLowerCase()], definition: null, engine: 'claude', ...extra });
const Q = [
  { id: 'riker', lead: true, display: 'Lead', role: 'orchestrator', icon: ':satellite:', aliases: ['riker', 'lead'], definition: null },
  mk('bill', 'Builder', 'builder', { model: 'opus' }),
  mk('garfield', 'Reviewer', 'reviewer', { model: 'sonnet' }),
  mk('homer', 'Researcher', 'researcher', { engine: 'agy', model: 'Gemini 3.8 Flash (Medium)', seat: 'agy' }),
  mk('medeiros', 'Skeptic', 'skeptic', { engine: 'agy', model: 'GPT-OSS 120B (Medium)', seat: 'agy' }),
];
const seatFor = (id, opts) => fakeSeat({ persona: Q.find((p) => p.id === id), ...opts });

test('each persona speaks on its own model and the utterance is tagged with it', async () => {
  const { h, calls } = setup({ personas: Q });
  await h.say('Reviewer, look at this');
  assert.equal(calls[0].model, 'sonnet');
  assert.equal(h.snapshot().transcript[1].model, 'sonnet');
  await h.say('Builder, and you?');
  assert.equal(calls[1].model, 'opus');
  assert.equal(h.snapshot().transcript.at(-1).model, 'opus');
});

test('a persona with model null falls back to the mind model, in the turn and in warmTargets', async () => {
  const personas = [Q[0], mk('bill', 'Builder', 'builder', { model: null })];
  const { h, calls } = setup({ personas });
  await h.say('Builder, go');
  assert.equal(calls[0].model, MODELS.mind);
  assert.equal(h.snapshot().transcript[1].model, MODELS.mind);
  assert.ok(h.warmTargets().some((t) => t.model === MODELS.mind));
});

test('warmTargets uses each persona\'s own model and skips the agy seats', () => {
  const { h } = setup({ personas: Q, seats: [seatFor('homer'), seatFor('medeiros')] });
  const models = h.warmTargets().map((t) => t.model).sort();
  assert.deepEqual(models, ['haiku', 'opus', 'opus', 'sonnet'], 'the Lead floor, the Lead persona and bill on opus, garfield on sonnet');
});

test('the Lead names the second view: that seat is asked in second mode with the Claude answer; the other is not', async () => {
  const homer = seatFor('homer'); const medeiros = seatFor('medeiros');
  const { h } = setup({ personas: Q, seats: [homer, medeiros], leadReply: '{"speakers":["bill"],"second":"medeiros","reason":"r","ask":""}' });
  await h.say('how long would the dock take to build?');
  await h.idle();
  assert.equal(homer.asked.length, 0);
  assert.equal(medeiros.asked.length, 1);
  assert.equal(medeiros.asked[0].mode, 'second');
  assert.equal(medeiros.asked[0].target, 'Builder: Two sentences. Done.');
  const last = h.snapshot().transcript.at(-1);
  assert.deepEqual([last.speaker, last.model], ['medeiros', 'GPT-OSS 120B (Medium)']);
});

test('with no second named, second views rotate over the seats in roster order', async () => {
  const homer = seatFor('homer'); const medeiros = seatFor('medeiros');
  const { h } = setup({ personas: Q, seats: [medeiros, homer] });
  await h.say('Builder, how long would the dock take to build?');
  await h.idle();
  await h.say('Builder, what is the riskiest part of the dock?');
  await h.idle();
  await h.say('Builder, what would you cut from the first version?');
  await h.idle();
  assert.deepEqual(h.snapshot().transcript.filter((u) => u.model && /Gemini|GPT/.test(u.model)).map((u) => u.speaker), ['homer', 'medeiros', 'homer']);
});

test('an agy seat named before any Claude seat spoke waits: a Claude seat speaks first, then the seat answers addressed', async () => {
  const medeiros = seatFor('medeiros');
  const { h } = setup({ personas: Q, seats: [seatFor('homer'), medeiros], leadReply: '{"speakers":["bill"],"reason":"r","ask":""}' });
  await h.say('Skeptic, what do you think about the dock placement?');
  await h.idle();
  const t = h.snapshot().transcript.map((u) => u.speaker);
  assert.deepEqual(t, ['operator', 'bill', 'medeiros']);
  assert.equal(medeiros.asked[0].mode, 'addressed');
});

test('a persona with a seatError produces one error status frame at start', () => {
  const personas = [Q[0], mk('bill', 'Builder', 'builder', { model: null, seatError: 'bill: unknown engine "openai", using the default mind model' })];
  const { sent } = setup({ personas });
  const status = sent.filter((p) => p.event === 'status');
  assert.equal(status.length, 1);
  assert.equal(status[0].level, 'error');
  assert.match(status[0].text, /unknown engine "openai"/);
});

test('metric records a voice latency on the spine; a bad value is refused with no event', () => {
  const { h, stateDir } = setup();
  assert.equal(h.metric({ kind: 'voice', heardToFirstAudioMs: 2100, serverFirstSentenceMs: 900, speaker: 'bill' }), true);
  const rows = readSpineEvents(stateDir, { kind: SPINE_KINDS.HUDDLE_METRIC });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 'huddle:h1');
  assert.equal(rows[0].payload.heardToFirstAudioMs, 2100);
  assert.equal(h.metric({ kind: 'voice', heardToFirstAudioMs: -1 }), false);
  assert.equal(h.metric({ kind: 'voice', heardToFirstAudioMs: 121000 }), false);
  assert.equal(h.metric({ kind: 'other', heardToFirstAudioMs: 5 }), false);
  assert.equal(h.metric(null), false);
  assert.equal(readSpineEvents(stateDir, { kind: SPINE_KINDS.HUDDLE_METRIC }).length, 1);
});

test('the started roster carries each persona model and voice, for the dock voices', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const sent = [];
  const personas = [
    { ...P[0], model: null, voice: { pitch: 1, rate: 1 } },
    { ...P[1], model: 'opus', voice: { pitch: 0.9, rate: 1.05 } },
  ];
  const h = createHuddle({ personas, stateDir, models: MODELS, stream: fakeStream().stream, broadcast: (p) => sent.push(p), id: 'hv' });
  const started = sent.find((p) => p.event === 'started');
  assert.deepEqual(started.personas[1].voice, { pitch: 0.9, rate: 1.05 });
  assert.equal(started.personas[1].model, 'opus');
  assert.deepEqual(h.snapshot().personas[1].voice, { pitch: 0.9, rate: 1.05 });
});

test('a seat moved off a retired model: its line carries the new model and the move is one info status frame', async () => {
  let model = 'Claude Sonnet 4.6 (Thinking)';
  const seat = {
    persona: GEMINI_PERSONA,
    get model() { return model; },
    async respond() { model = 'Claude Sonnet 5.5 (Medium)'; return { text: 'A view.', pass: false, note: 'Gemini model moved.' }; },
  };
  const { h, sent } = setup({ seats: [seat] });
  await h.say('Builder, how long would the dock take to build?');
  await h.idle();
  assert.equal(h.snapshot().transcript.at(-1).model, 'Claude Sonnet 5.5 (Medium)');
  const notes = sent.filter((f) => f.event === 'status' && f.text === 'Gemini model moved.');
  assert.deepEqual(notes.map((f) => f.level), ['info']);
});

// A Lead that streams its speakers first and the rest of its reply later.
function slowTailStream({ head, tail, tailMs = 80 }) {
  const order = [];
  const calls = [];
  const stream = async ({ body, onText }) => {
    calls.push(body);
    if (String(body.system).includes('hold the floor')) {
      order.push('lead:start');
      onText?.(head, head);
      await new Promise((r) => setTimeout(r, tailMs));
      order.push('lead:end');
      return { text: head + tail, stopReason: 'end_turn', ttftMs: 5, totalMs: tailMs };
    }
    order.push(`mind:${body.speakerId}`);
    onText?.('Two sentences. Done.', 'Two sentences. Done.');
    return { text: 'Two sentences. Done.', stopReason: 'end_turn', ttftMs: 5, totalMs: 10 };
  };
  return { stream, order, calls };
}

test('the floor resolves when the Lead has streamed its speakers: the mind starts before the Lead reply ends, and the second view still comes from the whole reply', async () => {
  const { stream, order, calls } = slowTailStream({ head: '{"speakers":["bill"]', tail: ',"reason":"r","second":"gemini","ask":""}' });
  const seat = fakeSeat();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const h = createHuddle({ personas: [...P, GEMINI_PERSONA], stateDir, models: { ...MODELS, floorEffort: 'low' }, stream, broadcast: () => {}, seats: [seat], id: 'h2' });
  const r = await h.say('What should we build first this week?');
  assert.deepEqual(r.speakers, ['bill']);
  assert.deepEqual(order, ['lead:start', 'mind:bill', 'lead:end']);
  assert.deepEqual(calls[0].output_config, { effort: 'low' }, 'the Lead call carries floorEffort');
  await h.idle();
  assert.equal(seat.asked[0]?.mode, 'second', 'the second view named at the end of the reply is still asked');
});

test('the floor does not resolve early on an empty or unknown speakers list: the Lead question is recorded', async () => {
  const { stream, order } = slowTailStream({ head: '{"speakers":["nobody"]', tail: ',"reason":"r","second":"","ask":"Which part?"}' });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const h = createHuddle({ personas: P, stateDir, models: MODELS, stream, broadcast: () => {}, id: 'h3' });
  await h.say('I am thinking about the dock.');
  assert.deepEqual(order, ['lead:start', 'lead:end']);
  const last = h.snapshot().transcript.at(-1);
  assert.deepEqual([last.speaker, last.text], ['riker', 'Which part?']);
});

test('warmTargets warms the Lead with floorEffort, keyed like its turns', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const h = createHuddle({ personas: P, stateDir, models: { ...MODELS, floorEffort: 'low' }, stream: async () => ({ text: '' }), broadcast: () => {}, id: 'h4' });
  assert.equal(h.warmTargets()[0].effort, 'low');
});

test('an empty huddle makes no summary call and posts nothing to Slack', async () => {
  const posted = [];
  const { h, sent, calls } = setup({ postSummary: async (t) => { posted.push(t); } });
  await h.say('');
  await h.end();
  assert.deepEqual(posted, []);
  assert.equal(calls.filter((b) => String(b.system).startsWith('Summarise')).length, 0);
  assert.deepEqual(sent.at(-1).summaryPost, { ok: false, error: 'nobody spoke, so nothing was posted' });
  assert.equal(sent.at(-1).summary, 'Nobody on the team spoke in this huddle.');
});

test('announce records a Lead line that no model wrote, marked as a work line', () => {
  const { h, sent } = setup();
  const u = h.announce('Filed glmps-1 with its own Slack thread.');
  assert.deepEqual([u.speaker, u.text, u.via], ['riker', 'Filed glmps-1 with its own Slack thread.', 'work']);
  assert.equal(sent.at(-1).event, 'utterance');
  assert.equal(h.announce('  '), null);
});

// Track C: mute, agenda, shown model
const AGENDA = { question: 'Which seat chair goes first?', items: [{ text: 'Ship typed first?', lean: 'Yes, typing is the default.' }, { text: 'Keep push-to-talk?', lean: '' }] };

test('mute: a muted seat is dropped from the Lead prompt and never speaks, even when the Lead names it', async () => {
  const { h, sent, calls } = setup();
  assert.equal(h.mute('medeiros', true), true);
  const r = await h.say('what breaks first?');
  assert.ok(!String(calls.find((b) => String(b.system).includes('hold the floor')).system).includes('medeiros'), 'the Lead is not offered the muted seat');
  assert.ok(!r.speakers.includes('medeiros'));
  assert.ok(!h.snapshot().transcript.some((u) => u.speaker === 'medeiros'));
  assert.ok(sent.some((p) => p.event === 'muted' && p.muted.includes('medeiros')));
  assert.deepEqual(h.snapshot().muted, ['medeiros']);
});

test('mute: naming a muted seat does not reach it, and unmuting restores it', async () => {
  const { h } = setup();
  h.mute('medeiros', true);
  const named = await h.say('Critic, what breaks?');
  assert.notEqual(named.via, 'name');
  assert.ok(!h.snapshot().transcript.some((u) => u.speaker === 'medeiros'));
  h.mute('medeiros', false);
  const again = await h.say('Critic, what breaks?');
  assert.deepEqual(again.speakers, ['medeiros']);
  assert.deepEqual(h.snapshot().muted, []);
});

test('mute: the Lead and unknown ids cannot be muted', () => {
  const { h } = setup();
  assert.equal(h.mute('riker', true), false);
  assert.equal(h.mute('nobody', true), false);
  assert.deepEqual(h.snapshot().muted, []);
});

test('mute: a muted agy seat is skipped as the second view and a named call to it is not queued', async () => {
  const seat = fakeSeat();
  const { h } = setup({ seats: [seat], leadReply: '{"speakers":["bill"],"reason":"x","second":"gemini","ask":""}' });
  h.mute('gemini', true);
  await h.say('Should we rewrite the whole scheduler in rust this quarter?');
  await h.idle();
  assert.equal(seat.asked.length, 0);
  await h.say('Gemini, what do you think?');
  await h.idle();
  assert.equal(seat.asked.length, 0);
});

test('the roster carries the model each seat actually runs: the Lead on the floor model, a default mind on the mind model, a seat on its own', () => {
  const { h } = setup({ seats: [fakeSeat()] });
  const byId = Object.fromEntries(h.snapshot().personas.map((p) => [p.id, p.modelName]));
  assert.equal(byId.riker, 'haiku');
  assert.equal(byId.bill, 'opus');
  assert.equal(byId.gemini, 'Gemini 3.8 Flash (High)');
});

test('agenda: one non-streamed call on the floor model, stored, in the snapshot and broadcast; an empty huddle makes no call', async () => {
  const sent = [];
  const calls = [];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const stream = async ({ body, onText }) => {
    calls.push(body);
    if (String(body.system).includes('hold the floor')) return { text: '{"speakers":["bill"],"reason":"x","ask":""}' };
    if (body.system === AGENDA_SYSTEM) return { text: JSON.stringify(AGENDA) };
    onText?.('Fine. Done.', 'Fine. Done.');
    return { text: 'Fine. Done.', ttftMs: 1, totalMs: 2 };
  };
  const h = createHuddle({ personas: P, stateDir, models: MODELS, stream, broadcast: (p) => sent.push(p), id: 'ha' });
  assert.deepEqual(await h.agenda(), { question: '', items: [] });
  assert.equal(calls.length, 0);
  await h.say('Builder, should typing be the default?');
  const a = await h.agenda();
  assert.deepEqual(a, AGENDA);
  assert.equal(calls.find((b) => b.system === AGENDA_SYSTEM).model, 'haiku');
  assert.deepEqual(h.snapshot().agenda, AGENDA);
  assert.deepEqual(sent.findLast((p) => p.event === 'agenda'), { type: 'huddle', event: 'agenda', huddleId: 'ha', ...AGENDA });
});

const HOWARD = Object.freeze({ id: 'howard', role: 'researcher', display: 'Howard', icon: ':mag_right:', aliases: ['howard'], lead: false, researcher: true, engine: 'claude', model: 'sonnet', seatRole: 'researcher', definitionName: 'huddle/researcher', definition: 'Look things up.' });
const WITH_HOWARD = [...P, HOWARD];

// A fake researcher whose lookups settle when the test says so.
function fakeResearcher({ failWith = null } = {}) {
  const jobs = [];
  let active = false;
  return {
    model: 'sonnet',
    jobs,
    busy: () => active,
    run({ question, signal }) {
      if (active) return Promise.reject(Object.assign(new Error('busy'), { code: 'BUSY' }));
      active = true;
      return new Promise((resolve, reject) => {
        const job = { question, signal, finish: (text, extra = {}) => { active = false; resolve({ text, label: 'From the web, unverified', partial: false, ...extra }); } };
        signal?.addEventListener('abort', () => { active = false; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        jobs.push(job);
        if (failWith) { active = false; reject(new Error(failWith)); }
      });
    },
  };
}

const lines = (h, who) => h.snapshot().transcript.filter((u) => u.speaker === who);
const tick = () => new Promise((r) => setImmediate(r));

test('naming Howard: he acknowledges at once with no Lead call, then the finding lands later, marked as outside material', async () => {
  const researcher = fakeResearcher();
  const { h, sent, calls, stateDir } = setup({ personas: WITH_HOWARD, researcher });
  const r = await h.say('Howard, look up how library X retries failed requests');
  assert.deepEqual(r.speakers, ['howard']);
  assert.equal(r.via, 'name');
  assert.ok(!calls.some((b) => String(b.system).includes('hold the floor')), 'a name needs no floor call');
  const ack = lines(h, 'howard');
  assert.equal(ack.length, 1, 'only the acknowledgement so far');
  assert.match(ack[0].text, /how library X retries failed requests/);
  assert.equal(ack[0].via, 'research-ack');
  assert.equal(researcher.jobs.length, 1);
  assert.match(researcher.jobs[0].question, /library X retries/);
  assert.ok(!/howard/i.test(researcher.jobs[0].question), 'his own name is not part of the question');

  researcher.jobs[0].finish('Library X retries 3 times (https://x.test/docs). Our retry lives in server/lib/retry.js.');
  await tick();
  const both = lines(h, 'howard');
  assert.equal(both.length, 2);
  assert.equal(both[1].via, 'research');
  assert.equal(both[1].outside, true);
  assert.equal(both[1].label, 'From the web, unverified');
  const frame = sent.filter((p) => p.event === 'utterance' && p.speaker === 'howard').at(-1);
  assert.equal(frame.outside, true);
  assert.equal(frame.label, 'From the web, unverified');
  assert.equal(readSpineEvents(stateDir, { kind: SPINE_KINDS.HUDDLE_UTTERANCE }).filter((e) => e.payload.speaker === 'howard').length, 2);
  assert.match(h.transcriptText(), /Howard: \[From the web, unverified\] Library X retries 3 times/);
});

test('the finding is what decide() sees, labelled as outside material', async () => {
  const researcher = fakeResearcher();
  const { h } = setup({ personas: WITH_HOWARD, researcher });
  await h.say('Howard, look up X');
  researcher.jobs[0].finish('X does Y.');
  await tick();
  let seen = '';
  await h.decide({ via: async ({ body }) => { seen = body.messages[0].content; return { text: '{"problem":"","decisions":[],"actions":[],"open":[]}' }; } });
  assert.match(seen, /Howard: \[From the web, unverified\] X does Y\./);
});

test('the minds see the finding labelled too', async () => {
  const researcher = fakeResearcher();
  const { h, calls } = setup({ personas: WITH_HOWARD, researcher });
  await h.say('Howard, look up X');
  researcher.jobs[0].finish('X does Y.');
  await tick();
  await h.say('Builder, what do you make of that?');
  const mind = calls.filter((b) => b.speakerId === 'bill').at(-1);
  assert.ok(mind.transcript.some((row) => row.speaker === 'howard' && row.text.startsWith('[From the web, unverified] ')));
});

test('the chair can call on Howard: the Lead research field starts a lookup after the mind has spoken', async () => {
  const researcher = fakeResearcher();
  const { h } = setup({ personas: WITH_HOWARD, researcher, leadReply: '{"speakers":["bill"],"reason":"r","ask":"","research":"how tool Z compares to our queue"}' });
  await h.say('what should we do about the queue?');
  assert.equal(lines(h, 'bill').length, 1);
  assert.equal(researcher.jobs.length, 1);
  assert.equal(researcher.jobs[0].question, 'how tool Z compares to our queue');
  assert.match(lines(h, 'howard')[0].text, /tool Z compares to our queue/);
});

test('one lookup at a time: a second request while one runs is refused with a busy line and starts nothing', async () => {
  const researcher = fakeResearcher();
  const { h } = setup({ personas: WITH_HOWARD, researcher });
  await h.say('Howard, look up A');
  await h.say('Howard, look up B');
  assert.equal(researcher.jobs.length, 1);
  const hw = lines(h, 'howard');
  assert.equal(hw.length, 2);
  assert.equal(hw[1].via, 'research-busy');
  assert.match(hw[1].text, /already on another lookup/);
  researcher.jobs[0].finish('A done.');
  await tick();
  await h.say('Howard, look up B');
  assert.equal(researcher.jobs.length, 2, 'the slot is free again');
});

test('a failed lookup is an error line, not a finding', async () => {
  const researcher = fakeResearcher({ failWith: 'claude step timed out after 120000 ms' });
  const { h } = setup({ personas: WITH_HOWARD, researcher });
  await h.say('Howard, look up A');
  await tick();
  const last = lines(h, 'howard').at(-1);
  assert.equal(last.error, true);
  assert.match(last.text, /could not finish.*timed out/);
  assert.ok(!last.outside);
});

test('ending the huddle aborts a running lookup and drops its late finding', async () => {
  const researcher = fakeResearcher();
  const { h } = setup({ personas: WITH_HOWARD, researcher });
  await h.say('Howard, look up A');
  await h.say('Builder, ok');
  const snap = await h.end();
  assert.equal(researcher.jobs[0].signal.aborted, true);
  await tick();
  assert.equal(lines(h, 'howard').length, 1, 'only the acknowledgement; nothing recorded after the end');
  assert.equal(snap.ended, true);
});

test('Howard without a researcher behind him says so instead of pretending', async () => {
  const { h } = setup({ personas: WITH_HOWARD });
  await h.say('Howard, look up A');
  const hw = lines(h, 'howard');
  assert.equal(hw.length, 1);
  assert.equal(hw[0].error, true);
});

test('Howard is in the roster frame, listed to the Lead as a research call, muteable, and never warmed', async () => {
  const researcher = fakeResearcher();
  const { h, sent, calls } = setup({ personas: WITH_HOWARD, researcher });
  assert.ok(sent[0].personas.some((p) => p.id === 'howard' && p.seatRole === 'researcher'));
  assert.equal(h.mute('howard'), true);
  await h.say('Howard, look up A');
  assert.equal(researcher.jobs.length, 0, 'a muted Howard is not called on');
  h.mute('howard', false);
  await h.say('what now?');
  assert.ok(calls.some((b) => String(b.system).includes('hold the floor')));
  assert.ok(h.warmTargets().every((t) => !String(t.system).startsWith('You are Howard')), 'no claude process is warmed for Howard');
});
