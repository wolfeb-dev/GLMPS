import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DECISIONS_SYSTEM, parseDecisions, planCard, actionCards } from '../lib/huddle/decisions.js';
import { createHuddle } from '../lib/huddle/session.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

const EXTRACTED = {
  decisions: ['Ship voice on the desk first', 'Keep opus on the main seat'],
  actions: [{ title: 'Add the Talk button', detail: 'Chrome Beta dock has a Talk toggle.' }, { title: 'Bench the first word', detail: 'Ten turns, under 5 s.' }],
  open: ['Does the phone need TLS first?'],
};

// What parseDecisions returns for EXTRACTED: the four-part shape (no problem, no dissent).
const PARSED = { problem: '', ...EXTRACTED, against: ['', ''] };

test('DECISIONS_SYSTEM asks for JSON only with the three lists', () => {
  assert.match(DECISIONS_SYSTEM, /JSON only/);
  for (const k of ['"decisions"', '"actions"', '"open"', '"title"', '"detail"']) assert.ok(DECISIONS_SYSTEM.includes(k), k);
});

test('parseDecisions: clean JSON, JSON inside prose, and garbage', () => {
  const raw = JSON.stringify(EXTRACTED);
  assert.deepEqual(parseDecisions(raw), PARSED);
  assert.deepEqual(parseDecisions(`Here you go:\n${raw}\nDone.`), PARSED);
  assert.deepEqual(parseDecisions('no json here'), { problem: '', decisions: [], against: [], actions: [], open: [] });
  assert.deepEqual(parseDecisions(''), { problem: '', decisions: [], against: [], actions: [], open: [] });
  assert.deepEqual(parseDecisions(null), { problem: '', decisions: [], against: [], actions: [], open: [] });
});

test('parseDecisions: trims, drops empties and non-strings, caps lists at 12 and titles at 120', () => {
  const many = Array.from({ length: 20 }, (_, i) => `d${i}`);
  const r = parseDecisions(JSON.stringify({
    decisions: ['  keep  ', '', 7, ...many],
    actions: [{ title: 'x'.repeat(300), detail: ' d ' }, { title: '', detail: 'no title' }, 'bare string', { title: 'ok' }],
    open: ['  q  ', null],
  }));
  assert.equal(r.decisions.length, 12);
  assert.equal(r.decisions[0], 'keep');
  assert.equal(r.actions[0].title.length, 120);
  assert.equal(r.actions[0].detail, 'd');
  assert.deepEqual(r.actions[1], { title: 'ok', detail: '' });
  assert.equal(r.actions.length, 2);
  assert.deepEqual(r.open, ['q']);
});

test('planCard: one card that says write a plan then build it, with the decisions, actions, open questions and transcript', () => {
  const c = planCard({ huddleId: 'h9', extracted: EXTRACTED, transcriptText: 'Operator: go\nBuilder: ok', project: 'glmps' });
  assert.equal(c.title, 'Plan from huddle h9: Add the Talk button');
  assert.equal(c.project, 'glmps');
  assert.equal(c.source, 'huddle');
  assert.deepEqual(c.origin, { via: 'huddle', huddleId: 'h9' });
  assert.match(c.prompt, /^Write a spec with to-spec from the decisions below, commit it under docs\/specs\/, declare it on this card, then build it with implement\./);
  assert.match(c.prompt, /Decisions:\n- Ship voice on the desk first\n- Keep opus on the main seat/);
  assert.match(c.prompt, /Actions:\n- Add the Talk button: Chrome Beta dock has a Talk toggle\.\n- Bench the first word: Ten turns, under 5 s\./);
  assert.match(c.prompt, /Still open \(ask the operator before assuming\):\n- Does the phone need TLS first\?/);
  assert.match(c.prompt, /Transcript:\nOperator: go\nBuilder: ok$/);
  assert.deepEqual(c.acceptanceCriteria, [
    { text: 'AC-1 Add the Talk button', done: false },
    { text: 'AC-2 Bench the first word', done: false },
  ]);
});

