import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { kokoroVoices, KOKORO_FALLBACK_VOICES, fixTranscript, createEnergyVad, resampleLinear, createNeuralMouth, loadNeuralMouth, loadLocalEars } from '../../web/shared/huddle-neural.js';
import { createHuddleVoice } from '../../web/shared/huddle-voice.js';
import { DEFAULT_SEATS } from '../lib/huddle/roster.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'huddle-assets');

test('every default persona has its own Kokoro voice; a persona without one gets a fallback in roster order', () => {
  const ids = Object.values(DEFAULT_SEATS).map((s) => s.voice.kokoro);
  assert.equal(new Set(ids).size, ids.length, 'no two personas share a voice');
  assert.ok(ids.every((v) => /^[ab][fm]_[a-z]+$/.test(v)), `english Kokoro voice ids: ${ids}`);
  const m = kokoroVoices([{ id: 'a', voice: { kokoro: 'bf_emma' } }, { id: 'b' }, { id: 'c', voice: {} }]);
  assert.deepEqual([...m.entries()], [['a', 'bf_emma'], ['b', KOKORO_FALLBACK_VOICES[1]], ['c', KOKORO_FALLBACK_VOICES[2]]]);
});

test('fixTranscript restores the project names Whisper misspelled in the spike, and leaves ordinary words alone', () => {
  assert.equal(fixTranscript('Homer is the scutt router the right place for this.'), 'Homer is the SCUT router the right place for this.');
  assert.equal(fixTranscript('What breaks first when the AG seat times out?'), 'What breaks first when the agy seat times out?');
  assert.equal(fixTranscript('should glimps post it'), 'should GLMPS post it');
  assert.equal(fixTranscript('a glimpse of the plan, page one'), 'a glimpse of the plan, page one');
  assert.equal(fixTranscript('  agreed  '), 'agreed');
});

const frame = (db, n = 512) => {
  const amp = Math.pow(10, db / 20) * Math.SQRT2;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i += 1) f[i] = amp * Math.sin((2 * Math.PI * 220 * i) / 16000);
  return f;
};
function run(vad, plan) {
  const events = [];
  let now = 0;
  for (const [db, ms, playing = false] of plan) {
    for (let t = 0; t < ms; t += 32) { now += 32; events.push(...vad.push(frame(db), { playing, now })); }
  }
  return events;
}

test('the energy detector marks one start and one end for a spoken line, with pre-roll and the last voiced frame', () => {
  const vad = createEnergyVad();
  const ev = run(vad, [[-70, 1000], [-25, 640], [-70, 1200]]);
  assert.deepEqual(ev.map((e) => e.type), ['start', 'end']);
  const end = ev[1];
  assert.ok(end.audio.length / 16000 >= 0.9, `segment carries pre-roll and the speech: ${end.audio.length / 16000}s`);
  assert.ok(end.lastVoiced >= 1600 && end.lastVoiced <= 1700, `last voiced near the end of speech: ${end.lastVoiced}`);
  assert.ok(end.at - end.lastVoiced >= 500, 'the end comes after the hangover');
});

test('the energy detector ignores a short click, and raises its bar while a seat is playing', () => {
  assert.deepEqual(run(createEnergyVad(), [[-70, 1000], [-25, 96], [-70, 1000]]).map((e) => e.type), [], 'under 250 ms is not speech');
  // 15 dB over a -70 floor: speech when quiet, residual echo when a seat plays.
  assert.deepEqual(run(createEnergyVad(), [[-70, 1000], [-55, 600, true], [-70, 1000]]).map((e) => e.type), []);
  assert.deepEqual(run(createEnergyVad({ minDb: -60 }), [[-70, 1000], [-55, 600], [-70, 1000]]).map((e) => e.type), ['start', 'end']);
  assert.deepEqual(run(createEnergyVad(), [[-120, 2000]]).map((e) => e.type), [], 'digital silence never starts');
});

test('the energy detector ends a segment at the 15 s cap even if the room never goes quiet', () => {
  const ev = run(createEnergyVad(), [[-70, 500], [-25, 16000]]);
  assert.deepEqual(ev.map((e) => e.type).slice(0, 2), ['start', 'end']);
});

test('resampleLinear changes the length by the rate ratio and is a no-op at the same rate', () => {
  const x = new Float32Array(24000).fill(0.5);
  assert.equal(resampleLinear(x, 24000, 16000).length, 16000);
  assert.equal(resampleLinear(x, 16000, 16000), x);
  assert.ok(resampleLinear(x, 24000, 16000).every((v) => Math.abs(v - 0.5) < 1e-6));
});

