// server/test/web-huddle-logic.test.js
// Pure state logic of the dock, run in node (no DOM), like web-alerts-logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUE_BY_ROLE, initialHuddleState, reduceHuddle, fileThatPayload, decisionsView, pickProject, expandAgendaAnswers, agendaView, recordView } from '../../web/shared/huddle.js';

const started = { type: 'huddle', huddleId: 'h1', event: 'started', personas: [
  { id: 'riker', display: 'Lead', role: 'orchestrator', icon: ':satellite:' },
  { id: 'bill', display: 'Builder', role: 'builder', icon: ':hammer:' },
  { id: 'gemini', display: 'Gemini', role: 'dissent', icon: ':gem:', seat: 'gemini' },
] };

test('every roster role, and the Gemini seat, has a hue token', () => {
  for (const role of ['orchestrator', 'builder', 'reviewer', 'scout', 'researcher', 'assistant', 'critic', 'dissent']) assert.match(HUE_BY_ROLE[role], /^var\(--/);
});

test('started seeds the roster with idle chips; speaker/partial/utterance move one chip through its states', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  assert.equal(s.huddleId, 'h1');
  assert.deepEqual(s.chips.map((c) => [c.id, c.state]), [['riker', 'idle'], ['bill', 'idle'], ['gemini', 'idle']]);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'speaker', speaker: 'bill', state: 'thinking' });
  assert.equal(s.chips[1].state, 'thinking');
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'partial', speaker: 'bill', text: 'Half a' });
  assert.equal(s.chips[1].state, 'speaking');
  assert.deepEqual(s.partial, { speaker: 'bill', text: 'Half a' });
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'utterance', speaker: 'bill', text: 'Half a line.', ts: 't', model: 'opus' });
  assert.equal(s.chips[1].state, 'idle');
  assert.equal(s.partial, null);
  assert.deepEqual(s.captions.at(-1), { speaker: 'bill', text: 'Half a line.', ts: 't', model: 'opus', truncated: false, error: false, pass: false });
});

test('a seat pass and an error line keep their flags; payloads for another huddle are ignored', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'other', event: 'utterance', speaker: 'bill', text: 'x', ts: 't' });
  assert.equal(s.captions.length, 0);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'utterance', speaker: 'gemini', text: 'pass', ts: 't', model: 'Gemini 3.8 Flash (High)', pass: true });
  assert.equal(s.captions[0].pass, true);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'utterance', speaker: 'gemini', text: '(Gemini could not answer: x)', ts: 't', model: 'Gemini 3.8 Flash (High)', error: true });
  assert.equal(s.captions[1].error, true);
});

test('ended stores the summary and a failed Slack post becomes a visible status line', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'ended', summary: 'We agreed.', summaryPost: { ok: false, error: 'Slack is not connected' } });
  assert.equal(s.ended, true);
  assert.equal(s.summary, 'We agreed.');
  assert.deepEqual(s.status, { text: 'Summary not posted to Slack: Slack is not connected', level: 'error' });
  const ok = reduceHuddle(reduceHuddle(initialHuddleState(), started), { type: 'huddle', huddleId: 'h1', event: 'ended', summary: 'x', summaryPost: { ok: true, error: null } });
  assert.deepEqual(ok.status, { text: 'Summary posted to Slack.', level: 'info' });
});

test('dock-local status messages (file that, start, send failures) land in state.status', () => {
  const s = reduceHuddle(initialHuddleState(), { type: 'huddle-local', event: 'status', text: 'Could not file it: request failed (500)', level: 'error' });
  assert.deepEqual(s.status, { text: 'Could not file it: request failed (500)', level: 'error' });
});

test('fileThatPayload turns the last operator line and the replies after it into a card', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  for (const u of [
    { speaker: 'operator', text: 'Old question?', ts: '1' }, { speaker: 'bill', text: 'Old answer.', ts: '2' },
    { speaker: 'operator', text: 'Should the dock slide in from the right instead of the bottom? I think so.', ts: '3' },
    { speaker: 'bill', text: 'Right is cheaper.', ts: '4' }, { speaker: 'gemini', text: 'Bottom is easier to reach on a phone.', ts: '5' },
  ]) s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'utterance', ...u });
  const p = fileThatPayload(s);
  assert.equal(p.title, 'Should the dock slide in from the right instead of the bottom? I think so.');
  assert.match(p.prompt, /^Operator: Should the dock slide in/);
  assert.match(p.prompt, /Builder: Right is cheaper\./);
  assert.match(p.prompt, /Gemini: Bottom is easier/);
  assert.match(p.prompt, /\(from huddle h1\)$/);
  assert.equal(p.origin.via, 'huddle');
  assert.equal(p.source, 'huddle', 'model-written text is filed with external trust, not as an operator post');
  assert.equal(fileThatPayload(initialHuddleState()), null);
});

