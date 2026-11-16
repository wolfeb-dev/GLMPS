// server/lib/scut/notify.js
// SCUT outbound notifier: the event half of routing model C. When a launched
// job finishes, resolve the Slack room it came from and post the outcome back
// into it, as the agent that owns the room. Every dependency is injected
// (room lookup, post, theme, outbound mode, roll-up channel, permalink,
// presence) so this stays pure and testable; server.js supplies the real
// Slack client.
// Fail-soft by design: Slack being unreachable, a ticket with no bound room,
// a roll-up channel that cannot be resolved, a permalink that cannot be
// fetched, or a reaction that cannot be applied must never break the runner
// that calls jobFinished - so this never throws, it only returns a boolean.
//
// This is also the REAL completion wire (see engine.js): a launch resolving
// is not the same as a job finishing, so engine.js no longer marks the
// mention done on launch. jobFinished is what the GLMPS runner calls once
// the job is actually over, and it is what reacts on the ORIGINAL mention
// (room.mentionTs) with the true outcome.

const DEFAULT_AGENT = 'riker';

// The gate verdict an agent itself writes (PASS/CONCERNS/FAIL/WAIVED) is the
// real verdict; `ok` on its own only means "the runner did not have to
// intervene", which is not the same thing and must never be reported as if
// it were a pass. When no verdict is present at all, say so explicitly
// ("no gate verdict") rather than silently reading as a clean finish.
function statusWord({ ok, verdict }) {
  if (verdict) return verdict;
  return ok ? 'finished (no gate verdict)' : 'failed';
}

function outcomeText({ ticketId, ok, detail, verdict }) {
  const status = statusWord({ ok, verdict });
  const tail = detail ? ` - ${detail}` : '';
  return `${ticketId} ${status}${tail}`;
}

// A short one-line summary for the roll-up channel. When a permalink back to
// the originating thread is available, append it so the roll-up is a usable
// index into the real conversation rather than a duplicate of it.
function compactText({ ticketId, ok, verdict }, threadUrl) {
  const status = statusWord({ ok, verdict });
  return threadUrl ? `${ticketId} ${status} - <${threadUrl}|thread>` : `${ticketId} ${status}`;
}

/**
 * @param {object} deps
 * @param {(ticketId:string) => object|null} deps.findRoomByTicket
 * @param {(agentId, msg, theme) => any} deps.post   - (agentId, {channel, text, thread_ts}, theme)
 * @param {() => object} deps.getTheme
 * @param {() => 'thread'|'channel'|'both'} deps.getOutbound
 * @param {() => Promise<string|null>} [deps.rollupChannel] - lazily resolved by server.js; may yield null
 * @param {(loc:{channel:string, ts:string}) => Promise<string|null>} [deps.permalink]
 * @param {{done:Function, failed:Function}} [deps.presence] - reacts on the
 *   ORIGINAL mention (room.mentionTs) with the true outcome, once it is
 *   actually known. Optional so callers/tests that predate this wiring keep
 *   working; also skipped whenever room.mentionTs itself is absent (rooms
 *   bound before this change).
 * @param {(msg:string) => void} [deps.log]
 */
export function makeNotifier({
  findRoomByTicket,
  post,
  getTheme,
  getOutbound,
  rollupChannel = null,
  permalink = null,
  presence = null,
  log = () => {},
}) {
  // Full outcome, posted into the room's own thread. Never throws.
  async function postThread(room, payload) {
    const msg = { channel: room.channel, text: outcomeText(payload), thread_ts: room.thread_ts };
    try {
      await post(room.agentId || DEFAULT_AGENT, msg, getTheme());
      return true;
    } catch (e) {
      log('notify.jobFinished thread post failed: ' + (e?.message ?? e));
      return false;
    }
  }

  // Compact one-liner, posted into the roll-up channel. Absorbs every
  // failure mode - no roll-up configured, the resolver throwing, the
  // resolver yielding null, the permalink lookup throwing - by degrading to
  // "post without a link" or "post nothing", never by throwing.
  async function postRollup(room, payload) {
    if (!rollupChannel) return false;
    let channel;
    try {
      channel = await rollupChannel();
    } catch (e) {
      log('notify.jobFinished rollupChannel() failed: ' + (e?.message ?? e));
      return false;
    }
    if (!channel) return false; // not configured yet -> nothing to post into

    let url = null;
    if (permalink) {
      try {
        url = await permalink({ channel: room.channel, ts: room.thread_ts });
      } catch (e) {
        log('notify.jobFinished permalink() failed: ' + (e?.message ?? e));
        url = null; // degrade to a link-less line rather than skip the post
      }
    }

    const msg = { channel, text: compactText(payload, url) };
    try {
      await post(room.agentId || DEFAULT_AGENT, msg, getTheme());
      return true;
    } catch (e) {
      log('notify.jobFinished rollup post failed: ' + (e?.message ?? e));
      return false;
    }
  }

  // Turn the mention's :eyes: into :white_check_mark: or :x: on the ORIGINAL
  // mention message (room.mentionTs), now that the outcome is actually known.
  // A room bound before this change has no mentionTs - there is nothing to
  // react to, so skip it rather than reacting on the wrong message. Never
  // throws: a reaction is a nice-to-have on top of the post that already
  // happened, not something that can un-happen it.
  async function reactOnMention(room, payload) {
    if (!presence || !room.mentionTs) return;
    const ctx = { channel: room.channel, ts: room.mentionTs };
    try {
      if (payload.ok && payload.verdict !== 'FAIL') await presence.done(ctx);
      else await presence.failed(ctx);
    } catch (e) {
      log('notify.jobFinished presence reaction failed: ' + (e?.message ?? e));
    }
  }

  return {
    async jobFinished(payload) {
      const room = findRoomByTicket(payload.ticketId);
      if (!room) return false; // no bound room -> nothing to post into

      const mode = getOutbound();
      let posted = false;
      // 'both' does both halves; a failure in one never suppresses the
      // other, and the overall result is true as long as at least one post
      // landed somewhere.
      if (mode === 'thread' || mode === 'both') {
        if (await postThread(room, payload)) posted = true;
      }
      if (mode === 'channel' || mode === 'both') {
        if (await postRollup(room, payload)) posted = true;
      }
      await reactOnMention(room, payload);
      return posted;
    },
  };
}
