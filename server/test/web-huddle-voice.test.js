// server/test/web-huddle-voice.test.js
// Pure logic of the dock's voices, run in node (no DOM, no speech engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceSupport, assignVoices, nextSpeakable, latencyMark, shouldSpeak, isEcho, createHuddleVoice, isDesktopApp, blockedMicMessage, createWebSpeechMouth, HUDDLE_SPEECH_RATE } from '../../web/shared/huddle-voice.js';
import { DEFAULT_SEATS } from '../lib/huddle/roster.js';

test('voiceSupport reports ears and mouths separately, with a reason when one is missing', () => {
  const full = voiceSupport({ webkitSpeechRecognition: function R() {}, speechSynthesis: {}, SpeechSynthesisUtterance: function U() {} });
  assert.deepEqual([full.ears, full.mouths, full.why], [true, true, '']);
  assert.equal(voiceSupport({ SpeechRecognition: function R() {}, speechSynthesis: {}, SpeechSynthesisUtterance: function U() {} }).ears, true);
  const ff = voiceSupport({ speechSynthesis: {}, SpeechSynthesisUtterance: function U() {} });
  assert.equal(ff.ears, false);
  assert.equal(ff.mouths, true);
  assert.match(ff.why, /speech recognition/i);
  const none = voiceSupport({});
  assert.deepEqual([none.ears, none.mouths], [false, false]);
  assert.equal(voiceSupport(null).ears, false);
});

const personas = ['riker', 'bill', 'garfield', 'mario', 'homer', 'guppy', 'medeiros'].map((id, i) => ({ id, voice: { pitch: 1 + i / 10, rate: 1 } }));

test('assignVoices deals english voices out so adjacent personas differ, one entry per persona', () => {
  const voices = [{ voiceURI: 'de', lang: 'de-DE' }, { voiceURI: 'a', lang: 'en-US' }, { voiceURI: 'b', lang: 'en-GB' }, { voiceURI: 'c', lang: 'en-AU' }];
  const m = assignVoices(personas, voices);
  assert.equal(m.size, 7);
  const ids = personas.map((p) => m.get(p.id).voiceURI);
  assert.ok(!ids.includes('de'), 'non-english voices are skipped while english ones exist');
  for (let i = 1; i < ids.length; i += 1) assert.notEqual(ids[i], ids[i - 1]);
  const keys = personas.map((p) => `${m.get(p.id).voiceURI}|${m.get(p.id).pitch}|${m.get(p.id).rate}`);
  assert.equal(new Set(keys).size, 7, 'reuse stays distinct through the persona pitch and rate');
  assert.equal(m.get('bill').pitch, 1.1);
});

test('assignVoices with no voices yet gives voiceURI null and keeps pitch and rate', () => {
  const m = assignVoices(personas, []);
  assert.equal(m.size, 7);
  assert.equal(m.get('riker').voiceURI, null);
  assert.equal(m.get('mario').pitch, 1.3);
  assert.equal(assignVoices([{ id: 'x' }], [{ voiceURI: 'z', lang: 'fr-FR' }]).get('x').voiceURI, 'z', 'with no english voice any voice is better than none');
  assert.deepEqual([assignVoices([{ id: 'x' }], []).get('x').pitch, assignVoices([{ id: 'x' }], []).get('x').rate], [1, 1]);
});

test('the browser voice speaks every seat 25% faster than its own rate and leaves pitch alone', () => {
  assert.equal(HUDDLE_SPEECH_RATE, 1.25);
  const said = [];
  const win = { speechSynthesis: { speak: (u) => said.push(u), getVoices: () => [] }, SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } } };
  const seats = Object.entries(DEFAULT_SEATS).map(([id, s]) => ({ id, voice: s.voice }));
  const mouth = createWebSpeechMouth(win, seats);
  for (const p of seats) mouth.speak({ speaker: p.id, text: 'Hi.' });
  assert.deepEqual(said.map((u) => u.rate), seats.map((p) => p.voice.rate * 1.25));
  assert.deepEqual(said.map((u) => u.pitch), seats.map((p) => p.voice.pitch));
  mouth.speak({ speaker: 'nobody', text: 'Hi.' });
  assert.deepEqual([said.at(-1).rate, said.at(-1).pitch], [1.25, 1], 'a seat with no rate of its own still speeds up');
});

test('nextSpeakable streams sentence by sentence and never speaks a third sentence', () => {
  let r = nextSpeakable('Use the pool', 0, { final: false });
  assert.deepEqual(r, { chunk: '', spokenChars: 0 });
  r = nextSpeakable('Use the pool. It is warm', 0, { final: false });
  assert.equal(r.chunk, 'Use the pool.');
  const first = r.spokenChars;
  r = nextSpeakable('Use the pool. It is warm', first, { final: false });
  assert.equal(r.chunk, '');
  assert.equal(r.spokenChars, first);
  r = nextSpeakable('Use the pool. It is warm.', first, { final: true });
  assert.equal(r.chunk, 'It is warm.');
  r = nextSpeakable('One. Two. Three. Four.', 0, { final: true });
  assert.equal(r.chunk, 'One. Two.');
  const after = nextSpeakable('One. Two. Three. Four.', r.spokenChars, { final: true });
  assert.equal(after.chunk, '');
});

