// server/lib/huddle/decisions.js
// What the operator agreed in a huddle, as data, and the backlog cards that
// turn it into work. Pure: the session makes the model call, the server files
// the cards.
export const DECISIONS_SYSTEM = 'You read a huddle transcript and extract what the operator agreed. Reply with JSON only: {"problem":"<one or two sentences: the question the huddle set out to settle>","decisions":[{"text":"<what was agreed>","against":"<the display name of the specialist who argued against it, or empty>"}],"actions":[{"title":"<imperative, under 80 chars>","detail":"<one or two sentences: what done looks like>"}],"open":["..."]}. Only what the operator agreed to or asked for counts as a decision or action; a specialist\'s suggestion the operator did not take up goes in open. Empty arrays and an empty problem when there is nothing.';

// The operator's spoken or typed "turn this into work" (H3). Matched before
// the floor call, so it never reaches a mind. Imperatives only: a question
// such as "does this work?" or "can you file that?" is a turn for the team.
const WORK_COMMAND = /^(?:(?:ok(?:ay)?|right|alright|great|good)[,.!]?\s+)?(?:(?:please|let'?s|go(?: ahead)?(?: and)?)\s+)?(?:make (?:this|that|it) (?:work|happen|real)|file (?:this|that|it)(?: as work)?|kick (?:this|that|it) off|kick off (?:this|that|the work)|turn (?:this|that|it) into (?:work|cards?|tickets?)|ship (?:this|that|it) to the (?:board|runner))(?:\s+(?:now|please))?[.!]*$/i;
export function isWorkCommand(text) {
  return WORK_COMMAND.test(String(text ?? '').trim());
}

const MAX_ITEMS = 12;
const MAX_TITLE = 120;

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, MAX_ITEMS) : []);

function actionList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const a of v) {
    if (!a || typeof a !== 'object' || typeof a.title !== 'string') continue;
    const title = a.title.trim().slice(0, MAX_TITLE);
    if (!title) continue;
    out.push({ title, detail: typeof a.detail === 'string' ? a.detail.trim() : '' });
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}

export function parseDecisions(raw) {
  let obj = null;
  const s = String(raw ?? '');
  try { obj = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }
  // A decision is a string or {text, against}; `against` rides parallel to
  // `decisions` so every consumer of the plain string list keeps working.
  const decisions = [];
  const against = [];
  for (const d of Array.isArray(obj?.decisions) ? obj.decisions : []) {
    const text = (typeof d === 'string' ? d : typeof d?.text === 'string' ? d.text : '').trim();
    if (!text) continue;
    decisions.push(text);
    against.push(typeof d?.against === 'string' ? d.against.trim() : '');
    if (decisions.length === MAX_ITEMS) break;
  }
  return { problem: typeof obj?.problem === 'string' ? obj.problem.trim() : '', decisions, against, actions: actionList(obj?.actions), open: strings(obj?.open) };
}

const bullets = (items) => items.map((x) => `- ${x}`).join('\n');
const origin = (huddleId) => ({ via: 'huddle', huddleId });

export function planCard({ huddleId, extracted, transcriptText, project }) {
  const { decisions, actions, open } = extracted;
  const lead = actions[0]?.title ?? decisions[0] ?? 'untitled';
  const sections = [
    'Write a spec with to-spec from the decisions below, commit it under docs/specs/, declare it on this card, then build it with implement.',
    decisions.length ? `Decisions:\n${bullets(decisions)}` : null,
    actions.length ? `Actions:\n${bullets(actions.map((a) => (a.detail ? `${a.title}: ${a.detail}` : a.title)))}` : null,
    open.length ? `Still open (ask the operator before assuming):\n${bullets(open)}` : null,
    `Transcript:\n${transcriptText}`,
  ].filter(Boolean);
  return {
    project,
    title: `Plan from huddle ${huddleId}: ${lead}`,
    prompt: sections.join('\n\n'),
    source: 'huddle',
    origin: origin(huddleId),
    acceptanceCriteria: actions.map((a, i) => ({ text: `AC-${i + 1} ${a.title}`, done: false })),
  };
}

export function actionCards({ huddleId, extracted, picks, project }) {
  const seen = new Set();
  const out = [];
  for (const i of Array.isArray(picks) ? picks : []) {
    if (!Number.isInteger(i) || i < 0 || i >= extracted.actions.length || seen.has(i)) continue;
    seen.add(i);
    const a = extracted.actions[i];
    const context = extracted.decisions.length ? `Decisions for context:\n${bullets(extracted.decisions)}` : null;
    out.push({
      project,
      title: a.title,
      prompt: [a.detail || a.title, context, `(from huddle ${huddleId})`].filter(Boolean).join('\n\n'),
      source: 'huddle',
      origin: origin(huddleId),
    });
  }
  return out;
}

// The agenda column: the question on the table and the open questions the
// operator still has to answer, each with the team's leading recommendation.
export const AGENDA_SYSTEM = 'You read a huddle transcript and write its agenda. Reply with JSON only: {"question":"<the one question being decided now, one sentence>","items":[{"text":"<an open question the operator still has to answer, a yes or no or a pick, one sentence>","lean":"<the team\'s leading recommendation, one short clause, or empty>"}]}. At most 5 items, most important first. An empty question and no items when nothing is open.';

const MAX_AGENDA = 6;
export function parseAgenda(raw) {
  let obj = null;
  const s = String(raw ?? '');
  try { obj = JSON.parse(s); } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }
  const items = [];
  for (const it of Array.isArray(obj?.items) ? obj.items : []) {
    const text = (typeof it === 'string' ? it : typeof it?.text === 'string' ? it.text : '').trim();
    if (!text) continue;
    items.push({ text, lean: typeof it?.lean === 'string' ? it.lean.trim() : '' });
    if (items.length === MAX_AGENDA) break;
  }
  return { question: typeof obj?.question === 'string' ? obj.question.trim() : '', items };
}