test('planCard with no actions titles itself from the first decision', () => {
  const c = planCard({ huddleId: 'h9', extracted: { decisions: ['Go with the dock'], actions: [], open: [] }, transcriptText: 't' });
  assert.equal(c.title, 'Plan from huddle h9: Go with the dock');
  assert.deepEqual(c.acceptanceCriteria, []);
  assert.equal(c.project, undefined);
});

test('actionCards: one body per picked action; out-of-range, repeated and non-integer picks are ignored', () => {
  const cards = actionCards({ huddleId: 'h9', extracted: EXTRACTED, picks: [1, 7, -1, 1, 'x', 0], project: 'glmps' });
  assert.deepEqual(cards.map((c) => c.title), ['Bench the first word', 'Add the Talk button']);
  assert.equal(cards[0].source, 'huddle');
  assert.deepEqual(cards[0].origin, { via: 'huddle', huddleId: 'h9' });
  assert.match(cards[0].prompt, /^Ten turns, under 5 s\./);
  assert.match(cards[0].prompt, /Ship voice on the desk first/);
  assert.match(cards[0].prompt, /\(from huddle h9\)$/);
  assert.deepEqual(actionCards({ huddleId: 'h9', extracted: EXTRACTED, picks: [] }), []);
});

// decide() on the session
const P = [
  { id: 'riker', lead: true, display: 'Lead', role: 'orchestrator', icon: ':x:', aliases: ['riker'], definition: null },
  { id: 'bill', lead: false, display: 'Builder', role: 'builder', icon: ':x:', aliases: ['bill', 'builder'], definition: null },
];
function decideSetup({ decide, models = { floor: 'haiku', mind: 'opus', effort: 'low', maxTokens: 160 } } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-dec-'));
  const sent = [];
  const calls = [];
  const stream = async ({ body, onText }) => {
    calls.push(body);
    if (body.system === DECISIONS_SYSTEM) return decide ? decide(body) : { text: JSON.stringify(EXTRACTED) };
    onText?.('Fine. Done.', 'Fine. Done.');
    return { text: 'Fine. Done.', ttftMs: 1, totalMs: 2 };
  };
  const h = createHuddle({ personas: P, stateDir, models, stream, broadcast: (p) => sent.push(p), id: 'hd' });
  return { h, stateDir, sent, calls };
}

test('decide: one non-streamed call on models.decide (default the mind model), stores, emits on the spine and broadcasts the frame', async () => {
  const { h, stateDir, sent, calls } = decideSetup({ models: { floor: 'haiku', mind: 'opus', decide: 'sonnet', maxTokens: 160 } });
  await h.say('Builder, should we ship voice first?');
  const r = await h.decide();
  assert.deepEqual(r, PARSED);
  const call = calls.find((b) => b.system === DECISIONS_SYSTEM);
  assert.equal(call.model, 'sonnet');
  assert.equal(call.max_tokens, 600);
  assert.match(call.messages[0].content, /Operator: Builder, should we ship voice first\?/);
  assert.deepEqual(h.snapshot().extracted, PARSED);
  const frame = sent.find((p) => p.event === 'decisions');
  assert.deepEqual(frame, { type: 'huddle', event: 'decisions', huddleId: 'hd', ...PARSED });
  assert.equal(readSpineEvents(stateDir, { kind: SPINE_KINDS.HUDDLE_DECISIONS }).length, 1);
});

test('decide falls back to the mind model when models.decide is unset', async () => {
  const { h, calls } = decideSetup();
  await h.say('Builder, hi');
  await h.decide();
  assert.equal(calls.find((b) => b.system === DECISIONS_SYSTEM).model, 'opus');
});

