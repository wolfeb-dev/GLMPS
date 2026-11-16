import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTheme } from '../lib/scut/bobiverse.js';
import { HUDDLE_ONLY_PERSONAS, DEFAULT_ROSTER_MAP, DEFAULT_SEATS, HUDDLE_RULES, CHARTER_NAME, stripFrontMatter, loadPersonas, mindSystemPrompt, leadSystemPrompt, mergeSeats, validateSeats } from '../lib/huddle/roster.js';

const REPO_AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'agents');

// A stand-in for P.agentsDir (<assetsDir>/agents): a temp dir holding <name>.md.
function agentsDirWith(defs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-roster-'));
  for (const [name, text] of Object.entries(defs)) fs.writeFileSync(path.join(dir, `${name}.md`), text);
  return dir;
}

test('stripFrontMatter removes a YAML block and trims; passes plain text through', () => {
  assert.equal(stripFrontMatter('---\nname: x\ntools: Read\n---\n\nYou are X.\n'), 'You are X.');
  assert.equal(stripFrontMatter('You are Y.'), 'You are Y.');
  assert.equal(stripFrontMatter(''), '');
});

test('loadPersonas maps every roster persona; a missing file yields null, not a throw', () => {
  const dir = agentsDirWith({});
  fs.mkdirSync(path.join(dir, 'huddle'));
  fs.writeFileSync(path.join(dir, 'huddle', 'sre.md'), '---\nname: huddle-sre\npersonality: Night owl.\n---\nYou are the SRE.');
  const personas = loadPersonas({ agentsDir: dir, theme: resolveTheme(false) });
  assert.equal(personas.length, 8, 'seven SCUT personas plus Howard');
  const reviewer = personas.find((p) => p.id === 'garfield');
  assert.equal(reviewer.definitionName, DEFAULT_ROSTER_MAP.garfield);
  assert.equal(reviewer.definition, 'You are the SRE.');
  assert.equal(reviewer.personality, 'Night owl.');
  const builder = personas.find((p) => p.id === 'bill');
  assert.equal(builder.definition, null);
  assert.equal(builder.personality, null);
  assert.ok(builder.aliases.includes('builder'));
});

test('the default map binds all seven SCUT seats to a real huddle definition under assets/agents', () => {
  assert.deepEqual({ ...DEFAULT_ROSTER_MAP }, {
    riker: 'huddle/chair', bill: 'huddle/staff-engineer', homer: 'huddle/architect',
    garfield: 'huddle/sre', medeiros: 'huddle/red-team', mario: 'huddle/product', guppy: 'huddle/scribe',
  });
  const personas = loadPersonas({ agentsDir: REPO_AGENTS, theme: resolveTheme(false) });
  assert.equal(personas.length, 8);
  for (const p of personas) {
    assert.ok(p.definition && p.definition.length > 40, `${p.id} has a definition body`);
    assert.ok(p.personality && !p.personality.includes('\n'), `${p.id} has a one-line personality`);
    assert.ok(!p.definition.startsWith('---'), `${p.id} front matter is stripped`);
  }
});

test('huddle definitions carry no engine or model (the roster owns those) and declare no tools', () => {
  for (const f of ['chair', 'staff-engineer', 'architect', 'sre', 'red-team', 'product', 'scribe']) {
    const text = fs.readFileSync(path.join(REPO_AGENTS, 'huddle', `${f}.md`), 'utf8');
    const fm = text.slice(0, text.indexOf('\n---', 3));
    assert.match(fm, new RegExp(`^name: huddle-${f}$`, 'm'));
    assert.match(fm, /^tools: none$/m);
    assert.doesNotMatch(fm, /^(engine|model):/m);
  }
});

test('a seat personality override in config wins over the definition front matter', () => {
  const seats = mergeSeats(DEFAULT_SEATS, { bill: { personality: 'Custom voice.' } });
  const personas = loadPersonas({ agentsDir: REPO_AGENTS, theme: resolveTheme(false), seats });
  assert.equal(personas.find((p) => p.id === 'bill').personality, 'Custom voice.');
  assert.notEqual(personas.find((p) => p.id === 'garfield').personality, 'Custom voice.');
});