test('the dock is registered once in DOCKS and its adapter imports without a DOM', async () => {
  const { DOCKS } = await import('../../web/shared/dock-list.js');
  const entry = DOCKS.find((d) => d.id === 'huddle');
  assert.ok(entry, 'DOCKS has the huddle entry');
  assert.equal(DOCKS.filter((d) => d.id === 'huddle').length, 1);
  const mod = await entry.load();
  assert.equal(typeof mod.mount, 'function');
});

test('mountHuddle returns a closer (static check: no DOM in node)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/shared/huddle.js', import.meta.url), 'utf8');
  assert.match(src, /export function mountHuddle\(rootEl\)/);
  assert.match(src, /return \{ close\(\)/);
});

test('an ending status (dock-local) is carried and cleared by the ended event', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  s = reduceHuddle(s, { type: 'huddle-local', event: 'ending' });
  assert.equal(s.ending, true);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'ended', summary: 'x', summaryPost: null });
  assert.equal(s.ending, false);
  assert.equal(s.ended, true);
});

test('a started frame for a different huddle never takes over a live dock (I1)', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'utterance', speaker: 'bill', text: 'mine', ts: 't' });
  const foreign = reduceHuddle(s, { ...started, huddleId: 'h2' });
  assert.equal(foreign, s, 'state is returned unchanged');
  const again = reduceHuddle(s, started);
  assert.equal(again, s, 'a repeat of our own started does not reset the captions');
  const ended = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'ended', summary: 'x', summaryPost: null });
  assert.equal(reduceHuddle(ended, { ...started, huddleId: 'h3' }).huddleId, 'h3', 'a finished huddle can be replaced by a new start');
});

test('the dock source applies started only from its own start response and guards double starts (I1, I2, I3, M1)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/shared/huddle.js', import.meta.url), 'utf8');
  assert.match(src, /let starting = false/);
  assert.match(src, /finally \{ starting = false/);
  // The launcher's double-start guard: a live huddle or a start in flight only toggles the panel.
  assert.match(src, /if \(state\.huddleId \|\| starting\)/, 'the launcher guards on a live huddle or a start in flight');
  const setStarting = src.indexOf('starting = true');
  const startCall = src.indexOf("postJson('/api/huddle'");
  assert.ok(setStarting !== -1 && startCall !== -1, 'both the starting flag and the start call are present');
  assert.ok(setStarting < startCall, 'starting is set before the start request goes out');
  // The stream path forwards every huddle frame except started.
  assert.match(src, /payload\?\.type === 'huddle' && payload\.event !== 'started'\) apply\(payload\)/, 'the stream path must not forward started');
  // The live region is emptied only when the huddle changes, never per frame.
  assert.equal(src.split("log.textContent = ''").length - 1, 1, 'the live region is emptied in exactly one place');
  assert.match(src, /if \(state\.huddleId !== renderedHuddle \|\| state\.captions\.length < renderedLines\) \{\s*log\.textContent = '';/, 'and only inside the huddle-change branch');
  const css = fs.readFileSync(new URL('../../web/shared/huddle.css', import.meta.url), 'utf8');
  assert.match(css, /\.huddle-status \{[^}]*color: var\(--fg\)/);
  assert.match(css, /\.huddle-model \{[^}]*color: var\(--fg\)/);
});

test('a huddle status frame (a warm-up failure behind a failed turn) lands in state.status; another huddle\'s does not', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'other', event: 'status', text: 'x', level: 'error' });
  assert.equal(s.status, null);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'status', text: 'Builder could not warm up earlier: boom', level: 'error' });
  assert.deepEqual(s.status, { text: 'Builder could not warm up earlier: boom', level: 'error' });
});

test('a speaker frame with state idle returns the chip to idle (an aborted seat call)', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'speaker', speaker: 'gemini', state: 'thinking' });
  assert.equal(s.chips[2].state, 'thinking');
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'speaker', speaker: 'gemini', state: 'idle' });
  assert.equal(s.chips[2].state, 'idle');
  assert.equal(s.captions.length, 0, 'no caption for a dropped call');
});

