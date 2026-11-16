// server/lib/scut/router.js
// SCUT inbound routing - routing model C: an @mention either launches a new
// Claude Code session or steers the one already bound to this Slack thread.
// Every dependency is injected (room lookups, launch, steer, reply) so this
// module stays pure and testable; server.js supplies the real I/O.
//
// Safety note: this is wired as the `onMention` seam of createEngine
// (server/lib/scut/engine.js). engine.onEvent already runs guard.check()
// (the identity allowlist - see server/lib/scut/guard.js for why that check
// is allowlist-only, not a content scan) BEFORE onMention is ever called. Do NOT add a second entry point into this router
// that skips that gate - route everything through engine.onEvent.
//
// Honesty note: `launch` may hand back a ticket that was filed but not
// started (quarantined at intake, or deferred for capacity) via the `note`
// field on its result, and `steer` may reject a request against a live
// session instead of applying it. Both cases are reported to the room
// verbatim rather than reused as if the job had launched or the steer had
// applied - see the reply-text table in
// docs/superpowers/plans/2026-07-25-scut-phase4-remediation.md.
//
// Ticket channels (glmps-92): a Slack channel may BE a ticket's
// whole conversation. When it is, the channel alone identifies the session -
// the thread is irrelevant, and `getRoom` is never consulted. This is the one
// choke point where inbound isolation is decided, deliberately in a single
// place: `ticketForChannel` is fail-closed (unknown channel -> null -> the
// pre-existing thread behaviour), and a ticket channel can NEVER reach the
// launch branch. A pruned or missing room inside a ticket channel says so and
// stops, because the alternative - falling through to launch - is exactly the
// "one reply crossed into a different session" failure this was gated on.
//
// Attachments: a Slack message's images and files are fetched ONCE here, at the
// top of onMention, and folded into the body all four branches below send. This
// is the only sensible place for it - launch, steer, wake and queue are four
// exits from one message, and doing it per branch would download the same image
// four times over. See server/lib/scut/attachments.js.

const MAX_TITLE_LEN = 120;

// Reopen by reply (D27): which card states a reply may reopen.
// Duplicated from lib/scut/reopen.js's REOPENABLE_STATES on purpose - this
// module stays free of imports beyond its own file (see the module header),
// and the two sets are each pinned by their own tests.
const REOPENABLE = new Set(['idle', 'done', 'cancelled', 'archived']);

/**
 * First line of the text, trimmed to MAX_TITLE_LEN. The title comes from the
 * operator's OWN words, never from the attachment block appended below - a
 * ticket called "Attachments (1)" tells nobody anything. A mention that is
 * nothing but a file is the one case where the file's name is the best title
 * available, and it beats the generic fallback.
 */
function titleFor(agentId, text, files = []) {
  const firstLine = String(text ?? '').split('\n')[0].trim();
  if (!firstLine) {
    const name = files.find((f) => f?.name)?.name;
    return name ? `SCUT: ${String(name).slice(0, MAX_TITLE_LEN)}` : `SCUT: ${agentId} request`;
  }
  return firstLine.length > MAX_TITLE_LEN ? firstLine.slice(0, MAX_TITLE_LEN) : firstLine;
}

/** Verbatim text plus a short provenance line naming the originating Slack thread. */
function promptFor(text, ctx) {
  return `${text}\n\n(via Slack, channel ${ctx.channel}, thread ${ctx.thread_ts})`;
}

