// judge@1 over our copy of the openevals prompts (MIT, openevals 0.2.2).
// The judge call itself (fill the template, request { reasoning, score } as
// JSON, parse) is ours, derived from openevals dist/llm.js (MIT): that file
// is vendored only so upgrade PRs show upstream changes to the judge logic,
// it is never imported here because it pulls in LangChain and LangSmith.
// Only the two upstream prompt constants below are imported; neither prompt
// file has any imports of its own (openevals 0.2.2 dist/prompts/**/*.js).
import { TRAJECTORY_ACCURACY_PROMPT } from './vendor/openevals/dist/prompts/trajectory/accuracy.js';
import { TASK_COMPLETION_PROMPT } from './vendor/openevals/dist/prompts/conversation/task_completion.js';

export const CONTRACT = 'judge@1';
export const TASK_CLASSES = ['debug', 'feature', 'refactor', 'research', 'docs', 'ops', 'review', 'ui', 'other'];
export const OUTCOMES = ['succeeded', 'partial', 'failed', 'abandoned'];
// The exact prompt text the judge sends, for the Personality page; core may
// reach the vendor tree only through this adapter.
export const PROMPTS = { trajectory: TRAJECTORY_ACCURACY_PROMPT, taskCompletion: TASK_COMPLETION_PROMPT };

let chat = null;
export function configureHost({ chatCompletion }) {
  if (!chatCompletion) throw new Error('judge plugin: configureHost needs chatCompletion');
  chat = chatCompletion;
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
// Cheap mitigation of the prompt-injection surface: session-derived text is
// interpolated inside <trajectory>...</trajectory> and
// <conversation>...</conversation> blocks (the upstream templates' own
// delimiters), so message content containing a literal closing tag could
// forge an early close and make later injected text (e.g. a fake "<system>"
// aside) read as if it sat outside the delimited block. This does not
// attempt to defend against prompt injection generally, only to stop
// content from closing the specific delimiter it is embedded in; the
// vendored prompt text itself is never touched, only the untrusted content
// filled into it.
const escapeClosingTags = (s) => String(s).replace(/<\/(trajectory|conversation)/gi, '<\\/$1');
// Content may be a string or an OpenAI/Anthropic-style block array or object.
const contentText = (c) => {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(contentText).filter(Boolean).join('\n');
  if (typeof c.text === 'string') return c.text;
  try { return JSON.stringify(c); } catch { return String(c); }
};
const render = (msgs) => msgs.map((m) => `${m.role}: ${escapeClosingTags(contentText(m.content))}`).join('\n');

// Requests a single JSON object from the model and hands it back parsed.
// The host's chatCompletion (server/lib/plugins/claude-model.js) already
// throws a ModelError before this runs if a structured request comes back
// non-JSON or non-object, but a test double (or any other host adapter)
// might not enforce that, so this checks again rather than trusting the
// caller: a missing or malformed judgement must be a clear, queueable
// error, never an object with holes silently read as false/undefined.
async function judgeJson(prompt, schema) {
  if (!chat) throw new Error('judge plugin: configureHost was not called');
  const r = await chat({
    model: 'haiku',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_schema', json_schema: { name: 'judgement', schema } },
  });
  const content = r?.choices?.[0]?.message?.content;
  if (content == null) throw new Error('judge plugin: model response had no content');
  let out;
  try {
    out = JSON.parse(content);
  } catch {
    throw new Error('judge plugin: model response was not JSON');
  }
  if (out === null || typeof out !== 'object' || Array.isArray(out)) {
    throw new Error('judge plugin: model response was not a JSON object');
  }
  return out;
}

export async function verdict({ trajectory }) {
  if (!Array.isArray(trajectory) || !trajectory.length) throw new Error('trajectory must be a non-empty message array');
  const prompt = fill(TRAJECTORY_ACCURACY_PROMPT, { outputs: render(trajectory), inputs: '', reference_outputs: '' });
  const out = await judgeJson(prompt, {
    type: 'object',
    required: ['reasoning', 'score'],
    properties: { reasoning: { type: 'string' }, score: { type: 'boolean' } },
  });
  // A non-boolean score is a malformed judgement, not a "no": reading it as
  // false would silently record a failed verdict for a response the model
  // never actually rendered a boolean opinion on.
  if (typeof out.score !== 'boolean') throw new Error('judge plugin: verdict score must be a boolean');
  return { pass: out.score, comment: String(out.reasoning || ''), by: 'openevals:trajectory-accuracy' };
}

export async function classify({ firstPrompt = '', summary = '' }) {
  const safeFirstPrompt = escapeClosingTags(firstPrompt);
  const outputs = `user: ${safeFirstPrompt}\n${escapeClosingTags(summary)}`;
  const prompt = `${fill(TASK_COMPLETION_PROMPT, { outputs, inputs: safeFirstPrompt })}\n\nAlso classify what the task was about as one of: ${TASK_CLASSES.join(', ')}; and how it ended as one of: ${OUTCOMES.join(', ')}.`;
  const out = await judgeJson(prompt, {
    type: 'object',
    required: ['taskClass', 'outcome', 'reason'],
    properties: {
      taskClass: { type: 'string', enum: TASK_CLASSES },
      outcome: { type: 'string', enum: OUTCOMES },
      reason: { type: 'string' },
    },
  });
  const taskClassOk = TASK_CLASSES.includes(out.taskClass);
  const outcomeOk = OUTCOMES.includes(out.outcome);
  const result = {
    taskClass: taskClassOk ? out.taskClass : 'other',
    outcome: outcomeOk ? out.outcome : 'partial',
    reason: String(out.reason || ''),
    by: 'openevals:task-completion',
  };
  // coercing an
  // out-of-enum value to 'other'/'partial' stays (a plan test mandates it -
  // a bogus value must never propagate uncoerced), but landing on the exact
  // same values a genuine 'other'/'partial' classification would produce
  // made garbage indistinguishable from a real one. coerced:true plus the
  // raw (rejected) values make it visible instead.
  if (!taskClassOk || !outcomeOk) {
    result.coerced = true;
    result.raw = { taskClass: out.taskClass, outcome: out.outcome };
  }
  return result;
}