test('the ending status matches the 10 s seat grace, not two minutes', () => {
  const s = reduceHuddle(reduceHuddle(initialHuddleState(), started), { type: 'huddle-local', event: 'ending' });
  assert.doesNotMatch(s.status.text, /two minutes/);
  assert.match(s.status.text, /10 seconds/);
});

const dec = { type: 'huddle', huddleId: 'h1', event: 'decisions', decisions: ['Ship the dock first'], actions: [{ title: 'Add Decide button', detail: 'Calls /decide.' }, { title: 'Wire kickoff', detail: 'Posts /kickoff.' }], open: ['Phone TLS?'] };

test('a decisions frame populates extracted; another huddle frame is ignored', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  assert.equal(s.extracted, null);
  assert.equal(s.deciding, false);
  assert.equal(s.kickoff, null);
  s = reduceHuddle(s, { ...dec, huddleId: 'other' });
  assert.equal(s.extracted, null);
  s = reduceHuddle(s, dec);
  assert.deepEqual(s.extracted, { problem: '', against: [], decisions: dec.decisions, actions: dec.actions, open: dec.open });
});

test('deciding is a dock-local flag and a decisions frame clears it', () => {
  let s = reduceHuddle(reduceHuddle(initialHuddleState(), started), { type: 'huddle-local', event: 'deciding', on: true });
  assert.equal(s.deciding, true);
  s = reduceHuddle(s, dec);
  assert.equal(s.deciding, false);
  s = reduceHuddle(s, { type: 'huddle-local', event: 'deciding', on: true });
  s = reduceHuddle(s, { type: 'huddle-local', event: 'deciding', on: false });
  assert.equal(s.deciding, false);
});

test('decisionsView indexes actions and gates the two kick-off buttons', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  assert.deepEqual(decisionsView(s), { decisions: [], actions: [], open: [], canPlan: false, canQueue: false });
  s = reduceHuddle(s, dec);
  const v = decisionsView(s);
  assert.deepEqual(v.actions, [{ i: 0, title: 'Add Decide button', detail: 'Calls /decide.' }, { i: 1, title: 'Wire kickoff', detail: 'Posts /kickoff.' }]);
  assert.equal(v.canPlan, true);
  assert.equal(v.canQueue, true);
  const none = reduceHuddle(reduceHuddle(initialHuddleState(), started), { ...dec, actions: [] });
  assert.equal(decisionsView(none).canQueue, false);
  assert.equal(decisionsView(none).canPlan, true);
  const empty = reduceHuddle(reduceHuddle(initialHuddleState(), started), { ...dec, decisions: [], actions: [] });
  assert.equal(decisionsView(empty).canPlan, false);
});

test('a kickoff-local event stores the filed cards and the repeat flag', () => {
  let s = reduceHuddle(reduceHuddle(initialHuddleState(), started), dec);
  s = reduceHuddle(s, { type: 'huddle-local', event: 'kickoff', cards: [{ id: 'glmps-x-1', title: 't', state: 'queued' }], repeat: true });
  assert.deepEqual(s.kickoff, { cards: [{ id: 'glmps-x-1', title: 't', state: 'queued' }], repeat: true });
});

test('seat personas keep their model and the agy seat chip flag', () => {
  const s = reduceHuddle(initialHuddleState(), { ...started, personas: [{ id: 'homer', display: 'Researcher', role: 'researcher', seat: 'agy', model: 'Gemini 3.8 Flash (Medium)', voice: { pitch: 1, rate: 0.95 } }] });
  assert.equal(s.chips[0].seat, 'agy');
  assert.deepEqual(s.chips[0].voice, { pitch: 1, rate: 0.95 });
});

test('pickProject: the remembered project if it still exists, else glmps, else the first, else none', () => {
  const ps = [{ name: 'delta-terminal' }, { name: 'glmps' }, { name: 'glmps-2.0' }];
  assert.equal(pickProject(ps, 'glmps-2.0'), 'glmps-2.0');
  assert.equal(pickProject(ps, 'gone'), 'glmps');
  assert.equal(pickProject([{ name: 'a' }, { name: 'b' }], null), 'a');
  assert.equal(pickProject([], 'x'), '');
});

// Track C: typed answers to the agenda, mute, agenda and record state
const AG = { question: 'Ship voice first?', items: [{ text: 'TLS on the phone?', lean: 'Yes' }, { text: 'Keep push-to-talk?', lean: '' }, { text: 'Which model?', lean: 'opus' }] };