function fakeAudio() {
  const played = [];
  const ctx = {
    state: 'running',
    destination: {},
    createBuffer: (ch, n, rate) => ({ n, rate, copyToChannel() {} }),
    createBufferSource() {
      const src = { connect() {}, start() { played.push(src); }, stop() { src.stopped = true; src.onended?.(); } };
      return src;
    },
  };
  return { ctx, played };
}
function fakeTts() {
  const calls = [];
  const gates = new Map();
  return {
    calls,
    release(text) { gates.get(text)?.(); },
    generate(text, { voice, speed }) {
      calls.push({ text, voice, speed });
      return new Promise((resolve) => gates.set(text, () => resolve({ audio: new Float32Array(2400), sampling_rate: 24000 })));
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the neural mouth speaks in the persona voice at the huddle speed, starts the next sentence early, and calls onEnd once', async () => {
  const tts = fakeTts();
  const { ctx, played } = fakeAudio();
  const mouth = createNeuralMouth({ tts, audioCtx: ctx, voices: new Map([['bill', 'am_fenrir']]) });
  const log = [];
  mouth.speak({ speaker: 'bill', text: 'One.', onStart: () => log.push('start'), onEnd: () => log.push('end') });
  mouth.prepare('bill', 'Two.');
  assert.deepEqual(tts.calls, [{ text: 'One.', voice: 'am_fenrir', speed: 1.25 }, { text: 'Two.', voice: 'am_fenrir', speed: 1.25 }], 'Two. is generating while One. waits');
  tts.release('One.');
  await tick();
  assert.equal(played.length, 1);
  assert.equal(mouth.busy, true);
  played[0].onended();
  played[0].onended();
  assert.deepEqual(log, ['start', 'end']);
  assert.equal(mouth.busy, false);
  mouth.speak({ speaker: 'bill', text: 'Two.', onEnd() {} });
  assert.equal(tts.calls.length, 2, 'the prepared sentence is not generated twice');
});

test('cancel stops playback and drops what was generating; a failed generation reports once and still ends', async () => {
  const tts = fakeTts();
  const { ctx, played } = fakeAudio();
  const mouth = createNeuralMouth({ tts, audioCtx: ctx });
  const ends = [];
  mouth.speak({ speaker: 'x', text: 'Late.', onEnd: () => ends.push('late') });
  mouth.cancel();
  tts.release('Late.');
  await tick();
  assert.equal(played.length, 0, 'a sentence cancelled while generating never plays');
  assert.deepEqual(ends, ['late']);
  const errors = [];
  const bad = createNeuralMouth({ tts: { generate: () => Promise.reject(new Error('gpu lost')) }, audioCtx: ctx, onError: (e) => errors.push(e.message) });
  await bad.speak({ speaker: 'x', text: 'A.', onEnd: () => ends.push('a') });
  assert.deepEqual(errors, ['gpu lost']);
  assert.deepEqual(ends, ['late', 'a']);
});

test('the loaders refuse with a reason when the browser has no WebGPU or no microphone API', async () => {
  await assert.rejects(loadNeuralMouth({ win: { navigator: {} }, importer: () => { throw new Error('must not import'); } }), /no WebGPU/);
  await assert.rejects(loadNeuralMouth({ win: { navigator: { gpu: { requestAdapter: async () => null } } }, importer: () => { throw new Error('must not import'); } }), /no usable GPU adapter/);
  await assert.rejects(loadLocalEars({ win: { navigator: { gpu: {} } }, importer: () => { throw new Error('must not import'); } }), /no microphone access/);
});

function plainWin() {
  return { localStorage: { getItem: () => null, setItem() {} } };
}

test('the controller speaks through a swapped-in mouth, and local ears barge in on speech start only while a seat is audible', async () => {
  const tts = fakeTts();
  const { ctx, played } = fakeAudio();
  let barged = 0;
  const heard = [];
  const v = createHuddleVoice({ win: plainWin(), personas: [{ id: 'bill' }], onHeard: (t) => heard.push(t), onBargeIn: () => { barged += 1; }, onMetric() {} });
  assert.equal(v.mouthKind, null, 'no browser voices in this window');
  v.setMouth(createNeuralMouth({ tts, audioCtx: ctx }));
  v.setVoicesOn(true);
  assert.equal(v.mouthKind, 'neural');
  v.speechStarted();
  assert.equal(barged, 0, 'nothing audible: speech start is not a barge-in');
  v.speakFinal({ speaker: 'bill', text: 'First sentence. Second sentence.' });
  assert.deepEqual(tts.calls.map((c) => c.text), ['First sentence. Second sentence.']);
  v.speechStarted();
  assert.equal(barged, 1);
  tts.release('First sentence. Second sentence.');
  await tick();
  assert.equal(played.length, 0, 'the cut reply never plays');
});

test('a heard line from local ears is timed from when the operator stopped, and a line that is mostly the seat is dropped as echo', async () => {
  const tts = fakeTts();
  const { ctx, played } = fakeAudio();
  const metrics = [];
  const heard = [];
  const v = createHuddleVoice({ win: plainWin(), personas: [{ id: 'bill' }], onHeard: (t) => heard.push(t), onBargeIn() {}, onMetric: (m) => metrics.push(m) });
  v.setMouth(createNeuralMouth({ tts, audioCtx: ctx }));
  v.setVoicesOn(true);
  v.speakFinal({ speaker: 'bill', text: 'Ship the smallest slice first.' });
  v.heardLine('ship the smallest slice first');
  assert.deepEqual(heard, [], 'echo of the seat is not the operator');
  v.heardLine('what would that cost', Date.now() - 1200);
  assert.deepEqual(heard, ['what would that cost']);
  v.speakFinal({ speaker: 'bill', text: 'About a day.' });
  tts.release('About a day.');
  await tick();
  assert.equal(played.length, 1);
  assert.ok(metrics[0].heardToFirstAudioMs >= 1200, `measured from the end of speech: ${metrics[0].heardToFirstAudioMs}`);
});

test('the huddle voice bundles are pinned by checksum and stay out of the dashboard vendor budget', () => {
  const lic = fs.readFileSync(path.join(ASSETS, 'LICENSES.md'), 'utf8');
  for (const f of ['kokoro.web.js', 'transformers.min.js']) {
    const m = lic.match(new RegExp(`^sha256 ${f.replace(/\./g, '\\.')} ([0-9a-f]{64})$`, 'm'));
    assert.ok(m, `no sha256 line for ${f}`);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ASSETS, f))).digest('hex'), m[1]);
  }
  assert.match(lic, /Apache License/);
  const vendor = path.join(ASSETS, '..', 'vendor');
  assert.ok(!fs.existsSync(path.join(vendor, 'kokoro.web.js')) && !fs.existsSync(path.join(vendor, 'transformers.min.js')));
});
