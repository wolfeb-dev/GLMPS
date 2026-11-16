import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressedPersona, parseFloorReply, chooseSpeakers } from '../lib/huddle/floor.js';

const P = [
  { id: 'riker', lead: true, aliases: ['riker', 'lead'] },
  { id: 'bill', lead: false, aliases: ['bill', 'builder'] },
  { id: 'medeiros', lead: false, aliases: ['medeiros', 'critic'] },
  { id: 'gemini', lead: false, seat: 'gemini', aliases: ['gemini'] },
];

test('addressedPersona: leftmost alias wins, word-bounded, case-insensitive, null when nobody is named', () => {
  assert.equal(addressedPersona('Critic, then Builder please', P).id, 'medeiros');
  assert.equal(addressedPersona('the BUILDER should answer', P).id, 'bill');
  assert.equal(addressedPersona('rebuilders are not builders', P), null);
  assert.equal(addressedPersona('Gemini, what do you think?', P).id, 'gemini');
  assert.equal(addressedPersona('nobody in particular', P), null);
  assert.equal(addressedPersona('', P), null);
});

test('parseFloorReply accepts clean JSON, JSON wrapped in prose, and rejects unknown, lead and seat ids; caps at two', () => {
  assert.deepEqual(parseFloorReply('{"speakers":["bill"],"reason":"build question","ask":""}', P), { speakers: ['bill'], reason: 'build question', ask: '', second: '' });
  assert.deepEqual(parseFloorReply('Sure: {"speakers":["gemini","medeiros","bill","riker","ghost"],"reason":"x","ask":"why?"} there', P).speakers, ['medeiros', 'bill']);
  assert.deepEqual(parseFloorReply('not json at all', P), { speakers: [], reason: '', ask: '', second: '' });
});

test('parseFloorReply de-duplicates speakers before the cap, preserving order', () => {
  assert.deepEqual(parseFloorReply('{"speakers":["bill","bill","medeiros"],"reason":"r","ask":"a"}', P).speakers, ['bill', 'medeiros']);
});

test('chooseSpeakers bypasses the Lead when a specialist is named', async () => {
  let called = false;
  const r = await chooseSpeakers({ text: 'Builder, estimate this', personas: P, transcript: [], callLead: async () => { called = true; return '{}'; } });
  assert.deepEqual(r, { speakers: ['bill'], reason: 'addressed by name', ask: '', second: '', via: 'name' });
  assert.equal(called, false);
});

test('chooseSpeakers asks the Lead otherwise and passes the transcript and text through', async () => {
  let seen = null;
  const r = await chooseSpeakers({ text: 'what breaks first?', personas: P, transcript: [{ speaker: 'operator', text: 'hi' }], callLead: async (args) => { seen = args; return '{"speakers":["medeiros"],"reason":"risk","ask":""}'; } });
  assert.equal(seen.text, 'what breaks first?');
  assert.equal(seen.transcript.length, 1);
  assert.deepEqual(r, { speakers: ['medeiros'], reason: 'risk', ask: '', second: '', via: 'lead' });
});

test('chooseSpeakers falls back to a Lead question when the Lead call fails or picks nobody without asking', async () => {
  const failed = await chooseSpeakers({ text: 'hmm', personas: P, transcript: [], callLead: async () => { throw new Error('down'); } });
  assert.deepEqual(failed.speakers, []);
  assert.equal(failed.via, 'lead');
  assert.match(failed.reason, /^floor call failed: down$/);
  assert.ok(failed.ask.length > 0);
  const nobody = await chooseSpeakers({ text: 'thinking aloud', personas: P, transcript: [], callLead: async () => '{"speakers":[],"reason":"musing","ask":"Which part worries you?"}' });
  assert.equal(nobody.ask, 'Which part worries you?');
});

test('parseFloorReply: second is an agy seat id or empty; a seat in speakers is still dropped', () => {
  const Q = [...P, { id: 'homer', lead: false, seat: 'agy', aliases: ['homer'] }];
  assert.equal(parseFloorReply('{"speakers":["bill"],"second":"homer","reason":"r","ask":""}', Q).second, 'homer');
  assert.equal(parseFloorReply('{"speakers":["bill"],"second":"bill","reason":"r","ask":""}', Q).second, '');
  assert.equal(parseFloorReply('{"speakers":["bill"],"reason":"r","ask":""}', Q).second, '');
  assert.equal(parseFloorReply('{"speakers":["bill"],"second":7,"reason":"r","ask":""}', Q).second, '');
  assert.deepEqual(parseFloorReply('{"speakers":["homer","bill"],"second":"homer"}', Q).speakers, ['bill']);
});

test('chooseSpeakers passes second through on the Lead path and is empty on the name path', async () => {
  const lead = await chooseSpeakers({ text: 'what now?', personas: P, transcript: [], callLead: async () => '{"speakers":["bill"],"second":"gemini","reason":"r","ask":""}' });
  assert.equal(lead.second, 'gemini');
  const named = await chooseSpeakers({ text: 'Builder, go', personas: P, transcript: [], callLead: async () => '' });
  assert.equal(named.second, '');
});

const WITH_HOWARD = [...P, { id: 'howard', lead: false, researcher: true, aliases: ['howard'] }];

test('Howard is addressable by name but is never a first responder in the Lead reply', async () => {
  assert.equal(addressedPersona('Howard, can you look up library X?', WITH_HOWARD).id, 'howard');
  assert.deepEqual(parseFloorReply('{"speakers":["howard","bill"],"reason":"r","ask":""}', WITH_HOWARD).speakers, ['bill']);
  const named = await chooseSpeakers({ text: 'Howard, look up X', personas: WITH_HOWARD, transcript: [], callLead: async () => { throw new Error('no lead call for a name'); } });
  assert.deepEqual(named.speakers, ['howard']);
  assert.equal(named.via, 'name');
});

test('the chair can pick Howard through a research request, only when Howard is on the roster', () => {
  const raw = '{"speakers":["bill"],"reason":"r","ask":"","research":"how library X handles retries"}';
  assert.equal(parseFloorReply(raw, WITH_HOWARD).research, 'how library X handles retries');
  assert.ok(!('research' in parseFloorReply(raw, P)), 'no researcher on the roster: the field is ignored');
  assert.ok(!('research' in parseFloorReply('{"speakers":["bill"],"research":""}', WITH_HOWARD)));
});
