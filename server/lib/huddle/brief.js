// server/lib/huddle/brief.js
// What the minds know about the project. They have no tools in a huddle, and
// without this they guessed: on 2026-10-24 one said it could not check the
// repo, one took "GLMPS" for a typo, and one proposed building browser voices
// the dock already had. The brief is built once per huddle from the wiki
// glossary and the board, and capped so it does not slow the first word.

export const BRIEF_MAX = 1500;

const SYSTEM = [
  'GLMPS 2.0 is the operator\'s own local system for running coding agents: a kernel (a Node server running as a Windows service) with a dashboard of four lenses, a board of cards, a queue runner that launches cards as agent sessions in their own worktrees, a merge queue, and SCUT, the Slack front end where named personas take requests in threads.',
  'This huddle already has: the Lead choosing who speaks, a model per persona, second views from agy seats (Gemini and others), neural voices on the operator\'s GPU and local speech recognition with barge-in, a summary posted to Slack, and Decide then Kick-off, which turns the decisions into cards.',
].join(' ');

const ACTIVE = ['in_progress', 'in_review', 'queued'];

// cards: board items ({ title, state, project, updatedAt }); glossary: the
// wiki glossary ({ terms: [{ term, definition }] }). Either may be missing.
export function buildBrief({ glossary = null, cards = [], projects = null, maxCards = 8, maxChars = BRIEF_MAX } = {}) {
  const terms = (glossary?.terms ?? []).filter((t) => t?.term && t?.definition).map((t) => `${t.term}: ${t.definition}`);
  const active = (cards ?? [])
    .filter((c) => ACTIVE.includes(c?.state) && (!projects || projects.includes(c.project)))
    .sort((a, b) => ACTIVE.indexOf(a.state) - ACTIVE.indexOf(b.state) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, maxCards)
    .map((c) => `${c.state === 'queued' ? 'queued' : 'in progress'}: ${String(c.title ?? '').replace(/\s+/g, ' ').slice(0, 90)}`);
  const parts = [SYSTEM];
  if (active.length) parts.push(`On the board now:\n${active.map((l) => `- ${l}`).join('\n')}`);
  if (terms.length) parts.push(`Terms:\n${terms.map((l) => `- ${l}`).join('\n')}`);
  let out = parts.join('\n\n');
  // Terms go first when over the cap: the system and the board are what the
  // minds were getting wrong.
  while (out.length > maxChars && terms.length) {
    terms.pop();
    parts[parts.length - 1] = terms.length ? `Terms:\n${terms.map((l) => `- ${l}`).join('\n')}` : '';
    out = parts.filter(Boolean).join('\n\n');
  }
  return out.slice(0, maxChars);
}
