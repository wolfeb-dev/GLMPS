import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBrief, BRIEF_MAX } from '../lib/huddle/brief.js';
import { mindSystemPrompt } from '../lib/huddle/roster.js';
import { seatPrompt } from '../lib/huddle/agy-seat.js';
import { createHuddle } from '../lib/huddle/session.js';

const GLOSSARY = JSON.parse(fs.readFileSync(new URL('../../docs/wiki/glossary.json', import.meta.url), 'utf8'));
const card = (title, state, project = 'glmps-2.0', updatedAt = '2026-10-24T00:00:00Z') => ({ title, state, project, updatedAt });

test('buildBrief names the system, the huddle\'s own features, the active cards and the glossary, under the cap', () => {
  const b = buildBrief({ glossary: GLOSSARY, cards: [card('Ship the dock', 'in_progress'), card('Old work', 'done'), card('Next thing', 'queued'), card('Other repo', 'queued', 'tidewatch')], projects: ['glmps-2.0'] });
  assert.ok(b.length <= BRIEF_MAX, `${b.length} chars`);
  assert.match(b, /GLMPS 2\.0 is the operator's own local system/);
  assert.match(b, /neural voices on the operator's GPU and local speech recognition with barge-in/, 'the minds know the dock already speaks');
  assert.match(b, /- in progress: Ship the dock\n- queued: Next thing/);
  assert.doesNotMatch(b, /Old work|Other repo/);
  assert.match(b, /card: One unit of work/);
});

test('buildBrief drops glossary terms before cards when over the cap, and tolerates missing inputs', () => {
  const many = Array.from({ length: 8 }, (_, i) => card(`Card ${i} ${'x'.repeat(80)}`, 'in_progress'));
  const b = buildBrief({ glossary: GLOSSARY, cards: many, maxChars: 1500 });
  assert.ok(b.length <= 1500);
  assert.match(b, /Card 7/);
  assert.match(buildBrief(), /GLMPS 2\.0 is/);
  assert.match(buildBrief({ glossary: { terms: [{ term: 'x' }] }, cards: null }), /GLMPS 2\.0 is/);
});

test('the brief rides every mind prompt and the agy seat prompt, and is absent when empty', () => {
  const persona = { display: 'Builder', role: 'builder', definition: 'Build.', personality: null };
  assert.match(mindSystemPrompt(persona, 'BRIEF TEXT'), /Answer from this before guessing[\s\S]*BRIEF TEXT[\s\S]*Your standing brief/);
  assert.doesNotMatch(mindSystemPrompt(persona), /before guessing/);
  const seat = { display: 'Researcher', role: 'researcher', personality: 'Warm.', model: 'Gemini 3.8 Flash (Medium)' };
  assert.match(seatPrompt({ persona: seat, transcriptText: 'Operator: q', mode: 'second', brief: 'BRIEF TEXT' }), /answer from this before guessing\):\nBRIEF TEXT/);
});

test('createHuddle hands its brief to the minds it calls, the warm targets and the seats', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-'));
  const systems = [];
  const stream = async ({ body }) => { systems.push(body.system); return { text: 'One. Two.', ttftMs: 1, totalMs: 2 }; };
  const asked = [];
  const seatPersona = { id: 'homer', lead: false, seat: 'agy', display: 'Researcher', role: 'researcher', aliases: ['homer'], model: 'Gemini 3.8 Flash (Medium)' };
  const personas = [
    { id: 'riker', lead: true, display: 'Lead', role: 'orchestrator', aliases: ['riker'] },
    { id: 'bill', lead: false, display: 'Builder', role: 'builder', aliases: ['bill'], definition: null },
    seatPersona,
  ];
  const seat = { persona: seatPersona, model: seatPersona.model, respond: async (a) => { asked.push(a); return { text: 'pass', pass: true }; } };
  const h = createHuddle({ personas, stateDir, models: { floor: 'haiku', mind: 'opus', maxTokens: 160 }, stream, broadcast: () => {}, seats: [seat], brief: 'BRIEF TEXT', id: 'hb' });
  await h.say('Bill, what should we build first this week?');
  await h.idle();
  assert.match(systems.at(-1), /BRIEF TEXT/);
  assert.match(h.warmTargets()[1].system, /BRIEF TEXT/);
  assert.equal(asked[0].brief, 'BRIEF TEXT');
});