/**
 * @param {object} deps
 * @param {(channel:string, thread_ts:string) => object|null} deps.getRoom
 * @param {(room:object) => object} deps.bindRoom
 * @param {(sessionId:string) => boolean} deps.isSessionLive   - false for unknown ids
 * @param {(sessionId:string, note:string, ctx:object) => Promise<{ok:boolean, reason?:string}>} deps.steer
 * @param {(input:{title:string, prompt:string, project?:string, origin:object}) => Promise<{id:string, note?:string|null}>} deps.launch
 * @param {(agentId:string, ctx:object, text:string) => any} deps.reply  - post into the thread as the agent
 * @param {(ticketId:string) => string|null} [deps.approveUrlFor] - link to release a quarantined ticket, when known
 * @param {string} [deps.project]
 * @param {(ticketId:string) => boolean} [deps.isParked] - true when the ticket's session is parked (long-polling)
 * @param {(ticketId:string, text:string, ctx:object) => Promise<{ok:boolean, reason?:string}>} [deps.wake] - deliver a note into a parked session
 * @param {(ticketId:string, text:string, ctx:object) => Promise<{ok:boolean, reason?:string}>} [deps.queue] - stash a mention for a job that has not started yet
 * @param {(channelId:string) => string|null} [deps.ticketForChannel] - the ticket
 *   a Slack channel IS the conversation for, or null. Fail-closed by default
 *   (`() => null`), which is exactly the pre-ticket-channel behaviour.
 * @param {(ticketId:string) => object|null} [deps.roomForTicket] - the room a
 *   ticket speaks through, used INSTEAD of getRoom inside a ticket channel.
 * @param {(ticketId:string) => string|null} [deps.cardState] - the card's
 *   current state, for reopen-by-reply (D27). Fail-closed default
 *   (`() => null`) never matches REOPENABLE, so a caller that has not wired
 *   this keeps the pre-reopen behaviour exactly.
 * @param {(ticketId:string) => boolean} [deps.hasLedgerEntry] - whether the
 *   runner ledger actually has a slot for this ticket right now. Fail-open default (`() => true`) keeps the pre-check
 *   behaviour - always try to queue - for a caller that has not wired this.
 * @param {(ticketId:string, text:string, ctx:object) => Promise<{outcome:string, reason?:string, result?:object}>} [deps.reopen] -
 *   route a reply for a known, non-running ticket through the registered
 *   reopen loop (server.js: reopenHandle.runNow). `null` by default, which
 *   keeps the pre-reopen behaviour exactly.
 * @param {(ctx:object) => Promise<{files:object[], block:string}>} [deps.attachments] -
 *   fetch the mention's Slack files and describe them (server/lib/scut/attachments.js).
 *   Called ONCE per mention, here rather than per branch, because launch, steer,
 *   wake and queue all send the same body: fetching it four times over would
 *   download the same image four times and could report four different outcomes
 *   for one message. Omitting it is the pre-attachment behavior, unchanged.
 */