test('nextSpeakable: e.g. and a decimal are not sentence boundaries; final flushes an unterminated tail', () => {
  assert.equal(nextSpeakable('Try e.g. caching first. Then v2.5 later', 0, { final: false }).chunk, 'Try e.g. caching first.');
  assert.equal(nextSpeakable('It costs $2.50 each', 0, { final: false }).chunk, '');
  assert.equal(nextSpeakable('It costs $2.50 each', 0, { final: true }).chunk, 'It costs $2.50 each');
  assert.equal(nextSpeakable('Done.', 0, { final: true }).chunk, 'Done.');
  assert.equal(nextSpeakable('', 0, { final: true }).chunk, '');
});

test('shouldSpeak: never operator, error, pass or truncated lines', () => {
  assert.equal(shouldSpeak({ speaker: 'bill', text: 'Hello.' }), true);
  assert.equal(shouldSpeak({ speaker: 'operator', text: 'Hi' }), false);
  assert.equal(shouldSpeak({ speaker: 'bill', text: 'x', error: true }), false);
  assert.equal(shouldSpeak({ speaker: 'homer', text: 'pass', pass: true }), false);
  assert.equal(shouldSpeak({ speaker: 'bill', text: 'cut', truncated: true }), false);
  assert.equal(shouldSpeak({ speaker: 'bill', text: '  ' }), false);
});

test('latencyMark yields one heardToFirstAudioMs per heard line, null before heard', () => {
  const m = latencyMark();
  assert.equal(m.firstAudio(500), null);
  m.heard(1000);
  assert.equal(m.firstAudio(3100), 2100);
  assert.equal(m.firstAudio(3200), null, 'once per heard line');
  m.heard(5000);
  assert.equal(m.firstAudio(5900), 900);
});

test('isEcho: the mic hearing a seat read aloud is echo; the operator talking over it is not', () => {
  const said = 'I would ship the smallest version this week. It costs about six hours.';
  assert.equal(isEcho('ship the smallest version this week', said), true);
  assert.equal(isEcho('it costs about six hours', said), true);
  assert.equal(isEcho('wait stop that is not what I asked', said), false);
  assert.equal(isEcho('hold on', said), false);
  assert.equal(isEcho('anything at all', ''), false);
  assert.equal(isEcho('', said), true, 'nothing heard is never a barge-in');
});

function fakeVoiceWindow(log) {
  let cur = null;
  const synth = {
    speaking: false, getVoices: () => [], addEventListener() {}, removeEventListener() {},
    speak(u) { cur = u; this.speaking = true; log.push(u.text); u.onstart?.(); },
    cancel() { if (cur) { const u = cur; cur = null; this.speaking = false; u.onerror?.({ error: 'interrupted' }); } },
  };
  const win = { speechSynthesis: synth, SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } }, localStorage: { getItem: () => null, setItem() {} } };
  win.webkitSpeechRecognition = class { constructor() { win.rec = this; } start() {} stop() {} };
  return win;
}

test('a seat cut off while reading a settled reply still speaks its next reply', () => {
  const log = [];
  const win = fakeVoiceWindow(log);
  const v = createHuddleVoice({ win, personas: [{ id: 'mario' }], onHeard() {}, onBargeIn() {}, onMetric() {} });
  v.setTalk(true);
  v.speakFinal({ speaker: 'mario', text: 'A long shot idea. It reuses the desk path.' });
  assert.equal(log.length, 1, 'the settled reply is being read');
  const res = [{ transcript: 'one more adjacent idea please' }]; res.isFinal = true;
  win.rec.onresult({ resultIndex: 0, results: [res] });
  v.speakPartial('mario', 'Try a stop key. ');
  v.speakFinal({ speaker: 'mario', text: 'Try a stop key. It is cheap.' });
  assert.ok(log.some((t) => t.startsWith('Try a stop key')), `next reply spoken, got ${JSON.stringify(log)}`);
});

test('a seat cut off mid-stream stays silent for the rest of that reply only', () => {
  const log = [];
  const win = fakeVoiceWindow(log);
  const v = createHuddleVoice({ win, personas: [{ id: 'bill' }], onHeard() {}, onBargeIn() {}, onMetric() {} });
  v.setTalk(true);
  v.speakPartial('bill', 'First sentence here. ');
  const res = [{ transcript: 'stop that and listen' }]; res.isFinal = true;
  win.rec.onresult({ resultIndex: 0, results: [res] });
  v.speakPartial('bill', 'First sentence here. Second sentence here. ');
  v.speakFinal({ speaker: 'bill', text: 'First sentence here. Second sentence here.' });
  assert.ok(!log.some((t) => t.startsWith('Second')), 'the rest of the cut reply is dropped');
  v.speakPartial('bill', 'New answer now. ');
  assert.ok(log.some((t) => t.startsWith('New answer')), 'the next reply speaks');
});