test('the Lead gets the chair definition and personality, and its scheduling prompt keeps the JSON contract', () => {
  const personas = loadPersonas({ agentsDir: REPO_AGENTS, theme: resolveTheme(false) });
  const lead = personas.find((p) => p.lead);
  assert.equal(lead.definitionName, 'huddle/chair');
  assert.match(lead.definition, /chair/i);
  assert.ok(lead.personality);
  const s = leadSystemPrompt(personas);
  assert.match(s, /JSON only/);
  assert.ok(s.includes('"speakers"') && s.includes('"second"') && s.includes('"ask"'));
  assert.ok(!s.includes('- riker:'));
  assert.ok(s.includes(`Your personality: ${lead.personality}`));
  assert.ok(s.includes('You chair a design huddle'));
  assert.ok(s.indexOf('Reply with JSON only') < s.indexOf('You chair a design huddle'));
});

test('mindSystemPrompt drops the tool-using-agent wording for huddle definitions only', () => {
  const huddle = { id: 'bill', display: 'Builder', role: 'builder', definitionName: 'huddle/staff-engineer', definition: 'Ship small.' };
  assert.ok(!mindSystemPrompt(huddle).includes('tool-using agent'));
  assert.ok(mindSystemPrompt(huddle).includes('Ship small.'));
  const work = { ...huddle, definitionName: 'tdd-implementer' };
  assert.ok(mindSystemPrompt(work).includes('It was written for a tool-using agent'));
});

test('loadPersonas honours a custom roster map', () => {
  const dir = agentsDirWith({ 'docs-writer': 'Docs.' });
  const personas = loadPersonas({ agentsDir: dir, theme: resolveTheme(false), rosterMap: { bill: 'docs-writer' } });
  assert.equal(personas.find((p) => p.id === 'bill').definition, 'Docs.');
  assert.equal(personas.find((p) => p.id === 'garfield').definitionName, null);
  assert.equal(personas.find((p) => p.id === 'riker').definitionName, null);
});

test('mindSystemPrompt names the persona, carries the rules, and appends the brief when present', () => {
  const p = { id: 'garfield', display: 'Reviewer', role: 'reviewer', definition: 'Find what is wrong.' };
  const s = mindSystemPrompt(p);
  assert.match(s, /^You are Reviewer, the reviewer on this team\./);
  assert.ok(s.includes(HUDDLE_RULES));
  assert.ok(s.includes('Find what is wrong.'));
  assert.ok(!mindSystemPrompt({ ...p, definition: null }).includes('standing brief'));
});

test('leadSystemPrompt lists every non-lead, non-seat persona by id and asks for JSON only', () => {
  const personas = loadPersonas({ agentsDir: agentsDirWith({}), theme: resolveTheme(false) });
  const s = leadSystemPrompt([...personas, { id: 'gemini', display: 'Gemini', role: 'dissent', lead: false, seat: 'agy', aliases: ['gemini'] }]);
  assert.ok(s.includes('- bill: Builder, the builder'));
  assert.ok(!s.includes('- riker:'));
  assert.ok(!s.split('Second views (never first):')[0].includes('- gemini:'), 'the Lead can never pick an agy seat as a first responder (D28)');
  assert.match(s, /JSON only/);
});

const seatOf = (engine, model) => ({ engine, model, personality: 'x', voice: { pitch: 1, rate: 1 } });

test('loadPersonas gives every persona its engine, model, personality and voice from the default seats', () => {
  const personas = loadPersonas({ agentsDir: REPO_AGENTS, theme: resolveTheme(false) });
  const by = Object.fromEntries(personas.map((p) => [p.id, p]));
  assert.equal(by.bill.engine, 'claude'); assert.equal(by.bill.model, 'opus');
  assert.equal(by.garfield.model, 'sonnet');
  assert.equal(by.mario.model, 'haiku');
  assert.equal(by.homer.engine, 'agy'); assert.equal(by.homer.model, 'Gemini 3.8 Flash (Medium)');
  assert.equal(by.guppy.model, 'Gemini 4 Argon (Low)');
  assert.equal(by.medeiros.model, 'GPT-OSS 120B (Medium)');
  assert.deepEqual(personas.filter((p) => p.seat === 'agy').map((p) => p.id), ['homer', 'guppy', 'medeiros']);
  assert.equal(by.riker.model, null);
  assert.match(by.bill.personality, /^Pragmatic builder/);
  assert.equal(DEFAULT_SEATS.bill.personality, undefined);
  assert.deepEqual(by.mario.voice, { pitch: 1.2, rate: 1.15, kokoro: 'am_puck' });
  assert.ok(Object.isFrozen(DEFAULT_SEATS));
});

