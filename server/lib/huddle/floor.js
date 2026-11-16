// server/lib/huddle/floor.js
// Who speaks next. Two rules from the conversation-analysis literature the
// spec cites (Nonomura and Mori 2025; arXiv 2606.13544): a directly addressed
// specialist must answer next, and otherwise a moderator conditioned on
// roles picks the speaker over the text transcript. Here the first rule is
// alias matching (the same leftmost-wins rule engine.js uses for Slack
// mentions) and the second is one small Lead call whose reply is JSON.
// An agy seat can be named by the operator, or named by the Lead only as a
// second view; it is never a first responder.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function addressedPersona(text, personas) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower) return null;
  let best = null;
  for (const p of personas) {
    for (const alias of p.aliases ?? []) {
      const i = lower.search(new RegExp(`\\b${esc(alias)}\\b`));
      if (i !== -1 && (best === null || i < best.index)) best = { persona: p, index: i };
    }
  }
  return best ? best.persona : null;
}

export function parseFloorReply(raw, personas) {
  const ids = new Set(personas.filter((p) => !p.lead && !p.seat && !p.researcher).map((p) => p.id));
  const hasResearcher = personas.some((p) => p.researcher);
  const seatIds = new Set(personas.filter((p) => !p.lead && p.seat).map((p) => p.id));
  let obj = null;
  const s = String(raw ?? '');
  try { obj = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }
  const speakers = Array.isArray(obj?.speakers) ? [...new Set(obj.speakers.filter((id) => ids.has(id)))].slice(0, 2) : [];
  const research = hasResearcher && typeof obj?.research === 'string' ? obj.research.trim().slice(0, 300) : '';
  return {
    speakers,
    reason: typeof obj?.reason === 'string' ? obj.reason : '',
    ask: typeof obj?.ask === 'string' ? obj.ask.trim() : '',
    second: typeof obj?.second === 'string' && seatIds.has(obj.second) ? obj.second : '',
    ...(research ? { research } : {}),
  };
}

const FALLBACK_ASK = 'Which of us should take that?';

export async function chooseSpeakers({ text, personas, transcript, callLead }) {
  const named = addressedPersona(text, personas);
  if (named && !named.lead) return { speakers: [named.id], reason: 'addressed by name', ask: '', second: '', via: 'name' };
  let raw = '';
  let failure = null;
  // A failed floor call is not hidden: its reason rides the result, the
  // session records it on the Lead's fallback line, and the dock shows it.
  try { raw = await callLead({ transcript, text }); } catch (e) { failure = `floor call failed: ${e?.message ?? e}`; }
  const parsed = parseFloorReply(raw, personas);
  if (failure) parsed.reason = failure;
  if (!parsed.speakers.length && !parsed.ask) parsed.ask = FALLBACK_ASK;
  return { ...parsed, via: 'lead' };
}