test('a final line stops local speech without a separate interrupt; interim words barge in', () => {
  const log = [];
  const win = fakeVoiceWindow(log);
  let barged = 0;
  const heard = [];
  const v = createHuddleVoice({ win, personas: [{ id: 'bill' }], onHeard: (t) => heard.push(t), onBargeIn: () => { barged += 1; }, onMetric() {} });
  v.setTalk(true);
  v.speakFinal({ speaker: 'bill', text: 'Something long being read out. And more.' });
  const fin = [{ transcript: 'new question for the team' }]; fin.isFinal = true;
  win.rec.onresult({ resultIndex: 0, results: [fin] });
  assert.equal(barged, 0, 'no interrupt POST on a final line');
  assert.equal(win.speechSynthesis.speaking, false, 'speech stopped');
  assert.deepEqual(heard, ['new question for the team']);
  v.speakFinal({ speaker: 'bill', text: 'Another reply being read. More.' });
  const mid = [{ transcript: 'hold on wait' }]; mid.isFinal = false;
  win.rec.onresult({ resultIndex: 0, results: [mid] });
  assert.equal(barged, 1, 'interim words over speech interrupt the server turn');
});

test('nextSpeakable with clause: a long opening goes at its first comma once it has six words; short or settled replies do not', () => {
  const long = 'The smallest version is a single hold-to-talk key, which gates the stream we already have';
  assert.deepEqual(nextSpeakable(long, 0, { clause: true }), { chunk: 'The smallest version is a single hold-to-talk key,', spokenChars: 50 });
  assert.deepEqual(nextSpeakable(long, 0), { chunk: '', spokenChars: 0 }, 'without clause it waits for the sentence');
  assert.deepEqual(nextSpeakable('Yes, but later', 0, { clause: true }), { chunk: '', spokenChars: 0 }, 'too short to cut');
  const more = `${long}. Then we measure it. A third.`;
  const r = nextSpeakable(more, 50, { clause: true });
  assert.equal(r.chunk, 'which gates the stream we already have. Then we measure it.');
  assert.equal(nextSpeakable(more, r.spokenChars, { clause: true, final: true }).chunk, '', 'never a third sentence');
});

test('nextSpeakable with clause cuts before a joining word when the opening has no comma', () => {
  const t = 'The smallest version is a hold-to-talk button and a release that closes the stream';
  assert.deepEqual(nextSpeakable(t, 0, { clause: true }), { chunk: 'The smallest version is a hold-to-talk button', spokenChars: 45 });
  assert.deepEqual(nextSpeakable('Cats and dogs and more', 0, { clause: true }), { chunk: '', spokenChars: 0 }, 'under six words');
});

// 2026-10-27 (card glmps-2-0-runtime-82): the desktop app has no site settings.
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) glmps-shell/0.1.0 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

test('a blocked microphone in the desktop app names the app and what to do, not site settings', () => {
  const desktop = { navigator: { userAgent: ELECTRON_UA } };
  assert.equal(isDesktopApp(desktop), true);
  const msg = blockedMicMessage(desktop);
  assert.match(msg, /GLMPS 2\.0 desktop app/);
  assert.match(msg, /Windows Settings/);
  assert.doesNotMatch(msg, /site settings/);
});

test('a blocked microphone in a browser still points at site settings', () => {
  for (const win of [{ navigator: { userAgent: CHROME_UA } }, {}, null]) {
    assert.equal(isDesktopApp(win), false);
    assert.equal(blockedMicMessage(win), 'Microphone blocked: allow it in the site settings.');
  }
});

test('the huddle reports the desktop message when the browser ears are refused', () => {
  const win = fakeVoiceWindow([]);
  win.navigator = { userAgent: ELECTRON_UA };
  const status = [];
  const v = createHuddleVoice({ win, personas: [], onStatus: (t) => status.push(t) });
  v.setTalk(true);
  win.rec.onerror({ error: 'not-allowed' });
  assert.equal(v.talking, false);
  assert.deepEqual(status, [blockedMicMessage(win)]);
});

test('the huddle reports the desktop message when local ears are refused the microphone', async () => {
  const win = fakeVoiceWindow([]);
  win.navigator = { userAgent: ELECTRON_UA };
  const status = [];
  const v = createHuddleVoice({ win, personas: [], onStatus: (t) => status.push(t) });
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  v.setEars({ kind: 'local', start: () => Promise.reject(denied), stop() {}, destroy() {} });
  v.setTalk(true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(status, [blockedMicMessage(win)]);
});