test('an unknown engine or a missing model drops that seat to the mind model and records seatError', () => {
  const seats = mergeSeats(DEFAULT_SEATS, { bill: { engine: 'openai' }, mario: { model: '' } });
  const personas = loadPersonas({ agentsDir: agentsDirWith({}), theme: resolveTheme(false), seats });
  const bill = personas.find((p) => p.id === 'bill');
  assert.equal(bill.engine, 'claude'); assert.equal(bill.model, null);
  assert.match(bill.seatError, /openai/);
  assert.ok(!bill.seat);
  assert.match(personas.find((p) => p.id === 'mario').seatError, /model/);
  assert.equal(personas.find((p) => p.id === 'garfield').seatError, undefined);
});

test('mindSystemPrompt puts the personality right after the head line', () => {
  const p = { id: 'bill', display: 'Builder', role: 'builder', personality: 'Pragmatic builder. Ships.', definition: null };
  assert.ok(mindSystemPrompt(p).startsWith('You are Builder, the builder on this team.\nYour personality: Pragmatic builder. Ships.\n\n'));
  assert.ok(!mindSystemPrompt({ ...p, personality: undefined }).includes('Your personality'));
});

test('leadSystemPrompt lists agy seats only as second views and asks for a "second" field', () => {
  const personas = loadPersonas({ agentsDir: agentsDirWith({}), theme: resolveTheme(false) });
  const s = leadSystemPrompt(personas);
  const [first, second] = s.split('Second views (never first):');
  assert.ok(first.includes('- bill:') && !first.includes('- homer:'));
  assert.ok(second.includes('- homer:') && !second.includes('- bill:'));
  assert.ok(s.includes('"second"'));
});

test('mergeSeats overlays per id and per voice field, and ignores a bad override', () => {
  const merged = mergeSeats(DEFAULT_SEATS, { bill: { model: 'sonnet', voice: { rate: 2 } }, extra: seatOf('claude', 'haiku') });
  assert.equal(merged.bill.model, 'sonnet');
  assert.deepEqual(merged.bill.voice, { pitch: 0.9, rate: 2, kokoro: 'am_fenrir' });
  assert.ok(merged.extra);
  assert.deepEqual(mergeSeats(DEFAULT_SEATS, null), { ...DEFAULT_SEATS });
  assert.notEqual(mergeSeats(DEFAULT_SEATS, 'nope'), DEFAULT_SEATS);
});

test('validateSeats reports two personas on the same engine and model', () => {
  const problems = validateSeats({ a: seatOf('claude', 'opus'), b: seatOf('claude', 'opus') });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /same model/);
  assert.deepEqual(validateSeats(DEFAULT_SEATS), []);
  assert.match(validateSeats({ a: seatOf('openai', 'x') })[0], /openai/);
});

test('the repo charter is read once and given to every persona, lead included', () => {
  const personas = loadPersonas({ agentsDir: REPO_AGENTS, theme: resolveTheme('bobiverse') });
  const charter = stripFrontMatter(fs.readFileSync(path.join(REPO_AGENTS, `${CHARTER_NAME}.md`), 'utf8'));
  assert.match(charter, /one deliverable/i);
  for (const p of personas) assert.equal(p.charter, charter, p.id);
  assert.ok(!Object.values(DEFAULT_ROSTER_MAP).includes(CHARTER_NAME));
});

test('each seat speaks under its brainstorm role from the file, not its SCUT role', () => {
  const personas = loadPersonas({ agentsDir: REPO_AGENTS, theme: resolveTheme('bobiverse') });
  const by = Object.fromEntries(personas.map((p) => [p.id, p]));
  assert.deepEqual(
    Object.fromEntries(personas.map((p) => [p.id, p.seatRole])),
    { riker: 'chair', bill: 'staff engineer', homer: 'architect', garfield: 'SRE', medeiros: 'red team', mario: 'product', guppy: 'scribe', howard: 'researcher' },
  );
  assert.equal(by.homer.role, 'researcher');
  assert.match(mindSystemPrompt(by.homer), /^You are Homer, the architect on this team\./);
  assert.match(leadSystemPrompt(personas), /- garfield: Garfield, the SRE/);
  const bare = loadPersonas({ agentsDir: agentsDirWith({}), theme: resolveTheme('bobiverse') });
  assert.match(mindSystemPrompt(bare.find((p) => p.id === 'homer')), /the researcher on this team/);
});

