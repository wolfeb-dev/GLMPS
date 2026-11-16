// web/shared/huddle-neural.js
// Local neural voices and local ears for the huddle dock (H3). Kokoro 82M
// speaks and Whisper base.en listens, both in the page on WebGPU through the
// vendored kokoro-js and transformers.js bundles; nothing runs on the server
// and nothing needs a key. The model files are fetched once by the libraries
// and cached by the browser. Without WebGPU both loaders refuse with a reason
// and the dock keeps the browser's own voices and recognizer: on the CPU
// Kokoro took 5 to 6 s a sentence (spike, 2026-10-24), too slow to talk to.
// The pure parts (voice choice, the energy detector, transcript fixes) are
// tested in node; the loaders are the thin browser side.

import { HUDDLE_SPEECH_RATE } from './huddle-voice.js';

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const WHISPER_MODEL = 'onnx-community/whisper-base.en';
const VENDOR = '/huddle-assets/';

// Used for a persona with no `voice.kokoro` of its own, in roster order.
export const KOKORO_FALLBACK_VOICES = Object.freeze(['am_michael', 'af_heart', 'bm_george', 'af_bella', 'am_fenrir', 'bf_emma', 'am_puck']);

export function kokoroVoices(personas) {
  const out = new Map();
  (personas ?? []).forEach((p, i) => out.set(p.id, p.voice?.kokoro || KOKORO_FALLBACK_VOICES[i % KOKORO_FALLBACK_VOICES.length]));
  return out;
}

// Whisper's misspellings of the project's own names, seen in the spike
// ("scutt", "AG") and in earlier huddles. Whole words only; "AG" only in
// capitals, so "a g" in ordinary speech is left alone unless spelled out.
const FIXES = [
  [/\bscutt?\b/gi, 'SCUT'],
  [/\bglimps\b|\bglmp\b|\bg\.? ?l\.? ?m\.? ?p\.? ?s\b/gi, 'GLMPS'],
  [/\bAG\b|\ba\.? ?g\.? ?y\.?(?=\s|$)/g, 'agy'],
];
export function fixTranscript(text) {
  let s = String(text ?? '').trim();
  for (const [re, to] of FIXES) s = s.replace(re, to);
  return s;
}

// Speech segmentation on the echo-cancelled microphone. One frame is a
// Float32Array of samples. Speech starts after `startMs` above the adaptive
// noise floor by `startDb` (more while a seat is playing, so residual echo
// does not count as the operator), and ends after `endMs` below floor +
// `endDb`. `start` comes with no audio; `end` carries the segment (pre-roll
// included) and the time of its last voiced frame, which is where the
// operator stopped talking.
export function createEnergyVad({ sampleRate = 16000, startMs = 250, endMs = 500, startDb = 12, endDb = 6, playingExtraDb = 10, minDb = -50, prerollMs = 300, maxMs = 15000, initialFloorDb = -70 } = {}) {
  let floor = initialFloorDb;
  let inSpeech = false;
  let aboveMs = 0;
  let belowMs = 0;
  let lastVoiced = 0;
  let pending = []; // frames of the run above threshold, before start
  let preroll = [];
  let prerollLen = 0;
  let segment = [];
  let segmentMs = 0;
  const msOf = (f) => (f.length / sampleRate) * 1000;
  const dbOf = (f) => {
    let sum = 0;
    for (let i = 0; i < f.length; i += 1) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / Math.max(1, f.length));
    return rms > 0 ? 20 * Math.log10(rms) : -120;
  };
  const concat = (frames) => {
    const n = frames.reduce((a, f) => a + f.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  };
  function keepPreroll(f) {
    preroll.push(f);
    prerollLen += msOf(f);
    while (preroll.length > 1 && prerollLen - msOf(preroll[0]) >= prerollMs) prerollLen -= msOf(preroll.shift());
  }
  return {
    get floorDb() { return floor; },
    get speaking() { return inSpeech; },
    push(frame, { playing = false, now = 0 } = {}) {
      const db = dbOf(frame);
      const ms = msOf(frame);
      const events = [];
      if (!inSpeech) {
        const over = db > minDb && db > floor + startDb + (playing ? playingExtraDb : 0);
        if (over) {
          pending.push(frame);
          aboveMs += ms;
          if (aboveMs >= startMs) {
            inSpeech = true;
            segment = [...preroll, ...pending];
            segmentMs = segment.reduce((a, f) => a + msOf(f), 0);
            pending = []; preroll = []; prerollLen = 0;
            belowMs = 0;
            lastVoiced = now;
            events.push({ type: 'start', at: now });
          }
        } else {
          for (const f of pending) keepPreroll(f);
          pending = [];
          aboveMs = 0;
          // The floor follows quiet quickly and noise slowly.
          floor = db < floor ? floor * 0.7 + db * 0.3 : floor + (db - floor) * 0.02;
          keepPreroll(frame);
        }
        return events;
      }
      segment.push(frame);
      segmentMs += ms;
      if (db > floor + endDb && db > minDb) { belowMs = 0; lastVoiced = now; } else belowMs += ms;
      if (belowMs >= endMs || segmentMs >= maxMs) {
        inSpeech = false;
        aboveMs = 0;
        events.push({ type: 'end', at: now, lastVoiced, audio: concat(segment) });
        segment = []; segmentMs = 0;
      }
      return events;
    },
  };
}

