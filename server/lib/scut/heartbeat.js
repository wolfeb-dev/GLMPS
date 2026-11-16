// server/lib/scut/heartbeat.js
// Slack-held dead-man switch for SCUT host liveness. See
// docs/superpowers/plans/2026-07-26-scut-host-liveness.md for the design.
//
// Slack holds the timer, not us: chat.scheduleMessage books a "host
// unreachable" alarm a few minutes into the future, and chat.deleteScheduledMessage
// cancels the previous one. A living host keeps pushing the alarm forward on
// every tick forever; a dead host stops ticking, and Slack delivers the alarm
// on schedule. reconcile() sweeps our own orphaned alarms (identified by
// TRIPWIRE_MARKER) so a crash's leftover tripwire cannot fire against a host
// that has since come back up.
//
// Every method here is best-effort: nothing may throw, because a heartbeat
// that crashes the server is worse than no heartbeat at all.

export const TRIPWIRE_MARKER = 'scut-host-tripwire'; // stable, searchable, never localized

/**
 * @param {object} opts
 * @param {object} opts.web              - slack-web client: chatScheduleMessage / chatDeleteScheduledMessage / chatScheduledMessagesList
 * @param {string} opts.channelId        - where the tripwire alarm lands (the roll-up channel)
 * @param {number} [opts.intervalMs]     - heartbeat tick period
 * @param {number} [opts.graceMultiple]  - alarm fires at now + intervalMs * graceMultiple
 * @param {() => number} [opts.now]      - injected clock
 * @param {() => string} [opts.describeState] - short string: what was in flight at the last beat
 * @param {(msg: string) => void} [opts.log]  - injected logger, never throws on its own
 * @returns {{ tick: () => Promise<void>, disarm: () => Promise<void>, reconcile: () => Promise<void>, pendingId: () => (string|null) }}
 */
export function makeHeartbeat({
  web,
  channelId,
  intervalMs = 5 * 60 * 1000,
  graceMultiple = 3,
  now = () => Date.now(),
  describeState = () => '',
  log = () => {},
}) {
  let pending = null; // scheduled_message_id of the alarm currently booked, or null if none

  function alarmText() {
    const beatAt = new Date(now()).toISOString();
    const state = describeState();
    return `${TRIPWIRE_MARKER}: host unreachable since last beat at ${beatAt}${state ? ` (${state})` : ''}`;
  }

  // Books the NEW alarm first, then deletes the previous one. Order is
  // load-bearing: deleting first and then crashing would leave no tripwire at
  // all, silently disabling the whole feature. If scheduling fails, keep the
  // existing pending id untouched - degrade toward "an alarm exists", never
  // toward "no alarm".
  async function tick() {
    const previous = pending;
    const postAt = Math.floor((now() + intervalMs * graceMultiple) / 1000);
    let scheduledId;
    try {
      const res = await web.chatScheduleMessage({ channel: channelId, post_at: postAt, text: alarmText() });
      scheduledId = res?.scheduled_message_id ?? null;
    } catch (err) {
      log(`scut heartbeat: schedule failed, keeping previous tripwire (${err?.message ?? err})`);
      return;
    }
    pending = scheduledId;
    if (previous) {
      try {
        await web.chatDeleteScheduledMessage({ channel: channelId, scheduled_message_id: previous });
      } catch (err) {
        log(`scut heartbeat: failed to cancel previous tripwire ${previous} (${err?.message ?? err})`);
      }
    }
  }

  // Clean-shutdown path: cancel the pending alarm so a deliberate restart
  // does not cry wolf.
  async function disarm() {
    if (!pending) return;
    const id = pending;
    pending = null;
    try {
      await web.chatDeleteScheduledMessage({ channel: channelId, scheduled_message_id: id });
    } catch (err) {
      log(`scut heartbeat: failed to disarm tripwire ${id} (${err?.message ?? err})`);
    }
  }

  // Sweeps orphaned tripwires left behind by a crash. chatScheduledMessagesList
  // only ever returns messages scheduled with our own token, so filtering by
  // TRIPWIRE_MARKER is enough to leave every unrelated scheduled message
  // (someone's standup reminder, etc.) alone.
  async function reconcile() {
    let listed;
    try {
      const res = await web.chatScheduledMessagesList({ channel: channelId });
      listed = res?.scheduled_messages ?? [];
    } catch (err) {
      log(`scut heartbeat: reconcile list failed (${err?.message ?? err})`);
      return;
    }
    for (const msg of listed) {
      if (typeof msg?.text !== 'string' || !msg.text.includes(TRIPWIRE_MARKER)) continue;
      try {
        await web.chatDeleteScheduledMessage({ channel: channelId, scheduled_message_id: msg.id });
      } catch (err) {
        log(`scut heartbeat: reconcile delete failed for ${msg.id} (${err?.message ?? err})`);
      }
    }
  }

  return { tick, disarm, reconcile, pendingId: () => pending };
}
