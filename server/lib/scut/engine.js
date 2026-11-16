// server/lib/scut/engine.js
// The SCUT inbound engine: an app_mention becomes either a Bob-mode toggle or a
// routed instruction for a specific agent. Personas resolve from the LIVE theme
// (getTheme reads the current bobMode), so a toggle takes effect immediately.
// The "route to a Claude Code session" step is the injected onMention seam.
import { postAs } from './provision.js';
import { parseIntent, applyToggle } from './toggle.js';
import { parseCommand } from './commands.js';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parse "<@BOT> builder: do X" -> { agentId, text } by matching agent aliases.
 * When multiple agents are named, the one named LEFTMOST wins (e.g. "bill,
 * ask riker later" resolves to bill) - object-iteration order over `agents`
 * is not a meaningful signal, position in the sender's own text is.
 */
export function resolveMention(text, agents) {
  const stripped = String(text ?? '').replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = stripped.toLowerCase();
  let best = null; // { agentId, index }
  for (const a of Object.values(agents || {})) {
    for (const alias of a.aliases || []) {
      const index = lower.search(new RegExp(`\\b${esc(alias)}\\b`));
      if (index === -1) continue;
      if (best === null || index < best.index) best = { agentId: a.id, index };
    }
  }
  return { agentId: best ? best.agentId : null, text: stripped };
}

// Slack `message` subtypes. A message with NO subtype is a person typing.
// `file_share` is also a person typing - it is what Slack stamps on a message
// that carries an attachment, and treating it as machinery was previously
// eating whole messages (see the SCUT attachments work). Everything else is
// machinery (joins, leaves, edits, deletions, topic and purpose changes, bot
// posts) and must never become an instruction.
const HUMAN_SUBTYPES = new Set([undefined, null, '', 'file_share']);

// A toggle command is "bobmode [arg]" or a bare magic phrase. Returns the intent
// arg string (possibly empty) when it is a toggle, else null.
function detectToggle(stripped) {
  const s = stripped.trim();
  if (/^bobmode\b/i.test(s)) return s.replace(/^bobmode\b/i, '').trim();
  if (/\bwe are (bob|legion)\b/i.test(s)) return s;
  return null;
}

/**
 * @param {object} opts
 * @param {() => object} opts.getTheme  - returns the active resolved theme
 * @param {(agentId, text, ctx) => any} opts.onMention - routing seam
 * @param {(argText, ctx) => any} [opts.onBobToggle] - Bob-mode toggle handler
 * @param {{status:Function, stop:Function, help:Function, close:Function, approve:Function, deny:Function, run:Function, drop:Function}} [opts.commands] -
 *   chat verbs (server/lib/scut/commands.js parses them). Checked AFTER the
 *   bobmode toggle and BEFORE the router: a command never launches or
 *   steers, never binds a room, so it gets a `presence.done()` on success
 *   like the toggle does - a command genuinely completes when it replies.
 * @param {string} [opts.defaultAgent]
 * @param {string|null} [opts.botUserId] - this bot's own Slack user id, so it
 *   never routes (or answers) its own messages.
 * @param {(channelId:string, userId:string, inviter:string|null) => any} [opts.onRejoin] - D27:
 *   someone joined a channel; server.js reopens the ticket that channel is
 *   hidden-for, when it is one. `null` by default (fail-closed): a caller
 *   that has not wired this, or a Slack app that has not subscribed to
 *   `member_joined_channel`, never sees this event at all. `inviter` is
 *   Slack's own event field (null for a self-join) - the bot's own loop-prevention filter below is not the allowlist
 *   decision itself, so server.js needs the inviter to make it (a
 *   non-allowlisted member can otherwise /invite an allowed operator into a
 *   hidden channel and trigger a reopen nobody asked for).
 * @param {(key:string, reason:string) => any} [opts.reportMiss] - a throwing
 *   onRejoin is reported by name, not only logged; this is
 *   the named-miss escape hatch (server.js wires the real adapters/health.js
 *   reportMiss). No-op by default so a caller that has not wired it keeps
 *   today's log-only behavior instead of throwing on a missing dependency.
 * @param {(channel:string, thread_ts:string) => boolean} [opts.isOpenThread] -
 *   true when the thread is bound to a session that is still open (live,
 *   parked, or starting), which lets a plain reply there route without an @.
 * @param {{onMessage:(msg:object) => Promise<boolean>}} [opts.approvals] -
 *   operator-approved actions (server/lib/scut/approvals.js). Sees every
 *   message first; true means the message was an approval attempt and stops.
 */
export function createEngine({ getTheme, onMention, onBobToggle = null, commands = null, approvals = null, presence = null, guard = null, dedup = null, botUserId = null, defaultAgent = 'riker', isTicketChannel = () => false, isOpenThread = () => false, onRejoin = null, log = () => {}, reportMiss = () => {} }) {
  if (typeof onMention !== 'function') throw new Error('createEngine: onMention required');

  async function onEvent(event) {
    if (!event) return;

    // D27: rejoining a hidden ticket channel reopens its ticket. Needs the
    // Slack app to subscribe to member_joined_channel. Off unless wired.
    if (event.type === 'member_joined_channel') {
      // unhideTicketChannel's own re-invite makes the
      // BOT the `inviter` of the join event Slack fires back at us. Without
      // this, turning rejoin-reopens on would make every unhide immediately
      // re-trigger itself through its own invite - a feedback loop, not a
      // rejoin. A genuinely operator-caused join (self-join, or invited by
      // someone else) still reaches onRejoin.
      // event_ts is not always present on this event
      // type. The fallback is Slack's own envelope-level event_id (attached
      // by socket-mode.js), never a synthesized channel:user key - that key
      // has no time component, so a genuine SECOND join by the same user to
      // the same channel would read as "already seen" and be dropped
      // forever.
      if (onRejoin && event.user && event.user !== botUserId && event.inviter !== botUserId
        && (!dedup || dedup.isNew(event.event_ts ?? event.event_id ?? Symbol('member_joined_channel')))) {
        try { await onRejoin(event.channel, event.user, event.inviter ?? null); }
        catch (e) {
          // Named, not just logged - a single stable per-route key
          // ('scut-rejoin'), channel/user/reason in the text (never a per-id
          // key).
          const reason = e?.message ?? String(e);
          log('onRejoin threw: ' + reason);
          reportMiss('scut-rejoin', `${event.channel}/${event.user}: ${reason}`);
        }
      }
      return;
    }

    // Two doors into the same room. An app_mention is the original one and is
    // unchanged. A plain `message` is the ticket-channel door: inside a channel
    // that IS a ticket's conversation, addressing anyone is redundant. It opens
    // ONLY for a registered ticket channel, so a message anywhere else - a
    // project channel, the hub, a DM, any channel the bot happens to be in -
    // is ignored exactly as it is today. That predicate is the whole isolation
    // guarantee, and both doors then share one guard, one dedup and one router.
    // The default is fail-closed: a caller that has not opted in keeps the
    // mentions-only surface it has now.
    // A third door (glmps-2-0-29): a plain REPLY inside a thread that already
    // has an open session. Starting a conversation still takes an @mention, so
    // a top-level message never qualifies, and neither does a thread whose
    // session is gone - idle chatter there must not launch a fresh job. The
    // predicate is a store lookup, so it fails closed if it throws.
    const isMention = event.type === 'app_mention';
    const isHumanMessage = event.type === 'message' && HUMAN_SUBTYPES.has(event.subtype);
    const fromBot = Boolean(event.bot_id || event.subtype === 'bot_message' || (botUserId && event.user === botUserId));

    // Operator-approved actions (spec 2026-10-17-slack-approved-actions): every
    // message is offered here before any door, so the approval phrase is never
    // routed, steered or filed, wherever it is typed. Bot posts are offered too
    // so a relayed phrase is refused on the record rather than dropped silently.
    // A throwing check is reported and the message routes on: a broken log
    // must not make SCUT deaf, and the phrase alone grants nothing without the
    // operator's Slack identity.
    // Slack delivers one @mention twice, as `message` and as `app_mention`,
    // with the same ts and no fixed order, so this check must not take the
    // routing dedup slot below: when the plain copy took it first, the mention
    // that followed was dropped silently (SCUT went deaf on 2026-10-18).
    // Redelivery is keyed by event type here, each message is offered once,
    // and the twin follows whatever the first copy's decision was.
    if (approvals && (isMention || isHumanMessage || (event.type === 'message' && fromBot))) {
      const key = event.event_ts ?? event.ts;
      const tracked = !fromBot && dedup && key != null;
      let offer = true;
      if (tracked) {
        if (!dedup.isNew(`${event.type}:${key}`)) return;
        if (!dedup.isNew(`approvals:${key}`)) {
          // The twin of a consumed phrase stops too; the twin of a message
          // that passed skips the check and goes on to the doors.
          if (dedup.isNew(`approvals-pass:${key}`)) return;
          offer = false;
        }
      }
      if (offer) {
        const msg = { channel: event.channel, thread_ts: event.thread_ts ?? event.ts, user: event.user ?? null, fromBot, text: event.text ?? '' };
        let consumed = false;
        try { consumed = await approvals.onMessage(msg); }
        catch (e) { log('approvals threw: ' + (e?.message ?? e)); reportMiss('scut-approvals', e?.message ?? String(e)); }
        if (consumed) return;
        if (tracked) dedup.isNew(`approvals-pass:${key}`);
      }
    }

    const isChannelTurn = isHumanMessage && isTicketChannel(event.channel);
    const isThreadTurn = isHumanMessage && !isChannelTurn
      && Boolean(event.thread_ts) && event.thread_ts !== event.ts
      && (() => { try { return isOpenThread(event.channel, event.thread_ts) === true; } catch { return false; } })();
    if (!isMention && !isChannelTurn && !isThreadTurn) return;

    // Self-guard: SCUT must never route or answer its own messages. This runs
    // BEFORE the dedup check - dedup is a bounded structure, and a self-message
    // that consumed a slot could shadow a genuine later duplicate.
    if (fromBot) return;

    const ctx = { channel: event.channel, user: event.user, ts: event.ts, thread_ts: event.thread_ts ?? event.ts, raw: event };

    // Idempotency: a redelivered event carries the same event_ts. Under routing
    // model C a duplicate = a double-launched job, so drop it silently.
    if (dedup && !dedup.isNew(event.event_ts ?? event.ts)) return;

    const stripped = String(event.text ?? '').replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // A message that is only whitespace (or only an @mention) carries no
    // instruction. Routing it would file a ticket titled after nothing.
    if (!stripped) return;

    // Safety gate: authorize the sender BEFORE any action (toggle or route). The
    // text is not scanned here: the ticket intake scan owns that (see guard.js).
    if (guard) {
      const g = guard.check(ctx);
      if (!g.allowed) { await presence?.failed?.(ctx); log(`mention rejected (${g.reason})`); return; }
    }

    const toggleArg = detectToggle(stripped);
    if (toggleArg !== null && onBobToggle) {
      try { await onBobToggle(toggleArg, ctx); await presence?.done?.(ctx); }
      catch (e) { await presence?.failed?.(ctx); log('onBobToggle threw: ' + (e?.message ?? e)); }
      return;
    }

    // Chat verbs: status/stop/help are presentation over state GLMPS already
    // has, not new work, so they must never fall into the router (which would
    // file a ticket and launch a session just to answer a question). Only a
    // LEADING verb counts - parseCommand returns null for a sentence that
    // merely contains the word mid-way, e.g. "can you check the status of
    // the build", and that case falls through to the normal route below.
    if (commands) {
      const parsed = parseCommand(stripped);
      if (parsed) {
        try {
          if (parsed.cmd === 'status') await commands.status(ctx);
          else if (parsed.cmd === 'stop') await commands.stop(parsed.arg, ctx);
          else if (parsed.cmd === 'help') await commands.help(ctx);
          else if (parsed.cmd === 'close') await commands.close?.(parsed.arg, ctx);
          else if (parsed.cmd === 'approve') await commands.approve?.(parsed.arg, ctx);
          else if (parsed.cmd === 'deny') await commands.deny?.(parsed.arg, ctx);
          else if (parsed.cmd === 'mode') await commands.mode?.({ mode: parsed.mode, id: parsed.id }, ctx);
          else if (parsed.cmd === 'run') await commands.run?.(parsed.ids, ctx);
          else if (parsed.cmd === 'drop') await commands.drop?.(parsed.ids, ctx);
          await presence?.done?.(ctx);
        } catch (e) {
          await presence?.failed?.(ctx);
          log('command threw: ' + (e?.message ?? e));
        }
        return;
      }
    }

    await presence?.receipt?.(ctx); // :eyes: - the mention was seen. This stays
    // in place on a successful route: routing only LAUNCHES the job, it does
    // not finish it, so it must not read as done. The real completion arrives
    // later on notify.jobFinished (GLMPS's runner calling scut.jobFinished),
    // which is the only thing that turns :eyes: into a checkmark or an x.
    const theme = getTheme ? getTheme() : {};
    const agents = theme.addressable ?? theme.agents ?? {};
    const { agentId, text } = resolveMention(event.text, agents);
    try { await onMention(agentId || defaultAgent, text, ctx); }
    catch (e) { await presence?.failed?.(ctx); log('onMention threw: ' + (e?.message ?? e)); }
  }

  return { onEvent, resolveMention };
}

/** Safe default routing seam: the addressed agent replies in-thread (stub). */
export function defaultOnMention(web, getTheme) {
  return async (agentId, text, ctx) => {
    await postAs(web, agentId, {
      channel: ctx.channel,
      thread_ts: ctx.thread_ts,
      text: `(${agentId} here - live routing to a Claude Code session is not wired yet. Heard: "${text}")`,
    }, getTheme ? getTheme() : undefined);
  };
}

/** Build the Bob-mode toggle handler: apply the intent, then announce in the new theme. */
export function makeBobToggleHandler({ web, settings, getTheme, announcer = 'riker' }) {
  return async (argText, ctx) => {
    const r = applyToggle(parseIntent(argText), settings);
    await postAs(web, announcer, { channel: ctx.channel, thread_ts: ctx.thread_ts, text: r.message }, getTheme());
    return r;
  };
}