export function resampleLinear(x, from, to) {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = (i * from) / to;
    const k = Math.floor(t);
    const f = t - k;
    y[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? x[k] ?? 0) * f;
  }
  return y;
}

// The neural mouth. `tts.generate(text, { voice, speed })` resolves { audio:
// Float32Array, sampling_rate }. prepare() starts a sentence's generation
// early so it is ready when the one before it finishes playing; cancel()
// stops playback and drops everything prepared.
export function createNeuralMouth({ tts, audioCtx, voices = new Map(), onError = null }) {
  let gen = 0; // bumped by cancel(): anything started before it is dropped
  const prepared = new Map();
  let source = null;
  const keyOf = (speaker, text) => `${speaker}\u0000${text}`;
  function prepare(speaker, text) {
    const k = keyOf(speaker, text);
    if (!prepared.has(k)) {
      const p = tts.generate(text, { voice: voices.get(speaker) || KOKORO_FALLBACK_VOICES[0], speed: HUDDLE_SPEECH_RATE });
      p.catch(() => {});
      prepared.set(k, p);
    }
    return prepared.get(k);
  }
  return {
    kind: 'neural',
    get busy() { return Boolean(source); },
    setPersonas(personas) { voices = kokoroVoices(personas); },
    prepare,
    // onEnd is called once per speak, whether it played, was cancelled or failed.
    async speak({ speaker, text, onStart, onEnd }) {
      const mine = gen;
      let out;
      try {
        out = await prepare(speaker, text);
      } catch (e) {
        prepared.delete(keyOf(speaker, text));
        if (mine === gen) onError?.(e);
        onEnd?.();
        return;
      }
      prepared.delete(keyOf(speaker, text));
      if (mine !== gen) { onEnd?.(); return; }
      if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch { /* the gesture rule; the dock's buttons resume it */ } }
      const buf = audioCtx.createBuffer(1, out.audio.length, out.sampling_rate);
      buf.copyToChannel(out.audio, 0);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      let ended = false;
      src.onended = () => { if (ended) return; ended = true; if (source === src) source = null; onEnd?.(); };
      source = src;
      src.start();
      onStart?.();
    },
    cancel() {
      gen += 1;
      prepared.clear();
      const s = source;
      source = null;
      if (s) { try { s.stop(); } catch { /* already stopped */ } }
    },
    destroy() { this.cancel(); },
  };
}

