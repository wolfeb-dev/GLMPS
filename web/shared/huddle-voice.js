// web/shared/huddle-voice.js
// Voices for the huddle dock: ears, mouths, one voice per persona, and
// barge-in. The browser's own Web Speech engines are the default; the local
// neural engines (huddle-neural.js) replace them through setMouth and setEars
// when they load. The pure helpers are tested in node; createHuddleVoice is
// the thin DOM-side part.

export function voiceSupport(win) {
  const ears = Boolean(win && (win.SpeechRecognition || win.webkitSpeechRecognition));
  const mouths = Boolean(win && win.speechSynthesis && win.SpeechSynthesisUtterance);
  const why = [];
  if (!ears) why.push('This browser has no speech recognition (use Chrome or Edge); you can still type.');
  if (!mouths) why.push('This browser has no speech synthesis.');
  return { ears, mouths, why: why.join(' ') };
}

// The desktop app (apps/shell) leaves the dashboard pane's Electron user agent
// as-is (only Slack's is rewritten to plain Chrome), and it has no site
// settings to send the operator to: a block there is the app's own permission
// policy or Windows' microphone privacy switch.
export function isDesktopApp(win) {
  return /\bElectron\//.test(String(win?.navigator?.userAgent ?? ''));
}

export function blockedMicMessage(win) {
  return isDesktopApp(win)
    ? 'Microphone blocked in the GLMPS 2.0 desktop app: install the latest app build, and check that Windows Settings > Privacy & security > Microphone lets desktop apps use it.'
    : 'Microphone blocked: allow it in the site settings.';
}

// One huddle-wide speed on top of each persona's own rate, so the seats keep
// their relative pacing (operator, 2026-10-28: "25% faster"). Both mouths use it.
export const HUDDLE_SPEECH_RATE = 1.25;

// Deal the voices out in roster order so neighbours differ. With fewer voices
// than personas a voice is reused, and the persona's own pitch and rate keep the
// pair distinct. An empty list (voices load late) gives voiceURI null; call again
// on `voiceschanged`.
export function assignVoices(personas, voices) {
  const all = Array.isArray(voices) ? voices : [];
  const english = all.filter((v) => /^en/i.test(v.lang ?? ''));
  const pool = english.length ? english : all;
  const out = new Map();
  (personas ?? []).forEach((p, i) => {
    out.set(p.id, { voiceURI: pool.length ? pool[i % pool.length].voiceURI : null, pitch: p.voice?.pitch ?? 1, rate: p.voice?.rate ?? 1 });
  });
  return out;
}

// Same rule as clampSentences in server/lib/huddle/session.js (copied: the web
// side imports no server code). A period ending one of these words, or a lone
// letter, does not end a sentence.
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'mr', 'mrs', 'ms', 'dr']);
const MAX_SENTENCES = 2;

function sentenceEnds(text) {
  const ends = [];
  const terminator = /[.!?]+["')\]]?(?=\s|$)/g;
  let m;
  while ((m = terminator.exec(text)) !== null) {
    const word = (text.slice(0, m.index).match(/(\S+)$/)?.[1] ?? '').toLowerCase();
    if (m[0].startsWith('.') && (ABBREVIATIONS.has(word) || /^[a-z]$/.test(word))) continue;
    ends.push(m.index + m[0].length);
  }
  return ends;
}

// The part of a streaming reply that can be spoken now. While streaming, a
// terminator at the very end of the text does not count yet ("v2." may become
// "v2.5"); `final` flushes the tail. At most two sentences per utterance.
// `clause` lets the opening of a reply go at its first comma, semicolon or
// colon once it has CLAUSE_MIN_WORDS words: the minds write long first
// sentences, and the neural voice can start on a clause while the rest
// streams (live, 2026-10-24: the first sentence cost 1.9 s of a 6.1 s turn).
const CLAUSE_MIN_WORDS = 6;
export function nextSpeakable(text, spokenChars, { final = false, clause = false } = {}) {
  const s = String(text ?? '');
  const ends = sentenceEnds(s).slice(0, MAX_SENTENCES);
  let limit;
  if (final) limit = ends.length >= MAX_SENTENCES ? ends[MAX_SENTENCES - 1] : s.length;
  else limit = ends.filter((e) => e < s.length).pop() ?? 0;
  if (clause && !final && spokenChars === 0 && limit === 0) {
    // A comma, semicolon or colon is cut after; a joining word is cut before.
    const re = /[,;:](?=\s)|\s(?=(?:and|but|so|because|which|then)\s)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (words(s.slice(0, m.index)).length >= CLAUSE_MIN_WORDS) { limit = m[0].trim() ? m.index + 1 : m.index; break; }
    }
  }
  if (limit <= spokenChars) return { chunk: '', spokenChars };
  return { chunk: s.slice(spokenChars, limit).trim(), spokenChars: limit };
}

