// server/lib/scut/commands.js
// Chat verbs for SCUT: a small, deliberately narrow set of LEADING-verb
// commands recognized before a mention is ever handed to the router. Without
// this, every message actuates - "@scut what is running?" files a ticket and
// launches a whole coding session just to answer a question GLMPS already
// has the answer to, in the same closure the mention arrived in.
//
// Only a LEADING verb counts. "can you check the status of the build" must
// NOT parse as a status command - the word merely appears mid-sentence, and
// treating it as a command would silently swallow an ordinary instruction
// that was supposed to route and do work. parseCommand is pure text parsing;
// the actual status/stop/help behavior is injected into createEngine as the
// `commands` table (server/lib/scut/engine.js), wired to real GLMPS state by
// server.js.

const STATUS_ALIASES = ['status', 'jobs', 'running', "what's running", 'whats running'];
const STOP_ALIASES = ['stop', 'cancel', 'halt'];
const HELP_ALIASES = ['help', 'commands', '?'];
// glmps-29. Kept deliberately short so an approval is one thumb-typed
// word on a phone, which is the whole point of an AFK approval gate.
const APPROVE_ALIASES = ['approve', 'ok', 'yes'];
const DENY_ALIASES = ['deny', 'reject', 'no'];
// D27: the operator's explicit close, distinct from `stop` (which only
// pauses). An optional ticket id, same as stop - a bare `close` inside a
// ticket channel means "this channel's ticket", elsewhere the handler asks.
const CLOSE_ALIASES = ['close'];

// True when `alias` is the LEADING word/phrase of `lower`: either the whole
// string, or followed by a word boundary (the next character is a space, or
// there is nothing after it). This is what keeps "stopwatch app" or
// "statuses of everything" from matching - `alias` must end a whole word.
function matchesLeading(lower, alias) {
  if (lower === alias) return true;
  if (!lower.startsWith(alias)) return false;
  const next = lower[alias.length];
  return next === ' ';
}

function firstMatch(lower, original, aliases) {
  for (const alias of aliases) {
    if (matchesLeading(lower, alias)) return original.slice(alias.length).trim();
  }
  return undefined;
}

/**
 * Parse a leading chat verb out of already-stripped mention text (no
 * `<@BOT>`, already trimmed of Slack markup by the caller).
 *
 * Deliberately conservative: a bare `stop` with no id parses to
 * `{ cmd: 'stop', arg: '' }` rather than guessing which job is meant - the
 * handler must ask, never guess.
 *
 * @param {string} text
 * @returns {{cmd:'status'|'stop'|'help'|'approve'|'deny'|'close'|'mode'|'run'|'drop', arg:string}|null}
 */
export function parseCommand(text) {
  const original = String(text ?? '').trim();
  if (!original) return null;
  const lower = original.toLowerCase();

  let arg = firstMatch(lower, original, STATUS_ALIASES);
  if (arg !== undefined) return { cmd: 'status', arg };

  arg = firstMatch(lower, original, STOP_ALIASES);
  if (arg !== undefined) return { cmd: 'stop', arg };

  arg = firstMatch(lower, original, HELP_ALIASES);
  if (arg !== undefined) return { cmd: 'help', arg };

  arg = firstMatch(lower, original, APPROVE_ALIASES);
  if (arg !== undefined) return { cmd: 'approve', arg };

  arg = firstMatch(lower, original, DENY_ALIASES);
  if (arg !== undefined) return { cmd: 'deny', arg };

  arg = firstMatch(lower, original, CLOSE_ALIASES);
  if (arg !== undefined) return { cmd: 'close', arg };

  const ids = parseIdVerb(lower, original);
  if (ids) return ids;

  return parseModeCommand(lower, original);
}

// glmps-2-0-171 D5: `run <id>...` and `drop <id>...` answer the daily orphan
// post. Both words open ordinary sentences, so the rest must be ticket ids only.
const ID_VERBS = ['run', 'drop'];
const TICKET_ID_RE = /^[a-z0-9][a-z0-9-]*-\d+$/i;
function parseIdVerb(lower, original) {
  for (const verb of ID_VERBS) {
    if (!matchesLeading(lower, verb)) continue;
    const arg = original.slice(verb.length).trim();
    const ids = arg.split(/[\s,]+/).filter(Boolean);
    if (!ids.length || !ids.every((t) => TICKET_ID_RE.test(t))) return null;
    return { cmd: verb, arg, ids };
  }
  return null;
}

// Unattended reliability T5: `mode <interactive|headless|auto> [ticket-id]`,
// the id and the mode in either order. Stricter than the other verbs because
// "mode" opens ordinary sentences: the rest must be a mode word and at most an
// id, else it is not the verb and the text routes as an instruction.
const MODE_WORDS = { interactive: 'interactive', headless: 'headless', auto: null };
function parseModeCommand(lower, original) {
  if (!matchesLeading(lower, 'mode')) return null;
  const arg = original.slice('mode'.length).trim();
  const tokens = arg.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { cmd: 'mode', arg, mode: undefined, id: '' };
  if (tokens.length > 2) return null;
  const at = tokens.findIndex((t) => Object.hasOwn(MODE_WORDS, t.toLowerCase()));
  if (at < 0) return null;
  const id = tokens.length === 2 ? tokens[1 - at] : '';
  if (id && !/^[a-z0-9][a-z0-9-]*-\d+$/i.test(id)) return null;
  return { cmd: 'mode', arg, mode: MODE_WORDS[tokens[at].toLowerCase()], id };
}