function webgpuAvailable(win) {
  return Boolean(win?.navigator?.gpu);
}

async function gpuAdapter(win) {
  try { return await win.navigator.gpu.requestAdapter(); } catch { return null; }
}

// Eight lines of mixed length: in the spike the fifth and later sentences ran
// at about 0.4 s, the first four slower while shaders compiled.
const WARMUP = ['One moment.', 'Ready when you are.', 'That works for me, and it is cheap.', 'Let me think about that one for a second.', 'We can ship it this week, then measure it.', 'The weakest part of the plan is the echo, because the microphone hears the speakers.', 'Agreed.', 'I would cut the second view from the first release and keep the floor as it is.'];

// Loads Kokoro on WebGPU and warms it (the first sentences compile shaders:
// 2.5 to 6.8 s, then about 0.4 s). Rejects with a plain reason.
export async function loadNeuralMouth({ win = globalThis, personas = [], audioCtx = null, onError = null, importer = (u) => import(u) } = {}) {
  if (!webgpuAvailable(win)) throw new Error('no WebGPU in this browser');
  if (!(await gpuAdapter(win))) throw new Error('WebGPU has no usable GPU adapter');
  const { KokoroTTS } = await importer(`${VENDOR}kokoro.web.js`);
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'fp32', device: 'webgpu' });
  for (const line of WARMUP) await tts.generate(line, { voice: KOKORO_FALLBACK_VOICES[0] });
  return createNeuralMouth({ tts, audioCtx: audioCtx ?? new win.AudioContext(), voices: kokoroVoices(personas), onError });
}

// Local ears: the echo-cancelled microphone, the energy detector, and
// Whisper per finished segment. `isPlaying()` tells the detector a seat is
// audible. start() asks for the microphone; stop() releases it.
export async function loadLocalEars({ win = globalThis, onSpeechStart, onFinal, onStatus, isPlaying = () => false, importer = (u) => import(u) } = {}) {
  if (!webgpuAvailable(win)) throw new Error('no WebGPU in this browser');
  if (!win.navigator.mediaDevices?.getUserMedia) throw new Error('no microphone access on this page (it needs https or localhost)');
  const { pipeline } = await importer(`${VENDOR}transformers.min.js`);
  const asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL, { device: 'webgpu', dtype: 'fp32' });
  await asr(new Float32Array(16000)); // warm: the first call compiles
  let stream = null;
  let ctx = null;
  let node = null;
  let queue = Promise.resolve();
  const vad = createEnergyVad();
  function transcribe(audio, lastVoiced) {
    queue = queue.then(async () => {
      try {
        const out = await asr(audio);
        const text = fixTranscript(out?.text ?? '');
        if (text && !/^\[.*\]$/.test(text)) onFinal?.(text, lastVoiced);
      } catch (e) { onStatus?.(`Local recognition failed: ${e?.message ?? e}`); }
    });
  }
  return {
    kind: 'local',
    async start() {
      if (stream) return;
      stream = await win.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      ctx = new win.AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule('/huddle/mic-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      node = new win.AudioWorkletNode(ctx, 'huddle-mic');
      node.port.onmessage = (e) => {
        const frame = e.data instanceof Float32Array ? e.data : new Float32Array(e.data);
        const audio = ctx.sampleRate === 16000 ? frame : resampleLinear(frame, ctx.sampleRate, 16000);
        for (const ev of vad.push(audio, { playing: isPlaying(), now: Date.now() })) {
          if (ev.type === 'start') onSpeechStart?.();
          else if (ev.type === 'end') transcribe(ev.audio, ev.lastVoiced);
        }
      };
      src.connect(node);
    },
    stop() {
      try { node?.disconnect(); } catch { /* gone */ }
      try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
      try { ctx?.close(); } catch { /* gone */ }
      stream = null; ctx = null; node = null;
    },
    destroy() { this.stop(); },
  };
}
