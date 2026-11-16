// server/lib/huddle/session.js
// One huddle: an in-memory transcript, the floor, the minds, the agy seats,
// and the record. Every utterance is a typed spine event with sessionId
// 'huddle:<id>' and an SSE payload on the dashboard bus, both tagged with the
// model that spoke it (D28). Nothing here does HTTP or spawns: `stream`,
// `seats`, `broadcast` and `postSummary` are injected, so the whole
// conversation is testable with fakes.
import { randomUUID } from 'node:crypto';
import { chooseSpeakers, parseFloorReply } from './floor.js';
import { mindSystemPrompt, leadSystemPrompt } from './roster.js';
import { isSubstantive } from './agy-seat.js';
import { OUTSIDE_LABEL } from './researcher.js';
import { DECISIONS_SYSTEM, parseDecisions, AGENDA_SYSTEM, parseAgenda } from './decisions.js';
import { emitSpineEvent, SPINE_KINDS } from '../observability/spine.js';

const SUMMARY_SYSTEM = 'Summarise this huddle for an engineering manager reading on a phone: what was decided, what is open, who said the thing that mattered. Under 120 words, plain prose, no headings.';
const LEAD_TURN_PROMPT = 'Speak your next line now.';
// The operator's conversational limit is under 5 s; end() gives a seat call
// in flight at most this long, then aborts it and summarises without it.
export const SEAT_END_GRACE_MS = 10_000;

// A sentence has ended when the text so far ends in . ! or ? (optionally a
// closing quote or bracket) followed by whitespace or the end of the text.
// "v2.5 is" does not count: the period is followed by a digit.
export function firstSentenceReached(text) {
  return /[.!?]["')\]]?(\s|$)/.test(String(text ?? ''));
}

// A period ending one of these words (or a lone letter, an initial) does not
// end a sentence: "Try e.g. caching" is one sentence.
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'mr', 'mrs', 'ms', 'dr']);

