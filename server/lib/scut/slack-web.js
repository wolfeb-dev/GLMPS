// server/lib/scut/slack-web.js
// Minimal zero-dep Slack Web API client. Transport (`fetch`) is injectable so
// tests run with a fake - no network, no real token. Only the handful of methods
// SCUT needs are wrapped; `call()` is the escape hatch for anything else.

const API_BASE = 'https://slack.com/api/';

export class SlackError extends Error {
  constructor(method, code, data) {
    super(`slack ${method} failed: ${code}`);
    this.name = 'SlackError';
    this.method = method;
    this.code = code;   // slack's `error` string, e.g. 'invalid_auth'
    this.data = data;   // full response for context
  }
}

/**
 * @param {object} opts
 * @param {string} opts.token       - bot token (xoxb-...)
 * @param {typeof fetch} [opts.fetchImpl] - injected fetch (defaults to global)
 * @param {string} [opts.base]      - API base url (override for a mock server)
 * @param {number} [opts.maxRetries] - bounded 429 retries before giving up
 * @param {(ms:number) => Promise<void>} [opts.sleep] - injected delay (defaults to real setTimeout)
 * @param {number} [opts.timeoutMs] - per-request abort timeout (default 15s)
 */
export function createSlackWeb({
  token,
  fetchImpl = fetch,
  base = API_BASE,
  maxRetries = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 15000,
} = {}) {
  if (!token) throw new Error('createSlackWeb: token required');

  // Slack does NOT accept a JSON body for every method, contrary to what this
  // file used to claim. conversations.replies returns `invalid_arguments` for
  // one and works form-encoded (proven against the live API, 2026-08-02). Form
  // encoding is therefore a per-method choice, not a global switch: the write
  // methods keep the JSON body they have always worked with.
  function encode(params, form) {
    if (!form) {
      return {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(params),
      };
    }
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      search.set(k, String(v));
    }
    return {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: search,
    };
  }

  async function call(method, params = {}, { form = false } = {}) {
    let attempt = 0;
    for (;;) {
      const enc = encode(params, form);
      const res = await fetchImpl(base + method, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...enc.headers,
        },
        body: enc.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Only HTTP 429 retries, and only up to maxRetries times. Every other
      // response (including a non-ok:true JSON body) falls through to the
      // existing behavior below - throw exactly as before.
      if (res.status === 429 && attempt < maxRetries) {
        // Existing tests pass fake responses with no `headers` property, so
        // read it defensively - a missing/unparseable header falls back to
        // exponential backoff. Retry-After is in SECONDS per Slack's API.
        const retryAfter = res.headers?.get?.('retry-after');
        const retryAfterSec = Number(retryAfter);
        const delayMs = retryAfter != null && Number.isFinite(retryAfterSec) && retryAfterSec >= 0
          ? retryAfterSec * 1000
          : 1000 * 2 ** attempt;
        attempt += 1;
        await sleep(delayMs);
        continue;
      }
      const data = await res.json();
      if (!data || data.ok !== true) {
        throw new SlackError(method, data?.error ?? 'unknown_error', data);
      }
      return data;
    }
  }

  return {
    call,
    authTest: () => call('auth.test'),
    conversationsList: (params = {}) => call('conversations.list', { limit: 200, exclude_archived: true, ...params }),
    conversationsCreate: (name, params = {}) => call('conversations.create', { name, ...params }),
    // conversations.create makes the BOT the only member, so the wizard uses
    // this to put the operator into the channels it just provisioned.
    conversationsInvite: ({ channel, users }) => call('conversations.invite', { channel, users }),
    // Ticket-channel lifecycle (D27: close-and-hide). rename and kick both
    // need channels:manage for public channels, which ticket channels are
    // and which the wizard already asks for. members is a READ method and
    // needs channels:read instead (docs/reference/2026-09-23/slack/).
    conversationsRename: ({ channel, name }) => call('conversations.rename', { channel, name }),
    conversationsKick: ({ channel, user }) => call('conversations.kick', { channel, user }),
    // A read method: form-encoded, like conversationsReplies. Needs
    // channels:read (or groups:read for a private conversation), NOT
    // channels:manage - a separate scope from its two lifecycle neighbors
    // above.
    conversationsMembers: ({ channel, cursor = null, limit = 200 }) =>
      call('conversations.members', { channel, limit, ...(cursor ? { cursor } : {}) }, { form: true }),
    // confirms a name_taken rename against the
    // channel's ACTUAL current name, rather than assuming it. A read
    // method, same scope and encoding as conversationsMembers.
    conversationsInfo: ({ channel }) => call('conversations.info', { channel }, { form: true }),
    // Channel-level catch-up, the flat-channel counterpart of
    // conversationsReplies. FORM-ENCODED for the same reason that one is:
    // Slack's read methods answer `invalid_arguments` to a JSON body.
    conversationsHistory: ({ channel, oldest = null, limit = 50 }) =>
      call('conversations.history', { channel, limit, ...(oldest ? { oldest } : {}) }, { form: true }),
    // A read method, form-encoded like the others. Needs users:read.email.
    usersLookupByEmail: ({ email }) => call('users.lookupByEmail', { email }, { form: true }),
    chatPostMessage: (params) => call('chat.postMessage', params),
    // Thread catch-up for the channel provider (server/lib/scut/channel-server.js).
    // `oldest` is a CURSOR, which is the whole point: polling from the last ts we
    // delivered cannot lose a message across a dropped connection the way the
    // socket-mode push path can.
    //
    // FORM-ENCODED, not JSON: this method answers `invalid_arguments` to a JSON
    // body. That is the difference between a channel that reads its thread and
    // one that connects, registers, and silently never hears the operator.
    conversationsReplies: ({ channel, ts, oldest = null, limit = 50 }) =>
      call('conversations.replies', { channel, ts, limit, ...(oldest ? { oldest } : {}) }, { form: true }),
    // chat.getPermalink is a GET-style Slack method that has worked with a JSON
    // body in practice, so it is left alone. ("Slack accepts JSON for every
    // method", which this comment used to assert, is false - see
    // conversationsReplies below. Any read method added here should be probed
    // against the live API rather than assumed.)
    chatGetPermalink: ({ channel, message_ts }) => call('chat.getPermalink', { channel, message_ts }),
    reactionsAdd: ({ channel, timestamp, name }) => call('reactions.add', { channel, timestamp, name }),
    reactionsRemove: ({ channel, timestamp, name }) => call('reactions.remove', { channel, timestamp, name }),
    // Host-liveness heartbeat (server/lib/scut/heartbeat.js) uses these three
    // to book, cancel, and sweep the "host unreachable" tripwire alarm.
    // chat.scheduleMessage needs chat:write; chat.scheduledMessages.list needs
    // no scopes and only ever returns messages scheduled with this same token.
    chatScheduleMessage: ({ channel, post_at, text }) => call('chat.scheduleMessage', { channel, post_at, text }),
    chatDeleteScheduledMessage: ({ channel, scheduled_message_id }) => call('chat.deleteScheduledMessage', { channel, scheduled_message_id }),
    chatScheduledMessagesList: ({ channel } = {}) => call('chat.scheduledMessages.list', { channel }),
  };
}