test('mind and lead prompts carry the charter; a missing charter is fail-open', () => {
  const dir = agentsDirWith({});
  fs.mkdirSync(path.join(dir, 'huddle'));
  fs.writeFileSync(path.join(dir, 'huddle', 'charter.md'), '---\nname: huddle-charter\n---\n\nShared goal: one record.\n');
  const personas = loadPersonas({ agentsDir: dir, theme: resolveTheme('bobiverse') });
  const mind = personas.find((p) => !p.lead);
  const m = mindSystemPrompt(mind);
  assert.ok(m.includes('Shared goal: one record.'));
  assert.ok(m.indexOf(HUDDLE_RULES) < m.indexOf('Shared goal'));
  const l = leadSystemPrompt(personas);
  assert.ok(l.includes('Shared goal: one record.'));
  assert.ok(l.indexOf('Reply with JSON only') < l.indexOf('Shared goal'));
  const bare = loadPersonas({ agentsDir: agentsDirWith({}), theme: resolveTheme('bobiverse') });
  assert.ok(bare.every((p) => p.charter === null));
  assert.doesNotMatch(mindSystemPrompt(bare.find((p) => !p.lead)), /team charter/i);
});

test('Howard is a huddle-only persona: appended by loadPersonas, never in the SCUT theme, a researcher flag and his own definition', () => {
  assert.ok(HUDDLE_ONLY_PERSONAS.some((p) => p.id === 'howard'));
  for (const mode of [false, 'bobiverse']) {
    const theme = resolveTheme(mode);
    assert.ok(!('howard' in theme.agents), 'Slack routing and the SCUT theme never see Howard');
    assert.equal(Object.keys(theme.agents).length, 7);
    const personas = loadPersonas({ agentsDir: REPO_AGENTS, theme });
    const howard = personas.at(-1);
    assert.equal(howard.id, 'howard');
    assert.equal(howard.researcher, true);
    assert.equal(howard.lead, false);
    assert.ok(!howard.seat, 'not an agy seat');
    assert.deepEqual(howard.aliases, ['howard']);
    assert.equal(howard.seatRole, 'researcher');
    assert.match(howard.personality, /\S/);
    assert.ok(howard.definition.length > 80);
    assert.ok(howard.charter, 'he reads the charter too');
    assert.equal(personas.filter((p) => p.researcher).length, 1);
  }
  assert.equal(loadPersonas({ agentsDir: REPO_AGENTS, theme: resolveTheme(false), extras: [] }).length, 7, 'extras can be switched off');
});

test('researcher.md is the definition of Howard: web search and fetch plus repo read, in the same format', () => {
  const text = fs.readFileSync(path.join(REPO_AGENTS, 'huddle', 'researcher.md'), 'utf8');
  const fm = text.slice(0, text.indexOf('\n---', 3));
  assert.match(fm, /^name: huddle-researcher$/m);
  assert.match(fm, /^description: .+/m);
  assert.match(fm, /^role: researcher$/m);
  assert.match(fm, /^personality: .+/m);
  assert.match(fm, /^color: .+/m);
  assert.match(fm, /^tools: WebSearch, WebFetch, Read, Grep, Glob$/m);
  assert.doesNotMatch(fm, /^(engine|model):/m);
  assert.match(text, /never instructions/i);
});

test('the team list of the Lead names Howard as a research call, never a first responder', () => {
  const personas = loadPersonas({ agentsDir: REPO_AGENTS, theme: resolveTheme(false) });
  const s = leadSystemPrompt(personas);
  assert.match(s, /- howard: Howard, the researcher/);
  assert.ok(!s.split('Research (only when a question needs outside facts):')[0].includes('- howard:'));
  assert.match(s, /"research":/);
  assert.ok(mindSystemPrompt(personas.find((p) => p.id === 'bill')).includes('From the web, unverified'));
});