// The CLI has no max-tokens flag, so the two-sentence rule is also kept here.
// Cuts after the n-th real terminator: . ! or ? (optionally a closing quote or
// bracket) followed by whitespace or the end, and not an abbreviation. A
// period inside a token ("$2.50", "v2.5") is never followed by whitespace, so
// it never counts, and nothing before the cut is ever dropped.
export function clampSentences(text, n) {
  const s = String(text ?? '').trim();
  const terminator = /[.!?]+["')\]]?(?=\s|$)/g;
  let count = 0;
  let m;
  while ((m = terminator.exec(s)) !== null) {
    const word = (s.slice(0, m.index).match(/(\S+)$/)?.[1] ?? '').toLowerCase();
    if (m[0].startsWith('.') && (ABBREVIATIONS.has(word) || /^[a-z]$/.test(word))) continue;
    count += 1;
    if (count === n) return s.slice(0, m.index + m[0].length).trim();
  }
  return s;
}

// "Howard, can you look up X": the request without the name or the verb.
function lookupQuestion(text, persona) {
  let q = String(text ?? '');
  for (const alias of persona.aliases ?? []) q = q.replace(new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[,:]?\\s*`, 'i'), '');
  q = q.replace(/^(?:(?:can|could|would) you\s+|please\s+)*(?:look\s+up|look\s+into|research|find\s+out|dig\s+into|check)\s+/i, '').trim();
  return (q || String(text ?? '').trim()).slice(0, 300);
}

// `researcher` is the injected lookup ({ run, busy, model }); without one a
// researcher persona answers that he cannot look anything up.
export function createHuddle({ personas, stateDir, models, stream, broadcast, seats = [], notes = [], brief = '', postSummary = null, researcher = null, actor = 'operator', now = Date.now, id = randomUUID().slice(0, 8), seatEndGraceMs = SEAT_END_GRACE_MS }) {
  const transcript = [];
  const startedAt = new Date().toISOString();
  let inflight = null;
  let ended = false;
  let ending = null; // the end() promise once ending has begun
  const turns = new Set(); // settled-promises of say() turns still running
  let summaryPost = null;
  let summary = null; // set once ended; the end response carries it for the dock
  let extracted = null; // the last decide() result
  let deciding = null; // the decide() call in flight, shared by concurrent callers
  let agenda = null; // the last agenda() result
  let agendaCall = null;
  // Seats the operator has muted: the floor never schedules them, as a first
  // responder, a second view or a name call.
  const muted = new Set();
  let pendingSeat = Promise.resolve();
  let seatAc = null; // the AbortController of the seat call in flight
  let seatMode = null; // and its mode
  // Bumped by every operator line and every interrupt. A turn whose number is
  // no longer current stops before its next speaker, and a queued second view
  // that has not started yet is dropped: the conversation has moved on.
  let turnSeq = 0;
  const sessionId = `huddle:${id}`;
  const modelOf = (p) => p.model ?? models.mind;
  const roster = () => personas.map((p) => ({ id: p.id, display: p.display, role: p.role, ...(p.seatRole ? { seatRole: p.seatRole } : {}), icon: p.icon, modelName: p.lead ? models.floor : modelOf(p), ...(p.seat ? { seat: p.seat } : {}), ...(p.model ? { model: p.model } : {}), ...(p.voice ? { voice: p.voice } : {}) }));
  const displayOf = (pid) => (pid === 'operator' ? 'Operator' : personas.find((p) => p.id === pid)?.display ?? pid);
  const lead = personas.find((p) => p.lead) ?? null;
  const seatIds = new Set(personas.filter((p) => p.seat).map((p) => p.id));
  // Roster order, so the round-robin over second views is stable.
  const seatList = personas.filter((p) => p.seat).map((p) => seats.find((x) => x.persona.id === p.id)).filter(Boolean);
  const seatById = new Map(seatList.map((x) => [x.persona.id, x]));
  // Why a seat is missing or was refused, as text. They ride the snapshot as
  // well as status frames, because the frames fire before the dock may be listening.
  const startNotes = [...new Set([...personas.map((p) => p.seatError).filter(Boolean), ...notes])];
  let secondTurn = 0; // round-robin counter over seatList

  // Outside material is labelled wherever another model reads it, so the
  // label survives into the minds, the summary and decide().
  const shown = (u) => (u.outside ? `[${OUTSIDE_LABEL}] ${u.text}` : u.text);
  function transcriptText() {
    return transcript.map((u) => `${displayOf(u.speaker)}: ${shown(u)}${u.truncated ? ' [interrupted]' : ''}`).join('\n');
  }
  function transcriptRows() {
    return transcript.filter((u) => !u.error).map((u) => ({ speaker: u.speaker, name: displayOf(u.speaker), text: shown(u), truncated: Boolean(u.truncated) }));
  }
  function messagesFor() {
    return [{ role: 'user', content: `Transcript so far:\n${transcriptText() || '(nothing yet)'}\n\n${LEAD_TURN_PROMPT}` }];
  }
  function record(speaker, text, model, extra = {}) {
    const u = { speaker, text, ts: new Date().toISOString(), model, ...extra };
    transcript.push(u);
    emitSpineEvent(stateDir, {
      kind: SPINE_KINDS.HUDDLE_UTTERANCE,
      label: text.slice(0, 200),
      actor: speaker === 'operator' ? actor : `agent:${speaker}`,
      sessionId,
      payload: { speaker, model, ...extra },
    });
    broadcast({ type: 'huddle', huddleId: id, event: 'utterance', speaker, text, ts: u.ts, model, ...extra });
    return u;
  }
  function snapshot() {
    return { id, startedAt, ended, ...(ended ? { summary } : {}), summaryPost, personas: roster(), transcript: transcript.slice(), ...(startNotes.length ? { notes: startNotes } : {}), muted: [...muted], ...(agenda ? { agenda } : {}), ...(extracted ? { extracted } : {}) };
  }
  // A pre-warm failure is silent until a turn on that mind fails too; then the
  // dock shows why the warm-up failed as its status line.
  function warmFailureStatus(display, e) {
    if (!e?.prewarmError) return;
    broadcast({ type: 'huddle', huddleId: id, event: 'status', level: 'error', text: `${display} could not warm up earlier: ${e.prewarmError}` });
  }
  const researcherIds = new Set(personas.filter((p) => p.researcher).map((p) => p.id));
  const claudeHasSpoken = () => transcript.some((u) => u.speaker !== 'operator' && !seatIds.has(u.speaker) && !researcherIds.has(u.speaker) && !u.error);

  // Howard: a one-line acknowledgement now, the lookup in the background. His
  // finding is outside material and is recorded only while the huddle is open.
  // One lookup at a time per kernel: a second request is refused, not queued.
  const researchAcs = new Set();
  function abortResearch() { for (const ac of researchAcs) ac.abort(); }
  function askResearcher(persona, rawQuestion) {
    const say = (text, extra) => record(persona.id, text, null, extra);
    if (!researcher) return say(`(${persona.display} cannot look anything up in this huddle)`, { error: true, via: 'research' });
    if (researcher.busy()) return say('I am already on another lookup. Ask me again once it posts.', { via: 'research-busy' });
    const question = lookupQuestion(rawQuestion, persona);
    const ac = new AbortController();
    researchAcs.add(ac);
    // Started before the acknowledgement is recorded: run() takes the single
    // slot synchronously, so a refusal is known before anything is said.
    const job = researcher.run({ question, signal: ac.signal });
    say(`On it. I will look up ${question.length > 140 ? `${question.slice(0, 137)}...` : question} on the web, compare it with our repo, and post what I find here.`, { via: 'research-ack' });
    broadcast({ type: 'huddle', huddleId: id, event: 'speaker', speaker: persona.id, state: 'thinking' });
    job.then((r) => {
      if (ac.signal.aborted || ended || ending) return;
      say(r.text, { via: 'research', outside: true, label: OUTSIDE_LABEL, ...(r.partial ? { partial: true } : {}) });
    }, (e) => {
      if (ac.signal.aborted || ended || ending) return;
      if (e?.code === 'BUSY') say('I am already on another lookup. Ask me again once it posts.', { via: 'research-busy' });
      else say(`(${persona.display} could not finish that lookup: ${e?.message ?? e})`, { error: true, via: 'research' });
    }).catch((e) => {
      console.error(`[huddle ${id}] research line failed: ${e?.message ?? e}`);
    }).finally(() => {
      researchAcs.delete(ac);
      if (!ended && !ending) broadcast({ type: 'huddle', huddleId: id, event: 'speaker', speaker: persona.id, state: 'idle' });
    });
  }

  async function speak(persona, floorMs, via) {
    const ac = new AbortController();
    inflight = ac;
    broadcast({ type: 'huddle', huddleId: id, event: 'speaker', speaker: persona.id, state: 'thinking' });
    let sofar = '';
    let firstSentenceMs = null;
    const t0 = now();
    try {
      const body = {
        model: modelOf(persona),
        max_tokens: models.maxTokens,
        system: mindSystemPrompt(persona, brief),
        messages: messagesFor(),
        transcript: transcriptRows(),
        speakerId: persona.id,
      };
      if (models.effort) body.output_config = { effort: models.effort };
      const res = await stream({
        body,
        signal: ac.signal,
        onText: (delta, text) => {
          sofar = text;
          if (firstSentenceMs === null && firstSentenceReached(text)) firstSentenceMs = now() - t0;
          broadcast({ type: 'huddle', huddleId: id, event: 'partial', speaker: persona.id, text });
        },
      });
      record(persona.id, clampSentences(res.text, 2), modelOf(persona), { ttftMs: res.ttftMs, firstSentenceMs: firstSentenceMs ?? res.totalMs, floorMs, via, cold: res.cold ?? null });
      return true;
    } catch (e) {
      if (ac.signal.aborted) record(persona.id, sofar.trim(), modelOf(persona), { truncated: true, floorMs, via });
      else {
        warmFailureStatus(persona.display, e);
        record(persona.id, `(${persona.display} could not answer: ${e.message})`, modelOf(persona), { error: true, floorMs, via });
      }
      return false;
    } finally {
      if (inflight === ac) inflight = null;
    }
  }

  // A seat speaks after Claude, off the first-reply path: queued, never
  // awaited by say(). Its failure is its own error line. agy is serialized
  // process-wide, so a second view can sit queued behind a slow call; one that
  // has not started by the time the operator speaks again is dropped (a reply
  // to a superseded answer). A question put to a seat by name is always
  // answered. `target` is the line the seat must weigh, fixed when the call is
  // queued.
  const seatIdle = (seat) => broadcast({ type: 'huddle', huddleId: id, event: 'speaker', speaker: seat.persona.id, state: 'idle' });
  function queueSeat(seat, mode, seq, target) {
    if (!seat) return;
    pendingSeat = pendingSeat.then(async () => {
      // A seat turn that has not started by the time end() begins is dropped,
      // addressed or not: the summary must not wait on it.
      if (ended || ending) return;
      if (mode === 'second' && seq !== turnSeq) return;
      broadcast({ type: 'huddle', huddleId: id, event: 'speaker', speaker: seat.persona.id, state: 'thinking' });
      const ac = new AbortController();
      seatAc = ac;
      seatMode = mode;
      try {
        const call = seat.respond({ transcriptText: transcriptText(), mode, target, brief, signal: ac.signal });
        call.catch(() => {}); // settles after an abort with nobody listening
        // An aborted call releases the seat queue at once; agyGenerate keeps
        // its own process-wide serialization until the killed agy has exited.
        const aborted = new Promise((r) => ac.signal.addEventListener('abort', r, { once: true }));
        const r = await Promise.race([call, aborted]);
        // aborted (a new operator line, end() or server close): its line is
        // dropped, and with no utterance the chip needs telling it is idle
        if (ac.signal.aborted) return seatIdle(seat);
        if (r.note) broadcast({ type: 'huddle', huddleId: id, event: 'status', level: 'info', text: r.note });
        record(seat.persona.id, r.text, seat.model, r.pass ? { pass: true } : {});
      } catch (e) {
        if (ac.signal.aborted) return seatIdle(seat);
        record(seat.persona.id, `(${seat.persona.display} could not answer: ${e?.message ?? e})`, seat.model, { error: true });
      } finally {
        if (seatAc === ac) seatAc = null;
      }
    }).catch((e) => {
      // Only a throw from record/broadcast lands here. The chain is kept alive
      // so later seat turns and end() are not poisoned, and the dock still gets
      // a seat error line (so its chip leaves "thinking"), best effort.
      const msg = e?.message ?? String(e);
      console.error(`[huddle ${id}] seat turn failed outside the seat call: ${msg}`);
      try {
        broadcast({ type: 'huddle', huddleId: id, event: 'utterance', speaker: seat.persona.id, text: `(${seat.persona.display} could not answer: ${msg})`, ts: new Date().toISOString(), model: seat.model, error: true });
      } catch (e2) {
        console.error(`[huddle ${id}] seat error line could not be broadcast: ${e2?.message ?? e2}`);
      }
    });
  }

  // The floor decision is the `speakers` array, the first key of the Lead's
  // JSON: the call resolves with it as soon as it has streamed and names a
  // Claude mind, and the rest of the reply (`second`) is read from `rest` after
  // the mind has spoken. An empty or invalid list waits for the whole reply.
  const firstResponders = new Set(personas.filter((p) => !p.lead && !p.seat && !p.researcher).map((p) => p.id));
  const unmuted = () => personas.filter((p) => !muted.has(p.id));
  const leadBody = () => ({
    model: models.floor, max_tokens: 200, system: leadSystemPrompt(unmuted()), messages: messagesFor(), transcript: transcriptRows(), speakerId: lead?.id ?? 'lead',
    ...(models.floorEffort ? { output_config: { effort: models.floorEffort } } : {}),
  });
  function leadCall() {
    let rest = null;
    const call = () => new Promise((resolve, reject) => {
      let early = false;
      rest = stream({
        body: leadBody(),
        onText: (delta, text) => {
          if (early) return;
          const m = String(text).match(/"speakers"\s*:\s*(\[[^\]]*\])/);
          if (!m) return;
          let ids;
          try { ids = JSON.parse(m[1]); } catch { return; }
          if (!Array.isArray(ids) || !ids.some((x) => firstResponders.has(x))) return;
          early = true;
          resolve(`{"speakers":${m[1]}}`);
        },
      }).then((r) => r.text);
      rest.then((t) => { if (!early) resolve(t); }, (e) => {
        if (early) return;
        warmFailureStatus(lead?.display ?? 'Lead', e);
        reject(e);
      });
    });
    return { call, rest: () => (rest ? rest.catch(() => null) : Promise.resolve(null)) };
  }

  const huddle = {
    id,
    // An operator line is two steps. hear() records and broadcasts it at once
    // and supersedes whatever turn is in flight; respond() runs its turn. The
    // server calls them apart so a superseding line is visible immediately
    // while its turn waits behind the prior one; say() is both, back to back.
    hear(text) {
      if (ended || ending) throw new Error('huddle ended');
      const clean = String(text ?? '').trim();
      if (!clean) return { clean: '', seq: turnSeq };
      huddle.interrupt();
      // a second view on a superseded answer is not worth the wait; a question
      // put to a seat by name is still answered
      if (seatAc && seatMode === 'second') seatAc.abort();
      record('operator', clean, null);
      return { clean, seq: ++turnSeq };
    },
    // Server close: abort the seat call in flight now, so end() does not wait.
    abortSeat() {
      if (seatAc) seatAc.abort();
      abortResearch();
    },
    respond(line) {
      if (ended || ending) return Promise.reject(new Error('huddle ended'));
      const turn = runTurn(line);
      // end() waits on every turn still running, so an interrupted mind's
      // truncated line is recorded before the summary and before `ended`.
      const settled = turn.catch(() => {});
      turns.add(settled);
      settled.then(() => turns.delete(settled));
      return turn;
    },
    say(text) {
      let line;
      try { line = huddle.hear(text); } catch (e) { return Promise.reject(e); }
      return huddle.respond(line);
    },
    // Stops the speaking mind and the rest of its turn (a second picked
    // speaker does not start). A fresh AbortController per speak() call, so no
    // signal is reused across turns.
    interrupt() {
      turnSeq += 1;
      if (inflight) { const ac = inflight; inflight = null; ac.abort(); }
    },
    idle() { return pendingSeat; },
    // The operator silences a seat for the rest of the huddle (or brings it
    // back). The Lead holds the floor and cannot be muted.
    mute(pid, on = true) {
      const p = personas.find((x) => x.id === pid);
      if (!p || p.lead) return false;
      if (on) muted.add(pid); else muted.delete(pid);
      broadcast({ type: 'huddle', huddleId: id, event: 'muted', muted: [...muted] });
      return true;
    },
    // The question on the table and the open questions with the team's lean:
    // one non-streamed call on the floor model, off the reply path.
    agenda({ via = stream } = {}) {
      if (agendaCall) return agendaCall;
      const run = (async () => {
        if (!transcript.some((u) => u.speaker !== 'operator' && !u.error)) agenda = { question: '', items: [] };
        else {
          const res = await via({ body: { model: models.floor, max_tokens: 400, system: AGENDA_SYSTEM, messages: [{ role: 'user', content: transcriptText() }] } });
          agenda = parseAgenda(res.text);
        }
        broadcast({ type: 'huddle', event: 'agenda', huddleId: id, ...agenda });
        return agenda;
      })();
      agendaCall = run;
      const clear = () => { if (agendaCall === run) agendaCall = null; };
      run.then(clear, clear);
      return run;
    },
    // What POST /api/huddle pre-warms: the Lead (floor model, no effort) and
    // every Claude persona's mind, with the model, effort and system prompt
    // their turns use, so the pool keys them identically. Never a seat.
    warmTargets() {
      return [
        { model: models.floor, effort: models.floorEffort || null, system: leadSystemPrompt(personas) },
        ...personas.filter((p) => !p.seat && !p.researcher).map((p) => ({ model: modelOf(p), effort: models.effort || null, system: mindSystemPrompt(p, brief) })),
      ];
    },
    async end() {
      if (ended || ending) return ending ?? snapshot();
      ending = (async () => {
        huddle.interrupt();
        // A lookup is not waited for: its finding would land after the record.
        abortResearch();
        await Promise.all([...turns]);
        // A queued seat call never starts (ending is set); one in flight gets
        // the grace, then is aborted and its late line dropped.
        let timer;
        const settled = await Promise.race([
          pendingSeat.then(() => true),
          new Promise((r) => { timer = setTimeout(() => r(false), seatEndGraceMs); }),
        ]);
        clearTimeout(timer);
        // an aborted step settles at once (it stops waiting on the seat), and
        // its idle frame must reach the dock before ended
        if (!settled && seatAc) { seatAc.abort(); await pendingSeat; }
        ended = true;
        summary = '';
        // Nothing to report: an empty huddle makes no summary call and posts
        // nothing to Slack (on 2026-10-24 one posted "I don't have anything to summarise").
        const spoke = transcript.some((u) => u.speaker !== 'operator' && !u.error);
        if (!spoke) summary = 'Nobody on the team spoke in this huddle.';
        else {
          try {
            const res = await stream({ body: { model: models.floor, max_tokens: 400, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: transcriptText() }] } });
            summary = res.text.trim();
          } catch (e) {
            summary = `(summary unavailable: ${e?.message ?? e})`;
          }
        }
        if (!spoke) summaryPost = { ok: false, error: 'nobody spoke, so nothing was posted' };
        else if (!postSummary) summaryPost = { ok: false, error: 'no Slack relay configured' };
        else {
          try { await postSummary(summary); summaryPost = { ok: true, error: null }; }
          catch (e) { summaryPost = { ok: false, error: e?.message ?? String(e) }; }
        }
        emitSpineEvent(stateDir, { kind: SPINE_KINDS.HUDDLE_ENDED, label: `huddle ${id} ended`, actor, sessionId, payload: { turns: transcript.length, summary, summaryPost } });
        broadcast({ type: 'huddle', huddleId: id, event: 'ended', summary, summaryPost });
        return snapshot();
      })();
      return ending;
    },
    snapshot,
    transcriptText,
    // One non-streamed call that reads the transcript and returns what the
    // operator agreed. Works live or ended; `via` lets the server hand an ended
    // huddle (whose pool is closed) a fresh stream for this one call.
    decide({ via = stream } = {}) {
      if (deciding) return deciding;
      const run = (async () => {
        if (!transcript.some((u) => u.speaker !== 'operator' && !u.error)) {
          extracted = { problem: '', decisions: [], against: [], actions: [], open: [] };
        } else {
          const res = await via({ body: { model: models.decide ?? models.mind, max_tokens: 600, system: DECISIONS_SYSTEM, messages: [{ role: 'user', content: transcriptText() }] } });
          extracted = parseDecisions(res.text);
        }
        emitSpineEvent(stateDir, { kind: SPINE_KINDS.HUDDLE_DECISIONS, label: `huddle ${id} decisions`, actor, sessionId, payload: { decisions: extracted.decisions.length, actions: extracted.actions.length, open: extracted.open.length } });
        broadcast({ type: 'huddle', event: 'decisions', huddleId: id, ...extracted });
        return extracted;
      })();
      deciding = run;
      const clear = () => { if (deciding === run) deciding = null; };
      run.then(clear, clear);
      return run;
    },
    // A line from the Lead that no model wrote (what a work command filed),
    // spoken by the dock like any other line.
    announce(text) {
      if (!lead || !String(text ?? '').trim()) return null;
      return record(lead.id, String(text).trim(), null, { via: 'work' });
    },
    recordKickoff({ mode, state, cards }) {
      emitSpineEvent(stateDir, { kind: SPINE_KINDS.HUDDLE_KICKOFF, label: `huddle ${id} kickoff ${mode}`, actor, sessionId, payload: { mode, state, cards } });
    },
    metric(m) {
      const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 120000;
      if (!m || m.kind !== 'voice' || !ok(m.heardToFirstAudioMs)) return false;
      if (m.serverFirstSentenceMs != null && !ok(m.serverFirstSentenceMs)) return false;
      const payload = { kind: 'voice', heardToFirstAudioMs: m.heardToFirstAudioMs };
      if (m.serverFirstSentenceMs != null) payload.serverFirstSentenceMs = m.serverFirstSentenceMs;
      if (typeof m.speaker === 'string') payload.speaker = m.speaker.slice(0, 40);
      emitSpineEvent(stateDir, { kind: SPINE_KINDS.HUDDLE_METRIC, label: `voice ${m.heardToFirstAudioMs} ms`, actor, sessionId, payload });
      return true;
    },
  };

  // The operator line was already recorded by hear(); this is its turn.
  async function runTurn({ clean, seq: myTurn }) {
    if (!clean) return { speakers: [], via: 'none', floorMs: 0 };
    // false once the operator has spoken again, interrupted, or ended the huddle
    const current = () => !ended && myTurn === turnSeq;
    // superseded while it waited behind the prior turn: no Lead call at all
    if (!current()) return { speakers: [], via: 'superseded', floorMs: 0 };
    const t0 = now();
    let floor = leadCall();
    let choice = await chooseSpeakers({ text: clean, personas: unmuted(), transcript, callLead: floor.call });
    const howard = choice.via === 'name' ? personas.find((p) => p.researcher && p.id === choice.speakers[0]) : null;
    if (howard) {
      askResearcher(howard, clean);
      return { speakers: [...choice.speakers], via: 'name', floorMs: now() - t0 };
    }
    const seatNamed = choice.via === 'name' && seatIds.has(choice.speakers[0]);
    const named = seatNamed ? seatById.get(choice.speakers[0]) : null;
    // Never first (D28): a seat named before any Claude mind has spoken
    // waits for the Lead's pick to speak first.
    const question = `${displayOf('operator')}: ${clean}`;
    if (seatNamed && claudeHasSpoken()) {
      const floorMs = now() - t0;
      queueSeat(named, 'addressed', myTurn, question);
      return { speakers: [...choice.speakers], via: 'name', floorMs };
    }
    if (seatNamed) {
      floor = leadCall();
      choice = { ...(await chooseSpeakers({ text: '', personas: unmuted(), transcript, callLead: floor.call })), via: 'lead' };
    }
    const floorMs = now() - t0;
    if (!current()) return { speakers: [], via: choice.via, floorMs };
    if (!choice.speakers.length && lead) record(lead.id, choice.ask || 'What would you like us to weigh in on?', models.floor, { floorMs, via: choice.via, ...(choice.reason.startsWith('floor call failed') ? { error: true, reason: choice.reason } : {}) });
    let answered = false;
    for (const pid of choice.speakers) {
      if (!current()) break;
      const persona = personas.find((p) => p.id === pid);
      if (persona && await speak(persona, floorMs, choice.via)) answered = true;
    }
    // The Lead's whole reply, for its second-view pick. Awaited even when
    // nobody needs it, so the Lead's process is free before the next turn.
    if (choice.via === 'lead') {
      const full = await floor.rest();
      if (full) { const parsed = parseFloorReply(full, unmuted()); choice = { ...choice, second: parsed.second, ...(parsed.research ? { research: parsed.research } : {}) }; }
    }
    const chairHoward = choice.research && current() ? unmuted().find((p) => p.researcher) : null;
    if (chairHoward) askResearcher(chairHoward, choice.research);
    if (seatNamed) queueSeat(named, 'addressed', myTurn, question);
    else if (answered && isSubstantive(clean) && seatList.some((x) => !muted.has(x.persona.id))) {
      const answer = transcript.findLast((u) => u.speaker !== 'operator' && !seatIds.has(u.speaker) && !researcherIds.has(u.speaker) && !u.error);
      const open = seatList.filter((x) => !muted.has(x.persona.id));
      const second = seatById.get(choice.second) ?? open[secondTurn++ % open.length];
      queueSeat(second, 'second', myTurn, answer ? `${displayOf(answer.speaker)}: ${answer.text}` : null);
    }
    return { speakers: choice.speakers, via: choice.via, floorMs };
  }

  emitSpineEvent(stateDir, { kind: SPINE_KINDS.HUDDLE_STARTED, label: `huddle ${id}`, actor, sessionId, payload: { personas: personas.map((p) => p.id) } });
  broadcast({ type: 'huddle', huddleId: id, event: 'started', personas: roster() });
  for (const text of startNotes) broadcast({ type: 'huddle', huddleId: id, event: 'status', level: 'error', text });
  return huddle;
}
