// server/lib/huddle/agy-seat.js
// An agy seat (D28, generalized): a persona on a non-Claude model through the
// operator's Google plan via agy. Its job is a different view. After a Claude
// mind answers a substantive question it gives a short second view or passes;
// the operator can address it by name. It never speaks first, is never the
// Lead, and its latency is kept off the first-reply path by the session.
// agy returns whole answers (no streaming) and is serialized process-wide
// inside agyGenerate; each call runs in its own throwaway cwd.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agyGenerate } from '../observability/wiki-agy.js';
import { isTestProcess } from '../test-process.js';
import { retiredModelError, resolveRetiredModel } from './agy-models.js';

export { AGY_MODELS } from './agy-models.js';

const QUESTION_START = /^(what|why|how|when|where|which|who|should|would|could|can|is|are|do|does|did|will|shall)\b/i;

export function isSubstantive(text) {
  const s = String(text ?? '').trim();
  if (s.split(/\s+/).filter(Boolean).length < 4) return false;
  return s.endsWith('?') || QUESTION_START.test(s);
}

// The seat is told which line to weigh rather than "the last answer": a
// second view that lands late leaves the seat's own line last in the
// transcript, and asked to critique that, Gemini 3.8 Flash (agy 1.3.4)
// reasoned about which answer was meant until the seat timeout (live,
// 2026-10-13).
export function seatPrompt({ persona, transcriptText, mode, target = null, brief = '' }) {
  const addressed = mode === 'addressed';
  const task = addressed
    ? `The operator has asked you directly${target ? ' (the question is quoted at the end)' : ''}. Answer in at most two sentences.`
    : `Give your own view on ${target ? 'the answer quoted at the end' : 'the most recent answer from a Claude specialist'}: what it misses, or a better alternative, in at most two sentences. If you genuinely agree and have nothing to add, reply with exactly: PASS`;
  return [
    `You are ${persona.display}, the ${persona.seatRole ?? persona.role} in a live engineering huddle. Your personality: ${String(persona.personality ?? 'none given').replace(/[.]+$/, '')}. You run on ${persona.model}; the others run on other models, and you are here so the team hears a different view.`,
    task,
    'No lists, no headings, no code. Plain sentences only.',
    ...(persona.charter ? ['', String(persona.charter)] : []),
    ...(persona.definition ? ['', 'Your standing brief:', String(persona.definition)] : []),
    ...(brief ? ['', 'The project being discussed (answer from this before guessing):', String(brief)] : []),
    '',
    `Transcript (lines from ${persona.display} are your own earlier replies, and may land after later questions):`,
    String(transcriptText ?? ''),
    ...(target ? ['', `${addressed ? 'Question to answer' : 'Answer to weigh'}:`, String(target)] : []),
  ].join('\n');
}

export function parseSeatReply(raw) {
  const s = String(raw ?? '').trim();
  if (/^pass\.?$/i.test(s)) return { text: 'pass', pass: true };
  const sentences = s.match(/[^.!?]+[.!?]+(\s|$)/g);
  const two = sentences && sentences.length > 2 ? sentences.slice(0, 2).join('').trim() : s;
  return { text: two.slice(0, 400), pass: false };
}

// The seat's own agy bound (the wiki ask and build keep theirs): a second view
// later than this is no use to a live conversation.
export const SEAT_AGY_TIMEOUT_MS = 30_000;

// `avoidModels` returns the models the other seats hold, so a seat moved off a
// retired model never lands on a sibling's model.
export function createAgySeat({ persona, generate = null, timeoutMs = SEAT_AGY_TIMEOUT_MS, tmpDir = os.tmpdir(), convDir, env = process.env, avoidModels = () => [] } = {}) {
  let model = persona.model;
  return {
    persona,
    get model() { return model; },
    async respond({ transcriptText, mode = 'second', target = null, brief = '', signal } = {}) {
      // Same rule as the claude pool: the real agy is never started from a test process.
      if (!generate && (env?.GLMPS_MODEL_RUNNER === 'off' || process.env.GLMPS_MODEL_RUNNER === 'off')) throw new Error('agy seat disabled (GLMPS_MODEL_RUNNER=off)');
      if (!generate && isTestProcess({ env })) throw new Error('agy seat refused: test process, no injected generate');
      const gen = generate ?? agyGenerate;
      const cwd = fs.mkdtempSync(path.join(tmpDir, 'mc-agy-seat-'));
      const ask = (m) => gen(seatPrompt({ persona: { ...persona, model: m }, transcriptText, mode, target, brief }), { model: m, timeout: timeoutMs, cwd, convDir, signal });
      try {
        try {
          return parseSeatReply(await ask(model));
        } catch (e) {
          // agy retired this seat's model (an agy upgrade): move to one it still
          // lists, say so once, and answer this turn on it.
          const retired = signal?.aborted ? null : retiredModelError(e?.message, model);
          if (!retired) throw e;
          const next = resolveRetiredModel(model, retired.available, avoidModels());
          if (!next) throw new Error(`${persona.display}'s model ${model} is no longer offered by agy, and every model it lists is taken by another seat`);
          const note = `${persona.display}'s model ${model} is no longer offered by agy; moved to ${next}.`;
          model = next;
          return { ...parseSeatReply(await ask(next)), note };
        }
      } finally {
        try { fs.rmSync(cwd, { recursive: true, force: true }); }
        catch (e) { console.error(`agy-seat: temp cleanup failed for ${cwd}: ${e.message}`); }
      }
    },
  };
}