test('expandAgendaAnswers turns "1 yes, 2 b" into a sentence that names each question; anything else is left alone', () => {
  const out = expandAgendaAnswers('1 yes, 2 b', AG);
  assert.deepEqual(out.answered, [0, 1]);
  assert.equal(out.text, 'Answering the open questions. 1 (TLS on the phone?): yes. 2 (Keep push-to-talk?): b.');
  assert.deepEqual(expandAgendaAnswers('3. opus; 1 no', AG).answered, [2, 0]);
  for (const t of ['I think 1 yes is right', '4 yes', '0 yes', '1', 'ship it', '1 yes, then we ship', '']) assert.equal(expandAgendaAnswers(t, AG), null, t);
  assert.equal(expandAgendaAnswers('1 yes', { question: '', items: [] }), null, 'no agenda, no interception');
  assert.equal(expandAgendaAnswers('1 yes', null), null);
});

test('agenda and muted frames land in state; a new agenda clears the answered marks; a new huddle clears both', () => {
  let s = reduceHuddle(initialHuddleState(), started);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'agenda', ...AG });
  assert.deepEqual(s.agenda, AG);
  s = reduceHuddle(s, { type: 'huddle-local', event: 'answered', indexes: [0] });
  assert.deepEqual(agendaView(s).items.map((i) => [i.n, i.answered]), [[1, true], [2, false], [3, false]]);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'agenda', ...AG });
  assert.deepEqual(s.answered, []);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'muted', muted: ['bill'] });
  assert.deepEqual(s.muted, ['bill']);
  assert.deepEqual(s.chips.find((c) => c.id === 'bill').muted, true);
  assert.equal(s.chips.find((c) => c.id === 'riker').muted, false);
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'other', event: 'muted', muted: [] });
  assert.deepEqual(s.muted, ['bill'], 'another huddle is ignored');
  const fresh = reduceHuddle(reduceHuddle({ ...s, ended: true }, { type: 'huddle', huddleId: 'h2', event: 'started', personas: [] }), { type: 'huddle', huddleId: 'h2', event: 'agenda', ...AG });
  assert.deepEqual(fresh.muted, []);
});

test('agendaView is empty without an agenda and flags a question with nothing open', () => {
  const v = agendaView(reduceHuddle(initialHuddleState(), started));
  assert.deepEqual(v, { question: '', items: [], empty: true });
});

test('a record-local event stores the saved four-part record and recordView lays it out; saving is a local flag', () => {
  let s = reduceHuddle(reduceHuddle(initialHuddleState(), started), { type: 'huddle-local', event: 'saving', on: true });
  assert.equal(s.saving, true);
  const record = { id: 'h1', problem: 'P?', decisions: [{ text: 'D1', against: 'Red Team' }, { text: 'D2', against: '' }], open: ['O1'], actions: [{ title: 'A1', detail: 'd' }] };
  s = reduceHuddle(s, { type: 'huddle-local', event: 'record', record });
  assert.equal(s.saving, false);
  const v = recordView(s);
  assert.equal(v.problem, 'P?');
  assert.deepEqual(v.decisions, [{ text: 'D1', against: 'Red Team' }, { text: 'D2', against: '' }]);
  assert.deepEqual(v.open, ['O1']);
  assert.deepEqual(v.actions, [{ title: 'A1', detail: 'd' }]);
  assert.equal(v.canFile, true);
  assert.equal(recordView(initialHuddleState()), null);
  assert.equal(recordView(reduceHuddle(reduceHuddle(initialHuddleState(), started), { type: 'huddle-local', event: 'record', record: { ...record, decisions: [], actions: [] } })).canFile, false);
});

test('an outside-material utterance keeps its label on the caption; ordinary ones gain no keys', () => {
  let s = reduceHuddle(initialHuddleState(), { type: 'huddle', huddleId: 'h1', event: 'started', personas: [{ id: 'howard', role: 'researcher', display: 'Howard' }] });
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'utterance', speaker: 'howard', text: 'X does Y.', ts: 't', model: 'sonnet', outside: true, label: 'From the web, unverified', via: 'research' });
  assert.equal(s.captions[0].outside, true);
  assert.equal(s.captions[0].label, 'From the web, unverified');
  s = reduceHuddle(s, { type: 'huddle', huddleId: 'h1', event: 'utterance', speaker: 'howard', text: 'On it.', ts: 't', model: null });
  assert.ok(!('outside' in s.captions[1]));
});
