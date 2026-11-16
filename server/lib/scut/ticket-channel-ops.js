// server/lib/scut/ticket-channel-ops.js
// The pure half of a ticket channel's lifecycle: what to name it, who to
// invite, what the channel's first message says, and what the doorway channel
// gets told. server.js performs the Slack calls; everything decided here is
// data so it can be tested without a token.
import { ticketChannelName } from './ticket-channels.js';
import { CLOSED_STATES } from '../orchestration/backlog-store.js';

// a ticket's title (and any agent-authored outcome
// text) is untrusted - Slack mrkdwn, not plain text, so `<!channel>` in a
// title pings the whole channel the moment the welcome or the closing
// summary posts it, and `<http://x|y>` renders as a live link nobody wrote.
// Slack's documented escaping (https://api.slack.com/reference/surfaces/formatting#escaping):
// `&` first, then `<` and `>` - in that order, so the ampersands these two
// substitutions introduce are never re-escaped.
//
// Slack's Events API delivers inbound text with its OWN
// incidental `&`/`<`/`>` ALREADY entity-escaped - only markup Slack itself
// generates (`<@U..>`, `<#C..>`, `<!channel>`, `<url|text>`) arrives with
// literal brackets. `titleFor` (router.js) stores that already-escaped text
// verbatim as the ticket's title, so escaping it again here would double it
// ("A &amp; B" -> "A &amp;amp; B", a visible bug, not a security fix).
// Decoding the three entities FIRST makes this idempotent: text already in
// Slack's escaped form round-trips to itself, and text carrying Slack's own
// unescaped special-mention markup still gets neutralized exactly once.
//
// decode `&lt;`/`&gt;` BEFORE `&amp;`, not after.
// Decoding `&amp;` first can manufacture a FRESH `&lt;`/`&gt;` substring that a
// later decode step then wrongly consumes: Slack delivers a typed literal
// "&lt;" (the user's own four characters, not real markup) as "&amp;lt;" (it
// only ever escapes the ampersand it did not put there itself), and decoding
// `&amp;` first turns that into "&lt;" - which the next step then decodes
// AGAIN into a bare "<", collapsing two layers of escaping into an angle
// bracket that was never actually typed. Decoding `&amp;` LAST means whatever
// it produces is never re-processed, so a typed "&lt;" round-trips to itself.
// One consequence: a title authored directly on the board (never round-
// tripped through Slack's own escaping, unlike a Slack-delivered title) that
// contains the literal text "&amp;" is indistinguishable from Slack-escaped
// input to this function, so it decodes too - it reaches Slack as a single
// "&", not as the five characters typed.
function escapeSlackText(s) {
  const decoded = String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return decoded.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {object} input
 * @param {string} input.ticketId
 * @param {string} input.title
 * @param {string} [input.project]
 * @param {{channel:string, thread_ts:string, user:string}} [input.origin]
 * @param {string|null} [input.operatorUserId] - who to pull into the channel
 * @param {string|null} [input.permalink] - link back to the originating message
 * @returns {{name:string, invite:string|null, welcome:string, indexLine:string}}
 */
export function ticketChannelPlan({ ticketId, title, project = null, origin = {}, operatorUserId = null, permalink = null }) {
  const name = ticketChannelName(ticketId, title);
  // `title` is untrusted (the operator's own Slack text, or a filename) - see
  // escapeSlackText above. `ticketId` never is: it is this module's own slug.
  const safeTitle = escapeSlackText(title);
  // The channel has to stand on its own: someone opening it a week later
  // should see what was asked and be one click from where it was asked.
  const lines = [
    `*${ticketId}* - ${safeTitle}`,
    project ? `project: ${project}` : null,
    permalink ? `asked here: ${permalink}` : 'asked in the project channel.',
    '',
    'Everything about this ticket lives in this channel. It is hidden when the card closes; a reply here reopens it.',
  ].filter((l) => l !== null);
  return {
    name,
    invite: operatorUserId || null,
    welcome: lines.join('\n'),
    indexLine: `filed *${ticketId}* - ${safeTitle} -> #${name}`,
  };
}

const OPEN = new Set(['queued', 'in_progress', 'held', 'in_review', 'idle']);
const MAX_NAME = 80;
const PREFIX = 'closed-';

/**
 * D27: a closed ticket's channel is hidden (renamed, operator removed), never
 * archived, so it stays searchable and the bot still hears replies in it. An
 * idle ticket is paused, not closed, so its channel stays visible.
 * Unknown states answer null: guessing wrong hides a live conversation.
 * @param {{state:string, hiddenTs:number|null}} input
 * @returns {'hide'|'unhide'|null}
 */
export function visibilityAction({ state, hiddenTs }) {
  if (CLOSED_STATES.has(state)) return hiddenTs ? null : 'hide';
  if (OPEN.has(state)) return hiddenTs ? 'unhide' : null;
  return null;
}

/**
 * What POST /api/backlog/<id>/channel does for a card that already exists.
 * An existing channel is returned as it is: a hidden one stays hidden unless
 * `reopen` is asked for, and even then only on an open card, because the close
 * reconciler hides a closed card's channel again on its next run.
 * @returns {{action:'create'|'existing'|'unhide'} | {action:'refuse', reason:string}}
 */
export function openChannelPlan({ item, entry, reopen = false }) {
  if (!entry) return { action: 'create' };
  const isHidden = Boolean(entry.hiddenTs || entry.archivedTs);
  if (!isHidden || !reopen) return { action: 'existing' };
  // Slack refuses to rename or invite into an archived channel at all.
  if (!entry.hiddenTs) return { action: 'refuse', reason: 'the channel is a legacy archived one, which Slack will not unhide; the archived-channel migration owns it' };
  if (!OPEN.has(item?.state)) {
    return { action: 'refuse', reason: `the card is ${item?.state ?? 'in no state'}; move it to queued or held first, which unhides its channel on its own` };
  }
  return { action: 'unhide' };
}

/** The hidden name: `closed-` plus the original, cut to Slack's 80 characters. */
export function hiddenChannelName(name) {
  const base = String(name ?? '');
  if (base.startsWith(PREFIX)) return base.slice(0, MAX_NAME).replace(/-+$/g, '');
  return `${PREFIX}${base}`.slice(0, MAX_NAME).replace(/-+$/g, '');
}

/**
 * The closing post: the gate plus a one-line outcome (program 5b, C3).
 * rejoining only reopens a ticket when the operator has
 * actually wired it (member_joined_channel + cfg.scut.rejoinReopens) -
 * mentioning it otherwise promises something that silently does nothing.
 */
// Card glmps-2-0-104: the same summary also goes to the ticket's original
// thread in the operator's main channel (`channelId` set), since the in-channel
// copy posts in the same step that removes the operators from the channel.
// The outcome is the agent's gate summary when it wrote one; the last devlog
// line is the fallback, and is usually a sign-off rather than a result.
export function closingSummary({ ticketId, title, gate, outcome, prUrl = null, channelId = null, rejoinEnabled = false }) {
  // `title`, `outcome` and the gate summary are untrusted - see
  // escapeSlackText above. `outcome` is the agent's own devlog text, which can
  // itself echo untrusted input.
  const gateSummary = String(gate?.summary ?? '').replace(/\s+/g, ' ').trim();
  const rawLine = gateSummary || String(outcome ?? '').split('\n')[0].trim().slice(0, 200);
  const line = rawLine ? escapeSlackText(rawLine) : 'no summary recorded.';
  // glmps-2-0-185: close-out summaries named what was verified only 25-30% of
  // the time; the recorded check count is the floor the reader always gets.
  const checks = Array.isArray(gate?.evidence) ? gate.evidence.filter((e) => String(e ?? '').trim()).length : 0;
  const verdict = `Gate: ${gate?.status ?? 'none recorded'}${gate?.risk ? ` (risk ${gate.risk})` : ''}${checks ? `, ${checks} check${checks === 1 ? '' : 's'} recorded` : ''}.`;
  // Only a bare https URL is posted; anything else could carry mrkdwn.
  const pr = /^https:\/\/[^\s<>|]+$/.test(String(prUrl ?? '')) ? `PR: ${prUrl}` : null;
  const howToReopen = rejoinEnabled ? 'Reply here, or rejoin it,' : 'Reply here';
  const where = channelId
    ? `Its channel <#${channelId}> is now hidden but searchable; reply there to reopen the ticket in its own session.`
    : `This channel is now hidden but searchable. ${howToReopen} to reopen the ticket in its own session.`;
  return [
    `Closed *${ticketId}* - ${escapeSlackText(title ?? '')}`.trimEnd(),
    `${verdict} Outcome: ${line}`,
    pr,
    where,
  ].filter(Boolean).join('\n');
}