// Operator lines, error lines, pass lines and cut-off lines are captions only.
export function shouldSpeak(c) {
  if (!c || c.speaker === 'operator' || c.error || c.pass || c.truncated) return false;
  return String(c.text ?? '').trim().length > 0;
}

export function latencyMark() {
  let heardAt = null;
  return {
    heard(ts) { heardAt = ts; },
    firstAudio(ts) {
      if (heardAt === null) return null;
      const ms = Math.max(0, Math.round(ts - heardAt));
      heardAt = null;
      return ms;
    },
  };
}

// On speakers the mic hears the seats too, and recognition has no echo
// cancellation we can rely on. A heard phrase counts as echo when most of its
// words were in what the seats just said; only a non-echo phrase barges in.
const words = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? [];
export function isEcho(heard, recentlySpoken) {
  const h = words(heard);
  if (!h.length) return true;
  const said = new Set(words(recentlySpoken));
  if (!said.size) return false;
  return h.filter((w) => said.has(w)).length / h.length >= 0.6;
}

const PREF_KEY = 'huddle.voices';
export function readVoicesPref(win) {
  try { return win.localStorage.getItem(PREF_KEY) !== 'off'; } catch { return true; }
}
function writeVoicesPref(win, on) {
  try { win.localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* private mode: the preference just does not persist */ }
}

// The browser's speech synthesis as a mouth. It plays through the operating
// system, outside the page, so the browser's echo canceller cannot remove it
// from the microphone; with this mouth the word-overlap echo rule is what
// keeps a seat from hearing itself.
export function createWebSpeechMouth(win, personas = []) {
  const synth = win.speechSynthesis;
  let assigned = assignVoices(personas, []);
  let roster = personas;
  let current = null; // held so the engine does not collect it before onend
  const refresh = () => { assigned = assignVoices(roster, synth.getVoices?.() ?? []); };
  refresh();
  synth.addEventListener?.('voiceschanged', refresh);
  return {
    kind: 'browser',
    get busy() { return Boolean(current) || Boolean(synth.speaking); },
    setPersonas(next) { roster = next ?? []; refresh(); },
    speak({ speaker, text, onStart, onEnd }) {
      const u = new win.SpeechSynthesisUtterance(text);
      const v = assigned.get(speaker);
      if (v?.voiceURI) {
        const voice = (synth.getVoices?.() ?? []).find((x) => x.voiceURI === v.voiceURI);
        if (voice) u.voice = voice;
      }
      u.pitch = v?.pitch ?? 1;
      u.rate = (v?.rate ?? 1) * HUDDLE_SPEECH_RATE;
      u.lang = u.voice?.lang || 'en-US';
      u.onstart = () => onStart?.();
      const done = () => { if (current === u) current = null; onEnd?.(); };
      u.onend = done;
      u.onerror = done;
      current = u;
      synth.speak(u);
    },
    cancel() { current = null; try { synth.cancel(); } catch { /* nothing to cancel */ } },
    destroy() { synth.removeEventListener?.('voiceschanged', refresh); },
  };
}