export function makeRouter({ getRoom, bindRoom, isSessionLive, steer, launch, reply, approveUrlFor = null, project = null, isParked = () => false, wake = null, queue = null, attachments = null, ticketForChannel = () => null, roomForTicket = () => null, cardState = () => null, hasLedgerEntry = () => true, reopen = null }) {
  // In-flight lock: socket-mode serializing envelopes and engine deduping by
  // event_ts are the invariants the module comment above warns not to route
  // around - but neither is visible from inside this module, so a change to
  // either would silently reopen the double-launch hazard. Make the router
  // self-defending instead: hold a lock per Slack thread for the duration of
  // the whole onMention call, so a second concurrent mention on the SAME
  // thread can never race the first into observing "no room yet" and
  // launching a second job. Keyed by `channel:thread_ts`; released in a
  // finally so a thrown launch/steer error cannot leave a thread stuck locked.
  const inFlight = new Set();

  return async function onMention(agentId, text, ctx) {
    // Resolve the ticket channel BEFORE anything else. In a ticket channel the
    // lock is per TICKET, not per thread: two messages in different threads of
    // the same ticket channel are still the same conversation and must not run
    // concurrently.
    const channelTicket = ticketForChannel(ctx.channel);
    const lockKey = channelTicket ? `ticket:${channelTicket}` : `${ctx.channel}:${ctx.thread_ts}`;
    if (inFlight.has(lockKey)) {
      await reply(agentId, ctx, `already working on this thread - hang tight.`);
      return;
    }
    inFlight.add(lockKey);
    try {
      // Slack hands us file METADATA, never bytes, so the attachment has to be
      // fetched before the message can be handed on. Whatever comes back is
      // folded into the body every branch below sends, which also means a
      // hostile filename is poison-scanned along with the text rather than
      // riding in beside it (steer/wake/queue each scan the note they get).
      let files = [];
      let block = '';
      if (attachments) {
        try {
          const got = await attachments(ctx);
          block = String(got?.block ?? '');
          files = Array.isArray(got?.files) ? got.files : [];
        } catch (e) {
          // Never lose a message over its attachments: the words still go
          // through, and the failure is said out loud instead of leaving the
          // agent to wonder what it was meant to be looking at.
          block = `(this message had attachments; SCUT could not fetch them: ${e?.message ?? e})`;
        }
      }
      const body = block ? `${text}\n\n${block}` : text;

      // A ticket channel resolves through the ticket, never through the thread.
      const room = channelTicket ? roomForTicket(channelTicket) : getRoom(ctx.channel, ctx.thread_ts);

      // Reopen by reply (D27): a message for a ticket that is not
      // running (idle, done, cancelled, archived) reopens THAT ticket, in its
      // own session when it can. It never launches a new ticket - the ticket
      // is known, so the launch branch below stays unreachable for it. This
      // is checked before the ticket-channel dead end below: a ticket channel
      // whose room went missing (a pruned binding, say) may still be
      // reopenable by state even with no room to speak through yet.
      const knownTicket = channelTicket ?? room?.ticketId ?? null;
      if (knownTicket && reopen && REOPENABLE.has(cardState(knownTicket))) {
        const r = await reopen(knownTicket, body, ctx);
        if (String(r?.outcome ?? '').startsWith('failed')) {
          await reply(agentId, ctx, `could not reopen ${knownTicket}: ${r.reason ?? r.outcome}. Check the board.`);
        } else if (r?.outcome === 'nothing-to-do' && !(r.result && 'refused' in r.result)) {
          // silence here used to read as "handled" for three
          // real cases - the registry's own already-running/stopped guards
          // (r.reason set directly, never answered by the maker), and a
          // maker-level race where the card is no longer reopenable by the
          // time the loop actually ran (r.result.state set). The ONE case
          // that must stay silent here is the maker's poison-scan refusal,
          // which already replied in the thread itself (r.result.refused).
          const why = r.reason ?? (r.result?.state ? `it is now ${r.result.state}` : 'nothing to do');
          await reply(agentId, ctx, `${knownTicket} was not reopened: ${why}.`);
        }
        return;
      }

      // A ticket channel with no resolvable room is a dead end, and it must be
      // a LOUD one. Falling through to the launch branch here would file a
      // second ticket for a conversation that already has one.
      if (channelTicket && !room) {
        await reply(agentId, ctx, `this channel belongs to ${channelTicket}, but I cannot find its session. Nothing was started; check the board.`);
        return;
      }

      // Parked thread -> wake the parked session through its park poll. This
      // outranks the live-steer branch on purpose: a parked session is still
      // making poll tool calls, so isSessionLive() reads true, and steering it
      // would write a note the idle agent never pulls (the exact no-op-with-a-
      // success-message the Phase-4 skeptic flagged).
      if (room?.ticketId && wake && isParked(room.ticketId)) {
        const outcome = await wake(room.ticketId, body, ctx);
        if (outcome && outcome.ok === false) {
          await reply(agentId, ctx, `not delivered: ${outcome.reason}`);
        } else {
          await reply(agentId, ctx, `continuing in the parked session for this thread.`);
        }
        return;
      }

      // Room bound to a live session -> steer it, do not launch anything new.
      // steer resolves rather than throws for a rejection (a busy or
      // uncooperative session), so both outcomes are reported honestly
      // instead of the router assuming the note applied.
      if (room?.sessionId && isSessionLive(room.sessionId)) {
        const outcome = await steer(room.sessionId, body, ctx);
        if (outcome && outcome.ok === false) {
          await reply(agentId, ctx, `not steered: ${outcome.reason}`);
        } else {
          // Honest about the mechanics: a steer note is PULLED at the target
          // session's next tool call, so for an idle (e.g. interactive,
          // between-turns) session delivery is deferred indefinitely. Saying
          // "steered" here read as "done" and hid exactly that gap
          // (operator-reported 2026-07-31 on glmps-38's thread).
          await reply(agentId, ctx,
            `left a note for this thread's running session; it reads it at its next action. ` +
            `If that session is idle, nothing happens until it moves again.`);
        }
        return;
      }

      // Room has a ticket but no session yet -> a job is already in flight for
      // this thread. Launching again here would double-launch (a duplicate
      // worktree + a duplicate agent), so the mention is QUEUED against the
      // ticket instead. Until glmps-42 this branch replied "hang
      // tight" and dropped the text entirely: nothing stashed it, nothing
      // replayed it, and the operator was told to wait for a message that no
      // longer existed. `queue` is optional so a caller that has not wired it
      // degrades to the old reply rather than losing the branch.
      if (room?.ticketId && !room?.sessionId) {
        if (!queue) {
          await reply(agentId, ctx, `still starting the session for ${room.ticketId} - hang tight.`);
          return;
        }
        const outcome = await queue(room.ticketId, body, ctx);
        if (outcome && outcome.ok === false) {
          await reply(agentId, ctx, `not queued: ${outcome.reason}`);
        } else {
          await reply(agentId, ctx, `${room.ticketId} is still starting - queued this, it picks it up when it starts.`);
        }
        return;
      }

      // NOT a rare race guard - this is
      // load-bearing. server.js's bindSessions reconciles rooms with no live
      // session on every backlog tick, and its `fallbackFor` falls back to
      // the card's own self-reported sessionId when no runner-worktree
      // session matches yet. That means a room this router just had cleared
      // (server.js clears it right after a reopen relaunch, precisely so the
      // starting-window branch above can catch a follow-up) can get REBOUND
      // to the ticket's stale, pre-relaunch sessionId by the very next
      // bindSessions tick, before the new session actually shows up in the
      // live list. Whatever this room's own (possibly stale, possibly
      // freshly re-stale-bound) sessionId says, a card the router can
      // independently see is in_progress right now must never be dead-ended
      // or double-launched. Queues exactly like the starting-window branch,
      // and covers BOTH a ticket channel (which would otherwise fall to the
      // dead end below) and a doorway thread (which would otherwise fall
      // through to launch).
      if (knownTicket && queue && cardState(knownTicket) === 'in_progress') {
        // in_progress with NO ledger entry at
        // all is not "relaunching", it is wedged - queuing there is a false
        // promise. Checked explicitly rather than read off queue()'s own
        // failure reason, which is worded for the ordinary already-gone
        // case. Scoped to ticket channels, which have a real board message
        // to fall back to instead.
        if (channelTicket && !hasLedgerEntry(knownTicket)) {
          await reply(agentId, ctx, `${channelTicket} has no live session right now. Reopen or requeue it on the board rather than starting a second one.`);
          return;
        }
        const outcome = await queue(knownTicket, body, ctx);
        if (outcome && outcome.ok === false) {
          await reply(agentId, ctx, `not queued: ${outcome.reason}`);
        } else {
          await reply(agentId, ctx, `${knownTicket} is relaunching - queued this, it picks it up when the new session binds.`);
        }
        return;
      }

      // No room, or a room bound to a dead session -> launch fresh. A dead
      // session means the old sessionId is stale; clear it so a later mention
      // cannot mistake it for something still live.
      // Belt and braces on the invariant above: nothing in a ticket channel
      // may ever reach launch, whatever the room's state turns out to be. The
      // branch above already returns for a missing room, so arriving here means
      // the room exists but its session is dead - and a dead session is a
      // reason to reopen the card, never a reason to start a second one.
      if (channelTicket) {
        await reply(agentId, ctx, `${channelTicket} has no live session right now. Reopen or requeue it on the board rather than starting a second one.`);
        return;
      }

      const origin = { via: 'slack', channel: ctx.channel, thread_ts: ctx.thread_ts, ts: ctx.ts, user: ctx.user, agentId };
      const job = await launch({ title: titleFor(agentId, text, files), prompt: promptFor(body, ctx), project, origin });
      // mentionTs remembers the ORIGINAL mention's ts (not the reply's), so a
      // later completion can react on the message the
      // user actually sent instead of on this router's own reply.
      // AWAITED: binding may also provision the ticket's own Slack channel
      // (server.js), and that has to finish inside the in-flight lock. If it
      // ran after the lock released, a second message could arrive with no
      // room bound yet and launch a duplicate job. `user` is recorded so the
      // binder knows who to invite into the ticket channel.
      await bindRoom({ channel: ctx.channel, thread_ts: ctx.thread_ts, ticketId: job.id, sessionId: null, mentionTs: ctx.ts, project, agentId, user: ctx.user });

      // launch may have filed a ticket without starting it (quarantined at
      // GLMPS intake, or deferred for runner capacity). That is reported
      // verbatim rather than reused as "launched" - see the module header.
      if (!job.note) {
        await reply(agentId, ctx, `launched ${job.id} for this thread.`);
      } else if (job.note === 'quarantined') {
        const url = typeof approveUrlFor === 'function' ? approveUrlFor(job.id) : null;
        const base = `filed ${job.id}, held for review - the text tripped the poison scan.`;
        await reply(agentId, ctx, url ? `${base} Approve: ${url}` : base);
      } else {
        await reply(agentId, ctx, `filed ${job.id}, not started yet: ${job.note}`);
      }
    } finally {
      inFlight.delete(lockKey);
    }
  };
}