test('concurrent decide calls share one in-flight call', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { h, calls } = decideSetup({ decide: async () => { await gate; return { text: JSON.stringify(EXTRACTED) }; } });
  await h.say('Builder, hi');
  const a = h.decide(); const b = h.decide();
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls.filter((x) => x.system === DECISIONS_SYSTEM).length, 1);
});

test('decide on an empty huddle makes no model call and returns empty lists; a failed call rejects and can be retried', async () => {
  const empty = decideSetup();
  assert.deepEqual(await empty.h.decide(), { problem: '', decisions: [], against: [], actions: [], open: [] });
  assert.equal(empty.calls.length, 0);
  let fail = true;
  const { h } = decideSetup({ decide: () => { if (fail) throw new Error('claude error: overloaded'); return { text: JSON.stringify(EXTRACTED) }; } });
  await h.say('Builder, hi');
  await assert.rejects(h.decide(), /overloaded/);
  fail = false;
  assert.deepEqual(await h.decide(), PARSED);
});

test('decide works after the huddle has ended', async () => {
  const { h } = decideSetup();
  await h.say('Builder, hi');
  await h.end();
  assert.deepEqual(await h.decide(), PARSED);
});

test('isWorkCommand: imperatives to turn the huddle into work, never a question or a longer sentence', async () => {
  const { isWorkCommand } = await import('../lib/huddle/decisions.js');
  for (const t of ['Make this work.', 'make it work', 'Okay, make this work now.', 'File that.', "Let's kick this off", 'turn this into cards', 'Go ahead and make it happen.', 'ship it to the board', 'Kick off the work.']) assert.equal(isWorkCommand(t), true, t);
  for (const t of ['does this work?', 'can you file that?', 'make this work better for the phone', 'I want to make this work', 'file that under later?', '', null]) assert.equal(isWorkCommand(t), false, String(t));
});

// Track C: the four-part record
test('DECISIONS_SYSTEM also asks for the problem statement and who argued against each decision', () => {
  for (const k of ['"problem"', '"against"']) assert.ok(DECISIONS_SYSTEM.includes(k), k);
});

test('parseDecisions: a decision may be a string or {text, against}; against rides parallel to decisions and problem is trimmed', () => {
  const r = parseDecisions(JSON.stringify({
    problem: '  Should voice ship first?  ',
    decisions: ['Plain one', { text: 'Ship on the desk', against: ' Red Team ' }, { text: '', against: 'x' }, { text: 'No dissent' }],
    actions: [], open: ['q'],
  }));
  assert.equal(r.problem, 'Should voice ship first?');
  assert.deepEqual(r.decisions, ['Plain one', 'Ship on the desk', 'No dissent']);
  assert.deepEqual(r.against, ['', 'Red Team', '']);
});

test('parseDecisions: garbage still yields the full four-part shape', () => {
  assert.deepEqual(parseDecisions('nope'), { problem: '', decisions: [], against: [], actions: [], open: [] });
});

test('decide on an empty huddle carries the four-part shape', async () => {
  const { h } = decideSetup();
  assert.deepEqual(await h.decide(), { problem: '', decisions: [], against: [], actions: [], open: [] });
});

test('parseAgenda: question and items with a lean, strings accepted, empties dropped, capped at 6; garbage is an empty agenda', async () => {
  const { parseAgenda, AGENDA_SYSTEM: SYS } = await import('../lib/huddle/decisions.js');
  assert.match(SYS, /JSON only/);
  const r = parseAgenda(JSON.stringify({ question: ' Q? ', items: ['plain', { text: 'with lean', lean: ' yes ' }, { text: '' }, ...Array.from({ length: 9 }, (_, i) => `i${i}`)] }));
  assert.equal(r.question, 'Q?');
  assert.deepEqual(r.items.slice(0, 2), [{ text: 'plain', lean: '' }, { text: 'with lean', lean: 'yes' }]);
  assert.equal(r.items.length, 6);
  assert.deepEqual(parseAgenda('nope'), { question: '', items: [] });
});