// The browser's recognizer as ears. It reports raw results; the controller
// decides what is echo, what barges in and what is a line.
export function createWebSpeechEars(win, { onResult, onBlocked }) {
  let rec = null;
  let on = false;
  function ensure() {
    if (rec) return rec;
    const Ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
    rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        onResult?.({ text: r[0]?.transcript ?? '', final: Boolean(r.isFinal), last: i === e.results.length - 1 });
      }
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') onBlocked?.(); };
    // Chrome ends a session after a stretch of silence; keep listening while on.
    rec.onend = () => {
      if (!on) return;
      setTimeout(() => { if (on) { try { rec.start(); } catch { /* already started */ } } }, 250);
    };
    return rec;
  }
  return {
    kind: 'browser',
    start() { on = true; try { ensure().start(); } catch { /* already started */ } },
    stop() { on = false; if (rec) { try { rec.stop(); } catch { /* not running */ } } },
    destroy() { this.stop(); },
  };
}

export function createHuddleVoice({ win, personas = [], onHeard, onBargeIn, onMetric, onInterim, onStatus, onChange }) {
  const support = voiceSupport(win);
  const mark = latencyMark();
  const notify = () => { try { onChange?.(); } catch { /* a render error must not stop speech */ } };
  let voicesOn = support.mouths && readVoicesPref(win);
  let talk = false;
  let roster = personas;
  let mouth = support.mouths ? createWebSpeechMouth(win, personas) : null;
  const queue = []; // { speaker, text }
  let current = null; // the queue item in flight; a mouth's end for any other item is stale
  const spoken = new Map(); // speaker -> chars of the current reply already queued
  const muted = new Set(); // speakers cut off by barge-in until their reply settles
  let recentlySpoken = ''; // the tail of what the seats said aloud, for isEcho
  let lastSpokeAt = 0;
  // Recognition lags the audio, so echo can arrive just after a seat stops.
  const ECHO_TAIL_MS = 1500;
  const isSpeaking = () => Boolean(current || queue.length);
  const audible = () => isSpeaking() || Boolean(mouth?.busy);
  const echoWindow = () => audible() || Date.now() - lastSpokeAt < ECHO_TAIL_MS;

  function pump() {
    if (current || !queue.length || !mouth || !voicesOn) return;
    const item = queue.shift();
    current = item;
    // The next sentence generates while this one plays (neural mouth only).
    if (queue[0]) mouth.prepare?.(queue[0].speaker, queue[0].text);
    recentlySpoken = `${recentlySpoken} ${item.text}`.slice(-600);
    notify();
    mouth.speak({
      speaker: item.speaker,
      text: item.text,
      onStart: () => {
        const ms = mark.firstAudio(Date.now());
        if (ms !== null) onMetric?.({ kind: 'voice', heardToFirstAudioMs: ms, speaker: item.speaker });
      },
      onEnd: () => { lastSpokeAt = Date.now(); if (current === item) { current = null; notify(); pump(); } },
    });
  }

  function enqueue(speaker, chunk) {
    if (!chunk) return;
    queue.push({ speaker, text: chunk });
    if (current && queue.length === 1) mouth?.prepare?.(speaker, chunk);
    pump();
  }

  // Only replies still streaming (in `spoken`) are muted: a settled reply has
  // no final frame left to unmute it, so muting it swallowed the next reply.
  function cancel() {
    for (const s of spoken.keys()) muted.add(s);
    queue.length = 0;
    current = null;
    mouth?.cancel();
    notify();
  }

  function speakPartial(speaker, text) {
    if (!voicesOn || speaker === 'operator' || muted.has(speaker)) return;
    if (/^\s*pass\W*$/i.test(String(text ?? ''))) return;
    const r = nextSpeakable(text, spoken.get(speaker) ?? 0, { final: false, clause: mouth?.kind === 'neural' });
    spoken.set(speaker, r.spokenChars);
    enqueue(speaker, r.chunk);
  }

  // The settled reply: speak what is left of it, then forget the speaker.
  function speakFinal(caption) {
    const speaker = caption.speaker;
    const wasMuted = muted.delete(speaker);
    const from = spoken.get(speaker) ?? 0;
    spoken.delete(speaker);
    if (!voicesOn || wasMuted || !shouldSpeak(caption)) return;
    enqueue(speaker, nextSpeakable(caption.text, from, { final: true }).chunk);
  }

  function bargeIn() {
    if (!audible()) return;
    cancel();
    onBargeIn?.();
  }

  // A line heard by either ears. `at` is when the operator stopped talking
  // (local ears know it; the browser recognizer only says when it is done).
  function heardLine(text, at = Date.now()) {
    const t = String(text ?? '').trim();
    if (!t) return;
    if (echoWindow() && isEcho(t, recentlySpoken)) return;
    // Local stop only: the line's own /say supersedes the server turn, and a
    // separate interrupt racing it could cut the reply to this line.
    if (audible()) cancel();
    mark.heard(at);
    onHeard?.(t);
  }

  let interim = '';
  const browserEars = () => createWebSpeechEars(win, {
    // Barge-in waits for words, not sound: speech start alone fires on the
    // seats' own voices coming back through the mic.
    onResult: ({ text, final, last }) => {
      const echo = echoWindow() && isEcho(text, recentlySpoken);
      if (final) { onInterim?.(''); if (!echo) heardLine(text); }
      else if (!echo) interim += text;
      if (last && interim) {
        if (words(interim).length >= 2) bargeIn();
        onInterim?.(interim);
      }
      if (last) interim = '';
    },
    onBlocked: () => { setTalk(false); onStatus?.(blockedMicMessage(win)); },
  });
  let ears = support.ears ? browserEars() : null;

  function setTalk(on) {
    if (on && !ears) { onStatus?.(support.why); return; }
    talk = on;
    if (on) {
      const failed = (e) => { talk = false; onStatus?.(e?.name === 'NotAllowedError' ? blockedMicMessage(win) : `Microphone unavailable: ${e?.message ?? e}`); notify(); };
      try { ears.start()?.catch?.(failed); } catch (e) { failed(e); }
    }
    else if (ears) { ears.stop(); onInterim?.(''); }
    notify();
  }

  function setVoicesOn(on) {
    voicesOn = Boolean(mouth) && on;
    writeVoicesPref(win, voicesOn);
    if (!voicesOn) { cancel(); spoken.clear(); }
    notify();
  }

  const api = {
    get support() { return { ...support, ears: Boolean(ears), mouths: Boolean(mouth) }; },
    get talking() { return talk; },
    get voicesOn() { return voicesOn; },
    get speaking() { return isSpeaking(); },
    get mouthKind() { return mouth?.kind ?? null; },
    get earsKind() { return ears?.kind ?? null; },
    get audible() { return audible(); },
    setTalk,
    setVoicesOn,
    speakPartial,
    speakFinal,
    cancel,
    // Swap the mouth: the neural one when it has loaded, the browser one when it fails.
    setMouth(next) {
      if (!next) return;
      cancel();
      mouth?.destroy?.();
      mouth = next;
      mouth.setPersonas?.(roster);
      if (!support.mouths) voicesOn = readVoicesPref(win);
      notify();
    },
    useBrowserMouth() { if (support.mouths && mouth?.kind !== 'browser') api.setMouth(createWebSpeechMouth(win, roster)); },
    // Swap the ears, keeping Talk on if it was.
    setEars(next) {
      if (!next) return;
      const wasTalking = talk;
      if (wasTalking) setTalk(false);
      ears?.destroy?.();
      ears = next;
      if (wasTalking) setTalk(true);
      notify();
    },
    useBrowserEars() { if (support.ears && ears?.kind !== 'browser') api.setEars(browserEars()); },
    // Local ears: speech start while a seat is audible barges in; a finished
    // segment is a heard line, timed from the operator's last voiced frame.
    speechStarted() { bargeIn(); },
    heardLine,
    setPersonas(next) { roster = next ?? []; mouth?.setPersonas?.(roster); },
    // The server dropped that speaker's call: no final line will arrive to clear it.
    release(speaker) { spoken.delete(speaker); muted.delete(speaker); },
    reset() { cancel(); spoken.clear(); muted.clear(); },
    destroy() { setTalk(false); cancel(); mouth?.destroy?.(); ears?.destroy?.(); },
  };
  return api;
}
